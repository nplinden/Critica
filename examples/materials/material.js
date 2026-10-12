// Material model mirroring openmc.Material (openmc/material.py, openmc/element.py).
//
// Material: {
//   id, name, color?, depletable, temperature, volume,
//   density: { value, units },          // units: g/cm3 kg/m3 atom/b-cm atom/cm3 sum macro
//   components: [{ kind: "nuclide"|"element", name, percent, type: "ao"|"wo",
//                  enrichment?, enrichmentTarget?, enrichmentType? }],
//   sab: [{ name, fraction }], isotropic: [nuclide], macroscopic, cfg
// }
// Elements are expanded into natural isotopes when written to XML, exactly as
// the Python API does (OpenMC's C++ reader only accepts nuclides). Without a
// cross_sections.xml at hand, expansion uses all naturally occurring isotopes,
// matching openmc.Element.expand when no library is configured.

import { AVOGADRO, SYMBOLS, NATURAL_ABUNDANCE, MASSES } from "./nuclear-data.js";
import { element, getText, getList, children } from "../openmc/xml.js";

export const DENSITY_UNITS = ["g/cm3", "kg/m3", "atom/b-cm", "atom/cm3", "sum", "macro"];
const UNIT_ALIASES = { "g/cc": "g/cm3", "atom/cc": "atom/cm3" };
const Z_OF = new Map(SYMBOLS.map((s, z) => [s, z]).filter(([s]) => s));

export const isElementSymbol = (s) => Z_OF.has(s) && s !== "n";

/** "U235", "Am242_m1", "C0" → { symbol, a, meta } or null. */
export function parseNuclide(name) {
  const m = /^([A-Z][a-z]?)(\d+)(?:_m(\d+))?$/.exec(name ?? "");
  if (!m || !isElementSymbol(m[1])) return null;
  return { symbol: m[1], a: Number(m[2]), meta: m[3] ? Number(m[3]) : 0 };
}

/** Atomic mass in amu (metastable states use the ground-state mass, like OpenMC). */
export function atomicMass(nuclide) {
  const base = nuclide.includes("_") ? nuclide.slice(0, nuclide.indexOf("_")) : nuclide;
  const m = MASSES[base.toLowerCase()];
  if (m === undefined) throw new Error(`no atomic mass for ${nuclide}`);
  return m;
}

/** Natural isotopes of an element as [name, atom fraction], ordered by mass number. */
export function naturalIsotopes(symbol) {
  const re = new RegExp(`^${symbol}\\d+$`);
  return Object.entries(NATURAL_ABUNDANCE)
    .filter(([n]) => re.test(n))
    .sort((a, b) => parseNuclide(a[0]).a - parseNuclide(b[0]).a);
}

export const atomicWeight = (symbol) => naturalIsotopes(symbol).reduce((s, [n, x]) => s + x * atomicMass(n), 0);

const normalize = (obj) => {
  const total = Object.values(obj).reduce((s, v) => s + v, 0);
  for (const k of Object.keys(obj)) obj[k] /= total;
  return obj;
};

/**
 * Port of openmc.Element.expand (no cross-section library): returns
 * [{ name, percent, type }] for the element's isotopes.
 */
