// Source workspace: the external source distributions written into OpenMC's
// <settings>. Sources live in scene.sources, so edits share undo/redo and
// autosave with the geometry. The geometry viewport is shown alongside (the
// builder moves it into this workspace) with the sources drawn in it.

import { h, keepFocus } from "./ui.js";
import {
  PARTICLES,
  DIST_TYPES,
  SPACE_TYPES,
  ANGLE_TYPES,
  DOMAIN_TYPES,
  defaultDist,
  defaultSpace,
  defaultAngle,
  validateSource,
  sourceToXML,
  WATT_DEFAULT,
} from "./source/source.js";
import { serializeXML } from "./openmc/xml.js";

const $ = (id) => document.getElementById(id);
const SPACE_ICONS = { point: "srcpoint", box: "cube", spherical: "sphere", cylindrical: "cylinder", cartesian: "cube", raw: "srcpoint" };

/** Energy presets: common fixed-source spectra ([label, make, tooltip]). */
const ENERGY_PRESETS = [
  ["Watt (U-235 fission)", () => WATT_DEFAULT(), "OpenMC's default: Watt spectrum of thermal U-235 fission neutrons (a = 0.988 MeV, b = 2.249 /MeV)"],
  ["14.1 MeV (D-T)", () => ({ type: "discrete", x: [14.1e6], p: [1] }), "Monoenergetic 14.1 MeV neutrons from deuterium–tritium fusion"],
  ["2.45 MeV (D-D)", () => ({ type: "discrete", x: [2.45e6], p: [1] }), "Monoenergetic 2.45 MeV neutrons from deuterium–deuterium fusion"],
  ["Maxwell (1.29 MeV)", () => ({ type: "maxwell", theta: 1.2895e6 }), "Maxwell fission spectrum with θ = 1.2895 MeV"],
];

// ---- tooltips ----

const DIST_TIPS = {
  discrete: "A finite set of values, each with a probability (e.g. a single line at 14.1 MeV)",
  uniform: "Equally likely anywhere between min and max",
  powerlaw: "Density p(x) ∝ xⁿ between min and max; for a radius, n = 1 fills a disk and n = 2 a ball uniformly",
  maxwell: "Maxwell spectrum p(E) ∝ E·e^(−E/θ), as OpenMC defines it",
  watt: "Watt fission spectrum p(E) ∝ e^(−E/a)·sinh(√(b·E)); thermal U-235 fission: a = 0.988 MeV, b = 2.249 /MeV",
  normal: "Gaussian (bell curve) with a mean and a standard deviation",
  tabular: "A density given at points, constant (histogram) or straight lines (linear-linear) between them",
};

const PARAM_TIPS = {
  a: "Lower end of the interval",
  b: "Upper end of the interval",
  n: "Exponent of p(x) ∝ xⁿ: 0 is uniform; for a radius, 1 fills a disk and 2 a ball uniformly",
  theta: "θ of the Maxwell spectrum, in eV (1.2895 MeV for fission neutrons)",
  mean: "Center of the bell curve",
  std: "Standard deviation: about 68% of samples fall within one of the mean",
};
const WATT_TIPS = { a: "Watt a parameter, in eV (0.988 MeV for thermal U-235 fission)", b: "Watt b parameter, in 1/eV (2.249 /MeV for thermal U-235 fission)" };

const SPACE_TIPS = {
  point: "Every particle starts at one point",
  box: "Uniformly inside an axis-aligned box",
  spherical: "Independent distributions of radius, polar angle (cos θ) and azimuth (φ) around an origin",
  cylindrical: "Independent distributions of radius, azimuth and height around an axis",
  cartesian: "Independent distributions of x, y and z",
};
const ANGLE_TIPS = {
  isotropic: "Every direction equally likely",
  monodirectional: "Every particle flies in the same direction (a beam)",
  "mu-phi": "Distributions of the cosine μ of the angle to a reference direction and of the azimuth φ around it",
};
const PARTICLE_TIPS = {
  neutron: "Neutrons: criticality, shielding, activation",
  photon: "Gamma rays and X-rays (turn photon transport on in Settings)",
  electron: "Electrons (needs photon transport, which handles charged particles)",
  positron: "Positrons (needs photon transport)",
  proton: "Protons",
  deuteron: "Deuterons",
  triton: "Tritons",
  alpha: "Alpha particles",
};

