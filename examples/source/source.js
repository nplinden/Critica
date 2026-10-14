// External source model mirroring openmc.IndependentSource (openmc/source.py)
// and the distributions of openmc.stats (univariate.py, multivariate.py).
//
// Source: {
//   id, name,                       // Critica only (OpenMC sources have no id or name)
//   strength, particle,
//   space:  { type: "point", xyz }
//         | { type: "box", lowerLeft, upperRight, fissionOnly }
//         | { type: "spherical", origin, r: Dist, cosTheta: Dist, phi: Dist }
//         | { type: "cylindrical", origin, r: Dist, phi: Dist, z: Dist, rDir?, zDir? }
//         | { type: "cartesian", x: Dist, y: Dist, z: Dist }
//         | { type: "raw", xml }      // mesh, cloud, …: kept verbatim
//   angle:  { type: "isotropic" } | { type: "monodirectional", uvw }
//         | { type: "mu-phi", uvw, mu: Dist, phi: Dist } | { type: "raw", xml }
//   energy: Dist,                   // eV
//   time:   Dist | null,            // s; null = born at t = 0
//   constraints: { domainType, domainIds, fissionable, energyBounds, timeBounds, rejectionStrategy }
// }
// or, for source types Critica does not edit (file, compiled, mesh, tokamak):
//   { id, name, raw: xmlElement }
//
// Dist: { type: "discrete", x, p } | { type: "uniform", a, b } | { type: "powerlaw", a, b, n }
//     | { type: "maxwell", theta } | { type: "watt", a, b } | { type: "normal", mean, std }
//     | { type: "tabular", x, p, interpolation } | { type: "raw", xml }

import { element, getText, getList, children } from "../openmc/xml.js";

export const PARTICLES = ["neutron", "photon", "electron", "positron", "proton", "deuteron", "triton", "alpha"];
const PARTICLE_ALIASES = { n: "neutron", gamma: "photon", p: "proton", d: "deuteron", t: "triton" };

/** Univariate distribution types, with their parameters (name, label, default). */
export const DIST_TYPES = {
  discrete: { label: "Discrete", params: [] },
  uniform: { label: "Uniform", params: [["a", "min"], ["b", "max"]] },
  powerlaw: { label: "Power law (p ∝ xⁿ)", params: [["a", "min"], ["b", "max"], ["n", "n"]] },
  maxwell: { label: "Maxwell", params: [["theta", "θ (eV)"]] },
  watt: { label: "Watt", params: [["a", "a (eV)"], ["b", "b (1/eV)"]] },
  normal: { label: "Normal", params: [["mean", "mean"], ["std", "std. dev."]] },
  tabular: { label: "Tabular", params: [] },
};

export const SPACE_TYPES = {
  point: "Point",
  box: "Box",
  spherical: "Spherical",
  cylindrical: "Cylindrical",
  cartesian: "Cartesian (x, y, z)",
};
export const ANGLE_TYPES = { isotropic: "Isotropic", monodirectional: "Monodirectional", "mu-phi": "Polar / azimuthal (μ, φ)" };
export const DOMAIN_TYPES = ["cell", "material", "universe"];

const TWO_PI = 2 * Math.PI;

/** OpenMC's default source energy: a Watt fission spectrum (a = 0.988 MeV, b = 2.249 /MeV). */
export const WATT_DEFAULT = () => ({ type: "watt", a: 0.988e6, b: 2.249e-6 });

/** A distribution of `type` with sensible defaults; `range` seeds bounded types. */
export function defaultDist(type, [lo, hi] = [0, 1]) {
  switch (type) {
    case "discrete":
      return { type, x: [lo], p: [1] };
    case "uniform":
      return { type, a: lo, b: hi };
    case "powerlaw":
      return { type, a: lo, b: hi, n: 0 };
    case "maxwell":
      return { type, theta: 1.2895e6 };
    case "watt":
      return WATT_DEFAULT();
    case "normal":
      return { type, mean: (lo + hi) / 2, std: (hi - lo) / 4 || 1 };
    case "tabular":
      return { type, x: [lo, hi], p: [1, 1], interpolation: "histogram" };
  }
  throw new Error(`unknown distribution type "${type}"`);
}

