// Materials workspace: library list, editor and live composition summary.
// Materials live in scene.materials, so edits share undo/redo and autosave
// with the geometry.

import { h, keepFocus } from "./ui.js";
import {
  DENSITY_UNITS,
  composition,
  elementDensities,
  validate,
  parseFormula,
  naturalIsotopes,
  isElementSymbol,
  fromLibrary,
  materialToXML,
  canonicalUnits,
} from "./materials/material.js";
import { THERMAL_NAMES } from "./materials/nuclear-data.js";
import { serializeXML } from "./openmc/xml.js";

const $ = (id) => document.getElementById(id);
const sig = (v, n = 6) => (v == null || !Number.isFinite(v) ? "—" : Math.abs(v) !== 0 && (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e5) ? v.toExponential(n - 1) : String(Number(v.toPrecision(n))));
const pct = (v) => (v == null ? "—" : `${sig(v * 100, 5)} %`);
const UNIT_LABELS = { "g/cm3": "g/cm³", "kg/m3": "kg/m³", "atom/b-cm": "atom/b-cm", "atom/cm3": "atom/cm³", sum: "sum of components", macro: "macro (multigroup)" };

/**
 * ctx: {
 *   scene(): Scene, commit(), changed()        // after edits (geometry colors, legend)
 *   colorOf(id): [r,g,b]                       // display color of a material
 *   selectCell(id), setMessage(text, error)
 * }
 */
