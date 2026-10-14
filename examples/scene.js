// Scene model for the builder plus a caching evaluator. DOM-free so it can be
// tested under Node.
//
// Node: { id, kind, name, enabled, collapsed, transform, params?, children?, fill?, openmc? }
//
//   primitives   cube, sphere, cylinder, cone, torus       finite solids (params)
//   operations   union, subtract, intersect, complement    children
//   halfspace    { surface: <surface id>, sense: "-"|"+" } one side of a shared surface
//   ref          { target: <node id> }                     reuses another region node, so one
//                region can appear in several cells (like an openmc.Region object)
//   composite    { type, sense, values }                   an OpenMC composite surface
//                (openmc.model.*): expands into private surfaces + a region
//   cell         region child (0..1) + fill               an OpenMC cell
//   universe     cells (and shapes)                        lives in scene.universes
//
// The scene holds:
//   roots       the root universe's content
//   universes   universe nodes, referenced by cell fills. Lattices will live here
//               too: a fill references any node in this list, and evaluation of a
//               fill target is parameterized by a clipping box in its local frame
//               (identical for every lattice element, so instances share cache).
//   surfaces    Map<id, { id, type, coeffs, boundary, albedo, periodic, name }>
//   world       bounding box for unbounded half-spaces; auto-computed by default
//   materials   material library keyed by id (see materials/material.js)
//   openmc      round-trip data: root universe id, preserved XML elements
//   sources     external source distributions (examples/source/source.js), written
//               into the <settings> of model.xml / settings.xml
//   settings    simulation settings { values } (examples/settings/settings.js)
//
// Polygon tags are node ids: every face maps back to the node (primitive, half-
// space, or cell) that produced it, for colouring and viewport picking.

import { newSource } from "./source/source.js";
import { defaultSettings, readSettings } from "./settings/settings.js";
import { SURFACE_TYPES, classifyQuadric, halfspaceBounds, infiniteBox, isPlane, axisOf } from "./openmc/surfaces.js";
import { intersectBoxes, unionBoxes, emptyBox, regionBounds as astBounds, linearConstraint, refineByPlanes } from "./openmc/region.js";
import { COMPOSITE_TYPES, defaultCompositeParams, expandComposite } from "./openmc/composite.js";
import * as M4 from "./mat4.js";
import { normalizeMaterial, newMaterial } from "./materials/material.js";

export const PRIMITIVES = {
  cube: { label: "Cube", params: { size: [2, 2, 2] } },
  sphere: { label: "Sphere", params: { radius: 1, slices: 32, stacks: 16 } },
  cylinder: { label: "Cylinder", params: { radius: 1, height: 2, slices: 32, axis: "z" } },
  cone: { label: "Cone", params: { radius: 1, height: 2, slices: 32 } },
  torus: { label: "Torus", params: { major: 1, minor: 0.25, segments: 48, rings: 24 } },
};

export const OPERATIONS = {
  union: { label: "Union", symbol: "∪" },
  subtract: { label: "Subtract", symbol: "−" },
  intersect: { label: "Intersect", symbol: "∩" },
  complement: { label: "Complement", symbol: "∁" },
};

export const SPECIAL = {
  halfspace: { label: "Half-space" },
  cell: { label: "Cell" },
  universe: { label: "Universe" },
  composite: { label: "Composite" },
  ref: { label: "Reference" },
};

export const isOperation = (node) => node.kind in OPERATIONS;
export const isPrimitive = (node) => node.kind in PRIMITIVES;
export const isCell = (node) => node.kind === "cell";
export const isUniverse = (node) => node.kind === "universe";
/** Nodes that describe a region of space (can sit inside operations and cells). */
export const isRegionNode = (node) =>
  isPrimitive(node) || isOperation(node) || node.kind === "halfspace" || node.kind === "composite" || node.kind === "ref";

/** Upper bound on nested references (guards against reference cycles). */
const MAX_REF_DEPTH = 64;

/** Expansion of a composite node: { surfaces, region } with surfaces indexed by position. */
export function compositeExpansion(node) {
  return expandComposite(node.params.type, node.params.values);
}

const AXIS_INDEX = { x: 0, y: 1, z: 2 };

const identityTransform = () => ({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });

