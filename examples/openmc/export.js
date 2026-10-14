// Scene → OpenMC geometry.xml (and model.xml when the scene came from one).
//
// Every region node compiles to a region expression over analytic surfaces:
// primitives use their exact surfaces (not their facets), node transforms are
// applied exactly to the surfaces and simplified back to the most specific
// OpenMC type, and duplicate surfaces are merged.
//
// Cells are exported as-is. Other top-level shapes become void cells with
// priority: an earlier item wins where it overlaps a later one (OpenMC cells
// must not overlap; imported cells are assumed not to overlap each other).

import { settingsWithSources } from "../source/source.js";
import { element, xmlDocument, getText } from "./xml.js";
import { formatRegion } from "./region.js";
import { toForm, fromForm, transformForm, clean } from "./surfaces.js";
import { isCell, isUniverse, isPrimitive, isOperation, isIdentity, completeBox, compositeExpansion } from "../scene.js";
import { latticeUniverseIds } from "./import.js";
import * as M4 from "../mat4.js";
import { materialsElement } from "../materials/material.js";

const EMPTY = { op: "empty" };
const FULL = { op: "full" };

const and = (args) => {
  if (args.some((a) => a.op === "empty")) return EMPTY;
  const rest = args.filter((a) => a.op !== "full").flatMap((a) => (a.op === "and" ? a.args : [a]));
  return rest.length === 0 ? FULL : rest.length === 1 ? rest[0] : { op: "and", args: rest };
};
const or = (args) => {
  if (args.some((a) => a.op === "full")) return FULL;
  const rest = args.filter((a) => a.op !== "empty").flatMap((a) => (a.op === "or" ? a.args : [a]));
  return rest.length === 0 ? EMPTY : rest.length === 1 ? rest[0] : { op: "or", args: rest };
};
const not = (a) => (a.op === "empty" ? FULL : a.op === "full" ? EMPTY : a.op === "not" ? a.arg : a.op === "half" ? { ...a, sense: a.sense === "-" ? "+" : "-" } : { op: "not", arg: a });

/** Local surfaces of a primitive: [surface, sense] pairs whose intersection is the solid. */
export function primitiveSurfaces(node) {
  const p = node.params;
  switch (node.kind) {
    case "cube": {
      const [x, y, z] = p.size.map((s) => s / 2);
      return [
        [{ type: "x-plane", coeffs: [-x] }, "+"],
        [{ type: "x-plane", coeffs: [x] }, "-"],
        [{ type: "y-plane", coeffs: [-y] }, "+"],
        [{ type: "y-plane", coeffs: [y] }, "-"],
        [{ type: "z-plane", coeffs: [-z] }, "+"],
        [{ type: "z-plane", coeffs: [z] }, "-"],
      ];
    }
    case "sphere":
      return [[{ type: "sphere", coeffs: [0, 0, 0, p.radius] }, "-"]];
    case "cylinder": {
      const a = p.axis ?? "y";
      return [
        [{ type: `${a}-cylinder`, coeffs: [0, 0, p.radius] }, "-"],
        [{ type: `${a}-plane`, coeffs: [-p.height / 2] }, "+"],
        [{ type: `${a}-plane`, coeffs: [p.height / 2] }, "-"],
      ];
    }
    case "cone":
      // Builder cones have their base at -h/2 and apex at +h/2.
      return [
        [{ type: "y-cone", coeffs: [0, p.height / 2, 0, (p.radius / p.height) ** 2] }, "-"],
        [{ type: "y-plane", coeffs: [-p.height / 2] }, "+"],
        [{ type: "y-plane", coeffs: [p.height / 2] }, "-"],
      ];
    case "torus":
      return [[{ type: "y-torus", coeffs: [0, 0, 0, p.major, p.minor, p.minor] }, "-"]];
  }
  throw new Error(`cannot export ${node.kind}`);
}

const fmt = (v) => String(clean(v, Math.abs(v)));

