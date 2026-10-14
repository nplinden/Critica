// OpenMC geometry.xml / model.xml → editable Scene.
//
// Surfaces become the scene's shared surface table; each cell becomes a `cell`
// node whose region expression is converted to half-space / operation nodes.
// Universes other than the root become universe nodes referenced by fills.
// Lattices and DAGMC universes are not modelled yet: their XML is preserved
// verbatim (and written back on export), and cells filled with them are shown
// as placeholders.

import { Scene } from "../scene.js";
import { parseXML, getText, getList, children } from "./xml.js";
import { parseRegion, formatRegion } from "./region.js";
import { validateSurface } from "./surfaces.js";
import { rotationToOpenMCAngles } from "../mat4.js";
import { sourceFromXML } from "../source/source.js";
import { readSettings } from "../settings/settings.js";
import { materialFromXML, normalizeMaterial } from "../materials/material.js";

const BOUNDARY_ALIASES = { transmit: "transmission", reflect: "reflective", reflecting: "reflective", "": "transmission" };
const SYMBOL = { and: "∩", or: "∪", not: "∁" };
const KIND = { and: "intersect", or: "union", not: "complement" };
const PRESERVED = ["lattice", "hex_lattice", "dagmc_universe"];

/** Finds the <geometry> element (and the <model> wrapper, if any) in a document. */
function locate(roots) {
  for (const r of roots) {
    if (r.name === "geometry") return { geometry: r, model: null, roots };
    if (r.name === "model") {
      const g = children(r, "geometry")[0];
      if (g) return { geometry: g, model: r, roots };
    }
  }
  throw new Error("no <geometry> element found");
}

/** The <source> elements of a <settings> element, as scene sources. */
export function readSources(settingsEl, warnings = []) {
  return children(settingsEl, "source").map((el, i) => {
    const src = sourceFromXML(el, i + 1);
    if (src.raw) warnings.push(`Source ${i + 1} is a ${src.kind} source: kept for export but not editable.`);
    return src;
  });
}

/**
 * Reads a standalone settings.xml: its sources, and the rest of the settings
 * (without the sources) to write back on export. Null when there is no <settings>.
 */
export function importSettingsXML(text) {
  const roots = parseXML(text);
  const el = roots.find((r) => r.name === "settings");
  if (!el) return null;
  const warnings = [];
  const sources = readSources(el, warnings);
  return { sources, settings: { ...el, children: el.children.filter((c) => c.name !== "source") }, values: readSettings(el), warnings };
}

/** Reads a <materials> element into a library keyed by id. */
export function readMaterials(materialsEl, warnings = []) {
  const materials = {};
  for (const el of children(materialsEl, "material")) {
    const id = getText(el, "id");
    try {
      const m = materialFromXML(el, { warnings });
      materials[m.id] = m;
    } catch (e) {
      warnings.push(`Material ${id}: ${e.message}`);
      if (id !== undefined) materials[id] = normalizeMaterial(id, { name: getText(el, "name") ?? "" });
    }
  }
  const cs = children(materialsEl, "cross_sections")[0];
  return { materials, crossSections: cs ? cs.text.trim() : null };
}

/**
 * Reads a standalone materials.xml (or the <materials> of a model.xml).
 * Returns null when the document has no <materials>.
 */
export function importMaterialsXML(text) {
  const roots = parseXML(text);
  const el = roots.find((r) => r.name === "materials") ?? roots.find((r) => r.name === "model")?.children.find((c) => c.name === "materials");
  if (!el) return null;
  const warnings = [];
  return { ...readMaterials(el, warnings), warnings };
}

/** Universe ids listed by a preserved lattice element (contents and outer). */
export function latticeUniverseIds(el) {
  const ids = new Set();
  const outer = getText(el, "outer");
  if (outer !== undefined) ids.add(parseInt(outer, 10));
  for (const u of getList(el, "universes", (s) => parseInt(s, 10)) ?? []) ids.add(u);
  return ids;
}

