// Simulation settings: the common elements of OpenMC's settings.xml
// (docs/source/io_formats/settings.rst, openmc/settings.py), edited in the
// Settings tab and written with the sources into <settings>.
//
// scene.settings.values: { key: value } holds the settings set explicitly;
// an absent key means OpenMC's default (nothing is written). Keys are element
// names, or "element.child" for children of compound elements (cutoff,
// output, keff_trigger, trigger, state_point, source_point). Elements Critica
// does not model are kept from the opened file and written back unchanged.

import { element, getText, children } from "../openmc/xml.js";

/**
 * Field specs: key, group (UI section), label, type ("enum" | "int" |
 * "float" | "bool" | "text" | "ints" | "floats"), OpenMC's default (shown as
 * a hint), and for enums the options. `when` limits a field to run modes.
 */
export const SETTINGS_FIELDS = [
  // Run
  { key: "run_mode", group: "run", label: "Run mode", type: "enum", options: ["eigenvalue", "fixed source", "volume", "plot", "particle restart"], default: "eigenvalue" },
  { key: "particles", group: "run", label: "Particles", type: "int", min: 1, help: "Particles per batch (per generation in eigenvalue mode)" },
  { key: "batches", group: "run", label: "Batches", type: "int", min: 1 },
  { key: "inactive", group: "run", label: "Inactive", type: "int", min: 0, default: 0, when: ["eigenvalue"], help: "Batches discarded while the fission source converges" },
  { key: "generations_per_batch", group: "run", label: "Generations", type: "int", min: 1, default: 1, when: ["eigenvalue"], help: "Generations per batch" },
  { key: "seed", group: "run", label: "Seed", type: "int", min: 1, default: 1, help: "Random number seed" },
  { key: "energy_mode", group: "run", label: "Energy mode", type: "enum", options: ["continuous-energy", "multi-group"], default: "continuous-energy" },
  { key: "max_order", group: "run", label: "Max order", type: "int", min: 0, help: "Highest scattering order (multi-group only)", whenEnergy: "multi-group" },

  // Convergence (triggers)
  { key: "keff_trigger.type", group: "convergence", label: "k-eff trigger", type: "enum", options: ["std_dev", "rel_err", "variance"], when: ["eigenvalue"], help: "Keep running until the uncertainty of k-eff is below the threshold" },
  { key: "keff_trigger.threshold", group: "convergence", label: "Threshold", type: "float", when: ["eigenvalue"] },
  { key: "trigger.active", group: "convergence", label: "Triggers on", type: "bool", default: false, help: "Use the k-eff trigger and tally triggers" },
  { key: "trigger.max_batches", group: "convergence", label: "Max batches", type: "int", min: 1, help: "Stop here even if a trigger is not met" },
  { key: "trigger.batch_interval", group: "convergence", label: "Check every", type: "int", min: 1, help: "Batches between trigger checks (predicted when empty)" },

  // Physics
  { key: "photon_transport", group: "physics", label: "Photon transport", type: "bool", default: false },
  { key: "electron_treatment", group: "physics", label: "Electrons", type: "enum", options: ["ttb", "led"], default: "ttb", help: "ttb: thick-target bremsstrahlung; led: local energy deposition" },
  { key: "survival_biasing", group: "physics", label: "Survival biasing", type: "bool", default: false, help: "Implicit capture" },
  { key: "create_fission_neutrons", group: "physics", label: "Fission neutrons", type: "bool", default: true, help: "Create secondary neutrons from fission (fixed source)" },
  { key: "create_delayed_neutrons", group: "physics", label: "Delayed neutrons", type: "bool", default: true },
  { key: "cutoff.weight", group: "physics", label: "Weight cutoff", type: "float", default: 0.25, help: "Russian roulette below this weight" },
  { key: "cutoff.weight_avg", group: "physics", label: "Survivor weight", type: "float", default: 1, help: "Weight given to particles surviving Russian roulette" },
  { key: "cutoff.energy_neutron", group: "physics", label: "Neutron cutoff", type: "float", default: 0, unit: "eV", help: "Kill neutrons below this energy" },
  { key: "cutoff.energy_photon", group: "physics", label: "Photon cutoff", type: "float", default: 1000, unit: "eV", help: "Kill photons below this energy" },
  { key: "cutoff.time_neutron", group: "physics", label: "Neutron time", type: "float", unit: "s", help: "Kill neutrons after this time" },

  // Temperature
  { key: "temperature_default", group: "temperature", label: "Default", type: "float", default: 293.6, unit: "K", help: "For cells and materials without a temperature" },
  { key: "temperature_method", group: "temperature", label: "Method", type: "enum", options: ["nearest", "interpolation"], default: "nearest" },
  { key: "temperature_tolerance", group: "temperature", label: "Tolerance", type: "float", default: 10, unit: "K" },
  { key: "temperature_multipole", group: "temperature", label: "Multipole", type: "bool", default: false, help: "Windowed multipole Doppler broadening" },
  { key: "temperature_range", group: "temperature", label: "Range", type: "floats", count: 2, unit: "K", help: "Load data for temperatures between min and max" },

  // Output
  { key: "output.summary", group: "output", label: "summary.h5", type: "bool", default: true },
  { key: "output.tallies", group: "output", label: "tallies.out", type: "bool", default: true },
  { key: "output.path", group: "output", label: "Output path", type: "text", help: "Must exist; current directory by default" },
  { key: "state_point.batches", group: "output", label: "State points", type: "ints", help: "Batches at which to write a state point (last batch by default)" },
  { key: "source_point.batches", group: "output", label: "Source points", type: "ints", help: "Batches at which to write the source bank" },
  { key: "source_point.separate", group: "output", label: "Separate file", type: "bool", default: false, help: "Write the source bank to its own file" },
  { key: "source_point.write", group: "output", label: "Write sources", type: "bool", default: true },
  { key: "source_point.overwrite_latest", group: "output", label: "Keep latest", type: "bool", default: false, help: "Overwrite source.h5 at every batch" },
  { key: "verbosity", group: "output", label: "Verbosity", type: "int", min: 1, max: 10, default: 7 },
  { key: "max_lost_particles", group: "output", label: "Max lost", type: "int", min: 0, default: 10, help: "Stop after this many lost particles" },
  { key: "rel_max_lost_particles", group: "output", label: "Max lost (rel.)", type: "float", default: 1e-6, help: "…or this fraction of all particles" },
];