const blankConstraints = () => ({ domainType: null, domainIds: [], fissionable: false, energyBounds: null, timeBounds: null, rejectionStrategy: "resample" });

/** Spatial distributions with a uniform density over a simple shape. */
export function defaultSpace(type, size = 1) {
  switch (type) {
    case "point":
      return { type, xyz: [0, 0, 0] };
    case "box":
      return { type, lowerLeft: [-size, -size, -size], upperRight: [size, size, size], fissionOnly: false };
    case "spherical":
      // openmc.stats.spherical_uniform: r ∝ r², cos θ and φ uniform.
      return { type, origin: [0, 0, 0], r: { type: "powerlaw", a: 0, b: size, n: 2 }, cosTheta: { type: "uniform", a: -1, b: 1 }, phi: { type: "uniform", a: 0, b: TWO_PI } };
    case "cylindrical":
      // openmc.stats.cylindrical_uniform: r ∝ r, φ and z uniform.
      return { type, origin: [0, 0, 0], r: { type: "powerlaw", a: 0, b: size, n: 1 }, phi: { type: "uniform", a: 0, b: TWO_PI }, z: { type: "uniform", a: -size, b: size } };
    case "cartesian":
      return { type, x: { type: "uniform", a: -size, b: size }, y: { type: "uniform", a: -size, b: size }, z: { type: "uniform", a: -size, b: size } };
  }
  throw new Error(`unknown spatial distribution "${type}"`);
}

export function defaultAngle(type) {
  if (type === "monodirectional") return { type, uvw: [0, 0, 1] };
  if (type === "mu-phi") return { type, uvw: [0, 0, 1], mu: { type: "uniform", a: -1, b: 1 }, phi: { type: "uniform", a: 0, b: TWO_PI } };
  return { type: "isotropic" };
}

export function newSource(id, spaceType = "point", { size = 1, ...overrides } = {}) {
  return {
    id,
    name: `Source ${id}`,
    strength: 1,
    particle: "neutron",
    space: defaultSpace(spaceType, size),
    angle: { type: "isotropic" },
    energy: WATT_DEFAULT(),
    time: null,
    constraints: blankConstraints(),
    ...overrides,
  };
}

// ---- validation ----------------------------------------------------------------

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(finite);

function distErrors(d, label, out) {
  if (!d) return out.push(`${label}: missing distribution`);
  switch (d.type) {
    case "raw":
      return;
    case "discrete":
    case "tabular":
      if (!d.x.length) out.push(`${label}: add at least one value`);
      if (d.x.length !== d.p.length) out.push(`${label}: as many probabilities as values are needed`);
      if (!d.x.every(finite) || !d.p.every(finite)) out.push(`${label}: values and probabilities must be numbers`);
      if (d.p.some((p) => p < 0)) out.push(`${label}: probabilities cannot be negative`);
      if (!(d.p.reduce((s, p) => s + p, 0) > 0)) out.push(`${label}: probabilities must not all be zero`);
      if (d.type === "tabular" && d.x.some((x, i) => i && !(x > d.x[i - 1]))) out.push(`${label}: tabular values must increase`);
      return;
    case "uniform":
    case "powerlaw":
      if (![d.a, d.b].every(finite) || !(d.b > d.a)) out.push(`${label}: max must be greater than min`);
      if (d.type === "powerlaw" && !finite(d.n)) out.push(`${label}: n must be a number`);
      return;
    case "maxwell":
      if (!(d.theta > 0)) out.push(`${label}: θ must be positive`);
      return;
    case "watt":
      if (!(d.a > 0) || !(d.b > 0)) out.push(`${label}: a and b must be positive`);
      return;
    case "normal":
      if (!finite(d.mean) || !(d.std > 0)) out.push(`${label}: the standard deviation must be positive`);
      return;
  }
  out.push(`${label}: unknown distribution "${d.type}"`);
}

