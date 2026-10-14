// Settings workspace: the simulation settings written into OpenMC's
// <settings> (run mode, particles and batches, triggers, physics,
// temperature, output). Values live in scene.settings.values, so edits share
// undo/redo and autosave with the geometry. An empty field means OpenMC's
// default and writes nothing.

import { h, keepFocus } from "./ui.js";
import { SETTINGS_FIELDS, SETTINGS_GROUPS, fieldApplies, validateSettings } from "./settings/settings.js";

const $ = (id) => document.getElementById(id);

const hint = (f) => (f.default === undefined ? "" : `default ${f.type === "bool" ? (f.default ? "on" : "off") : f.default}${f.unit ? ` ${f.unit}` : ""}`);

/**
 * ctx: {
 *   scene(), commit(), changed()
 *   settingsXML(): { text, warnings }     // the settings.xml that would be exported
 *   setMessage(text, error)
 * }
 */
export function createSettingsWorkspace(ctx) {
  const values = () => ctx.scene().settings.values;

  function control(f) {
    const v = values()[f.key];
    const data = { key: f.key };
    switch (f.type) {
      case "enum":
        return h(
          "select",
          { dataset: data },
          h("option", { value: "", selected: v === undefined }, f.default !== undefined ? `default (${f.default})` : "—"),
          f.options.map((o) => h("option", { value: o, selected: v === o }, o)),
        );
      case "bool":
        return h(
          "select",
          { dataset: data },
          [["", f.default !== undefined ? `default (${f.default ? "on" : "off"})` : "—"], ["true", "on"], ["false", "off"]].map(([val, label]) =>
            h("option", { value: val, selected: v === undefined ? val === "" : String(v) === val }, label),
          ),
        );
      case "int":
      case "float":
        return h("input", { type: "number", step: f.type === "int" ? "1" : "any", min: f.min, max: f.max, value: v ?? "", placeholder: hint(f) || "—", dataset: data });
      case "ints":
      case "floats":
        return h("input", { type: "text", value: (v ?? []).join(" "), placeholder: f.count ? `${f.count} values${f.unit ? ` (${f.unit})` : ""}` : "space separated", spellcheck: false, dataset: { ...data, kind: "list" } });
      default:
        return h("input", { type: "text", value: v ?? "", placeholder: hint(f) || "—", spellcheck: false, dataset: data });
    }
  }

  function renderForm() {
    const panel = $("settings-form");
    keepFocus(panel, () => {
      const vals = values();
      const groups = Object.entries(SETTINGS_GROUPS).map(([group, title]) => {
        const fields = SETTINGS_FIELDS.filter((f) => f.group === group && fieldApplies(f, vals));
        return h(
          "div",
          { class: "settings-card" },
          h("h3", {}, title),
          fields.map((f) =>
            h(
              "div",
              { class: "field", title: f.help ?? "" },
              h("label", {}, f.label),
              h("div", { class: f.unit && (f.type === "float" || f.type === "int") ? "unit-input" : "" }, control(f), f.unit && (f.type === "float" || f.type === "int") ? h("span", { class: "muted" }, f.unit) : null),
            ),
          ),
        );
      });
      panel.replaceChildren(
        h("h2", {}, "Simulation settings"),
        h("div", { class: "note settings-intro" }, "Empty fields use OpenMC's default and are not written. Settings of an opened model.xml or settings.xml that are not listed here are kept and written back."),
        h("div", { class: "settings-grid" }, groups),
      );
    });
  }

  function renderSummary() {
    const { errors, warnings } = validateSettings(values(), { sources: ctx.scene().sources.length });
    let xml = "";
    try {
      xml = ctx.settingsXML().text;
    } catch (e) {
      errors.push(e.message);
    }
    const parts = [
      h("h2", {}, "Summary"),
      h(
        "div",
        { class: "section" },
        errors.length || warnings.length ? [errors.map((e) => h("div", { class: "msg-err" }, `✕ ${e}`)), warnings.map((w) => h("div", { class: "msg-warn" }, `⚠ ${w}`))] : h("div", { class: "note" }, "Ready to run."),
      ),
      xml && h("div", { class: "section" }, h("h3", {}, "settings.xml"), h("pre", { class: "xml-preview settings-xml" }, xml)),
    ];
    $("settings-summary").replaceChildren(...parts.filter(Boolean));
    // The ribbon's run mode buttons show the current mode.
    for (const b of document.querySelectorAll("[data-run-mode]")) b.classList.toggle("on", (values().run_mode ?? "eigenvalue") === b.dataset.runMode);
  }

  function render() {
    renderForm();
    renderSummary();
  }

  function read(el) {
    const f = SETTINGS_FIELDS.find((x) => x.key === el.dataset.key);
    const raw = el.value.trim();
    if (raw === "") return { f, value: undefined };
    if (f.type === "bool") return { f, value: raw === "true" };
    if (f.type === "int" || f.type === "float") {
      const n = Number(raw);
      return Number.isFinite(n) ? { f, value: f.type === "int" ? Math.round(n) : n } : { f, invalid: true };
    }
    if (el.dataset.kind === "list") {
      const xs = raw.split(/[\s,;]+/).map(Number);
      return xs.every(Number.isFinite) ? { f, value: xs } : { f, invalid: true };
    }
    return { f, value: raw };
  }

  function apply(el) {
    const { f, value, invalid } = read(el);
    if (!f || invalid) return false;
    if (value === undefined) delete values()[f.key];
    else values()[f.key] = value;
    return true;
  }

  $("settings-form").addEventListener("input", (e) => {
    if (!e.target.dataset.key || e.target.tagName === "SELECT") return;
    if (apply(e.target)) renderSummary();
  });
  $("settings-form").addEventListener("change", (e) => {
    if (!e.target.dataset.key) return;
    apply(e.target);
    ctx.commit();
    ctx.changed();
    // The run and energy modes show or hide fields.
    setTimeout(render, 0);
  });

  function setRunMode(mode) {
    const v = values();
    v.run_mode = mode;
    // Eigenvalue and fixed source runs need particles and batches.
    if (mode === "eigenvalue" || mode === "fixed source") {
      v.particles ??= 1000;
      v.batches ??= mode === "eigenvalue" ? 100 : 10;
      if (mode === "eigenvalue") v.inactive ??= 10;
    }
    ctx.commit();
    ctx.changed();
    render();
  }

  function resetDefaults(defaults) {
    ctx.scene().settings.values = defaults;
    ctx.commit();
    ctx.changed();
    render();
    ctx.setMessage("Settings reset to the defaults of a new scene (Ctrl+Z to undo).");
  }

  return { render, setRunMode, resetDefaults };
}