export const SETTINGS_GROUPS = { run: "Run", convergence: "Convergence", physics: "Physics", temperature: "Temperature", output: "Output" };
const FIELD = new Map(SETTINGS_FIELDS.map((f) => [f.key, f]));
const COMPOUND = [...new Set(SETTINGS_FIELDS.filter((f) => f.key.includes(".")).map((f) => f.key.split(".")[0]))];

/** Settings of a new scene: what OpenMC needs to run an eigenvalue problem. */
export const defaultSettings = () => ({ values: { run_mode: "eigenvalue", particles: 1000, batches: 100, inactive: 10 } });

/** Whether a field applies to the current values (run mode, energy mode). */
export function fieldApplies(field, values) {
  if (field.when && !field.when.includes(values.run_mode ?? "eigenvalue")) return false;
  if (field.whenEnergy && (values.energy_mode ?? "continuous-energy") !== field.whenEnergy) return false;
  return true;
}

// ---- reading -------------------------------------------------------------------

function parseValue(field, raw) {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  switch (field.type) {
    case "bool":
      return ["true", "1"].includes(t.toLowerCase());
    case "int":
      return Number.isFinite(Number(t)) ? Math.round(Number(t)) : undefined;
    case "float":
      return Number.isFinite(Number(t)) ? Number(t) : undefined;
    case "ints":
    case "floats":
      return t ? t.split(/\s+/).map(Number) : [];
    default:
      return t;
  }
}

/** The modelled settings found in a <settings> element: { values }. */
export function readSettings(el) {
  const values = {};
  if (!el) return { values };
  for (const field of SETTINGS_FIELDS) {
    const [name, child] = field.key.split(".");
    let raw;
    if (child) {
      const parent = children(el, name)[0];
      raw = parent ? getText(parent, child) : undefined;
    } else raw = getText(el, name);
    const v = parseValue(field, raw);
    if (v !== undefined) values[field.key] = v;
  }
  return { values };
}

// ---- writing -------------------------------------------------------------------

const text = (field, v) => {
  if (field.type === "bool") return v ? "true" : "false";
  if (Array.isArray(v)) return v.map((x) => String(x)).join(" ");
  return String(v);
};

