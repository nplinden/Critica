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

/** Energy presets: common fixed-source spectra. */
const ENERGY_PRESETS = [
  ["Watt (U-235 fission)", () => WATT_DEFAULT()],
  ["14.1 MeV (D-T)", () => ({ type: "discrete", x: [14.1e6], p: [1] })],
  ["2.45 MeV (D-D)", () => ({ type: "discrete", x: [2.45e6], p: [1] })],
  ["Maxwell (1.29 MeV)", () => ({ type: "maxwell", theta: 1.2895e6 })],
];

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
  const sel = (path, options, value) => h("select", { dataset: { path } }, options.map(([v, l]) => h("option", { value: v, selected: String(v) === String(value) }, l)));
  const field = (label, control, title) => h("div", { class: "field", title }, h("label", {}, label), control);
  const vec = (label, path, v, title) => field(label, h("div", { class: "vec" }, [0, 1, 2].map((i) => num(`${path}.${i}`, v[i]))), title);
  const section = (title, ...kids) => h("div", { class: "section" }, h("h3", {}, title), ...kids);

  /** Editor of a univariate distribution at `path` ({ type, … }). */
  function distEditor(label, path, d, { unit = "", types = Object.keys(DIST_TYPES) } = {}) {
    if (d.type === "raw") return field(label, h("span", { class: "note" }, `${d.label} distribution, kept as imported (not editable here).`));
    const typeOptions = types.map((t) => [t, DIST_TYPES[t].label]);
    const rows = [field(label, sel(`${path}.type`, typeOptions, d.type))];
    for (const [key, name] of DIST_TYPES[d.type].params) rows.push(field(`  ${name}`, num(`${path}.${key}`, d[key]), unit && !/\(/.test(name) ? unit : ""));
    if (d.type === "discrete" || d.type === "tabular") {
      rows.push(field("  values", numbers(`${path}.x`, d.x, unit ? `in ${unit}, space separated` : "space separated")));
      rows.push(field("  probabilities", numbers(`${path}.p`, d.p, "one per value")));
      if (d.type === "tabular") rows.push(field("  interpolation", sel(`${path}.interpolation`, [["histogram", "histogram"], ["linear-linear", "linear-linear"]], d.interpolation)));
    }
    return h("div", { class: "dist" }, rows);
  }

  function spaceFields(s) {
    switch (s.type) {
      case "point":
        return [vec("Position", "space.xyz", s.xyz)];
      case "box":
        return [
          vec("Lower corner", "space.lowerLeft", s.lowerLeft),
          vec("Upper corner", "space.upperRight", s.upperRight),
          field("Fissionable only", h("input", { type: "checkbox", checked: s.fissionOnly, dataset: { path: "space.fissionOnly" }, style: "justify-self:start" }), "Keep only sites in fissionable materials (OpenMC \"fission\" box)"),
        ];
      case "spherical":
        return [
          vec("Origin", "space.origin", s.origin),
          distEditor("r", "space.r", s.r),
          distEditor("cos θ", "space.cosTheta", s.cosTheta),
          distEditor("φ (rad)", "space.phi", s.phi),
          h("div", { class: "note" }, "A power law r² with uniform cos θ ∈ [−1, 1] and φ ∈ [0, 2π] fills the sphere uniformly."),
        ];
      case "cylindrical":
        return [
          vec("Origin", "space.origin", s.origin),
          distEditor("r", "space.r", s.r),
          distEditor("φ (rad)", "space.phi", s.phi),
          distEditor("z", "space.z", s.z),
          h("div", { class: "note" }, `Along the ${s.zDir ? `axis (${s.zDir.join(", ")})` : "z axis"}, z relative to the origin. A power law r¹ with uniform φ fills the disk uniformly.`),
        ];
      case "cartesian":
        return [distEditor("x", "space.x", s.x), distEditor("y", "space.y", s.y), distEditor("z", "space.z", s.z)];
      default:
        return [h("div", { class: "note" }, `${s.label} spatial distribution, kept as imported (not editable here).`)];
    }
  }

  function angleFields(a) {
    if (a.type === "monodirectional") return [vec("Direction", "angle.uvw", a.uvw)];
    if (a.type === "mu-phi") return [vec("Reference", "angle.uvw", a.uvw, "Direction the polar angle is measured from"), distEditor("μ = cos θ", "angle.mu", a.mu), distEditor("φ (rad)", "angle.phi", a.phi)];
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
      const spaceTypes = Object.entries(SPACE_TYPES);
      const parts = [
        h("h2", {}, "Source"),
        section(
          "Source",
          field("Name", text("name", s.name), "Shown in Critica only: OpenMC sources have no names"),
          field("Particle", sel("particle", PARTICLES.map((p) => [p, p]), s.particle)),
          field("Strength", num("strength", s.strength, { min: 0 }), "Relative probability of this source among all sources"),
        ),
        section("Space", field("Type", sel("space.type", s.space.type === "raw" ? [["raw", s.space.label], ...spaceTypes] : spaceTypes, s.space.type)), spaceFields(s.space)),
        section("Angle", field("Type", sel("angle.type", s.angle.type === "raw" ? [["raw", s.angle.label], ...Object.entries(ANGLE_TYPES)] : Object.entries(ANGLE_TYPES), s.angle.type)), angleFields(s.angle)),
        section(
          "Energy",
          distEditor("Spectrum", "energy", s.energy, { unit: "eV" }),
          h("div", { class: "props-actions preset-row" }, ENERGY_PRESETS.map(([label, make]) => h("button", { class: "tb", onclick: () => edit((ss) => (ss.energy = make())) }, label))),
        ),
        section(
          "Time",
          field("Distribution", h("input", { type: "checkbox", checked: Boolean(s.time), dataset: { path: "time.enabled" }, style: "justify-self:start" }), "Off: every particle is born at t = 0"),
          s.time && distEditor("Time", "time", s.time, { unit: "s", types: ["uniform", "discrete", "tabular", "normal", "powerlaw"] }),
        ),
        h(
          "details",
          { class: "section advanced", open: Boolean(c.domainType || c.fissionable || c.energyBounds || c.timeBounds) },
          h("summary", {}, "Constraints"),
          field("Domain", sel("constraints.domainType", [["", "anywhere"], ...DOMAIN_TYPES.map((d) => [d, `${d}s`])], c.domainType ?? ""), "Reject sites outside these domains"),
          c.domainType && field("Ids", numbers("constraints.domainIds", c.domainIds, `${c.domainType} ids (OpenMC ids)`)),
          field("Fissionable", h("input", { type: "checkbox", checked: c.fissionable, dataset: { path: "constraints.fissionable" }, style: "justify-self:start" }), "Only accept sites in fissionable materials"),
          field("Energy (eV)", numbers("constraints.energyBounds", c.energyBounds, "min max (optional)")),
          field("Time (s)", numbers("constraints.timeBounds", c.timeBounds, "min max (optional)")),
          field("Rejected sites", sel("constraints.rejectionStrategy", [["resample", "resample"], ["kill", "kill (zero weight)"]], c.rejectionStrategy ?? "resample")),
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