/**
 * ctx: {
 *   scene(), commit(), changed()   // after edits (redraws the viewport)
 *   frame(): { center, half }      // where new sources go and how big
 *   icon(name), setMessage(text, error)
 * }
 */
export function createSourcesWorkspace(ctx) {
  let selected = null;
  const scene = () => ctx.scene();
  const sources = () => scene().sources;
  const current = () => sources().find((s) => s.id === selected) ?? null;

  function select(id) {
    selected = id;
    render();
    ctx.changed();
  }

  // ---- list ----

  function renderList() {
    const rows = sources().map((s) => {
      const { errors } = validateSource(s);
      const kind = s.raw ? `${s.kind} source` : SPACE_TYPES[s.space.type] ?? s.space.label ?? s.space.type;
      return h(
        "div",
        { class: `mat-row${s.id === selected ? " selected" : ""}`, onclick: () => select(s.id), title: errors[0] ?? kind },
        ctx.icon(SPACE_ICONS[s.raw ? "raw" : s.space.type] ?? "srcpoint"),
        h("span", { class: "name" }, s.name || `Source ${s.id}`),
        h("span", { class: "oid" }, s.raw ? s.kind : `${s.particle}${s.strength !== 1 ? ` ×${s.strength}` : ""}`),
        errors.length ? h("span", { class: "badge err" }, "⚠") : null,
      );
    });
    $("src-list").replaceChildren(...(rows.length ? rows : [h("div", { class: "empty-props" }, "No sources yet. Add one from the ribbon: a point, a box, a sphere or a cylinder.")]));
  }

  // ---- editor helpers ----

  const num = (path, value, opts = {}) =>
    h("input", { type: "number", step: opts.step ?? "any", min: opts.min, value: value ?? "", placeholder: opts.placeholder ?? "", dataset: { path, optional: opts.optional ? "1" : "" } });
  const numbers = (path, values, placeholder) => h("input", { type: "text", value: (values ?? []).join(" "), placeholder, spellcheck: false, dataset: { path, kind: "numbers" } });
  const text = (path, value, opts = {}) => h("input", { type: "text", value: value ?? "", placeholder: opts.placeholder ?? "", spellcheck: false, dataset: { path } });
  /** A dropdown; options are [value, label, tooltip?]. */
  const sel = (path, options, value) => h("select", { dataset: { path } }, options.map(([v, l, tip]) => h("option", { value: v, selected: String(v) === String(value), title: tip ?? null }, l)));
  const field = (label, control, title) => h("div", { class: "field", title }, h("label", {}, label), control);
  const vec = (label, path, v, title) => field(label, h("div", { class: "vec" }, [0, 1, 2].map((i) => num(`${path}.${i}`, v[i]))), title);
  const section = (title, ...kids) => h("div", { class: "section" }, h("h3", {}, title), ...kids);

  /**
   * Editor of a univariate distribution at `path` ({ type, … }); `tip`
   * explains the variable, `unit` is shown in the parameter tooltips.
   */
  function distEditor(label, path, d, { unit = "", types = Object.keys(DIST_TYPES), tip = "" } = {}) {
    if (d.type === "raw") return field(label, h("span", { class: "note" }, `${d.label} distribution, kept as imported (not editable here).`), tip);
    const typeOptions = types.map((t) => [t, DIST_TYPES[t].label, DIST_TIPS[t]]);
    const inUnit = (text) => (unit && !/\b(eV|1\/eV)\b/.test(text) ? `${text} (${unit})` : text);
    const rows = [field(label, sel(`${path}.type`, typeOptions, d.type), `${tip}${tip ? ". " : ""}${DIST_TIPS[d.type]}`)];
    for (const [key, name] of DIST_TYPES[d.type].params) {
      const paramTip = d.type === "watt" ? WATT_TIPS[key] : PARAM_TIPS[key];
      rows.push(field(`  ${name}`, num(`${path}.${key}`, d[key]), inUnit(paramTip)));
    }
    if (d.type === "discrete" || d.type === "tabular") {
      rows.push(field("  values", numbers(`${path}.x`, d.x, unit ? `in ${unit}, space separated` : "space separated"), inUnit(d.type === "tabular" ? "Points where the density is given, increasing, space separated" : "Possible values, space separated")));
      rows.push(field("  probabilities", numbers(`${path}.p`, d.p, "one per value"), d.type === "tabular" ? "Density at each point (normalized by OpenMC)" : "Relative probability of each value (normalized by OpenMC)"));
      if (d.type === "tabular")
        rows.push(
          field(
            "  interpolation",
            sel(`${path}.interpolation`, [["histogram", "histogram", "Constant from each point to the next"], ["linear-linear", "linear-linear", "Straight lines between points"]], d.interpolation),
            "How the density varies between points",
          ),
        );
    }
    return h("div", { class: "dist" }, rows);
  }

  function spaceFields(s) {
    switch (s.type) {
      case "point":
        return [vec("Position", "space.xyz", s.xyz, "Coordinates of the point source (cm)")];
      case "box":
        return [
          vec("Lower corner", "space.lowerLeft", s.lowerLeft, "Smallest x, y and z of the box (cm)"),
          vec("Upper corner", "space.upperRight", s.upperRight, "Largest x, y and z of the box (cm); equal to the lower corner on an axis for a flat source"),
          field("Fissionable only", h("input", { type: "checkbox", checked: s.fissionOnly, dataset: { path: "space.fissionOnly" }, style: "justify-self:start" }), "Keep only sites in fissionable materials (OpenMC \"fission\" box)"),
        ];
      case "spherical":
        return [
          vec("Origin", "space.origin", s.origin, "Center of the spherical coordinates (cm)"),
          distEditor("r", "space.r", s.r, { unit: "cm", tip: "Distance from the origin" }),
          distEditor("cos θ", "space.cosTheta", s.cosTheta, { tip: "Cosine of the polar angle from +z, between −1 and 1; uniform over [−1, 1] covers all directions evenly" }),
          distEditor("φ (rad)", "space.phi", s.phi, { unit: "rad", tip: "Azimuth around z, from +x; [0, 2π] is a full turn" }),
          h("div", { class: "note" }, "A power law r² with uniform cos θ ∈ [−1, 1] and φ ∈ [0, 2π] fills the sphere uniformly."),
        ];
      case "cylindrical":
        return [
          vec("Origin", "space.origin", s.origin, "Point of the axis where z = 0 (cm)"),
          distEditor("r", "space.r", s.r, { unit: "cm", tip: "Distance from the axis" }),
          distEditor("φ (rad)", "space.phi", s.phi, { unit: "rad", tip: "Azimuth around the axis; [0, 2π] is a full turn" }),
          distEditor("z", "space.z", s.z, { unit: "cm", tip: "Position along the axis, relative to the origin" }),
          h("div", { class: "note" }, `Along the ${s.zDir ? `axis (${s.zDir.join(", ")})` : "z axis"}, z relative to the origin. A power law r¹ with uniform φ fills the disk uniformly.`),
        ];
      case "cartesian":
        return ["x", "y", "z"].map((k) => distEditor(k, `space.${k}`, s[k], { unit: "cm", tip: `${k} coordinate of the birth site` }));
      default:
        return [h("div", { class: "note" }, `${s.label} spatial distribution, kept as imported (not editable here).`)];
    }
  }

  /** A section whose distribution may be left to OpenMC's default: a note and a button, or the editor and a ✕. */
  function optional(title, value, { defaultNote, addLabel, addTitle, add, remove, extra = null }, editor) {
    if (!value)
      return section(
        title,
        h("div", { class: "note" }, defaultNote),
        h("div", { class: "props-actions" }, h("button", { class: "tb", title: addTitle, onclick: () => edit(add) }, `+ ${addLabel}`)),
        extra,
      );
    return h(
      "div",
      { class: "section" },
      h("h3", { class: "with-action" }, title, h("button", { class: "tb icon-btn", title: "Remove: use OpenMC's default", onclick: () => edit(remove) }, "✕")),
      editor(),
      extra,
    );
  }

  function angleFields(a) {
    if (a.type === "monodirectional") return [vec("Direction", "angle.uvw", a.uvw, "Direction of flight (u, v, w); any length, OpenMC normalizes it")];
    if (a.type === "mu-phi")
      return [
        vec("Reference", "angle.uvw", a.uvw, "Direction the polar angle is measured from"),
        distEditor("μ = cos θ", "angle.mu", a.mu, { tip: "Cosine of the angle to the reference direction: 1 along it, −1 opposite; uniform over [−1, 1] is isotropic" }),
        distEditor("φ (rad)", "angle.phi", a.phi, { unit: "rad", tip: "Azimuth around the reference direction; [0, 2π] is a full turn" }),
      ];
    if (a.type === "raw") return [h("div", { class: "note" }, `${a.label} angular distribution, kept as imported.`)];
    return [];
  }

  function renderEditor() {
    const panel = $("src-editor");
    const s = current();
    keepFocus(panel, () => {
      if (!s) {
        panel.replaceChildren(h("h2", {}, "Source"), h("div", { class: "empty-props" }, "Select a source, or add one from the ribbon."));
        return;
      }
      if (s.raw) {
        panel.replaceChildren(
          h("h2", {}, "Source"),
          section("Source", field("Name", text("name", s.name)), h("div", { class: "note" }, `A ${s.kind} source: written back unchanged on export; Critica does not edit this kind yet.`)),
          section("OpenMC XML", h("pre", { class: "xml-preview" }, serializeXML(s.raw))),
        );
        return;
      }
      const c = s.constraints;
      const spaceTypes = Object.entries(SPACE_TYPES).map(([k, l]) => [k, l, SPACE_TIPS[k]]);
      const angleTypes = Object.entries(ANGLE_TYPES).map(([k, l]) => [k, l, ANGLE_TIPS[k]]);
      const parts = [
        h("h2", {}, "Source"),
        section(
          "General",
          field("Name", text("name", s.name), "Shown in Critica only: OpenMC sources have no names"),
          field("Particle", sel("particle", PARTICLES.map((p) => [p, p, PARTICLE_TIPS[p]]), s.particle), "Type of particle emitted"),
          field("Strength", num("strength", s.strength, { min: 0 }), "Relative probability of this source among all sources"),
        ),
        section(
          "Space",
          field("Type", sel("space.type", s.space.type === "raw" ? [["raw", s.space.label], ...spaceTypes] : spaceTypes, s.space.type), `Where particles are born. ${SPACE_TIPS[s.space.type] ?? ""}`),
          spaceFields(s.space),
        ),
        optional(
          "Angle",
          s.angle,
          {
            defaultNote: "OpenMC's default: isotropic (every direction equally likely).",
            addLabel: "Set the angular distribution",
            addTitle: "Give the particles a direction (a beam) or another angular distribution",
            add: (ss) => (ss.angle = defaultAngle("monodirectional")),
            remove: (ss) => (ss.angle = null),
          },
          () => [
            field("Type", sel("angle.type", s.angle.type === "raw" ? [["raw", s.angle.label], ...angleTypes] : angleTypes, s.angle.type), `Directions particles fly off in. ${ANGLE_TIPS[s.angle.type] ?? ""}`),
            angleFields(s.angle),
          ],
        ),
        optional(
          "Energy",
          s.energy,
          {
            defaultNote: "OpenMC's default: Watt spectrum of thermal U-235 fission neutrons (a = 0.988 MeV, b = 2.249 /MeV).",
            addLabel: "Set the energy spectrum",
            addTitle: "Choose the energy distribution of the emitted particles",
            add: (ss) => (ss.energy = WATT_DEFAULT()),
            remove: (ss) => (ss.energy = null),
            // Presets are one click away whether or not a spectrum is set.
            extra: h("div", { class: "props-actions preset-row" }, ENERGY_PRESETS.map(([label, make, tip]) => h("button", { class: "tb", title: tip, onclick: () => edit((ss) => (ss.energy = make())) }, label))),
          },
          () => [distEditor("Spectrum", "energy", s.energy, { unit: "eV", tip: "Energy of the emitted particles, in eV (1 MeV = 1e6 eV)" })],
        ),
        optional(
          "Time",
          s.time,
          {
            defaultNote: "OpenMC's default: every particle is born at t = 0.",
            addLabel: "Set the time distribution",
            addTitle: "Spread the birth times (for time-dependent tallies and time cutoffs)",
            add: (ss) => (ss.time = { type: "uniform", a: 0, b: 1e-6 }),
            remove: (ss) => (ss.time = null),
          },
          () => [distEditor("Time", "time", s.time, { unit: "s", types: ["uniform", "discrete", "tabular", "normal", "powerlaw"], tip: "Birth time of the particles, in seconds" })],
        ),
        h(
          "details",
          { class: "section advanced", open: Boolean(c.domainType || c.fissionable || c.energyBounds || c.timeBounds) },
          h("summary", {}, "Constraints"),
          field("Domain", sel("constraints.domainType", [["", "anywhere", "No domain constraint"], ...DOMAIN_TYPES.map((d) => [d, `${d}s`, `Birth sites must be inside one of the listed ${d}s`])], c.domainType ?? ""), "Reject sites outside these domains"),
          c.domainType && field("Ids", numbers("constraints.domainIds", c.domainIds, `${c.domainType} ids (OpenMC ids)`), `OpenMC ids of the ${c.domainType}s a birth site must be in, space separated; sites elsewhere are rejected`),
          field("Fissionable", h("input", { type: "checkbox", checked: c.fissionable, dataset: { path: "constraints.fissionable" }, style: "justify-self:start" }), "Only accept sites in fissionable materials"),
          field("Energy (eV)", numbers("constraints.energyBounds", c.energyBounds, "min max (optional)"), "Reject particles whose sampled energy is outside [min, max], in eV"),
          field("Time (s)", numbers("constraints.timeBounds", c.timeBounds, "min max (optional)"), "Reject particles whose sampled birth time is outside [min, max], in seconds"),
          field(
            "Rejected sites",
            sel("constraints.rejectionStrategy", [["resample", "resample", "Sample again until a site is accepted"], ["kill", "kill (zero weight)", "Keep the particle but with zero weight"]], c.rejectionStrategy ?? "resample"),
            "What happens to a birth site that fails a constraint",
          ),
        ),
      ];
      panel.replaceChildren(...parts.filter(Boolean));
    });
  }

  function renderSummary() {
    const panel = $("src-summary");
    const s = current();
    if (!s) {
      panel.replaceChildren(h("div", { class: "note" }, `${sources().length} source(s). Strengths are relative: OpenMC picks among sources in proportion to them.`));
      return;
    }
    const { errors, warnings } = validateSource(s);
    let xml = "";
    if (!errors.length) {
      try {
        xml = serializeXML(sourceToXML(s));
      } catch (e) {
        errors.push(e.message);
      }
    }
    const parts = [
      (errors.length > 0 || warnings.length > 0) && h("div", {}, errors.map((e) => h("div", { class: "msg-err" }, `✕ ${e}`)), warnings.map((w) => h("div", { class: "msg-warn" }, `⚠ ${w}`))),
      xml && h("details", { open: true }, h("summary", {}, "OpenMC XML"), h("pre", { class: "xml-preview" }, xml)),
    ];
    panel.replaceChildren(...parts.filter(Boolean));
  }

  function render() {
    if (selected != null && !current()) selected = null;
    if (selected == null && sources().length) selected = sources()[0].id;
    renderList();
    renderEditor();
    renderSummary();
  }

  // ---- editing ----

  function edit(fn) {
    const s = current();
    if (!s) return;
    fn(s);
    ctx.commit();
    ctx.changed();
    render();
  }

  const getPath = (o, path) => path.split(".").reduce((x, k) => x?.[k], o);
  function setPath(o, path, value) {
    const keys = path.split(".");
    const last = keys.pop();
    for (const k of keys) o = o[k];
    o[last] = value;
  }

  function readValue(el) {
    if (el.type === "checkbox") return el.checked;
    if (el.dataset.kind === "numbers") {
      const v = el.value.trim();
      if (!v) return [];
      const xs = v.split(/[\s,;]+/).map(Number);
      return xs.every(Number.isFinite) ? xs : undefined;
    }
    if (el.type === "number") {
      if (el.value === "") return el.dataset.optional ? null : undefined;
      const v = Number(el.value);
      return Number.isFinite(v) ? v : undefined;
    }
    return el.value;
  }

  /** Applies a field to the current source; returns false when the value was rejected. */
  function apply(el) {
    const s = current();
    const path = el.dataset.path;
    if (!s || !path) return false;
    const value = readValue(el);
    if (value === undefined) return false;
    const { center, half } = ctx.frame();
    if ((path === "space.type" || path === "angle.type") && value === "raw") return false; // the imported kind
    if (path === "space.type") {
      const space = defaultSpace(value, half);
      if (space.xyz) space.xyz = [...center];
      if (space.origin) space.origin = [...center];
      if (space.lowerLeft) {
        space.lowerLeft = center.map((v) => v - half);
        space.upperRight = center.map((v) => v + half);
      }
      if (value === "cartesian") ["x", "y", "z"].forEach((k, i) => (space[k] = { type: "uniform", a: center[i] - half, b: center[i] + half }));
      s.space = space;
      return true;
    }
    if (path === "angle.type") {
      s.angle = defaultAngle(value);
      return true;
    }
    if (path.endsWith(".type") && path !== "space.type" && path !== "angle.type") {
      // A distribution changes type: keep its range where it has one.
      const at = path.slice(0, -5);
      const old = getPath(s, at);
      const lo = old.a ?? old.mean ?? old.x?.[0] ?? 0;
      const hi = old.b ?? (old.x ? Math.max(...old.x) : lo + 1);
      setPath(s, at, defaultDist(value, [lo, hi > lo ? hi : lo + 1]));
      return true;
    }
    if (path === "time.enabled") {
      s.time = value ? { type: "uniform", a: 0, b: 1e-6 } : null;
      return true;
    }
    if (path === "constraints.domainType") {
      s.constraints.domainType = value || null;
      if (!value) s.constraints.domainIds = [];
      return true;
    }
    if (path === "constraints.energyBounds" || path === "constraints.timeBounds") {
      setPath(s, path, value.length ? value : null);
      return true;
    }
    setPath(s, path, value);
    return true;
  }

  $("src-editor").addEventListener("input", (e) => {
    const path = e.target.dataset.path;
    if (!path || e.target.tagName === "SELECT" || e.target.type === "checkbox") return;
    if (apply(e.target)) {
      renderList();
      renderSummary();
      ctx.changed();
    }
  });
  $("src-editor").addEventListener("change", (e) => {
    const path = e.target.dataset.path;
    if (!path) return;
    if (e.target.tagName === "SELECT" || e.target.type === "checkbox") apply(e.target);
    ctx.commit();
    ctx.changed();
    // Let the focus land on the clicked field before rebuilding (see keepFocus).
    setTimeout(render, 0);
  });

  // ---- ribbon actions ----

  /** Adds a source of `spaceType` sized to the world box, and selects it. */
  function addSource(spaceType) {
    const { center, half } = ctx.frame();
    const s = scene().addSource(spaceType, { size: half });
    if (s.space.xyz) s.space.xyz = [...center];
    if (s.space.origin) s.space.origin = [...center];
    if (s.space.lowerLeft) {
      s.space.lowerLeft = center.map((v) => v - half);
      s.space.upperRight = center.map((v) => v + half);
    }
    if (spaceType === "cartesian") ["x", "y", "z"].forEach((k, i) => (s.space[k] = { type: "uniform", a: center[i] - half, b: center[i] + half }));
    ctx.commit();
    select(s.id);
  }

  function duplicateSource() {
    const s = current();
    if (!s) return;
    const id = Math.max(0, ...sources().map((x) => x.id)) + 1;
    const copy = { ...structuredClone(s), id, name: `${s.name} copy` };
    sources().splice(sources().indexOf(s) + 1, 0, copy);
    ctx.commit();
    select(id);
  }

  function deleteSource() {
    const s = current();
    if (!s) return;
    sources().splice(sources().indexOf(s), 1);
    selected = null;
    ctx.commit();
    ctx.changed();
    render();
    ctx.setMessage(`Deleted ${s.name} (Ctrl+Z to undo).`);
  }

  return {
    render,
    select,
    addSource,
    duplicateSource,
    deleteSource,
    get selected() {
      return selected;
    },
  };
}