export function importOpenMC(text, { fileName } = {}) {
  const warnings = [];
  const { geometry, model, roots } = locate(parseXML(text));
  const scene = new Scene();
  scene.world = { ...scene.world, auto: true };

  // Materials (model.xml or a materials document alongside).
  const materialsEl = model ? children(model, "materials")[0] : roots.find((r) => r.name === "materials");
  if (materialsEl) {
    const lib = readMaterials(materialsEl, warnings);
    scene.materials = lib.materials;
    if (lib.crossSections) scene.openmc.crossSections = lib.crossSections;
  }

  // Surfaces.
  for (const el of children(geometry, "surface")) {
    const id = parseInt(getText(el, "id"), 10);
    if (!Number.isInteger(id)) throw new Error("surface without a valid id");
    const boundary = getText(el, "boundary") ?? "transmission";
    const s = {
      id,
      type: getText(el, "type"),
      coeffs: getList(el, "coeffs") ?? [],
      boundary: BOUNDARY_ALIASES[boundary] ?? boundary,
    };
    for (const [key, attr] of [
      ["name", "name"],
      ["albedo", "albedo"],
      ["periodic", "periodic_surface_id"],
    ]) {
      const v = getText(el, attr);
      if (v !== undefined && v !== "") s[key] = key === "name" ? v : Number(v);
    }
    validateSurface(s);
    if (scene.surfaces.has(id)) throw new Error(`duplicate surface id ${id}`);
    scene.surfaces.set(id, s);
  }

  // Elements not modelled yet are kept verbatim.
  const preserved = geometry.children.filter((c) => PRESERVED.includes(c.name));
  const preservedIds = new Map(preserved.map((el) => [parseInt(getText(el, "id"), 10), el]));
  for (const el of preserved) warnings.push(`<${el.name} id="${getText(el, "id")}"> is preserved for export but not displayed yet.`);
  for (const el of geometry.children) {
    if (!["surface", "cell", ...PRESERVED].includes(el.name)) warnings.push(`<${el.name}> elements are not supported and were ignored.`);
  }

  // Cells grouped by universe; find the root universe (not referenced by anything).
  const cellEls = children(geometry, "cell");
  const byUniverse = new Map();
  const referenced = new Set();
  for (const el of cellEls) {
    const u = parseInt(getText(el, "universe", "0"), 10);
    if (!byUniverse.has(u)) byUniverse.set(u, []);
    byUniverse.get(u).push(el);
    const fill = getText(el, "fill");
    if (fill !== undefined) referenced.add(parseInt(fill, 10));
  }
  for (const el of preserved) if (el.name !== "dagmc_universe") latticeUniverseIds(el).forEach((u) => referenced.add(u));
  const dagmcIds = preserved.filter((el) => el.name === "dagmc_universe").map((el) => parseInt(getText(el, "id"), 10));
  const candidates = [...byUniverse.keys(), ...dagmcIds].filter((u) => !referenced.has(u));
  let rootUniverse = candidates[0] ?? 0;
  if (candidates.length > 1) {
    rootUniverse = candidates.includes(0) ? 0 : candidates[0];
    warnings.push(`Several universes are not referenced by any cell (${candidates.join(", ")}); using ${rootUniverse} as the root.`);
  }
  // External sources become editable; the rest of <settings> is kept as is
  // and gets the scene's sources back on export.
  const settingsEl = model ? children(model, "settings")[0] : roots.find((r) => r.name === "settings");
  if (settingsEl) {
    scene.sources = readSources(settingsEl, warnings);
    scene.settings = readSettings(settingsEl);
  }
  const stripSources = (c) => (c.name === "settings" ? { ...c, children: c.children.filter((k) => k.name !== "source") } : c);
  scene.openmc = {
    ...scene.openmc,
    rootUniverse,
    preserved,
    source: fileName,
    model: model ? { sections: model.children.map((c) => (c.name === "geometry" ? null : stripSources(c))) } : undefined,
  };

  // Universe nodes first, so fills can reference them.
  const universeNodes = new Map();
  for (const u of [...byUniverse.keys()].sort((a, b) => a - b)) {
    if (u === rootUniverse) continue;
    universeNodes.set(u, scene.add("universe", { name: `Universe ${u}`, openmc: { id: u }, collapsed: true }));
  }

  const collapse = cellEls.length > 12;
  for (const [u, els] of byUniverse) {
    const target = u === rootUniverse ? scene.roots : universeNodes.get(u).children;
    for (const el of els) target.push(importCell(scene, el, universeNodes, preservedIds, warnings, collapse));
  }
  return { scene, warnings };
}

function importCell(scene, el, universeNodes, preservedIds, warnings, collapse) {
  const id = parseInt(getText(el, "id"), 10);
  const name = getText(el, "name");
  const extra = {};
  for (const key of ["temperature", "density", "volume"]) {
    const v = getText(el, key);
    if (v !== undefined) extra[key] = v;
  }

  let fill;
  const material = getText(el, "material");
  const fillId = getText(el, "fill");
  if (fillId !== undefined) {
    const f = parseInt(fillId, 10);
    if (universeNodes.has(f)) fill = { type: "universe", universe: universeNodes.get(f).id };
    else if (preservedIds.has(f)) fill = { type: preservedIds.get(f).name === "dagmc_universe" ? "external" : "lattice", id: f };
    else {
      warnings.push(`Cell ${id} is filled with unknown universe ${f}; imported as void.`);
      fill = { type: "material", material: "void" };
    }
  } else {
    fill = { type: "material", material: material ?? "void" };
  }

  const transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], order: "zyx" };
  const translation = getList(el, "translation");
  if (translation) transform.position = translation;
  const rotation = getList(el, "rotation");
  if (rotation?.length === 3) transform.rotation = rotation;
  else if (rotation?.length === 9) {
    // The 9 values are the world→local matrix M (row-major); the universe moves by Mᵀ.
    const R = [0, 1, 2].map((i) => [0, 1, 2].map((j) => rotation[j * 3 + i]));
    transform.rotation = rotationToOpenMCAngles(R);
  }

  const cell = scene.create("cell", {
    name: name || `Cell ${id}`,
    fill,
    transform,
    openmc: { id, ...(Object.keys(extra).length ? { extra } : {}) },
    collapsed: collapse,
  });
  const region = getText(el, "region");
  if (region) {
    try {
      const ast = parseRegion(region);
      if (ast) cell.children.push(astToNode(scene, ast, collapse));
    } catch (e) {
      throw new Error(`cell ${id}: ${e.message}`);
    }
  }
  return cell;
}

/** Converts a region AST to builder nodes (half-spaces under operations). */
export function astToNode(scene, ast, collapse = false) {
  if (ast.op === "half") {
    const s = scene.surfaces.get(ast.surface);
    if (!s) throw new Error(`region references unknown surface ${ast.surface}`);
    const label = `${ast.sense === "-" ? "−" : "+"}${ast.surface} ${s.type}${s.name ? ` (${s.name})` : ""}`;
    return scene.create("halfspace", { params: { surface: ast.surface, sense: ast.sense }, name: label });
  }
  const text = formatRegion(ast);
  const node = scene.create(KIND[ast.op], {
    name: `${SYMBOL[ast.op]} ${text.length > 48 ? `${text.slice(0, 47)}…` : text}`,
    collapsed: collapse,
  });
  const args = ast.op === "not" ? [ast.arg] : ast.args;
  node.children = args.map((a) => astToNode(scene, a, collapse));
  return node;
}