export function exportOpenMC(scene, { worldBoundary = "auto" } = {}) {
  const warnings = [];
  const out = new Map(); // id → surface written to the file
  const byKey = new Map(); // canonical key → id
  let nextSurface = Math.max(0, ...scene.surfaces.keys()) + 1;
  const keyOf = (s) => `${s.type}|${s.coeffs.join(" ")}|${s.boundary ?? "transmission"}|${s.albedo ?? ""}`;
  for (const s of scene.surfaces.values()) if (!byKey.has(keyOf(s))) byKey.set(keyOf(s), s.id);

  /** Registers a surface (transformed by m) and returns a half-space AST. */
  const halfspace = (surface, sense, m, originalId = null) => {
    if (originalId != null && M4.isIdentityMatrix(m)) {
      out.set(originalId, scene.surfaces.get(originalId));
      return { op: "half", surface: originalId, sense };
    }
    const t = fromForm(M4.isIdentityMatrix(m) ? toForm(surface) : transformForm(toForm(surface), m));
    const s = { type: t.type, coeffs: t.coeffs, boundary: surface.boundary ?? "transmission" };
    if (surface.albedo !== undefined) s.albedo = surface.albedo;
    const key = keyOf(s);
    let id = byKey.get(key);
    if (id === undefined) {
      id = nextSurface++;
      byKey.set(key, id);
    }
    if (!out.has(id)) out.set(id, scene.surfaces.get(id) ?? { ...s, id });
    return { op: "half", surface: id, sense: t.flip ? (sense === "-" ? "+" : "-") : sense };
  };

  let refDepth = 0;
  /**
   * Compiles a region node into an AST, with `m` the transform of its parent
   * frame. A reference compiles its source even when the source is disabled.
   */
  const compile = (node, m, viaRef = false) => {
    if (!node.enabled && !viaRef) return null;
    const local = isIdentity(node.transform) ? m : M4.multiply(m, M4.fromTransform(node.transform));
    if (node.kind === "halfspace") {
      const s = scene.surfaces.get(node.params.surface);
      if (!s) throw new Error(`"${node.name}": surface ${node.params.surface} does not exist`);
      return halfspace(s, node.params.sense, local, s.id);
    }
    if (node.kind === "ref") {
      const target = scene.find(node.params.target)?.node;
      if (!target) throw new Error(`"${node.name}": the referenced node no longer exists`);
      if (refDepth > 64) throw new Error(`"${node.name}": reference cycle`);
      refDepth++;
      try {
        // Same surfaces as the source (merged by the surface dedupe).
        return compile(target, local, true) ?? EMPTY;
      } finally {
        refDepth--;
      }
    }
    if (node.kind === "composite") {
      let expansion;
      try {
        expansion = compositeExpansion(node);
      } catch (e) {
        throw new Error(`"${node.name}": ${e.message}`);
      }
      const { surfaces, region } = expansion;
      // Emit each component surface once; `flip` records sense swaps from canonicalization.
      const emitted = surfaces.map((cs) => halfspace(cs, "-", local));
      surfaces.forEach((cs, i) => {
        if (cs.periodic === undefined) return;
        const id = emitted[i].surface;
        out.set(id, { ...out.get(id), periodic: emitted[cs.periodic].surface });
      });
      const map = (ast) => {
        switch (ast.op) {
          case "half": {
            const e = emitted[ast.surface];
            return { op: "half", surface: e.surface, sense: ast.sense === "-" ? e.sense : e.sense === "-" ? "+" : "-" };
          }
          case "and":
            return and(ast.args.map(map));
          case "or":
            return or(ast.args.map(map));
          case "not":
            return not(map(ast.arg));
        }
        throw new Error(`bad region node ${ast.op}`);
      };
      const inside = map(region);
      return node.params.sense === "+" ? not(inside) : inside;
    }
    if (isPrimitive(node)) {
      try {
        return and(primitiveSurfaces(node).map(([s, sense]) => halfspace(s, sense, local)));
      } catch (e) {
        throw new Error(`"${node.name}": ${e.message}`);
      }
    }
    if (isOperation(node)) {
      const kids = node.children.map((c) => compile(c, local)).filter(Boolean);
      switch (node.kind) {
        case "union":
          return or(kids);
        case "intersect":
          return kids.length ? and(kids) : EMPTY;
        case "subtract":
          return kids.length ? and([kids[0], ...kids.slice(1).map(not)]) : EMPTY;
        case "complement":
          return kids.length ? not(kids[0]) : EMPTY;
      }
    }
    throw new Error(`"${node.name}" cannot be part of a region`);
  };

  // ---- universes and ids ----
  const rootId = scene.openmc.rootUniverse ?? 0;
  const preserved = scene.openmc.preserved ?? [];
  const usedUniverseIds = new Set([rootId, ...preserved.map((el) => parseInt(getText(el, "id"), 10))]);
  const universeIds = new Map(); // universe node id → OpenMC id
  for (const u of scene.universes) {
    const want = u.openmc?.id;
    if (Number.isInteger(want) && !usedUniverseIds.has(want)) {
      universeIds.set(u.id, want);
      usedUniverseIds.add(want);
    }
  }
  let nextUniverse = Math.max(0, ...usedUniverseIds) + 1;
  for (const u of scene.universes) if (!universeIds.has(u.id)) universeIds.set(u.id, nextUniverse++);

  // Reachability from the root (fills and preserved lattices).
  const byOpenmcId = new Map(scene.universes.map((u) => [universeIds.get(u.id), u]));
  const preservedById = new Map(preserved.map((el) => [parseInt(getText(el, "id"), 10), el]));
  const reachable = new Set();
  const visit = (items) => {
    for (const n of items) {
      if (!isCell(n) || !n.enabled) continue;
      if (n.fill.type === "universe") {
        const u = scene.find(n.fill.universe)?.node;
        if (u && !reachable.has(u.id)) {
          reachable.add(u.id);
          visit(u.children);
        }
      } else if (n.fill.type === "lattice") {
        for (const uid of latticeUniverseIds(preservedById.get(n.fill.id) ?? { attrs: {}, children: [] })) {
          const u = byOpenmcId.get(uid);
          if (u && !reachable.has(u.id)) {
            reachable.add(u.id);
            visit(u.children);
          }
        }
      }
    }
  };
  visit(scene.roots);
  for (const u of scene.universes) if (!reachable.has(u.id)) warnings.push(`Universe "${u.name}" is not used by any cell and was not exported.`);

  const usedCellIds = new Set();
  const usedMaterials = new Set();
  const cellIdFor = (node) => {
    const want = node?.openmc?.id;
    if (Number.isInteger(want) && !usedCellIds.has(want)) {
      usedCellIds.add(want);
      return want;
    }
    return null;
  };

  // ---- cells ----
  const cellEls = [];
  const pendingIds = [];
  const rootRegions = [];
  const emitUniverse = (items, universeId) => {
    const live = items.filter((n) => n.enabled);
    const entries = live.map((n) => {
      const regionNode = isCell(n) ? n.children.find((c) => c.enabled) : n;
      const ast = regionNode ? compile(regionNode, M4.IDENTITY) : FULL;
      return { node: n, ast: ast ?? FULL, auto: !isCell(n), box: isCell(n) ? scene.regionBounds(n) : scene.regionBounds(n) };
    });
    // Priority: shapes (non-cells) win over later items where they overlap.
    entries.forEach((e, i) => {
      const earlier = entries.slice(0, i).filter((o) => (e.auto || o.auto) && boxesOverlap(o.box, e.box));
      if (earlier.length) e.ast = and([e.ast, ...earlier.map((o) => not(o.ast))]);
    });
    for (const e of entries) {
      if (universeId === rootId) rootRegions.push(e.ast);
      if (e.ast.op === "empty") {
        warnings.push(`"${e.node.name}" has an empty region and was skipped.`);
        continue;
      }
      const n = e.node;
      const attrs = { id: undefined, name: n.name };
      if (universeId !== 0) attrs.universe = universeId;
      const t = n.transform;
      if (isCell(n) && n.fill.type === "universe") attrs.fill = universeIds.get(n.fill.universe);
      else if (isCell(n) && (n.fill.type === "lattice" || n.fill.type === "external")) attrs.fill = n.fill.id;
      else attrs.material = isCell(n) ? n.fill.material : "void";
      if (attrs.material) for (const t of String(attrs.material).trim().split(/\s+/)) if (t !== "void") usedMaterials.add(t);
      if (e.ast.op !== "full") attrs.region = formatRegion(e.ast);
      if (isCell(n) && attrs.fill !== undefined) {
        if (t.position.some((v) => v !== 0)) attrs.translation = t.position.map(fmt).join(" ");
        if (t.scale.some((v) => v !== 1)) warnings.push(`Cell "${n.name}": OpenMC fills cannot be scaled; the scale was dropped.`);
        if (t.rotation.some((v) => v !== 0)) {
          const angles = (t.order ?? "zyx") === "zyx" ? t.rotation : M4.rotationToOpenMCAngles(M4.linear3(M4.fromTransform({ ...t, position: [0, 0, 0], scale: [1, 1, 1] })));
          attrs.rotation = angles.map(fmt).join(" ");
        }
      } else if (isCell(n) && !isIdentity(t)) {
        warnings.push(`Cell "${n.name}": a transform only applies to universe fills and was dropped.`);
      }
      Object.assign(attrs, isCell(n) ? n.openmc?.extra : undefined);
      const el = element("cell", attrs);
      const id = cellIdFor(isCell(n) ? n : null);
      if (id != null) el.attrs = { id: String(id), ...el.attrs };
      else pendingIds.push(el);
      cellEls.push(el);
    }
  };

  emitUniverse(scene.roots, rootId);
  for (const u of scene.universes) if (reachable.has(u.id)) emitUniverse(u.children, universeIds.get(u.id));

  // ---- world boundary ----
  const hasBoundary = [...out.values()].some((s) => s.boundary && s.boundary !== "transmission");
  const hasRootItems = scene.roots.some((n) => n.enabled);
  if (hasRootItems && (worldBoundary === true || (worldBoundary === "auto" && !hasBoundary))) {
    const w = scene.resolveWorld();
    const box = completeBox(w);
    const pad = 0.01 * Math.max(...box.max.map((v, i) => v - box.min[i]));
    const planes = [];
    for (let k = 0; k < 3; k++) {
      for (const [v, sense] of [
        [box.min[k] - pad, "+"],
        [box.max[k] + pad, "-"],
      ]) {
        const surface = { type: `${"xyz"[k]}-plane`, coeffs: [clean(v, Math.abs(v))], boundary: "vacuum" };
        planes.push(halfspace(surface, sense, M4.IDENTITY));
      }
    }
    const outside = and([...planes, not(or(rootRegions))]);
    if (outside.op !== "empty") {
      const el = element("cell", { id: undefined, name: "outside", material: "void", universe: rootId !== 0 ? rootId : undefined, region: outside.op === "full" ? undefined : formatRegion(outside) });
      pendingIds.push(el);
      cellEls.push(el);
    }
  }

  let nextCell = Math.max(0, ...usedCellIds) + 1;
  for (const el of pendingIds) {
    const { id: _, ...rest } = el.attrs;
    el.attrs = { id: String(nextCell++), ...rest };
  }

  // ---- surfaces ----
  const surfaceEls = [...out.values()]
    .sort((a, b) => a.id - b.id)
    .map((s) => {
      const attrs = { id: s.id, name: s.name || undefined, type: s.type };
      if (s.boundary && s.boundary !== "transmission") attrs.boundary = s.boundary;
      if (s.albedo !== undefined && s.albedo !== 1) attrs.albedo = s.albedo;
      if (s.periodic !== undefined && s.boundary === "periodic") attrs.periodic_surface_id = s.periodic;
      attrs.coeffs = s.coeffs.map(fmt).join(" ");
      return element("surface", attrs);
    });
  // Periodic partners must be written too.
  for (const s of out.values()) {
    if (s.periodic !== undefined && !out.has(s.periodic) && scene.surfaces.has(s.periodic)) warnings.push(`Periodic partner ${s.periodic} of surface ${s.id} is not used by any cell.`);
  }

  cellEls.sort((a, b) => Number(a.attrs.id) - Number(b.attrs.id));
  const geometry = element("geometry", {}, [...cellEls, ...preserved, ...surfaceEls]);
  const result = { geometry: xmlDocument(geometry), warnings };

  // ---- materials ----
  const library = Object.values(scene.materials ?? {});
  for (const id of usedMaterials) if (!scene.materials?.[id]) warnings.push(`Material ${id} is used by a cell but is not in the material library.`);
  let materialsEl = null;
  if (library.length) {
    try {
      materialsEl = materialsElement(library, scene.openmc.crossSections);
      result.materials = xmlDocument(materialsEl);
    } catch (e) {
      warnings.push(`Materials were not exported: ${e.message}`);
    }
  }

  // ---- model.xml: generated materials + geometry + any other preserved sections ----
  const preservedSections = scene.openmc.model?.sections ?? [];
  const originalMaterials = preservedSections.find((s) => s?.name === "materials");
  const sections = [];
  const matSection = materialsEl ?? originalMaterials ?? null;
  if (matSection) sections.push(matSection);
  sections.push(geometry);
  const settings = settingsFor(scene);
  for (const s of preservedSections) if (s && s.name !== "materials" && s.name !== "geometry" && s.name !== "settings") sections.push(s);
  if (settings.element) sections.splice(sections.indexOf(geometry) + 1, 0, settings.element);
  result.modelWarnings = settings.warnings;
  result.model = xmlDocument(element("model", {}, sections));
  return result;
}