/**
 * <settings>: `base` (the opened file's settings, or none) with the modelled
 * elements replaced by `values`; other elements and the unmodelled children of
 * compound elements are kept. Fields that do not apply to the run or energy
 * mode (e.g. inactive batches of a fixed source run) are not written; their
 * values stay in the scene. The <source> elements are left to the caller.
 */
export function applySettings(base, values) {
  const simple = SETTINGS_FIELDS.filter((f) => !f.key.includes("."));
  const modelled = new Set([...simple.map((f) => f.key), ...COMPOUND]);
  const kept = (base?.children ?? []).filter((c) => !modelled.has(c.name));
  const out = [];
  const written = (f) => values[f.key] !== undefined && values[f.key] !== null && fieldApplies(f, values);
  for (const f of simple) if (written(f)) out.push(element(f.key, {}, [], text(f, values[f.key])));
  for (const name of COMPOUND) {
    const original = (base?.children ?? []).find((c) => c.name === name);
    const fields = SETTINGS_FIELDS.filter((f) => f.key.startsWith(`${name}.`));
    const childNames = new Set(fields.map((f) => f.key.split(".")[1]));
    // Unmodelled children (and attributes) of the original stay.
    const kids = (original?.children ?? []).filter((c) => !childNames.has(c.name));
    const attrs = Object.fromEntries(Object.entries(original?.attrs ?? {}).filter(([k]) => !childNames.has(k)));
    for (const f of fields) {
      const v = values[f.key];
      if (written(f) && !(Array.isArray(v) && !v.length)) kids.push(element(f.key.split(".")[1], {}, [], text(f, v)));
    }
    if (kids.length || Object.keys(attrs).length) out.push(element(name, attrs, kids));
  }
  return element("settings", base?.attrs ?? {}, [...out, ...kept], base?.text ?? "");
}

// ---- validation ----------------------------------------------------------------

/** Problems that would stop OpenMC (errors) or are likely mistakes (warnings). */
export function validateSettings(values, { sources = 0 } = {}) {
  const errors = [];
  const warnings = [];
  const mode = values.run_mode ?? "eigenvalue";
  for (const [key, v] of Object.entries(values)) {
    const f = FIELD.get(key);
    if (!f || v === null || v === undefined) continue;
    if ((f.type === "int" || f.type === "float") && !Number.isFinite(v)) errors.push(`${f.label}: not a number`);
    if (f.min !== undefined && v < f.min) errors.push(`${f.label} must be at least ${f.min}`);
    if (f.max !== undefined && v > f.max) errors.push(`${f.label} must be at most ${f.max}`);
    if (f.type === "floats" && f.count && v.length && v.length !== f.count) errors.push(`${f.label}: give ${f.count} values`);
    if (f.type === "ints" && v.some((x) => !Number.isInteger(x) || x < 1)) errors.push(`${f.label}: batch numbers are positive integers`);
  }
  if (mode === "eigenvalue" || mode === "fixed source") {
    if (values.particles == null) errors.push(`${mode} runs need a number of particles`);
    if (values.batches == null) errors.push(`${mode} runs need a number of batches`);
  }
  if (mode === "eigenvalue" && values.batches != null && (values.inactive ?? 0) >= values.batches) errors.push("inactive batches must be fewer than batches");
  if (values["keff_trigger.type"] && !(values["keff_trigger.threshold"] > 0)) errors.push("the k-eff trigger needs a positive threshold");
  if (values["trigger.max_batches"] != null && values.batches != null && values["trigger.max_batches"] < values.batches) errors.push("trigger max batches must be at least the number of batches");
  if (values["trigger.active"] && values["trigger.max_batches"] == null) errors.push("active triggers need max batches");
  const tr = values.temperature_range;
  if (tr?.length === 2 && !(tr[1] > tr[0])) errors.push("temperature range: max must be above min");
  const last = values.batches;
  for (const key of ["state_point.batches", "source_point.batches"]) if (last != null && values[key]?.some((b) => b > last)) warnings.push(`${FIELD.get(key).label}: some batches are after the last batch (${last})`);
  if (mode === "fixed source" && !sources) warnings.push("no source defined: OpenMC will use an isotropic point source at the origin with a Watt spectrum (Source tab)");
  if (values.electron_treatment && !values.photon_transport) warnings.push("the electron treatment only matters with photon transport on");
  if (values["source_point.separate"] === false && values["source_point.batches"]?.length && !values["state_point.batches"]?.length) warnings.push("source points written in state points need matching state point batches");
  return { errors, warnings };
}