export function expandElement(symbol, percent, type = "ao", enrichment = null, target = null, enrichType = null) {
  if (!isElementSymbol(symbol)) throw new Error(`"${symbol}" is not an element symbol`);
  const iso = naturalIsotopes(symbol);
  if (!iso.length) throw new Error(`${symbol} has no naturally occurring isotopes`);
  let ab = Object.fromEntries(iso);

  if (enrichment != null && !target) {
    // Uranium correlation (ORNL/CSD/TM-244): U234 and U236 track U235 by weight.
    if (symbol !== "U") throw new Error("enrichment without a target nuclide is only defined for uranium");
    if (enrichType === "ao") throw new Error("uranium enrichment must be given in weight percent");
    if (!(enrichment >= 0 && enrichment < 100 / 1.008)) throw new Error("uranium enrichment out of range");
    ab = { U234: 0.0089 * enrichment, U235: enrichment, U236: 0.0046 * enrichment, U238: 100 - 1.0135 * enrichment };
    for (const n of Object.keys(ab)) ab[n] /= atomicMass(n);
    normalize(ab);
  } else if (enrichment != null && target) {
    if (target === "U235") throw new Error("for U235 give only the enrichment (weight percent), without a target");
    if (Object.keys(ab).length !== 2) throw new Error(`${symbol} does not have exactly two natural isotopes`);
    if (!(target in ab)) throw new Error(`${target} is not a natural isotope of ${symbol}`);
    if (!(enrichment >= 0 && enrichment <= 100)) throw new Error("enrichment must be between 0 and 100");
    if (enrichType === "wo") {
      const am = Object.entries(ab).reduce((s, [n, x]) => s + atomicMass(n) * x, 0);
      for (const n of Object.keys(ab)) ab[n] *= atomicMass(n) / am;
      normalize(ab);
    }
    const nonEnriched = 1 - ab[target];
    const tail = 1 - enrichment / 100;
    for (const n of Object.keys(ab)) ab[n] = (tail * ab[n]) / nonEnriched;
    ab[target] = enrichment / 100;
    if (enrichType === "wo") {
      for (const n of Object.keys(ab)) ab[n] /= atomicMass(n);
      normalize(ab);
    }
  }

  if (type === "wo") {
    const am = Object.entries(ab).reduce((s, [n, x]) => s + atomicMass(n) * x, 0);
    for (const n of Object.keys(ab)) ab[n] *= atomicMass(n) / am;
    normalize(ab);
  }
  return Object.entries(ab).map(([name, x]) => ({ name, percent: percent * x, type }));
}

/**
 * All nuclides of a material as written to XML: elements expanded, entries kept
 * in order. Repeated nuclides stay separate, as with add_nuclide (OpenMC's
 * reader keeps both, which adds them up).
 */
export function expandMaterial(mat) {
  return mat.components.flatMap((c) =>
    c.kind === "element"
      ? expandElement(c.name, c.percent, c.type, c.enrichment ?? null, c.enrichmentTarget || null, c.enrichmentType || null)
      : [{ name: c.name, percent: c.percent, type: c.type }],
  );
}

/** openmc.Material.average_molar_mass. */
export function averageMolarMass(nuclides) {
  let mass = 0;
  let moles = 0;
  for (const n of nuclides) {
    if (n.type === "ao") {
      mass += n.percent * atomicMass(n.name);
      moles += n.percent;
    } else {
      moles += n.percent / atomicMass(n.name);
      mass += n.percent;
    }
  }
  return mass / moles;
}

export const canonicalUnits = (u) => UNIT_ALIASES[u] ?? u;

/**
 * Port of openmc.Material.get_nuclide_atom_densities: nuclide → atom/b-cm.
 * Returns null for macroscopic materials.
 */
export function atomDensities(mat, nuclides = expandMaterial(mat)) {
  const units = canonicalUnits(mat.density.units);
  if (units === "macro" || !nuclides.length) return null;
  let density;
  if (units === "sum") density = nuclides.reduce((s, n) => s + n.percent, 0);
  else if (units === "g/cm3") density = -mat.density.value;
  else if (units === "kg/m3") density = -0.001 * mat.density.value;
  else if (units === "atom/b-cm") density = mat.density.value;
  else if (units === "atom/cm3") density = 1e-24 * mat.density.value;
  else throw new Error(`unknown density units "${mat.density.units}"`);
  if (!Number.isFinite(density)) throw new Error("density is not set");

  const amm = averageMolarMass(nuclides);
  const allAtom = nuclides.every((n) => n.type === "ao");
  // Weight amounts → atom amounts (mixed ao/wo is rejected by validate()).
  let values = nuclides.map((n) => (allAtom ? n.percent : (n.percent * amm) / atomicMass(n.name)));
  const sum = values.reduce((s, v) => s + v, 0);
  values = values.map((v) => v / sum);
  // With "sum", weight amounts are absolute g/cm3 (C++ reader semantics).
  if (units === "sum" && !allAtom) density = -density;
  const total = density > 0 ? density : (-density / amm) * 1e-24 * AVOGADRO;
  // Repeated nuclides add up.
  const out = {};
  nuclides.forEach((n, i) => (out[n.name] = (out[n.name] ?? 0) + total * values[i]));
  return out;
}