export function createMaterialsWorkspace(ctx) {
  let selected = null;
  let filter = "";
  let library = null; // PNNL, loaded on first use
  // Formula box drafts survive editor rebuilds (which follow every committed edit).
  const draft = { formula: "", total: "1" };

  const scene = () => ctx.scene();
  const mats = () => Object.values(scene().materials).sort((a, b) => a.id - b.id);
  const current = () => (selected != null ? scene().materials[selected] : null);
  const css = ([r, g, b]) => `rgb(${(r * 255) | 0} ${(g * 255) | 0} ${(b * 255) | 0})`;

  function select(id) {
    selected = id;
    render();
  }

  // ---- list ----

  function renderList() {
    const list = $("mat-list");
    const q = filter.trim().toLowerCase();
    const rows = mats()
      .filter((m) => !q || `${m.id} ${m.name}`.toLowerCase().includes(q))
      .map((m) => {
        const { errors } = validate(m);
        const users = scene().materialUsers(m.id).length;
        return h(
          "div",
          { class: `mat-row${m.id === selected ? " selected" : ""}`, dataset: { id: m.id }, onclick: () => select(m.id), title: errors[0] ?? "" },
          h("span", { class: "swatch", style: `background:${css(ctx.colorOf(m.id))}` }),
          h("span", { class: "oid" }, `#${m.id}`),
          h("span", { class: "name" }, m.name || "(unnamed)"),
          errors.length ? h("span", { class: "badge err" }, "⚠") : null,
          users ? h("span", { class: "badge", title: `Used by ${users} cell(s)` }, `×${users}`) : null,
        );
      });
    list.replaceChildren(...(rows.length ? rows : [h("div", { class: "empty-props" }, q ? "No match." : "No materials yet. Create one or add one from the library.")]));
  }

  // ---- editor ----

  const num = (path, value, opts = {}) =>
    h("input", { type: "number", step: opts.step ?? "any", min: opts.min, value: value ?? "", placeholder: opts.placeholder ?? "", disabled: opts.disabled, dataset: { path, optional: opts.optional ? "1" : "" } });
  const text = (path, value, opts = {}) => h("input", { type: "text", value: value ?? "", placeholder: opts.placeholder ?? "", list: opts.list, dataset: { path }, spellcheck: false });
  const sel = (path, options, value) => h("select", { dataset: { path } }, options.map(([v, l]) => h("option", { value: v, selected: String(v) === String(value) }, l)));
  const field = (label, control, title) => h("div", { class: "field", title }, h("label", {}, label), control);

  function componentRows(m) {
    const rows = [];
    m.components.forEach((c, i) => {
      const p = `components.${i}`;
      const enriched = c.kind === "element" && (c.enrichment != null || c.showEnrichment);
      rows.push(
        h(
          "div",
          { class: "comp-row" },
          sel(`${p}.kind`, [["nuclide", "Nuclide"], ["element", "Element"]], c.kind),
          text(`${p}.name`, c.name, { placeholder: c.kind === "element" ? "Fe" : "U235" }),
          num(`${p}.percent`, c.percent, { min: 0 }),
          c.kind === "element"
            ? h("button", { class: `tb icon-btn${enriched ? " on" : ""}`, title: "Enrichment", onclick: () => toggleEnrichment(i) }, "⇅")
            : h("span"),
          h("button", { class: "tb icon-btn", title: "Remove", onclick: () => edit((mm) => mm.components.splice(i, 1)) }, "✕"),
        ),
      );
      if (enriched) rows.push(enrichmentRow(c, p));
    });
    return rows;
  }

  function enrichmentRow(c, p) {
    const iso = isElementSymbol(c.name) ? naturalIsotopes(c.name).map(([n]) => n) : [];
    const isU = c.name === "U";
    const targets = isU ? [["", "U235 (weight %, ORNL correlation)"]] : [["", "—"], ...iso.map((n) => [n, n])];
    return h(
      "div",
      { class: "comp-row enrich-row" },
      h("span", { class: "muted" }, "enrich"),
      num(`${p}.enrichment`, c.enrichment, { min: 0, optional: true, placeholder: "natural" }),
      sel(`${p}.enrichmentTarget`, targets, c.enrichmentTarget ?? ""),
      isU ? h("span", { class: "muted" }, "wo %") : sel(`${p}.enrichmentType`, [["ao", "atom %"], ["wo", "weight %"]], c.enrichmentType ?? "ao"),
      h("span"),
    );
  }

  function toggleEnrichment(i) {
    const c = current().components[i];
    if (c.enrichment != null || c.showEnrichment) {
      edit((m) => {
        const cc = m.components[i];
        delete cc.enrichment;
        delete cc.enrichmentTarget;
        delete cc.enrichmentType;
        delete cc.showEnrichment;
      });
    } else {
      c.showEnrichment = true; // UI-only flag until a value is entered
      renderEditor();
    }
  }

  function renderEditor() {
    const panel = $("mat-editor");
    const m = current();
    keepFocus(panel, () => {
      if (!m) {
        panel.replaceChildren(h("h2", {}, "Material"), h("div", { class: "empty-props" }, "Select a material in the library, or create one."));
        return;
      }
      const units = canonicalUnits(m.density.units);
      const type = m.components[0]?.type ?? "ao";
      const formula = h("input", { type: "text", placeholder: "e.g. UO2, H2O, Ca(OH)2", spellcheck: false, class: "formula-input", value: draft.formula, dataset: { path: "draft.formula" } });
      const formulaTotal = h("input", { type: "number", step: "any", min: 0, value: draft.total, class: "formula-total", title: "Total amount for the formula's elements", dataset: { path: "draft.total" } });
      const addFormula = () => {
        try {
          const parts = parseFormula(formula.value.trim());
          const total = Number(formulaTotal.value) || 1;
          draft.formula = "";
          edit((mm) => mm.components.push(...parts.map((e) => ({ kind: "element", name: e.symbol, percent: e.fraction * total, type }))));
        } catch (e) {
          ctx.setMessage(`Formula: ${e.message}`, true);
        }
      };
      formula.addEventListener("keydown", (e) => e.key === "Enter" && addFormula());
      panel.replaceChildren(
        h("h2", {}, "Material"),
        h(
          "div",
          { class: "section" },
          field("Name", text("name", m.name)),
          field("ID", num("id", m.id, { min: 1, step: 1 }), "Referenced by cells (material=\"…\")"),
          field(
            "Color",
            h(
              "div",
              { class: "color-field" },
              h("input", { type: "color", value: toHex(ctx.colorOf(m.id)), dataset: { path: "color" } }),
              h("span", { class: "oid" }, m.color ?? "auto"),
              m.color && h("button", { class: "tb", onclick: () => edit((mm) => delete mm.color) }, "Auto"),
            ),
            "Display color in the geometry when coloring by material",
          ),
          field("Depletable", h("input", { type: "checkbox", checked: m.depletable, dataset: { path: "depletable" }, style: "justify-self:start" })),
        ),
        h(
          "div",
          { class: "section" },
          h("h3", {}, "Density"),
          h("div", { class: "density-row" }, num("density.value", units === "sum" ? null : m.density.value, { min: 0, disabled: units === "sum", placeholder: units === "sum" ? "sum" : units === "macro" ? "×1" : "" }), sel("density.units", DENSITY_UNITS.map((u) => [u, UNIT_LABELS[u]]), units)),
          h("div", { class: "note" }, units === "sum" ? "Component amounts are absolute: atom/b-cm (atom fractions) or g/cm³ (weight fractions)." : "Component amounts are relative and get normalized."),
          field("Temperature", h("div", { class: "unit-input" }, num("temperature", m.temperature, { optional: true, placeholder: "default" }), h("span", { class: "muted" }, "K"))),
          field("Volume", h("div", { class: "unit-input" }, num("volume", m.volume, { optional: true, min: 0, placeholder: "—" }), h("span", { class: "muted" }, "cm³"))),
        ),
        h(
          "div",
          { class: "section" },
          h("h3", {}, "Composition"),
          m.macroscopic
            ? h("div", { class: "note" }, `Macroscopic data set "${m.macroscopic}" (multigroup); remove it under Advanced to list nuclides.`)
            : [
                field("Fractions", sel("fractionType", [["ao", "atom (ao)"], ["wo", "weight (wo)"]], type), "Applies to every component (OpenMC does not allow mixing)"),
                h("div", { class: "comp-head" }, h("span", {}, "Kind"), h("span", {}, "Name"), h("span", {}, units === "sum" ? (type === "ao" ? "atom/b-cm" : "g/cm³") : "Amount"), h("span"), h("span")),
                componentRows(m),
                h(
                  "div",
                  { class: "props-actions" },
                  h("button", { class: "tb", onclick: () => edit((mm) => mm.components.push({ kind: "nuclide", name: "", percent: 1, type })) }, "+ Nuclide"),
                  h("button", { class: "tb", onclick: () => edit((mm) => mm.components.push({ kind: "element", name: "", percent: 1, type })) }, "+ Element"),
                ),
                h("div", { class: "formula-row" }, formula, formulaTotal, h("button", { class: "tb", onclick: addFormula, title: "Add the formula's elements (like add_elements_from_formula)" }, "+ Formula")),
              ],
        ),
        h(
          "div",
          { class: "section" },
          h("h3", {}, "Thermal scattering S(α,β)"),
          m.sab.map((s, i) =>
            h(
              "div",
              { class: "sab-row" },
              text(`sab.${i}.name`, s.name, { list: "thermal-names", placeholder: "c_H_in_H2O" }),
              num(`sab.${i}.fraction`, s.fraction, { min: 0, step: 0.05 }),
              h("button", { class: "tb icon-btn", title: "Remove", onclick: () => edit((mm) => mm.sab.splice(i, 1)) }, "✕"),
            ),
          ),
          h("datalist", { id: "thermal-names" }, THERMAL_NAMES.map((n) => h("option", { value: n }))),
          h("div", { class: "props-actions" }, h("button", { class: "tb", onclick: () => edit((mm) => mm.sab.push({ name: "", fraction: 1 })) }, "+ S(α,β) table")),
        ),
        h(
          "details",
          { class: "section advanced", open: Boolean(m.macroscopic || m.cfg || m.isotropic.length) },
          h("summary", {}, "Advanced"),
          field("Isotropic", text("isotropic", m.isotropic.join(" "), { placeholder: "nuclides, space separated" }), "Nuclides with isotropic-in-lab elastic scattering"),
          field("Macroscopic", text("macroscopic", m.macroscopic ?? "", { placeholder: "multigroup data set" })),
          field("NCrystal cfg", text("cfg", m.cfg ?? "", { placeholder: "e.g. Al_sg225.ncmat" })),
        ),
      );
    });
  }

  // ---- summary ----

  function renderSummary() {
    const panel = $("mat-summary");
    const m = current();
    if (!m) {
      panel.replaceChildren(h("h2", {}, "Summary"), h("div", { class: "empty-props" }, `${mats().length} material(s) in the library.`));
      return;
    }
    const { errors, warnings } = validate(m);
    let comp = null;
    let elements = null;
    if (!errors.length) {
      try {
        comp = composition(m);
        elements = elementDensities(m);
      } catch (e) {
        errors.push(e.message);
      }
    }
    const users = scene().materialUsers(m.id);
    const info = (label, value) => [h("span", { class: "info-label" }, label), h("span", {}, value)];
    const totalEl = elements ? Object.values(elements).reduce((s, v) => s + v, 0) : 0;
    let xml = "";
    if (!errors.length) {
      try {
        xml = serializeXML(materialToXML(m));
      } catch (e) {
        errors.push(e.message);
      }
    }
    // Conditional sections are false when absent; replaceChildren would print them.
    const sections = [
      h("h2", {}, "Summary"),
      (errors.length > 0 || warnings.length > 0) &&
        h("div", { class: "section" }, errors.map((e) => h("div", { class: "msg-err" }, `✕ ${e}`)), warnings.map((w) => h("div", { class: "msg-warn" }, `⚠ ${w}`))),
      comp &&
        h(
          "div",
          { class: "section" },
          h("h3", {}, "Totals"),
          h("div", { class: "info" }, ...info("mass density", `${sig(comp.massDensity)} g/cm³`), ...info("atom density", `${sig(comp.atomDensity)} atom/b-cm`), ...info("molar mass", `${sig(comp.molarMass)} g/mol`), ...info("nuclides", String(comp.nuclides.length))),
        ),
      elements &&
        h(
          "div",
          { class: "section" },
          h("h3", {}, "Elements"),
          h("table", { class: "comp-table" }, h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", {}, "atom %"), h("th", {}, "atom/b-cm"))), h("tbody", {}, Object.entries(elements).map(([sym, n]) => h("tr", {}, h("td", {}, sym), h("td", {}, pct(n / totalEl)), h("td", {}, sig(n, 5)))))),
        ),
      comp &&
        h(
          "details",
          { class: "section" },
          h("summary", {}, `Nuclides (${comp.nuclides.length})`),
          h("table", { class: "comp-table" }, h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", {}, "atom %"), h("th", {}, "wt %"), h("th", {}, "atom/b-cm"))), h("tbody", {}, comp.nuclides.map((n) => h("tr", {}, h("td", {}, n.name), h("td", {}, pct(n.atomFraction)), h("td", {}, pct(n.weightFraction)), h("td", {}, sig(n.atomDensity, 5)))))),
        ),
      h(
        "div",
        { class: "section" },
        h("h3", {}, "Used by"),
        users.length
          ? h("div", { class: "users" }, users.map((c) => h("button", { class: "link-button", onclick: () => ctx.selectCell(c.id) }, c.name)))
          : h("div", { class: "note" }, "No cell uses this material yet."),
      ),
      xml && h("details", { class: "section" }, h("summary", {}, "OpenMC XML"), h("pre", { class: "xml-preview" }, xml)),
    ];
    panel.replaceChildren(...sections.filter(Boolean));
  }

  function render() {
    if (selected != null && !scene().materials[selected]) selected = null;
    if (selected == null && mats().length) selected = mats()[0].id;
    renderList();
    renderEditor();
    renderSummary();
  }

  // ---- editing ----

  /** Applies a structural edit, commits and re-renders. */
  function edit(fn) {
    const m = current();
    if (!m) return;
    fn(m);
    ctx.commit();
    ctx.changed();
    render();
  }

  function setPath(m, path, value) {
    const keys = path.split(".");
    const last = keys.pop();
    let o = m;
    for (const k of keys) o = o[k];
    o[last] = value;
  }

  function readValue(el) {
    if (el.type === "checkbox") return el.checked;
    if (el.type === "number") {
      if (el.value === "") return el.dataset.optional ? null : undefined;
      const v = Number(el.value);
      return Number.isFinite(v) ? v : undefined;
    }
    return el.value;
  }

  /** Applies a field to the current material; returns false if the value was rejected. */
  function apply(el) {
    const m = current();
    const path = el.dataset.path;
    if (!m || !path) return false;
    const value = readValue(el);
    if (value === undefined) return false;
    if (path === "id") return false; // handled on change (renames references)
    if (path === "fractionType") {
      for (const c of m.components) c.type = value;
      return true;
    }
    if (path === "isotropic") {
      m.isotropic = String(value).split(/[\s,]+/).filter(Boolean);
      return true;
    }
    if (path === "macroscopic" || path === "cfg") {
      m[path] = String(value).trim() || null;
      return true;
    }
    if (path.endsWith(".enrichmentTarget") || path.endsWith(".enrichmentType")) {
      setPath(m, path, value || undefined);
      return true;
    }
    if (path.endsWith(".kind") && value === "element") {
      // Turning a nuclide into an element keeps just the symbol.
      const i = Number(path.split(".")[1]);
      m.components[i].name = m.components[i].name.replace(/\d.*$/, "");
    }
    setPath(m, path, value);
    return true;
  }

  function onInput(e) {
    if (e.target.dataset.path?.startsWith("draft.")) {
      draft[e.target.dataset.path.slice(6)] = e.target.value;
      return;
    }
    if (e.target.tagName === "SELECT" || !e.target.dataset.path) return;
    if (apply(e.target)) {
      renderList();
      renderSummary();
      ctx.changed();
    }
  }

  function onChange(e) {
    const path = e.target.dataset.path;
    if (!path || path.startsWith("draft.")) return;
    const m = current();
    if (path === "id") {
      const v = Number(e.target.value);
      try {
        if (!Number.isInteger(v) || v < 1) throw new Error("material ids are positive integers");
        scene().renameMaterial(m.id, v);
        selected = v;
      } catch (err) {
        ctx.setMessage(err.message, true);
        e.target.value = String(m.id);
        return;
      }
    } else {
      apply(e.target);
    }
    ctx.commit();
    ctx.changed();
    // Let the focus land on the clicked field before rebuilding (see keepFocus).
    setTimeout(render, 0);
  }

  $("mat-editor").addEventListener("input", onInput);
  $("mat-editor").addEventListener("change", onChange);

  // ---- list actions ----

  $("mat-search").addEventListener("input", (e) => {
    filter = e.target.value;
    renderList();
  });
  $("mat-new").onclick = () => {
    const m = scene().addMaterial();
    ctx.commit();
    ctx.changed();
    select(m.id);
  };
  $("mat-duplicate").onclick = () => {
    const m = current();
    if (!m) return;
    const copy = scene().addMaterial({ ...JSON.parse(JSON.stringify(m)), id: undefined, name: `${m.name} copy` });
    delete copy.color;
    ctx.commit();
    ctx.changed();
    select(copy.id);
  };
  $("mat-delete").onclick = () => {
    const m = current();
    if (!m) return;
    const users = scene().materialUsers(m.id).length;
    delete scene().materials[m.id];
    selected = null;
    ctx.commit();
    ctx.changed();
    render();
    ctx.setMessage(users ? `Deleted material ${m.id}; ${users} cell(s) still reference it (Ctrl+Z to undo).` : `Deleted material ${m.id}.`, users > 0);
  };

  // ---- library picker (PNNL compendium bundled with OpenMC) ----

  async function openLibrary() {
    library ??= (await import("./materials/pnnl_v2.js")).default;
    const dialog = $("library-picker");
    const search = $("library-search");
    const list = $("library-list");
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const names = Object.keys(library.materials).filter((n) => !q || n.toLowerCase().includes(q));
      list.replaceChildren(
        ...names.slice(0, 400).map((n) =>
          h(
            "button",
            {
              class: "lib-row",
              onclick: () => {
                const m = fromLibrary(library, n, Math.max(0, ...Object.keys(scene().materials).map(Number)) + 1);
                scene().materials[m.id] = m;
                ctx.commit();
                ctx.changed();
                dialog.close();
                select(m.id);
              },
            },
            h("span", { class: "name" }, n),
            h("span", { class: "muted" }, `${sig(library.materials[n].density, 4)} g/cm³`),
          ),
        ),
      );
      $("library-count").textContent = `${names.length} of ${Object.keys(library.materials).length}`;
    };
    search.oninput = draw;
    search.value = "";
    draw();
    $("library-source").textContent = `${library.source.title} (${library.source.report}), as bundled with OpenMC.`;
    dialog.showModal();
    search.focus();
  }
  $("mat-library").onclick = () => openLibrary();

  return {
    render,
    select,
    /** Selects the first material, or keeps the current one. */
    get selected() {
      return selected;
    },
  };
}

function toHex(rgb) {
  return `#${rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
}