/** Problems that would make OpenMC reject (errors) or misread (warnings) the source. */
export function validateSource(src) {
  const errors = [];
  const warnings = [];
  if (src.raw) return { errors, warnings };
  if (!(src.strength > 0)) errors.push("strength must be positive");
  const s = src.space;
  if (s.type === "point" && !vec3(s.xyz)) errors.push("point: x, y and z must be numbers");
  if (s.type === "box") {
    if (!vec3(s.lowerLeft) || !vec3(s.upperRight)) errors.push("box: corners must be numbers");
    // Equal corners on an axis are allowed: a flat (plane or line) source.
    else if (s.upperRight.some((v, i) => v < s.lowerLeft[i])) errors.push("box: the upper corner cannot be below the lower corner");
  }
  if (s.type === "spherical" || s.type === "cylindrical") {
    if (!vec3(s.origin)) errors.push(`${s.type}: the origin must be three numbers`);
    distErrors(s.r, "r", errors);
    distErrors(s.phi, "φ", errors);
    if (s.type === "spherical") {
      distErrors(s.cosTheta, "cos θ", errors);
      if (s.cosTheta && ["uniform", "powerlaw"].includes(s.cosTheta.type) && (s.cosTheta.a < -1 || s.cosTheta.b > 1)) errors.push("cos θ must stay within [−1, 1]");
    } else distErrors(s.z, "z", errors);
    if (s.r && ["uniform", "powerlaw"].includes(s.r.type) && s.r.a < 0) errors.push("r cannot be negative");
  }
  if (s.type === "cartesian") for (const k of ["x", "y", "z"]) distErrors(s[k], k, errors);
  const a = src.angle;
  if (a.type === "monodirectional" || a.type === "mu-phi") {
    if (!vec3(a.uvw) || !(Math.hypot(...a.uvw) > 0)) errors.push("angle: the direction must be a non-zero vector");
  }
  if (a.type === "mu-phi") {
    distErrors(a.mu, "μ", errors);
    distErrors(a.phi, "φ (angle)", errors);
  }
  distErrors(src.energy, "energy", errors);
  if (["uniform", "powerlaw", "discrete", "tabular"].includes(src.energy?.type)) {
    const lows = src.energy.type === "uniform" || src.energy.type === "powerlaw" ? [src.energy.a] : src.energy.x;
    if (lows.some((x) => x <= 0)) errors.push("energy: values must be positive (eV)");
    const highs = src.energy.type === "uniform" || src.energy.type === "powerlaw" ? [src.energy.b] : src.energy.x;
    if (highs.some((x) => x > 1e9)) warnings.push("energy above 1 GeV: values are in eV");
  }
  if (src.time) distErrors(src.time, "time", errors);
  const c = src.constraints;
  if (c.domainIds.length && !c.domainType) errors.push("constraints: choose a domain type for the domain ids");
  if (c.domainType && !c.domainIds.length) errors.push(`constraints: list the ${c.domainType} ids the source must be in`);
  for (const [key, label] of [["energyBounds", "energy bounds"], ["timeBounds", "time bounds"]]) {
    const b = c[key];
    if (b && !(b.length === 2 && b.every(finite) && b[1] > b[0])) errors.push(`constraints: ${label} need a lower and a higher value`);
  }
  if (s.type === "box" && s.fissionOnly && c.fissionable) warnings.push("a fission box already keeps only fissionable sites");
  return { errors, warnings };
}

// ---- XML ----------------------------------------------------------------------

// Shortest exact form: values like 2π or 1/√2 read back unchanged.
const fmt = (v) => String(Number(v));
const join = (xs) => xs.map(fmt).join(" ");