/** Composition summary: per-nuclide fractions and densities, totals. */
export function composition(mat) {
  const nuclides = expandMaterial(mat);
  const dens = atomDensities(mat, nuclides);
  if (!dens) return { nuclides: nuclides.map((n) => ({ name: n.name })), atomDensity: null, massDensity: null, molarMass: null };
  const totalN = Object.values(dens).reduce((s, v) => s + v, 0);
  const massOf = (n) => dens[n] * atomicMass(n);
  const totalMass = Object.keys(dens).reduce((s, n) => s + massOf(n), 0);
  return {
    nuclides: Object.keys(dens).map((n) => ({ name: n, atomDensity: dens[n], atomFraction: dens[n] / totalN, weightFraction: massOf(n) / totalMass })),
    atomDensity: totalN, // atom/b-cm
    massDensity: (totalMass * 1e24) / AVOGADRO, // g/cm3
    molarMass: totalMass / totalN, // g/mol
  };
}

/** Element atom densities (atom/b-cm), as get_element_atom_densities. */
export function elementDensities(mat) {
  const c = composition(mat);
  const out = {};
  for (const n of c.nuclides) {
    if (n.atomDensity == null) continue;
    const sym = parseNuclide(n.name)?.symbol ?? n.name;
    out[sym] = (out[sym] ?? 0) + n.atomDensity;
  }
  return out;
}

/** Problems that would make OpenMC reject (errors) or misread (warnings) the material. */
export function validate(mat) {
  const errors = [];
  const warnings = [];
  const units = canonicalUnits(mat.density.units);
  if (!DENSITY_UNITS.includes(units)) errors.push(`unknown density units "${mat.density.units}"`);
  if (!["sum", "macro"].includes(units) && !(mat.density.value > 0)) errors.push("density must be a positive number");
  if (mat.macroscopic) {
    if (mat.components.length || mat.sab.length) errors.push("a macroscopic material cannot also list nuclides, elements or S(α,β) tables");
    if (units !== "macro") warnings.push('macroscopic data normally uses density units "macro"');
  } else {
    if (!mat.components.length) errors.push("add at least one nuclide or element");
    if (units === "macro") errors.push('density units "macro" need a macroscopic data set');
  }
  const types = new Set(mat.components.map((c) => c.type));
  if (types.size > 1) errors.push("all components must use the same percent type (atom or weight)");
  for (const c of mat.components) {
    if (c.kind === "element" && !isElementSymbol(c.name)) errors.push(`"${c.name}" is not an element symbol`);
    if (c.kind === "nuclide") {
      if (!parseNuclide(c.name)) errors.push(`"${c.name}" is not a nuclide name (e.g. U235, Am242_m1)`);
      else if (MASSES[c.name.replace(/_m\d+$/, "").toLowerCase()] === undefined) warnings.push(`no atomic mass known for ${c.name}`);
    }
    if (!(c.percent >= 0)) errors.push(`${c.name}: percent must be ≥ 0`);
  }
  for (const s of mat.sab) if (!(s.fraction > 0 && s.fraction <= 1)) errors.push(`${s.name}: S(α,β) fraction must be in (0, 1]`);
  const seen = new Map();
  for (const c of mat.components) seen.set(`${c.kind}:${c.name}`, (seen.get(`${c.kind}:${c.name}`) ?? 0) + 1);
  for (const [key, count] of seen) if (count > 1) warnings.push(`${key.split(":")[1]} appears ${count} times; OpenMC adds the entries together`);
  if (!errors.length) {
    try {
      expandMaterial(mat);
    } catch (e) {
      errors.push(e.message);
    }
  }
  return { errors, warnings };
}