export function isIdentity(t) {
  return t.position.every((v) => v === 0) && t.rotation.every((v) => v === 0) && t.scale.every((v) => v === 1);
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const DEFAULT_WORLD = () => ({ auto: true, min: [-10, -10, -10], max: [10, 10, 10], segments: 48, up: "z" });

export class Scene {
  constructor() {
    this.roots = [];
    this.universes = [];
    this.surfaces = new Map();
    this.world = DEFAULT_WORLD();
    this.materials = {};
    this.openmc = {};
    this.sources = [];
    this.settings = defaultSettings();
    this.nextId = 1;
  }

  // ---- creation ---------------------------------------------------------------

  /** Creates a detached node. */
  create(kind, overrides = {}) {
    const def = PRIMITIVES[kind] ?? OPERATIONS[kind] ?? SPECIAL[kind];
    if (!def) throw new Error(`unknown node kind: ${kind}`);
    const id = this.nextId++;
    const node = { id, kind, name: `${def.label} ${id}`, enabled: true, collapsed: false, transform: identityTransform() };
    if (kind in PRIMITIVES) node.params = clone(def.params);
    if (kind === "halfspace") node.params = { surface: null, sense: "-" };
    if (kind === "ref") node.params = { target: null };
    if (kind === "composite") {
      const type = overrides.params?.type ?? "rcc";
      node.params = { type, sense: "-", values: defaultCompositeParams(type) };
      node.name = `${COMPOSITE_TYPES[type].label} ${id}`;
    }
    if (kind in OPERATIONS || kind === "cell" || kind === "universe") node.children = [];
    if (kind === "cell") node.fill = { type: "material", material: "void" };
    if (overrides.params) Object.assign(node.params, overrides.params);
    if (overrides.transform) Object.assign(node.transform, overrides.transform);
    for (const key of ["name", "fill", "openmc", "collapsed"]) if (key in overrides) node[key] = overrides[key];
    return node;
  }

  /** Creates a node inside `parentId` (an operation, cell or universe) or at the root. */
  add(kind, overrides, parentId = null) {
    const node = this.create(kind, overrides);
    if (kind === "universe") {
      this.universes.push(node);
      return node;
    }
    const parent = parentId == null ? null : this.find(parentId)?.node;
    if (parent && this.canContain(parent, node)) parent.children.push(node);
    else this.roots.push(node);
    return node;
  }

  /** Adds a surface and returns its id. */
  addSurface(surface) {
    const id = surface.id ?? Math.max(0, ...this.surfaces.keys()) + 1;
    this.surfaces.set(id, { boundary: "transmission", ...clone(surface), id });
    return id;
  }

  /** Creates a half-space on a new surface. */
  addHalfspace(type = "z-plane", coeffs = SURFACE_TYPES[type].defaults, sense = "-", parentId = null) {
    const surface = this.addSurface({ type, coeffs: [...coeffs] });
    return this.add("halfspace", { params: { surface, sense }, name: `${sense === "-" ? "−" : "+"}${surface} ${type}` }, parentId);
  }

  /** Creates a composite surface node (negative side = inside). */
  addComposite(type, parentId = null) {
    return this.add("composite", { params: { type } }, parentId);
  }

  /**
   * Replaces a composite node by explicit half-space nodes on new shared
   * surfaces, so its component surfaces can be edited individually.
   */
  expandCompositeNode(id) {
    const hit = this.find(id);
    if (!hit || hit.node.kind !== "composite") return null;
    const { surfaces, region } = compositeExpansion(hit.node);
    const ids = surfaces.map((s) => {
      const { periodic: _, ...rest } = s;
      return this.addSurface(rest);
    });
    surfaces.forEach((s, i) => {
      if (s.periodic !== undefined) this.surfaces.get(ids[i]).periodic = ids[s.periodic];
    });
    const kinds = { and: "intersect", or: "union", not: "complement" };
    const build = (ast) => {
      if (ast.op === "half") {
        const sid = ids[ast.surface];
        const type = this.surfaces.get(sid).type;
        return this.create("halfspace", { params: { surface: sid, sense: ast.sense }, name: `${ast.sense === "-" ? "−" : "+"}${sid} ${type}` });
      }
      const node = this.create(kinds[ast.op], { collapsed: true });
      node.children = (ast.op === "not" ? [ast.arg] : ast.args).map(build);
      return node;
    };
    let top = build(region);
    if (hit.node.params.sense === "+") {
      const c = this.create("complement");
      c.children = [top];
      top = c;
    }
    if (top.kind === "halfspace") {
      // A single half-space keeps the composite's transform through a group.
      const g = this.create("intersect");
      g.children = [top];
      top = g;
    }
    top.name = hit.node.name;
    top.transform = clone(hit.node.transform);
    top.collapsed = false;
    hit.list.splice(hit.index, 1, top);
    return top;
  }

  /**
   * Replaces node `id` by the intersection of half-spaces on scene surfaces
   * (`entries`: [{ surface: { type, coeffs }, sense }], in the node's parent
   * frame), or by one half-space when there is a single entry. Identical
   * transmission surfaces already in the scene are reused. The replacement
   * keeps the node's id, name and enabled state, so references still resolve.
   */
  replaceWithHalfspaces(id, entries) {
    const hit = this.find(id);
    if (!hit || !entries.length) return null;
    const same = (a, b) => a.type === b.type && a.coeffs.length === b.coeffs.length && a.coeffs.every((c, i) => Math.abs(c - b.coeffs[i]) <= 1e-12 * Math.max(1, Math.abs(c)));
    const halfspaces = entries.map(({ surface, sense }) => {
      let sid = [...this.surfaces.values()].find((s) => (s.boundary ?? "transmission") === "transmission" && same(s, surface))?.id;
      sid ??= this.addSurface({ type: surface.type, coeffs: [...surface.coeffs] });
      const s = this.surfaces.get(sid);
      return this.create("halfspace", { params: { surface: sid, sense }, name: `${sense === "-" ? "−" : "+"}${sid} ${s.type}${s.name ? ` (${s.name})` : ""}` });
    });
    let top = halfspaces[0];
    if (halfspaces.length > 1) {
      top = this.create("intersect");
      top.children = halfspaces;
    }
    top.id = hit.node.id;
    top.name = hit.node.name;
    top.enabled = hit.node.enabled;
    hit.list.splice(hit.index, 1, top);
    return top;
  }

  // ---- structure --------------------------------------------------------------

  get lists() {
    return [this.roots, this.universes];
  }

  /** Whether `node` may be placed inside `parent` (null = root list). */
  canContain(parent, node) {
    if (isUniverse(node)) return false;
    if (!parent) return true;
    if (isUniverse(parent)) return true;
    if (isCell(node)) return false;
    if (isCell(parent)) return isRegionNode(node) && parent.children.filter((c) => c !== node).length === 0;
    if (isOperation(parent)) return isRegionNode(node);
    return false;
  }

  /** Depth-first visit of the root list and all universes; `fn(node, parent, depth)`. */
  walk(fn, nodes = null, parent = null, depth = 0) {
    for (const node of nodes ?? [...this.roots, ...this.universes]) {
      fn(node, parent, depth);
      if (node.children) this.walk(fn, node.children, node, depth + 1);
    }
  }

  /** Locates a node: `{ node, parent, list, index }` or null. */
  find(id, list = null, parent = null) {
    for (const l of list ? [list] : this.lists) {
      for (let index = 0; index < l.length; index++) {
        const node = l[index];
        if (node.id === id) return { node, parent, list: l, index };
        if (node.children) {
          const hit = this.find(id, node.children, node);
          if (hit) return hit;
        }
      }
    }
    return null;
  }

  /** Ids of the ancestors of `id`, nearest first. */
  ancestors(id) {
    const chain = [];
    let hit = this.find(id);
    while (hit?.parent) {
      chain.push(hit.parent.id);
      hit = this.find(hit.parent.id);
    }
    return chain;
  }

  isDescendant(id, ancestorId) {
    return this.ancestors(id).includes(ancestorId);
  }

  /** Removes a node (with its subtree) and returns it. Fills that referenced a removed universe fall back to void. */
  detach(id) {
    const hit = this.find(id);
    if (!hit) return null;
    hit.list.splice(hit.index, 1);
    if (isUniverse(hit.node)) {
      this.walk((n) => {
        if (isCell(n) && n.fill.type === "universe" && n.fill.universe === id) n.fill = { type: "material", material: "void" };
      });
    }
    return hit.node;
  }

  /**
   * Groups region nodes under a new operation placed where the earliest of them
   * (in tree order) was. Children keep the order of `ids`, so for `subtract`
   * the first id is the base. `complement` wraps each node separately.
   */
  /** The cell whose region contains node `id`, or null. */
  ownerCell(id) {
    for (const a of this.ancestors(id)) {
      const n = this.find(a)?.node;
      if (n && isCell(n)) return n.id;
    }
    return null;
  }

  /**
   * Groups region nodes under a new operation. Children keep the order of
   * `ids`, so for `subtract` the first id is the base.
   *
   * Nodes that belong to a cell are referenced instead of moved when the
   * selection also contains free nodes or nodes of other cells: the cell keeps
   * its region and the new group reuses it (e.g. water = box − fuel region).
   * Nodes that all belong to the same cell are moved (restructuring that cell).
   * The group goes where the earliest moved node was, or at the end of the
   * root list when everything is referenced. `complement` wraps each node.
   * Returns the group; `lastCombineRefs` holds how many nodes were referenced.
   */
  combine(kind, ids) {
    const unique = [...new Set(ids)].filter((id) => this.find(id));
    const top = unique.filter((id) => !unique.some((other) => other !== id && this.isDescendant(id, other)));
    if (top.some((id) => !isRegionNode(this.find(id).node))) throw new Error("Only shapes, half-spaces and operations can be combined.");
    this.lastCombineRefs = 0;
    if (top.length === 0) return null;
    const owners = new Map(top.map((id) => [id, this.ownerCell(id)]));
    const distinctOwners = new Set(owners.values());
    const hasFree = [...owners.values()].includes(null);
    const reference = (id) => owners.get(id) !== null && (hasFree || distinctOwners.size > 1);
    const ref = (id) => {
      this.lastCombineRefs++;
      return this.create("ref", { params: { target: id }, name: this.find(id).node.name });
    };

    if (kind === "complement") {
      const groups = top.map((id) => {
        const group = this.create("complement");
        if (reference(id)) {
          group.children.push(ref(id));
          this.roots.push(group);
        } else {
          const hit = this.find(id);
          hit.list.splice(hit.index, 1, group);
          group.children.push(hit.node);
        }
        return group;
      });
      return groups[groups.length - 1];
    }
    let anchor = null;
    this.walk((n) => {
      if (anchor == null && top.includes(n.id) && !reference(n.id)) anchor = n.id;
    });
    const group = this.create(kind);
    if (anchor != null) {
      const first = this.find(anchor);
      first.list.splice(first.index, 0, group);
    } else {
      this.roots.push(group);
    }
    for (const id of top) group.children.push(reference(id) ? ref(id) : this.detach(id));
    return group;
  }

  /** Creates reference nodes to region nodes (at the root, or inside `parentId`). */
  addReferences(ids, parentId = null) {
    const parent = parentId == null ? null : this.find(parentId)?.node;
    return ids
      .map((id) => this.find(id)?.node)
      .filter((n) => n && isRegionNode(n))
      .map((target) => {
        if (parent && (parent.id === target.id || this.isDescendant(parent.id, target.id))) throw new Error(`"${target.name}" cannot reference itself.`);
        const node = this.create("ref", { params: { target: target.id }, name: target.name });
        (parent && this.canContain(parent, node) ? parent.children : this.roots).push(node);
        return node;
      });
  }

  /** The node a reference points to (following chains), or null. */
  resolveRef(node, depth = 0) {
    if (node.kind !== "ref") return node;
    if (depth > MAX_REF_DEPTH) return null;
    const target = this.find(node.params.target)?.node;
    return target ? this.resolveRef(target, depth + 1) : null;
  }

  /** Reference nodes pointing at `id`. */
  refsTo(id) {
    const out = [];
    this.walk((n) => n.kind === "ref" && n.params.target === id && out.push(n));
    return out;
  }

  /** Replaces a reference by an independent deep copy of its source. */
  unlinkRef(id) {
    const hit = this.find(id);
    if (!hit || hit.node.kind !== "ref") return null;
    const source = this.find(hit.node.params.target)?.node;
    if (!source) throw new Error("the referenced node no longer exists");
    const copy = clone(source);
    const renumber = (n) => {
      n.id = this.nextId++;
      n.children?.forEach(renumber);
    };
    renumber(copy);
    if (!isIdentity(hit.node.transform)) {
      // Keep the reference's own transform by wrapping the copy.
      const g = this.create("intersect", { name: copy.name });
      g.transform = clone(hit.node.transform);
      g.children = [copy];
      hit.list.splice(hit.index, 1, g);
      return g;
    }
    hit.list.splice(hit.index, 1, copy);
    return copy;
  }

  /** Wraps region nodes in new cells (one per node). Returns the cells. */
  makeCells(ids) {
    return ids
      .map((id) => this.find(id))
      .filter((hit) => hit && isRegionNode(hit.node) && !(hit.parent && !isUniverse(hit.parent)))
      .map((hit) => {
        const cell = this.create("cell", { name: `${hit.node.name} cell` });
        hit.list.splice(hit.index, 1, cell);
        cell.children.push(hit.node);
        return cell;
      });
  }

  /**
   * Replaces an operation node by its children. Refused when the group has a
   * transform: TRS chains cannot in general be folded into each child's TRS.
   */
  ungroup(id) {
    const hit = this.find(id);
    if (!hit || !isOperation(hit.node)) return null;
    if (!isIdentity(hit.node.transform)) throw new Error("Reset the group's transform before ungrouping it.");
    if (hit.node.kind === "complement") throw new Error("Ungrouping a complement would change its meaning.");
    if (hit.parent && isCell(hit.parent) && hit.node.children.length !== 1) throw new Error("A cell holds a single region.");
    hit.list.splice(hit.index, 1, ...hit.node.children);
    return hit.node.children;
  }

  /**
   * Moves `id` relative to `targetId`: "before", "after", or "inside".
   * `targetId == null` moves it to the end of its top-level list.
   */
  move(id, targetId, where = "inside") {
    if (id === targetId) return false;
    if (targetId != null && this.isDescendant(targetId, id)) return false;
    const node = this.find(id)?.node;
    const targetHit = targetId == null ? null : this.find(targetId);
    if (!node || (targetId != null && !targetHit)) return false;
    let parent;
    if (!targetHit) parent = null;
    else if (where === "inside") parent = targetHit.node;
    else parent = targetHit.parent;
    if (isUniverse(node)) {
      // Universes only reorder among themselves.
      if (where === "inside" || (targetHit && !isUniverse(targetHit.node))) return false;
    } else {
      if (targetHit && where === "inside" && !targetHit.node.children) return false;
      if (targetHit && where !== "inside" && isUniverse(targetHit.node)) return false;
      if (!this.canContain(parent, node)) return false;
    }
    this.detach(id);
    if (!targetHit) {
      (isUniverse(node) ? this.universes : this.roots).push(node);
    } else if (where === "inside") {
      targetHit.node.children.push(node);
      targetHit.node.collapsed = false;
    } else {
      const hit = this.find(targetId);
      hit.list.splice(hit.index + (where === "after" ? 1 : 0), 0, node);
    }
    return true;
  }

  /** Deep-copies a node with fresh ids (and no OpenMC id) right after the original. */
  /**
   * Copies a node and its subtree next to it. The copy is independent: its
   * half-spaces get their own copies of their surfaces (half-spaces sharing a
   * surface inside the copy share the new one), and references to nodes inside
   * the copied subtree point to the copies. References to nodes elsewhere keep
   * their target.
   */
  duplicate(id) {
    const hit = this.find(id);
    if (!hit) return null;
    const copy = clone(hit.node);
    const nodeIds = new Map(); // old node id → new
    const renumber = (n) => {
      const old = n.id;
      n.id = this.nextId++;
      nodeIds.set(old, n.id);
      if (n.openmc) delete n.openmc.id;
      n.children?.forEach(renumber);
    };
    renumber(copy);
    const surfaceIds = new Map(); // old surface id → private copy
    this.walk((n) => {
      if (n.kind === "halfspace" && this.surfaces.has(n.params.surface)) {
        const old = n.params.surface;
        if (!surfaceIds.has(old)) {
          const { id: _, periodic: __, ...rest } = this.surfaces.get(old);
          surfaceIds.set(old, this.addSurface(clone(rest)));
        }
        n.params.surface = surfaceIds.get(old);
        n.name = n.name.replace(new RegExp(`^([−+])${old}(?= )`), `$1${n.params.surface}`);
      } else if (n.kind === "ref" && nodeIds.has(n.params.target)) {
        n.params.target = nodeIds.get(n.params.target);
      }
    }, [copy]);
    // Periodic partners copied together stay paired.
    for (const [old, fresh] of surfaceIds) {
      const partner = this.surfaces.get(old).periodic;
      if (partner !== undefined && surfaceIds.has(partner)) this.surfaces.get(fresh).periodic = surfaceIds.get(partner);
    }
    copy.name = `${hit.node.name} copy`;
    hit.list.splice(hit.index + 1, 0, copy);
    return copy;
  }

  /** Adds an external source (see examples/source/source.js) with the next free id. */
  addSource(spaceType = "point", options = {}) {
    const id = Math.max(0, ...this.sources.map((s) => s.id)) + 1;
    const src = newSource(id, spaceType, options);
    this.sources.push(src);
    return src;
  }

  /** Adds a material to the library with the next free id. */
  addMaterial(overrides = {}) {
    const { id: wanted, ...rest } = overrides;
    // No id given (or an explicit undefined, as when duplicating): the next free one.
    const id = wanted ?? Math.max(0, ...Object.keys(this.materials).map(Number)) + 1;
    const m = newMaterial(id, rest);
    this.materials[id] = m;
    return m;
  }

  /** Cells whose fill names material `id` (alone or in a distributed list). */
  materialUsers(id) {
    const users = [];
    this.walk((n) => {
      if (isCell(n) && n.fill.type === "material" && String(n.fill.material).trim().split(/\s+/).includes(String(id))) users.push(n);
    });
    return users;
  }

  /** Changes a material id and updates the cells that use it. */
  renameMaterial(oldId, newId) {
    if (String(oldId) === String(newId)) return;
    if (this.materials[newId]) throw new Error(`material ${newId} already exists`);
    const m = this.materials[oldId];
    delete this.materials[oldId];
    m.id = Number(newId);
    this.materials[newId] = m;
    for (const cell of this.materialUsers(oldId)) {
      cell.fill.material = String(cell.fill.material).trim().split(/\s+/).map((t) => (t === String(oldId) ? String(newId) : t)).join(" ");
    }
  }

  /** Number of half-space nodes referencing a surface. */
  surfaceUsers(surfaceId) {
    let n = 0;
    this.walk((node) => node.kind === "halfspace" && node.params.surface === surfaceId && n++);
    return n;
  }

  /**
   * Moves surface `id` before or after surface `targetId` in id order, then
   * renumbers: the same set of ids is handed out in the new order, so imported
   * ids stay in use. Half-spaces, periodic partners and generated half-space
   * names ("−3 sphere") follow. Returns Map<old id, new id> of the ids that
   * changed, or null when nothing moved.
   */
  reorderSurface(id, targetId, where = "before") {
    if (id === targetId || !this.surfaces.has(id) || !this.surfaces.has(targetId)) return null;
    const ids = [...this.surfaces.keys()].sort((a, b) => a - b);
    const order = ids.filter((x) => x !== id);
    order.splice(order.indexOf(targetId) + (where === "after" ? 1 : 0), 0, id);
    const map = new Map();
    order.forEach((old, i) => old !== ids[i] && map.set(old, ids[i]));
    if (!map.size) return null;
    const moved = order.map((old) => this.surfaces.get(old));
    this.surfaces.clear();
    moved.forEach((sf, i) => {
      sf.id = ids[i];
      if (sf.periodic !== undefined && map.has(sf.periodic)) sf.periodic = map.get(sf.periodic);
      this.surfaces.set(sf.id, sf);
    });
    this.walk((n) => {
      if (n.kind !== "halfspace" || !map.has(n.params.surface)) return;
      const old = n.params.surface;
      n.params.surface = map.get(old);
      n.name = n.name.replace(new RegExp(`^([−+])${old}(?= )`), `$1${n.params.surface}`);
    });
    return map;
  }

  /** Gives a half-space its own copy of its surface. */
  uniquifySurface(nodeId) {
    const node = this.find(nodeId)?.node;
    if (!node || node.kind !== "halfspace") return null;
    const s = this.surfaces.get(node.params.surface);
    const { id: _, ...rest } = s;
    node.params.surface = this.addSurface({ ...rest, periodic: undefined });
    return node.params.surface;
  }

  // ---- bounds -----------------------------------------------------------------

  /** Conservative analytic bounds of a region node (may be infinite); `viaRef` as in the evaluator. */
  regionBounds(node, negated = false, viaRef = false) {
    if (!node || (!node.enabled && !viaRef)) return negated ? infiniteBox() : emptyBox();
    let box;
    if (node.kind === "halfspace") {
      const s = this.surfaces.get(node.params.surface);
      if (!s) return infiniteBox();
      const sense = negated ? (node.params.sense === "-" ? "+" : "-") : node.params.sense;
      box = halfspaceBounds(s, sense);
    } else if (node.kind === "ref") {
      const target = this.find(node.params.target)?.node;
      if (!target || (this._refDepth ?? 0) > MAX_REF_DEPTH) return infiniteBox();
      this._refDepth = (this._refDepth ?? 0) + 1;
      try {
        box = this.regionBounds(target, negated, true);
      } finally {
        this._refDepth--;
      }
    } else if (node.kind === "composite") {
      try {
        const { surfaces, region } = compositeExpansion(node);
        const flipSide = node.params.sense === "+";
        box = astBounds(region, new Map(surfaces.map((s, i) => [i, s])), negated !== flipSide);
      } catch {
        return infiniteBox();
      }
    } else if (isPrimitive(node)) {
      if (negated) return infiniteBox();
      box = primitiveBounds(node);
    } else if (isCell(node)) {
      const region = node.children.find((c) => c.enabled);
      return region ? this.regionBounds(region, negated) : negated ? emptyBox() : infiniteBox();
    } else if (isOperation(node)) {
      const kids = node.children.filter((c) => c.enabled);
      let conj;
      let boxes;
      if (node.kind === "complement") return transformBounds(this.regionBounds(kids[0], !negated), node.transform);
      if (node.kind === "subtract") {
        boxes = kids.map((c, i) => this.regionBounds(c, i === 0 ? negated : !negated));
        conj = !negated;
      } else {
        boxes = kids.map((c) => this.regionBounds(c, negated));
        conj = (node.kind === "intersect") !== negated;
      }
      if (boxes.length === 0) box = conj ? infiniteBox() : emptyBox();
      else box = boxes.reduce(conj ? intersectBoxes : unionBoxes);
      if (conj && boxes.length) {
        // Plane half-spaces among the operands: bound the polyhedron exactly.
        const planes = kids
          .map((c, i) => {
            if (c.kind !== "halfspace" || !isIdentity(c.transform)) return null;
            const flip = node.kind === "subtract" ? (i === 0 ? negated : !negated) : negated;
            return linearConstraint(this.surfaces.get(c.params.surface), flip ? (c.params.sense === "-" ? "+" : "-") : c.params.sense);
          })
          .filter(Boolean);
        box = refineByPlanes(box, planes);
      }
    } else {
      return infiniteBox();
    }
    return transformBounds(box, node.transform);
  }

  /**
   * The world box used to bound half-spaces: explicit, or derived from the
   * finite bound values of the root items per axis, so unbounded items (a lone
   * plane, a 2D model's missing z extent) are clipped to the bounded content.
   */
  resolveWorld() {
    if (!this.world.auto) return { min: [...this.world.min], max: [...this.world.max] };
    const box = emptyBox();
    for (const n of this.roots) {
      if (!n.enabled) continue;
      const b = this.regionBounds(n);
      if (b.min.some((v, k) => v > b.max[k])) continue; // empty
      for (let k = 0; k < 3; k++) {
        for (const v of [b.min[k], b.max[k]]) {
          if (!Number.isFinite(v)) continue;
          box.min[k] = Math.min(box.min[k], v);
          box.max[k] = Math.max(box.max[k], v);
        }
      }
    }
    return completeBox(box);
  }

  // ---- persistence ------------------------------------------------------------

  toJSON() {
    return {
      version: 2,
      nextId: this.nextId,
      roots: this.roots,
      universes: this.universes,
      surfaces: [...this.surfaces.values()],
      world: this.world,
      materials: this.materials,
      openmc: this.openmc,
      sources: this.sources,
      settings: this.settings,
    };
  }

  static fromJSON(data) {
    const scene = new Scene();
    scene.roots = clone(data.roots ?? []);
    scene.universes = clone(data.universes ?? []);
    for (const s of data.surfaces ?? []) scene.surfaces.set(s.id, clone(s));
    scene.world = { ...DEFAULT_WORLD(), ...(data.world ?? {}) };
    scene.materials = Object.fromEntries(Object.entries(data.materials ?? {}).map(([id, m]) => [id, normalizeMaterial(id, m)]));
    scene.openmc = clone(data.openmc ?? {});
    scene.sources = clone(data.sources ?? []);
    // Scenes saved before the Settings tab: read the settings an opened file kept.
    const keptSettings = (scene.openmc.model?.sections ?? []).find((s) => s?.name === "settings") ?? scene.openmc.settings;
    scene.settings = data.settings ? clone(data.settings) : keptSettings ? readSettings(keptSettings) : defaultSettings();
    let maxId = 0;
    scene.walk((n) => {
      maxId = Math.max(maxId, n.id);
      n.transform = { ...identityTransform(), ...n.transform };
      // Cylinders saved before the axis option existed were along Y.
      if (n.kind === "cylinder" && n.params && n.params.axis === undefined) n.params.axis = "y";
      if (n.kind in PRIMITIVES) n.params = { ...clone(PRIMITIVES[n.kind].params), ...n.params };
      if (n.kind === "composite" && COMPOSITE_TYPES[n.params.type]) n.params.values = { ...defaultCompositeParams(n.params.type), ...n.params.values };
    });
    scene.nextId = Math.max(data.nextId ?? 1, maxId + 1);
    return scene;
  }
}

function primitiveBounds(node) {
  const p = node.params;
  let r;
  switch (node.kind) {
    case "cube":
      r = p.size.map((s) => s / 2);
      break;
    case "sphere":
      r = [p.radius, p.radius, p.radius];
      break;
    case "cylinder": {
      const k = AXIS_INDEX[p.axis] ?? 1;
      r = [p.radius, p.radius, p.radius];
      r[k] = p.height / 2;
      break;
    }
    case "cone":
      r = [p.radius, p.height / 2, p.radius];
      break;
    case "torus":
      r = [p.major + p.minor, p.minor, p.major + p.minor];
      break;
  }
  return { min: r.map((v) => -v), max: r };
}

function transformBounds(box, t) {
  if (isIdentity(t) || box.min.some((v, i) => v > box.max[i])) return box;
  if ([...box.min, ...box.max].some((v) => !Number.isFinite(v))) {
    // Pure translations keep infinite bounds meaningful; anything else is unbounded.
    if (t.rotation.every((v) => v === 0) && t.scale.every((v) => v > 0)) {
      return { min: box.min.map((v, i) => v * t.scale[i] + t.position[i]), max: box.max.map((v, i) => v * t.scale[i] + t.position[i]) };
    }
    return infiniteBox();
  }
  return M4.transformBox(M4.fromTransform(t), box);
}

/** Replaces infinite or empty extents with finite ones based on the finite axes. */
export function completeBox(box) {
  // Reference span: the largest axis with a real extent (20 when there is none).
  const finite = [0, 1, 2].filter((k) => Number.isFinite(box.min[k]) && Number.isFinite(box.max[k]) && box.max[k] > box.min[k]);
  const span = finite.length ? Math.max(...finite.map((k) => box.max[k] - box.min[k])) : 20;
  const half = span / 2;
  const min = [];
  const max = [];
  for (let k = 0; k < 3; k++) {
    const lo = Number.isFinite(box.min[k]) ? box.min[k] : null;
    const hi = Number.isFinite(box.max[k]) ? box.max[k] : null;
    if (lo !== null && hi !== null && hi > lo) {
      min[k] = lo;
      max[k] = hi;
    } else if (lo !== null && hi !== null && hi === lo) {
      // A single plane: centre the box on it so both sides are visible.
      min[k] = lo - half;
      max[k] = lo + half;
    } else if (lo !== null && hi === null) {
      min[k] = lo;
      max[k] = lo + 2 * half;
    } else if (hi !== null && lo === null) {
      min[k] = hi - 2 * half;
      max[k] = hi;
    } else {
      min[k] = -half;
      max[k] = half;
    }
  }
  return { min, max };
}

// ---- evaluation ----------------------------------------------------------------

// A region value is { key, solid, inverted }: `inverted` means "everything
// except `solid`", so complements stay cheap until they must be displayed.
// ---- analytic forms of half-space solids (for the nested fast path) ----

/**
 * The box an axis-aligned plane side occupies in the world (the solid
 * #planeSide builds), with the tag of the face the plane makes:
 * { kind: "box", min, max, tags: [[lowTag, highTag] per axis] }. Null for
 * oblique planes.
 */
function planeBoxForm({ n, d }, neg, world, tag) {
  const len = Math.hypot(...n);
  if (!(len > 0)) return null;
  const u = n.map((v) => v / len);
  const axis = u.findIndex((v) => Math.abs(Math.abs(v) - 1) < 1e-12);
  if (axis < 0) return null;
  const x0 = (d / len) * Math.sign(u[axis]);
  const lower = neg === u[axis] > 0;
  const min = [...world.min];
  const max = [...world.max];
  const tags = [[], [], []];
  if (lower) {
    max[axis] = Math.min(world.max[axis], x0);
    tags[axis][1] = tag;
  } else {
    min[axis] = Math.max(world.min[axis], x0);
    tags[axis][0] = tag;
  }
  return { kind: "box", min, max, tags };
}

/**
 * The interior solid #interior builds for a sphere or an axis cylinder:
 * { kind: "sphere", center, r, tag } or { kind: "cylinder", axis, center
 * (the two other coordinates), r, lo, hi (the world's extent), tag }.
 */
function interiorForm(s, world, tag) {
  const c = s.coeffs;
  if (s.type === "sphere") return { kind: "sphere", center: c.slice(0, 3), r: c[3], tag };
  if (s.type === "x-cylinder" || s.type === "y-cylinder" || s.type === "z-cylinder") {
    const axis = axisOf(s.type);
    return { kind: "cylinder", axis, center: [c[0], c[1]], r: c[2], lo: world.min[axis], hi: world.max[axis], tag };
  }
  return null;
}

/**
 * Whether the tessellated sphere `a` lies strictly inside the tessellated
 * sphere `b`. Concentric spheres with the same tessellation are scaled copies
 * of each other, so a smaller radius is enough; otherwise `a` must clear the
 * facets of `b`, which sit up to (1 − cos²(π/segments))·r inside its sphere.
 */
function sphereWithin(a, b, segments) {
  const d = Math.hypot(...a.center.map((v, i) => v - b.center[i]));
  const eps = 1e-12 * Math.max(1, b.r);
  if (d <= eps) return a.r < b.r - eps;
  const facet = Math.cos(Math.PI / segments) ** 2;
  return d + a.r < b.r * facet - eps;
}

/** Whether two spheres (and so their inscribed tessellations) are strictly apart. */
const spheresApart = (a, b) => Math.hypot(...a.center.map((v, i) => v - b.center[i])) > a.r + b.r;

const EMPTY = Object.freeze({ key: "∅", solid: null, inverted: false });
const FULL = Object.freeze({ key: "𝕌", solid: null, inverted: true });

const boxKey = (b) => JSON.stringify([b.min, b.max]);
/** Complement of a value. */
const flip = (v) => (v.solid ? { ...v, key: `~${v.key}`, inverted: !v.inverted } : v.inverted ? EMPTY : FULL);

/**
 * Evaluates the scene into wasm solids. Every solid is created through a
 * memo keyed by structure (node data, transform, world box), so edits only
 * recompute what changed, undo is free, and universes instantiated with the
 * same local clip box share results. Solids not used in a pass are disposed.
 */
export class Evaluator {
  /** `fastPaths: false` always uses the general booleans (for tests). */
  constructor(geo, { fastPaths = true } = {}) {
    this.geo = geo;
    this.fastPaths = fastPaths;
    this.cache = new Map();
    this.used = null;
    this.refDepth = 0;
  }

  /**
   * Returns:
   *  parts   Map<node id, Part[]>  for root items and every visited cell
   *  solids  Map<node id, Solid>   materialized results for `focus` nodes and root items
   *  values  Map<node id, Value>
   *  errors  Map<node id, string>
   *  world   the resolved world box
   *  surfaces  Map<key, Solid | null>  for each requested `surfaces` entry
   *          ({ key, surface, tag }): the inside of that surface around the
   *          world box. Its faces off the world box are the surface itself.
   * Part = { key, solid, tag?, source? }  (tag = owning cell id; source = the
   * same solid with its leaf tags, when the part's faces were re-tagged). Solids are owned by the
   * evaluator: do not dispose them.
   */
  run(scene, { focus = [], surfaces = [] } = {}) {
    this.scene = scene;
    this.used = new Map();
    const world = scene.resolveWorld();
    const out = { parts: new Map(), solids: new Map(), values: new Map(), errors: new Map(), world, surfaces: new Map() };
    this.out = out;
    const ctx = this.#ctx(world, []);
    try {
      for (const node of scene.roots) {
        if (!node.enabled) continue;
        out.parts.set(node.id, this.#itemParts(node, ctx));
      }
      for (const id of focus) {
        if (out.solids.has(id)) continue;
        const node = scene.find(id)?.node;
        if (!node || !node.enabled) continue;
        if (isUniverse(node)) {
          out.parts.set(id, this.#universeParts(node, this.#ctx(world, [node.id])));
        } else if (isRegionNode(node) && out.values.has(id)) {
          const { value, ctx: c } = out.values.get(id);
          const m = this.#materialize(value, c);
          if (m) out.solids.set(id, m.solid);
        }
      }
      for (const { key, surface, tag } of surfaces) {
        try {
          out.surfaces.set(key, this.#surfaceSide(surface, "-", ctx, tag, `srf${tag}:`).solid ?? null);
        } catch {
          out.surfaces.set(key, null);
        }
      }
    } finally {
      for (const [key, solid] of this.cache) if (!this.used.has(key)) solid?.dispose();
      this.cache = this.used;
      this.used = null;
    }
    return out;
  }

  dispose() {
    for (const solid of this.cache.values()) solid?.dispose();
    this.cache.clear();
  }

  #memo(key, build) {
    if (this.used.has(key)) return this.used.get(key);
    const solid = this.cache.has(key) ? this.cache.get(key) : build();
    this.used.set(key, solid);
    return solid;
  }

  /** Tessellation of curved surfaces (slices; spheres use half as many stacks). */
  get segments() {
    return Math.max(8, Math.round(this.scene.world.segments ?? 48));
  }

  #ctx(world, stack) {
    const segments = this.segments;
    return { world, stack, segments, key: boxKey(world) + segments };
  }

  #worldSolid(ctx) {
    const { min, max } = ctx.world;
    return this.#memo(`W${ctx.key}`, () => this.geo.cube({ center: min.map((v, i) => (v + max[i]) / 2), size: max.map((v, i) => v - min[i]) }));
  }

  // ---- items, cells, universes ----

  #itemParts(node, ctx) {
    if (isCell(node)) return this.#cellParts(node, ctx);
    const value = this.#value(node, ctx);
    const m = value && this.#materialize(value, ctx);
    if (!m) return [];
    if (ctx.stack.length === 0) this.out.solids.set(node.id, m.solid);
    return [{ key: m.key, solid: m.solid }];
  }

  #universeParts(universe, ctx) {
    return universe.children.filter((n) => n.enabled).flatMap((n) => this.#itemParts(n, ctx));
  }

  #cellParts(cell, ctx) {
    try {
      const regionNode = cell.children.find((c) => c.enabled);
      const value = regionNode ? this.#value(regionNode, ctx) : FULL;
      const region = this.#materialize(value, ctx);
      let parts = [];
      if (region) {
        if (cell.fill.type === "universe") parts = this.#fillParts(cell, region, ctx);
        else {
          const key = `tag${cell.id}|${region.key}`;
          // `source` keeps the faces' original tags (the leaves that made them) for picking.
          parts = [{ key, solid: this.#memo(key, () => region.solid.tag(cell.id)), tag: cell.id, source: region.solid }];
        }
      }
      if (!this.out.parts.has(cell.id)) this.out.parts.set(cell.id, parts);
      return parts;
    } catch (e) {
      this.out.errors.set(cell.id, e.message ?? String(e));
      return [];
    }
  }

  #fillParts(cell, region, ctx) {
    const target = this.scene.find(cell.fill.universe)?.node;
    if (!target || !isUniverse(target)) throw new Error("fill references a missing universe");
    if (ctx.stack.includes(target.id)) throw new Error(`universe "${target.name}" contains itself`);
    const m = M4.fromTransform({ order: "zyx", ...cell.transform });
    const identity = isIdentity(cell.transform);
    const mKey = JSON.stringify(cell.transform);
    const b = region.solid.bounds;
    const local = identity ? b : M4.transformBox(M4.invert(m), b);
    const inner = this.#universeParts(target, this.#ctx(local, [...ctx.stack, target.id]));
    const parts = [];
    for (const p of inner) {
      const tKey = identity ? p.key : `T${mKey}${p.key}`;
      const moved = identity ? p.solid : this.#memo(tKey, () => p.solid.transform(m));
      // Tag the clipping region like the part so cut faces keep the inner cell's colour.
      const clipKey = p.tag ? `tag${p.tag}|${region.key}` : region.key;
      const clip = p.tag ? this.#memo(clipKey, () => region.solid.tag(p.tag)) : region.solid;
      const key = `∩${clipKey}|${tKey}`;
      const solid = this.#memo(key, () => moved.intersect(clip));
      if (!solid.isEmpty) parts.push({ key, solid, tag: p.tag });
    }
    return parts;
  }

  // ---- region values ----

  /**
   * A node's value, or undefined when it is disabled. `viaRef`: reached through
   * a reference, which uses its source even when the source is disabled
   * (disabling a top-level shape hides it without breaking its references).
   */
  #value(node, ctx, viaRef = false) {
    if (!node.enabled && !viaRef) return undefined;
    let value;
    try {
      value = this.#computeValue(node, ctx);
    } catch (e) {
      this.out.errors.set(node.id, e.message ?? String(e));
      value = EMPTY;
    }
    if (!this.out.values.has(node.id)) this.out.values.set(node.id, { value, ctx });
    return value;
  }

  #computeValue(node, ctx) {
    const identity = isIdentity(node.transform);
    const m = identity ? null : M4.fromTransform(node.transform);
    const tKey = identity ? "" : JSON.stringify(node.transform);
    // Children of a transformed node are built in its local frame, bounded by
    // the world box mapped into that frame.
    const local = identity ? ctx : this.#ctx(M4.transformBox(M4.invert(m), ctx.world), ctx.stack);

    let value;
    if (isPrimitive(node)) {
      const key = `${node.kind}#${node.id}${JSON.stringify(node.params)}${tKey}`;
      return { key, solid: this.#memo(key, () => this.#primitive(node, m)), inverted: false };
    }
    if (node.kind === "ref") {
      const target = this.scene.find(node.params.target)?.node;
      if (!target) throw new Error("the referenced node no longer exists");
      if (this.refDepth > MAX_REF_DEPTH) throw new Error("reference cycle");
      this.refDepth++;
      try {
        value = this.#value(target, local, true) ?? EMPTY;
      } finally {
        this.refDepth--;
      }
    } else if (node.kind === "halfspace") {
      value = this.#halfspace(node, local);
    } else if (node.kind === "composite") {
      value = this.#composite(node, local);
    } else {
      const kids = node.children.map((c) => this.#value(c, local)).filter(Boolean);
      value = this.#combine(node.kind, kids);
    }
    return m ? this.#transformValue(value, m, tKey) : value;
  }

  #transformValue(v, m, tKey) {
    if (!v.solid) return v;
    const key = `T${tKey}${v.key}`;
    return { key, solid: this.#memo(key, () => v.solid.transform(m)), inverted: v.inverted };
  }

  #combine(kind, kids) {
    switch (kind) {
      case "complement":
        return kids.length ? flip(kids[0]) : EMPTY;
      case "subtract":
        if (!kids.length) return EMPTY;
        return this.#intersect([kids[0], ...kids.slice(1).map(flip)]);
      case "intersect":
        return kids.length ? this.#intersect(kids) : EMPTY;
      case "union":
        return this.#union(kids);
    }
    return EMPTY;
  }

  #setOp(op, solids, keys) {
    if (solids.length === 1) return { key: keys[0], solid: solids[0] };
    const key = `${op}(${keys.join(",")})`;
    return { key, solid: this.#memo(key, () => solids[0][op](...solids.slice(1))) };
  }

  /** ∩P − ∪N, where P are plain values and N inverted ones. */
  #intersect(vals) {
    if (vals.some((v) => !v.inverted && !v.solid)) return EMPTY;
    const P = vals.filter((v) => !v.inverted && v.solid);
    const N = vals.filter((v) => v.inverted && v.solid);
    if (!P.length && !N.length) return FULL;
    if (!P.length) {
      // ∩~Nᵢ = ~∪Nᵢ
      const u = this.#setOp("union", N.map((v) => v.solid), N.map((v) => v.key));
      return { ...u, inverted: true };
    }
    const nested = this.#nestedIntersect(P, N);
    if (nested) return nested;
    const p = this.#setOp("intersect", P.map((v) => v.solid), P.map((v) => v.key));
    if (!N.length) return { ...p, inverted: false };
    const key = `sub(${p.key};${N.map((v) => v.key).join(",")})`;
    return { key, solid: this.#memo(key, () => p.solid.subtract(...N.map((v) => v.solid))), inverted: false };
  }

  /**
   * ∩P − ∪N with fewer (or no) booleans where boundaries cannot cross, from
   * the analytic forms of the operands; null when nothing applies (the caller
   * then uses the general BSP path, quadratic in the polygon count):
   * - spheres: nested P spheres reduce to the innermost; N spheres strictly
   *   inside it and apart from each other are merged in inverted (a shell is
   *   the outer sphere plus the inner one turned inside out);
   * - coaxial cylinders and axis boxes (planes): an annulus between the
   *   largest N and the smallest P cylinder, cut along the axis by the boxes,
   *   generated directly with the cylinders' own ring vertices.
   * The other operands are then applied with the general booleans. A merged
   * shell is only used when they are all subtractions (a channel through
   * it): other P operands, such as a plane cutting the shell, are cheaper to
   * apply to the outer sphere first, as the general path does, because the
   * BSP is quadratic in the polygon count and a cut halves it.
   */
  #nestedIntersect(P, N) {
    if (!this.fastPaths || !P.length) return null;
    const segs = this.segments;
    const kind = (v) => v.form?.kind;
    const keyOf = (ps, ns) => `nest(${ps.map((v) => v.key).join(",")};${ns.map((v) => v.key).join(",")})`;
    const rest = (used) => [...P, ...N].filter((v) => !used.includes(v));
    /** The fast part, then the rest through #intersect (general: the part has no form). */
    const finish = (part, used) => {
      const others = rest(used);
      return others.length ? this.#intersect([part, ...others]) : part;
    };

    // Spheres.
    const sphereP = P.filter((v) => kind(v) === "sphere");
    if (sphereP.length) {
      const inner = sphereP.find((a) => sphereP.every((b) => b === a || sphereWithin(a.form, b.form, segs)));
      const otherP = P.filter((v) => kind(v) !== "sphere");
      if (inner && !otherP.length) {
        const holes = [];
        for (const n of N) if (kind(n) === "sphere" && sphereWithin(n.form, inner.form, segs) && holes.every((h) => spheresApart(h.form, n.form))) holes.push(n);
        if (holes.length || sphereP.length > 1 || rest([...sphereP]).length === 0) {
          let part;
          if (!holes.length) part = { key: inner.key, solid: inner.solid, inverted: false };
          else {
            const key = keyOf([inner], holes);
            const solid = this.#memo(key, () => {
              const inverted = holes.map((n) => n.solid.inverse());
              const out = inner.solid.merge(...inverted);
              inverted.forEach((x) => x.dispose());
              return out;
            });
            part = { key, solid, inverted: false };
          }
          return finish(part, [...sphereP, ...holes]);
        }
      }
    }

    // Coaxial cylinders cut by axis boxes.
    const firstCyl = P.find((v) => kind(v) === "cylinder");
    if (!firstCyl) return null;
    const { axis: k, center } = firstCyl.form;
    const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    const coaxial = (v) => kind(v) === "cylinder" && v.form.axis === k && close(v.form.center[0], center[0]) && close(v.form.center[1], center[1]);
    const cylP = P.filter(coaxial);
    const cylN = N.filter(coaxial);
    const outer = cylP.map((v) => v.form).reduce((a, b) => (b.r < a.r ? b : a));
    const inner = cylN.map((v) => v.form).reduce((a, b) => (b.r > a.r ? b : a), { r: 0, tag: 0 });
    const [i, j] = [0, 1, 2].filter((a) => a !== k);
    const [ci, cj] = center;
    // Boxes holding the whole disk shorten the annulus; others stay as operands.
    const boxes = P.filter((v) => kind(v) === "box" && v.form.min[i] <= ci - outer.r && v.form.max[i] >= ci + outer.r && v.form.min[j] <= cj - outer.r && v.form.max[j] >= cj + outer.r);
    if (cylP.length + cylN.length + boxes.length < 2) return null; // a lone cylinder: nothing to save
    if (!(inner.r < outer.r)) return EMPTY;
    let [z0, tag0, z1, tag1] = [outer.lo, outer.tag, outer.hi, outer.tag];
    for (const { form: b } of boxes) {
      if (b.min[k] > z0) [z0, tag0] = [b.min[k], b.tags[k][0] ?? outer.tag];
      if (b.max[k] < z1) [z1, tag1] = [b.max[k], b.tags[k][1] ?? outer.tag];
    }
    if (!(z1 > z0)) return EMPTY;
    const at = (z) => {
      const p = [0, 0, 0];
      p[k] = z;
      p[i] = ci;
      p[j] = cj;
      return p;
    };
    const used = [...cylP, ...cylN, ...boxes];
    const key = keyOf([...cylP, ...boxes], cylN);
    const solid = this.#memo(key, () =>
      this.geo.tube({ start: at(z0), end: at(z1), innerRadius: inner.r, radius: outer.r, slices: segs, tags: { outer: outer.tag, inner: inner.tag, start: tag0, end: tag1 } }),
    );
    if (solid.isEmpty) return EMPTY;
    return finish({ key, solid, inverted: false }, used);
  }

  /** ∪P ∪ ∪~Nᵢ = ~(∩Nᵢ − ∪P). */
  #union(vals) {
    if (vals.some((v) => v.inverted && !v.solid)) return FULL;
    const P = vals.filter((v) => !v.inverted && v.solid);
    const N = vals.filter((v) => v.inverted && v.solid);
    if (!N.length) {
      if (!P.length) return EMPTY;
      return { ...this.#setOp("union", P.map((v) => v.solid), P.map((v) => v.key)), inverted: false };
    }
    const n = this.#setOp("intersect", N.map((v) => v.solid), N.map((v) => v.key));
    if (!P.length) return { ...n, inverted: true };
    const key = `sub(${n.key};${P.map((v) => v.key).join(",")})`;
    return { key, solid: this.#memo(key, () => n.solid.subtract(...P.map((v) => v.solid))), inverted: true };
  }

  /** Turns a value into a finite solid inside the world box (null when empty). */
  #materialize(v, ctx) {
    let key;
    let solid;
    if (!v.inverted) {
      if (!v.solid) return null;
      const b = v.solid.bounds;
      if (!b) return null;
      const eps = 1e-9 * Math.max(1, ...ctx.world.max.map((x, i) => x - ctx.world.min[i]));
      const inside = b.min.every((x, i) => x >= ctx.world.min[i] - eps) && b.max.every((x, i) => x <= ctx.world.max[i] + eps);
      if (inside) return { key: v.key, solid: v.solid };
      key = `${v.key}∩W${ctx.key}`;
      solid = this.#memo(key, () => v.solid.intersect(this.#worldSolid(ctx)));
    } else if (!v.solid) {
      key = `W${ctx.key}`;
      solid = this.#worldSolid(ctx);
    } else {
      key = `W${ctx.key}−${v.key}`;
      solid = this.#memo(key, () => this.#worldSolid(ctx).subtract(v.solid));
    }
    return solid && !solid.isEmpty ? { key, solid } : null;
  }

  // ---- leaves ----

  #primitive(node, m) {
    const { geo } = this;
    const p = node.params;
    const ends = (h) => ({ start: [0, -h / 2, 0], end: [0, h / 2, 0] });
    const count = (n, min) => Math.max(min, Math.round(n));
    let solid;
    switch (node.kind) {
      case "cube":
        solid = geo.cube({ size: p.size });
        break;
      case "sphere":
        solid = geo.sphere({ radius: p.radius, slices: count(p.slices, 3), stacks: count(p.stacks, 2) });
        break;
      case "cylinder": {
        // Centred on the origin along the chosen axis.
        const k = AXIS_INDEX[p.axis] ?? 1;
        const start = [0, 0, 0];
        const end = [0, 0, 0];
        start[k] = -p.height / 2;
        end[k] = p.height / 2;
        solid = geo.cylinder({ start, end, radius: p.radius, slices: count(p.slices, 3) });
        break;
      }
      case "cone":
        solid = geo.cone({ ...ends(p.height), radius: p.radius, slices: count(p.slices, 3) });
        break;
      case "torus":
        solid = geo.torus({ major: p.major, minor: p.minor, segments: count(p.segments, 3), rings: count(p.rings, 3) });
        break;
    }
    return this.#finish(solid, node.id, m);
  }

  /** Tags (and optionally transforms) a freshly built solid, consuming it. */
  #finish(solid, tag, m) {
    const tagged = solid.tag(tag);
    solid.dispose();
    if (!m) return tagged;
    const moved = tagged.transform(m);
    tagged.dispose();
    return moved;
  }

  #halfspace(node, ctx) {
    const surface = this.scene.surfaces.get(node.params.surface);
    if (!surface) throw new Error(`surface ${node.params.surface} does not exist`);
    return this.#surfaceSide(surface, node.params.sense, ctx, node.id, `hs#${node.id}`);
  }

  /** A composite's value: its region over generated surfaces, faces tagged with the node. */
  #composite(node, ctx) {
    const { surfaces, region } = compositeExpansion(node);
    const toValue = (ast) => {
      switch (ast.op) {
        case "half":
          return this.#surfaceSide(surfaces[ast.surface], ast.sense, ctx, node.id, `cs#${node.id}`);
        case "and":
          return this.#intersect(ast.args.map(toValue));
        case "or":
          return this.#union(ast.args.map(toValue));
        case "not":
          return flip(toValue(ast.arg));
      }
      throw new Error(`bad region node ${ast.op}`);
    };
    const inside = toValue(region);
    return node.params.sense === "+" ? flip(inside) : inside;
  }

  /** One side of a surface inside the context's world box. */
  #surfaceSide(surface, sense, ctx, tag, keyBase) {
    const neg = sense === "-";
    const key = `${keyBase}${JSON.stringify([surface.type, surface.coeffs])}${sense}@${ctx.key}`;
    const c = surface.coeffs;

    // Planes: build the clipped side directly.
    let plane = null;
    if (isPlane(surface.type) && surface.type !== "plane") {
      const n = [0, 0, 0];
      n[axisOf(surface.type)] = 1;
      plane = { n, d: c[0] };
    } else if (surface.type === "plane") {
      plane = { n: [c[0], c[1], c[2]], d: c[3] };
    }
    if (plane) {
      const solid = this.#memo(key, () => this.#planeSide(plane, neg, ctx, tag));
      return solid ? { key, solid, inverted: false, form: planeBoxForm(plane, neg, ctx.world, tag) } : EMPTY;
    }

    // Closed or tubular surfaces: build the interior; the positive side is its complement.
    let interiorIsNegative = true;
    let shape = null;
    if (surface.type === "quadric") {
      shape = classifyQuadric(c);
      interiorIsNegative = shape.sign > 0;
    }
    const solid = this.#memo(key, () => this.#interior(surface, shape, ctx, tag));
    if (!solid) return neg === interiorIsNegative ? EMPTY : FULL;
    return { key, solid, inverted: neg !== interiorIsNegative, form: interiorForm(surface, ctx.world, tag) };
  }

  #planeSide({ n, d }, neg, ctx, tag) {
    const { geo } = this;
    const { min, max } = ctx.world;
    const len = Math.hypot(...n);
    if (len === 0) throw new Error("plane normal is zero");
    const u = n.map((v) => v / len);
    const dn = d / len;
    const axis = u.findIndex((v) => Math.abs(Math.abs(v) - 1) < 1e-12);
    if (axis >= 0) {
      // Axis-aligned: an exact sub-box of the world.
      const x0 = dn * Math.sign(u[axis]);
      const lower = neg === u[axis] > 0; // keep x < x0
      const lo = [...min];
      const hi = [...max];
      if (lower) hi[axis] = Math.min(max[axis], x0);
      else lo[axis] = Math.max(min[axis], x0);
      if (hi[axis] - lo[axis] <= 1e-12) return null;
      return this.#finish(geo.cube({ center: lo.map((v, i) => (v + hi[i]) / 2), size: hi.map((v, i) => v - lo[i]) }), tag);
    }
    // Oblique: a large box beside the plane, clipped to the world.
    const center = min.map((v, i) => (v + max[i]) / 2);
    const diag = Math.hypot(...max.map((v, i) => v - min[i]));
    const L = 4 * diag + 1;
    const off = u[0] * center[0] + u[1] * center[1] + u[2] * center[2] - dn;
    const c0 = center.map((v, i) => v - u[i] * off);
    const side = neg ? -1 : 1;
    const t = c0.map((v, i) => v + (side * u[i] * L) / 2);
    const a = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const e1 = normalize(cross(a, u));
    const e2 = cross(u, e1);
    const frame = [...e1, 0, ...e2, 0, ...u, 0, ...t, 1];
    const box = this.#finish(geo.cube({ size: L }), tag, frame);
    const clipped = box.intersect(this.#worldSolid(ctx));
    box.dispose();
    if (clipped.isEmpty) {
      clipped.dispose();
      return null;
    }
    return clipped;
  }

  /** The bounded interior of a non-planar surface, large enough to cover the world box. */
  #interior(s, shape, ctx, tag) {
    const { geo } = this;
    const { min, max } = ctx.world;
    const segs = ctx.segments;
    const c = s.coeffs;
    const type = s.type;
    const reach = (p) => Math.hypot(...[0, 1, 2].map((i) => Math.max(Math.abs(min[i] - p[i]), Math.abs(max[i] - p[i])))) * 1.01 + 1e-9;

    if (type === "sphere") {
      return this.#finish(geo.sphere({ center: c.slice(0, 3), radius: c[3], slices: segs, stacks: Math.ceil(segs / 2) }), tag);
    }
    if (type.endsWith("cylinder")) {
      const k = axisOf(type);
      const center = [0, 0, 0];
      const [i, j] = [0, 1, 2].filter((a) => a !== k);
      center[i] = c[0];
      center[j] = c[1];
      const start = [...center];
      const end = [...center];
      start[k] = min[k];
      end[k] = max[k];
      return this.#finish(geo.cylinder({ start, end, radius: c[2], slices: segs }), tag);
    }
    if (type.endsWith("cone")) {
      const k = axisOf(type);
      const apex = c.slice(0, 3);
      const slope = Math.sqrt(c[3]);
      const nappes = [];
      for (const [limit, dir] of [
        [max[k], 1],
        [min[k], -1],
      ]) {
        const len = (limit - apex[k]) * dir;
        if (len <= 1e-12) continue;
        const base = [...apex];
        base[k] += dir * len;
        nappes.push(geo.cone({ start: base, end: apex, radius: slope * len, slices: segs }));
      }
      if (!nappes.length) return null;
      const both = nappes.length === 1 ? nappes[0] : nappes[0].union(nappes[1]);
      if (nappes.length > 1) nappes.forEach((n) => n.dispose());
      return this.#finish(both, tag);
    }
    if (type.endsWith("torus")) {
      const k = axisOf(type);
      const [, , , A, B, C] = c;
      // Builder tori are Y-axis; an axial scale makes the tube elliptical (B axial, C radial).
      const rot = k === 0 ? M4.rotationAxis(2, -90) : k === 2 ? M4.rotationAxis(0, 90) : M4.IDENTITY;
      const m = M4.compose(M4.translation(c.slice(0, 3)), rot, M4.scaling([1, B / C, 1]));
      return this.#finish(geo.torus({ major: A, minor: C, segments: segs, rings: Math.ceil(segs / 2) }), tag, m);
    }
    if (type === "quadric") {
      // basis: rows = world axes, columns = principal axes.
      const col = (j, s = 1) => [shape.basis[0][j] * s, shape.basis[1][j] * s, shape.basis[2][j] * s, 0];
      if (shape.kind === "ellipsoid") {
        const m = [...col(0, shape.semi[0]), ...col(1, shape.semi[1]), ...col(2, shape.semi[2]), ...shape.center, 1];
        return this.#finish(geo.sphere({ radius: 1, slices: segs, stacks: Math.ceil(segs / 2) }), tag, m);
      }
      const a = shape.axis;
      const [o1, o2] = [0, 1, 2].filter((j) => j !== a);
      const L = reach(shape.center);
      const m = [...col(o1, shape.semi[o1]), ...col(a), ...col(o2, shape.semi[o2]), ...shape.center, 1];
      if (shape.kind === "cylinder") {
        return this.#finish(geo.cylinder({ start: [0, -L, 0], end: [0, L, 0], radius: 1, slices: segs }), tag, m);
      }
      // Cone: unit-slope double cone in the local frame.
      const up = geo.cone({ start: [0, L, 0], end: [0, 0, 0], radius: L, slices: segs });
      const down = geo.cone({ start: [0, -L, 0], end: [0, 0, 0], radius: L, slices: segs });
      const both = up.union(down);
      up.dispose();
      down.dispose();
      return this.#finish(both, tag, m);
    }
    throw new Error(`unsupported surface type ${type}`);
  }
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};

/** Concatenates meshes from `Solid.toMesh()` into one. */
export function mergeMeshes(meshes) {
  const total = (k) => meshes.reduce((n, m) => n + m[k].length, 0);
  const out = {
    positions: new Float32Array(total("positions")),
    normals: new Float32Array(total("normals")),
    tags: new Uint32Array(total("tags")),
    indices: new Uint32Array(total("indices")),
  };
  let v = 0;
  let i = 0;
  for (const m of meshes) {
    out.positions.set(m.positions, v * 3);
    out.normals.set(m.normals, v * 3);
    out.tags.set(m.tags, v);
    for (let k = 0; k < m.indices.length; k++) out.indices[i + k] = m.indices[k] + v;
    v += m.tags.length;
    i += m.indices.length;
  }
  return out;
}

/** Axis-aligned bounds of a mesh, or null when empty. */
export function meshBounds(mesh) {
  const p = mesh.positions;
  if (p.length === 0) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < p.length; k += 3) {
    for (let a = 0; a < 3; a++) {
      if (p[k + a] < min[a]) min[a] = p[k + a];
      if (p[k + a] > max[a]) max[a] = p[k + a];
    }
  }
  return { min, max };
}