/** openmc.stats.Univariate.to_xml_element. */
export function distToXML(d, name) {
  if (d.type === "raw") return { ...d.xml, name };
  switch (d.type) {
    case "discrete":
      return element(name, { type: "discrete" }, [element("parameters", {}, [], `${join(d.x)} ${join(d.p)}`)]);
    case "tabular":
      return element(name, { type: "tabular", interpolation: d.interpolation ?? "histogram" }, [element("parameters", {}, [], `${join(d.x)} ${join(d.p)}`)]);
    case "uniform":
      return element(name, { type: "uniform", parameters: join([d.a, d.b]) });
    case "powerlaw":
      return element(name, { type: "powerlaw", parameters: join([d.a, d.b, d.n]) });
    case "maxwell":
      return element(name, { type: "maxwell", parameters: fmt(d.theta) });
    case "watt":
      return element(name, { type: "watt", parameters: join([d.a, d.b]) });
    case "normal":
      return element(name, { type: "normal", parameters: join([d.mean, d.std]) });
  }
  throw new Error(`unknown distribution type "${d.type}"`);
}

/** openmc.stats.Univariate.from_xml_element; types Critica does not edit are kept verbatim. */
export function distFromXML(el) {
  const type = getText(el, "type");
  const params = getList(el, "parameters") ?? [];
  const hasBias = children(el, "bias").length > 0;
  if (!hasBias) {
    const half = (xs) => [xs.slice(0, xs.length / 2), xs.slice(xs.length / 2)];
    switch (type) {
      case "discrete": {
        const [x, p] = half(params);
        return { type, x, p };
      }
      case "tabular": {
        const [x, p] = half(params);
        return { type, x, p, interpolation: getText(el, "interpolation") ?? "histogram" };
      }
      case "uniform":
        return { type, a: params[0], b: params[1] };
      case "powerlaw":
        return { type, a: params[0], b: params[1], n: params[2] };
      case "maxwell":
        return { type, theta: params[0] };
      case "watt":
        return { type, a: params[0], b: params[1] };
      case "normal":
        if (params.length === 2) return { type, mean: params[0], std: params[1] };
    }
  }
  return { type: "raw", xml: el, label: type ?? "distribution" };
}

function spaceToXML(s) {
  switch (s.type) {
    case "raw":
      return s.xml;
    case "point":
      return element("space", { type: "point" }, [element("parameters", {}, [], join(s.xyz))]);
    case "box":
      return element("space", { type: s.fissionOnly ? "fission" : "box" }, [element("parameters", {}, [], `${join(s.lowerLeft)} ${join(s.upperRight)}`)]);
    case "cartesian":
      return element("space", { type: "cartesian" }, [distToXML(s.x, "x"), distToXML(s.y, "y"), distToXML(s.z, "z")]);
    case "spherical":
      return element("space", { type: "spherical", origin: join(s.origin) }, [distToXML(s.r, "r"), distToXML(s.cosTheta, "cos_theta"), distToXML(s.phi, "phi")]);
    case "cylindrical": {
      const attrs = { type: "cylindrical" };
      if (s.origin.some((v) => v !== 0)) attrs.origin = join(s.origin);
      if (s.rDir) attrs.r_dir = join(s.rDir);
      if (s.zDir) attrs.z_dir = join(s.zDir);
      return element("space", attrs, [distToXML(s.r, "r"), distToXML(s.phi, "phi"), distToXML(s.z, "z")]);
    }
  }
  throw new Error(`unknown spatial distribution "${s.type}"`);
}