/** Port of add_elements_from_formula: "UO2", "Ca(OH)2" → [{ symbol, fraction }]. */
export function parseFormula(formula) {
  if (formula.includes(".")) throw new Error("non-integer multipliers are not accepted");
  const re = /([A-Z][a-z]*)(\d*)|(\()|(\))(\d*)/g;
  let consumed = "";
  const stack = [new Map()];
  for (const [whole, sym, n1, open, close, n2] of formula.matchAll(re)) {
    consumed += whole;
    if (sym) {
      if (!isElementSymbol(sym)) throw new Error(`"${sym}" is not an element symbol`);
      stack.at(-1).set(sym, (stack.at(-1).get(sym) ?? 0) + Number(n1 || 1));
    } else if (open) stack.push(new Map());
    else if (close) {
      if (stack.length < 2) throw new Error("unbalanced brackets");
      const top = stack.pop();
      for (const [s, v] of top) stack.at(-1).set(s, (stack.at(-1).get(s) ?? 0) + Number(n2 || 1) * v);
    }
  }
  if (stack.length !== 1) throw new Error("unbalanced brackets");
  if (consumed.length !== formula.replace(/\s+/g, "").length) throw new Error("the formula contains characters that are not element symbols, digits or brackets");
  const total = [...stack[0].values()].reduce((s, v) => s + v, 0);
  if (!total) throw new Error("empty formula");
  return [...stack[0]].map(([symbol, v]) => ({ symbol, fraction: v / total }));
}

/**
 * Regroups nuclides into elements where they exactly reproduce a natural
 * composition (as written by add_element), so imported files edit like the
 * scripts that produced them. Other nuclides stay as they are.
 */
export function groupIntoElements(nuclides, tolerance = 1e-9) {
  const bySymbol = new Map();
  for (const n of nuclides) {
    const p = parseNuclide(n.name);
    const key = p && !p.meta ? `${p.symbol}|${n.type}` : null;
    if (!key) continue;
    if (!bySymbol.has(key)) bySymbol.set(key, []);
    bySymbol.get(key).push(n);
  }
  const grouped = new Map(); // symbol|type → element component
  for (const [key, list] of bySymbol) {
    const [symbol, type] = key.split("|");
    const natural = naturalIsotopes(symbol);
    if (natural.length < 2 || list.length !== natural.length) continue;
    const total = list.reduce((s, n) => s + n.percent, 0);
    if (!(total > 0)) continue;
    const expected = Object.fromEntries(expandElement(symbol, 1, type).map((e) => [e.name, e.percent]));
    const matches = list.every((n) => n.name in expected && Math.abs(n.percent / total - expected[n.name]) <= tolerance * expected[n.name]);
    if (matches) grouped.set(key, { kind: "element", name: symbol, percent: total, type });
  }
  const out = [];
  const emitted = new Set();
  for (const n of nuclides) {
    const p = parseNuclide(n.name);
    const key = p && !p.meta ? `${p.symbol}|${n.type}` : null;
    if (key && grouped.has(key)) {
      if (!emitted.has(key)) out.push(grouped.get(key));
      emitted.add(key);
    } else out.push({ kind: "nuclide", name: n.name, percent: n.percent, type: n.type });
  }
  return out;
}

export function newMaterial(id, overrides = {}) {
  return {
    id,
    name: `Material ${id}`,
    depletable: false,
    temperature: null,
    volume: null,
    density: { value: 1, units: "g/cm3" },
    components: [],
    sab: [],
    isotropic: [],
    macroscopic: null,
    cfg: null,
    ...overrides,
  };
}

/** Fills missing fields (older scenes stored only { name }). */
export function normalizeMaterial(id, m = {}) {
  const base = newMaterial(Number(id), { name: m.name || `Material ${id}` });
  return { ...base, ...m, id: Number(id), density: { ...base.density, ...(m.density ?? {}) }, components: m.components ?? [], sab: m.sab ?? [], isotropic: m.isotropic ?? [] };
}