/**
 * The <settings> to export: the opened model's or settings.xml's settings (if
 * any) with their sources replaced by the scene's. { element|null, warnings }.
 */
function settingsFor(scene) {
  const base = (scene.openmc.model?.sections ?? []).find((s) => s?.name === "settings") ?? scene.openmc.settings ?? null;
  const sources = scene.sources ?? [];
  if (!base && !sources.length) return { element: null, warnings: ["model.xml has no <settings> section; add one before running OpenMC."] };
  const warnings = [];
  if (!base) warnings.push("The settings only hold the sources: add a run mode, particles and batches before running OpenMC.");
  return { element: settingsWithSources(base, sources, warnings), warnings };
}

/** settings.xml: the kept settings with the scene's sources (throws when there is nothing to write). */
export function exportSettingsXML(scene) {
  const { element: el, warnings } = settingsFor(scene);
  if (!el) throw new Error("there are no settings or sources to export: add a source in the Source tab");
  return { text: xmlDocument(el), warnings };
}

/** Just the library as materials.xml (throws if a material is invalid). */
export function exportMaterialsXML(scene) {
  const library = Object.values(scene.materials ?? {});
  if (!library.length) throw new Error("the material library is empty");
  return xmlDocument(materialsElement(library, scene.openmc.crossSections));
}

function boxesOverlap(a, b) {
  return a.min.every((v, i) => v < b.max[i] && b.min[i] < a.max[i]);
}