function spaceFromXML(el) {
  const type = getText(el, "type");
  const child = (name) => children(el, name)[0];
  const params = getList(el, "parameters") ?? [];
  switch (type) {
    case "point":
      return { type, xyz: params.slice(0, 3) };
    case "box":
    case "fission":
      return { type: "box", lowerLeft: params.slice(0, 3), upperRight: params.slice(3, 6), fissionOnly: type === "fission" };
    case "cartesian":
      if (child("x") && child("y") && child("z")) return { type, x: distFromXML(child("x")), y: distFromXML(child("y")), z: distFromXML(child("z")) };
      break;
    case "spherical": {
      const theta = child("cos_theta") ?? child("theta");
      if (child("r") && theta && child("phi")) return { type, origin: getList(el, "origin") ?? [0, 0, 0], r: distFromXML(child("r")), cosTheta: distFromXML(theta), phi: distFromXML(child("phi")) };
      break;
    }
    case "cylindrical":
      if (child("r") && child("phi") && child("z")) {
        const s = { type, origin: getList(el, "origin") ?? [0, 0, 0], r: distFromXML(child("r")), phi: distFromXML(child("phi")), z: distFromXML(child("z")) };
        const rDir = getList(el, "r_dir");
        const zDir = getList(el, "z_dir");
        if (rDir) s.rDir = rDir;
        if (zDir) s.zDir = zDir;
        return s;
      }
      break;
  }
  return { type: "raw", xml: el, label: type ?? "space" };
}

function angleToXML(a) {
  switch (a.type) {
    case "raw":
      return a.xml;
    case "isotropic":
      return element("angle", { type: "isotropic" });
    case "monodirectional":
      return element("angle", { type: "monodirectional", reference_uvw: join(a.uvw) });
    case "mu-phi":
      return element("angle", { type: "mu-phi", reference_uvw: join(a.uvw) }, [distToXML(a.mu, "mu"), distToXML(a.phi, "phi")]);
  }
  throw new Error(`unknown angular distribution "${a.type}"`);
}

function angleFromXML(el) {
  const type = getText(el, "type") ?? "isotropic";
  if (children(el, "bias").length) return { type: "raw", xml: el, label: type };
  if (type === "isotropic") return { type };
  if (type === "monodirectional") return { type, uvw: getList(el, "reference_uvw") ?? [1, 0, 0] };
  const mu = children(el, "mu")[0];
  const phi = children(el, "phi")[0];
  if (type === "mu-phi" && mu && phi && !getText(el, "reference_vwu")) return { type, uvw: getList(el, "reference_uvw") ?? [0, 0, 1], mu: distFromXML(mu), phi: distFromXML(phi) };
  return { type: "raw", xml: el, label: type };
}

/** openmc.IndependentSource.to_xml_element (raw sources are written back unchanged). */
export function sourceToXML(src) {
  if (src.raw) return src.raw;
  const { errors } = validateSource(src);
  if (errors.length) throw new Error(`source "${src.name}": ${errors[0]}`);
  const kids = [spaceToXML(src.space), angleToXML(src.angle), distToXML(src.energy, "energy")];
  if (src.time) kids.push(distToXML(src.time, "time"));
  const c = src.constraints;
  const ck = [];
  if (c.domainType && c.domainIds.length) {
    ck.push(element("domain_type", {}, [], c.domainType));
    ck.push(element("domain_ids", {}, [], c.domainIds.join(" ")));
  }
  if (c.timeBounds) ck.push(element("time_bounds", {}, [], join(c.timeBounds)));
  if (c.energyBounds) ck.push(element("energy_bounds", {}, [], join(c.energyBounds)));
  if (c.fissionable) ck.push(element("fissionable", {}, [], "true"));
  if (ck.length && c.rejectionStrategy && c.rejectionStrategy !== "resample") ck.push(element("rejection_strategy", {}, [], c.rejectionStrategy));
  if (ck.length) kids.push(element("constraints", {}, ck));
  return element("source", { type: "independent", strength: fmt(src.strength), particle: src.particle }, kids);
}