/** A material from a bundled library (e.g. PNNL): elements in atom fractions + g/cm3. */
export function fromLibrary(library, materialName, id) {
  const entry = library.materials[materialName];
  if (!entry) throw new Error(`"${materialName}" is not in the library`);
  const type = library.percent_type ?? "ao";
  return newMaterial(id, {
    name: materialName,
    density: { value: entry.density, units: library.density_units ?? "g/cm3" },
    // Entries list elements, nuclides (isotopic compositions), or both — as Material.from_library.
    components: [
      ...Object.entries(entry.elements ?? {}).map(([name, percent]) => ({ kind: "element", name, percent, type })),
      ...Object.entries(entry.nuclides ?? {}).map(([name, percent]) => ({ kind: "nuclide", name, percent, type })),
    ],
  });
}

// ---- XML ----------------------------------------------------------------------

const num = (s) => (s === undefined || s === "" ? null : Number(s));

/** openmc.Material.from_xml_element, keeping NCrystal cfg and macroscopic data. */
export function materialFromXML(el, { group = true } = {}) {
  const id = Number(getText(el, "id"));
  if (!Number.isInteger(id)) throw new Error("material without a valid id");
  const d = children(el, "density")[0];
  const units = canonicalUnits(d ? getText(d, "units") : "sum");
  const nuclides = children(el, "nuclide").map((n) => {
    const name = getText(n, "name");
    const ao = getText(n, "ao");
    return ao !== undefined ? { name, percent: Number(ao), type: "ao" } : { name, percent: Number(getText(n, "wo")), type: "wo" };
  });
  const macro = children(el, "macroscopic")[0];
  return normalizeMaterial(id, {
    name: getText(el, "name") ?? "",
    depletable: ["true", "1"].includes(getText(el, "depletable")),
    temperature: num(getText(el, "temperature")),
    volume: num(getText(el, "volume")),
    density: { value: units === "sum" ? null : num(d && getText(d, "value")), units },
    components: group ? groupIntoElements(nuclides) : nuclides.map((n) => ({ kind: "nuclide", ...n })),
    sab: children(el, "sab").map((s) => ({ name: getText(s, "name"), fraction: Number(getText(s, "fraction", "1")) })),
    isotropic: getList(el, "isotropic", String) ?? [],
    macroscopic: macro ? getText(macro, "name") : null,
    cfg: getText(el, "cfg") ?? null,
  });
}

const fmt = (v) => String(Number(v.toPrecision(12)));

/** openmc.Material.to_xml_element (elements expanded into nuclides). */
export function materialToXML(mat) {
  const { errors } = validate(mat);
  if (errors.length) throw new Error(`material ${mat.id} (${mat.name}): ${errors[0]}`);
  const units = canonicalUnits(mat.density.units);
  const attrs = { id: mat.id, name: mat.name || undefined };
  if (mat.depletable) attrs.depletable = "true";
  if (mat.volume) attrs.volume = fmt(mat.volume);
  if (mat.cfg) attrs.cfg = mat.cfg;
  if (mat.temperature != null) attrs.temperature = fmt(mat.temperature);
  const kids = [element("density", units === "sum" || (units === "macro" && mat.density.value == null) ? { units } : { value: fmt(mat.density.value), units })];
  if (mat.macroscopic) kids.push(element("macroscopic", { name: mat.macroscopic }));
  else for (const n of expandMaterial(mat)) kids.push(element("nuclide", { name: n.name, [n.type]: fmt(n.percent) }));
  for (const s of mat.sab) kids.push(element("sab", s.fraction !== 1 ? { name: s.name, fraction: fmt(s.fraction) } : { name: s.name }));
  if (mat.isotropic.length) kids.push(element("isotropic", {}, [], mat.isotropic.join(" ")));
  return element("material", attrs, kids);
}

/** <materials> element for a list of materials. */
export function materialsElement(materials, crossSections) {
  const kids = [];
  if (crossSections) kids.push(element("cross_sections", {}, [], crossSections));
  for (const m of [...materials].sort((a, b) => a.id - b.id)) kids.push(materialToXML(m));
  return element("materials", {}, kids);
}