/** openmc.SourceBase.from_xml_element: independent sources become editable, the rest stay verbatim. */
export function sourceFromXML(el, id) {
  const name = `Source ${id}`;
  const type = getText(el, "type") ?? (getText(el, "file") ? "file" : getText(el, "library") ? "compiled" : getText(el, "mesh") ? "mesh" : "independent");
  if (type !== "independent") return { id, name, raw: el, kind: type };
  const particle = String(getText(el, "particle") ?? "neutron");
  const space = children(el, "space")[0];
  const angle = children(el, "angle")[0];
  const energy = children(el, "energy")[0];
  const time = children(el, "time")[0];
  const cons = children(el, "constraints")[0];
  const constraints = blankConstraints();
  if (cons) {
    constraints.domainType = getText(cons, "domain_type") ?? null;
    constraints.domainIds = getList(cons, "domain_ids") ?? [];
    constraints.fissionable = ["true", "1"].includes(getText(cons, "fissionable"));
    constraints.timeBounds = getList(cons, "time_bounds") ?? null;
    constraints.energyBounds = getList(cons, "energy_bounds") ?? null;
    constraints.rejectionStrategy = getText(cons, "rejection_strategy") ?? "resample";
  }
  return {
    id,
    name,
    strength: Number(getText(el, "strength", "1")),
    particle: PARTICLE_ALIASES[particle] ?? particle,
    // OpenMC's defaults when an element is absent.
    space: space ? spaceFromXML(space) : defaultSpace("point"),
    angle: angle ? angleFromXML(angle) : { type: "isotropic" },
    energy: energy ? distFromXML(energy) : WATT_DEFAULT(),
    time: time ? distFromXML(time) : null,
    constraints,
  };
}

/**
 * `settings` with its <source> elements replaced by `sources` (a new
 * <settings> holding only the sources when there is none). An invalid source
 * is left out, with a note in `warnings`, rather than blocking the export.
 */
export function settingsWithSources(settings, sources, warnings = []) {
  const kept = settings ? settings.children.filter((c) => c.name !== "source") : [];
  const written = [];
  for (const src of sources) {
    try {
      written.push(sourceToXML(src));
    } catch (e) {
      warnings.push(`Not exported: ${e.message}.`);
    }
  }
  return element("settings", settings?.attrs ?? {}, [...kept, ...written], settings?.text ?? "");
}

// ---- display ------------------------------------------------------------------

/** Upper end of a distribution's support, for drawing; null when unbounded. */
function upper(d) {
  if (!d) return null;
  if (d.type === "uniform" || d.type === "powerlaw") return d.b;
  if (d.type === "discrete" || d.type === "tabular") return Math.max(...d.x);
  if (d.type === "normal") return d.mean + 3 * d.std;
  return null;
}
function lower(d) {
  if (!d) return null;
  if (d.type === "uniform" || d.type === "powerlaw") return d.a;
  if (d.type === "discrete" || d.type === "tabular") return Math.min(...d.x);
  if (d.type === "normal") return d.mean - 3 * d.std;
  return null;
}

/**
 * What to draw for a source in model coordinates:
 * { kind: "point", at } | { kind: "box", min, max } | { kind: "sphere", center, radius }
 * | { kind: "cylinder", center, radius, z0, z1, axis, rDir }, or null.
 */
export function sourceShape(src) {
  const s = src.space;
  if (!s || src.raw) return null;
  if (s.type === "point") return vec3(s.xyz) ? { kind: "point", at: s.xyz } : null;
  if (s.type === "box") return vec3(s.lowerLeft) && vec3(s.upperRight) ? { kind: "box", min: s.lowerLeft, max: s.upperRight } : null;
  if (s.type === "cartesian") {
    const min = ["x", "y", "z"].map((k) => lower(s[k]));
    const max = ["x", "y", "z"].map((k) => upper(s[k]));
    if (![...min, ...max].every(finite)) return null;
    // Degenerate axes (e.g. a line source) still draw as a thin box.
    return { kind: "box", min, max };
  }
  if (s.type === "spherical") {
    const radius = upper(s.r);
    return finite(radius) && vec3(s.origin) ? { kind: "sphere", center: s.origin, radius } : null;
  }
  if (s.type === "cylindrical") {
    const radius = upper(s.r);
    const z0 = lower(s.z);
    const z1 = upper(s.z);
    if (![radius, z0, z1].every(finite) || !vec3(s.origin)) return null;
    return { kind: "cylinder", center: s.origin, radius, z0, z1, axis: s.zDir ?? [0, 0, 1], rDir: s.rDir ?? [1, 0, 0] };
  }
  return null;
}
