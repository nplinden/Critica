// Interactive CSG builder: toolbar → scene tree → evaluator → viewer.
// Scenes can mix builder shapes with OpenMC-style cells, half-spaces and
// universes, and round-trip through OpenMC geometry/model XML.

import { init } from "../pkg/critica.js";
import { h, keepFocus } from "./ui.js";
import { createViewer } from "./viewer.js";
import {
  Scene,
  Evaluator,
  PRIMITIVES,
  OPERATIONS,
  isOperation,
  isPrimitive,
  isCell,
  isUniverse,
  isRegionNode,
  mergeMeshes,
  meshBounds,
} from "./scene.js";
import { SURFACE_TYPES, BOUNDARY_TYPES } from "./openmc/surfaces.js";
import { compositeExpansion, isIdentity } from "./scene.js";
import { importOpenMC, importMaterialsXML, importSettingsXML } from "./openmc/import.js";
import { exportOpenMC, exportMaterialsXML, exportSettingsXML, primitiveSurfaces } from "./openmc/export.js";
import { transformSurface, toForm, transformForm, isPlane, evaluate as evaluateSurface } from "./openmc/surfaces.js";
import { fromTransform, multiply, IDENTITY, invert, transformPoint } from "./mat4.js";
import { createMaterialsWorkspace } from "./materials-ui.js";
import { createSourcesWorkspace } from "./sources-ui.js";
import { createSettingsWorkspace } from "./settings-ui.js";
import { defaultSettings } from "./settings/settings.js";
import { sourceShape } from "./source/source.js";
import { COMPOSITE_TYPES } from "./openmc/composite.js";

const STORAGE_KEY = "critica.builder.scene.v2";
const HISTORY_LIMIT = 200;
const PALETTE = [
  [0.42, 0.71, 1.0],
  [1.0, 0.62, 0.35],
  [0.55, 0.85, 0.5],
  [0.85, 0.55, 0.9],
  [0.4, 0.85, 0.85],
  [0.95, 0.5, 0.55],
  [0.75, 0.75, 0.45],
  [0.6, 0.65, 1.0],
];
const VOID_COLOR = [0.55, 0.58, 0.62];
const PLACEHOLDER_COLOR = [0.45, 0.45, 0.5];
const NO_MATERIAL_COLOR = [0.7, 0.7, 0.66];
const HIGHLIGHT = [1.0, 0.82, 0.4];
const INT_PARAMS = new Set(["slices", "stacks", "segments", "rings"]);

const ICONS = {
  cutaway: '<path d="M8 1.5 14 5v6l-6 3.5L2 11V5z" stroke-opacity=".45"/><path d="M8 1.5V8l6-3M8 8l-6-3M8 8v6.5" stroke-dasharray="1.6 1.4"/><path d="M8 8 14 5v6l-6 3.5z" fill="currentColor" fill-opacity=".35"/>',
  fit: '<path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5"/><rect x="5" y="5" width="6" height="6" rx="1"/>',
  palette: '<path d="M8 1.8a6.2 6.2 0 1 0 0 12.4c1 0 1.4-.7 1.1-1.5-.4-.9.2-1.8 1.2-1.8h1.6a2.3 2.3 0 0 0 2.3-2.3C14.2 4.9 11.4 1.8 8 1.8z"/><circle cx="5" cy="7" r="1"/><circle cx="7.5" cy="4.6" r="1"/><circle cx="10.6" cy="5.6" r="1"/>',
  void: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5" stroke-dasharray="2 1.6"/>',
  worldbox: '<path d="M2 5h9v9H2z M2 5l3-3h9l-3 3 M14 2v9l-3 3"/>',
  isolate: '<circle cx="8" cy="8" r="2.6" fill="currentColor" fill-opacity=".45"/><circle cx="8" cy="8" r="6" stroke-dasharray="1.4 1.6"/>',
  xray: '<path d="M8 1.5 14 5v6l-6 3.5L2 11V5z M2 5l6 3.5L14 5 M8 8.5v6" stroke-dasharray="1.4 1.3"/>',
  add: '<path d="M8 3v10M3 8h10"/>',
  keff: '<path d="M8 13.5c-3 0-5-2-5-4.5C3 6 6 4.5 8 1.5c2 3 5 4.5 5 7.5 0 2.5-2 4.5-5 4.5z"/><path d="M8 11c-1.2 0-2-.8-2-1.9C6 7.8 7.2 7 8 5.6c.8 1.4 2 2.2 2 3.5 0 1.1-.8 1.9-2 1.9z" fill="currentColor" fill-opacity=".4"/>',
  reset: '<path d="M3 8a5 5 0 1 0 1.5-3.5M3 2.5v2.5h2.5"/>',
  srcpoint: '<circle cx="8" cy="8" r="2" fill="currentColor" fill-opacity=".5"/><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M3.4 3.4l2.1 2.1M10.5 10.5l2.1 2.1M3.4 12.6l2.1-2.1M10.5 5.5l2.1-2.1"/>',
  sources: '<circle cx="8" cy="8" r="1.6" fill="currentColor"/><circle cx="8" cy="8" r="4" stroke-dasharray="1.5 1.5"/><circle cx="8" cy="8" r="6.5" stroke-opacity=".5" stroke-dasharray="1.5 2"/>',
  axes: '<path d="M3 13V3M3 13h10M3 13l6-4" /><path d="M3 3 2 4.5M3 3l1 1.5M13 13l-1.5-1M13 13l-1.5 1"/>',
  grid: '<path d="M1.5 10.5 6 5.5h8.5L10 10.5z M3.8 8h8.9 M8.4 5.5 5.7 10.5 M11.3 5.5 8.6 10.5" stroke-opacity=".9"/>',
  xml: '<path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4M9.2 2.5 6.8 13.5"/>',
  more: '<rect x="2" y="2" width="5" height="5" rx="1"/><circle cx="11.5" cy="4.5" r="2.5"/><path d="M4.5 9 7 14H2z"/><path d="M9 11.5h5M11.5 9v5"/>',
  library: '<path d="M2.5 2.5h3v11h-3z M6.5 2.5h3v11h-3z M10.3 3.2l2.8-.8 2.4 10.6-2.8.8z"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9"/>',
  cube: '<path d="M8 1.5 14 5v6l-6 3.5L2 11V5z M2 5l6 3.5L14 5 M8 8.5v6"/>',
  sphere: '<circle cx="8" cy="8" r="6"/><ellipse cx="8" cy="8" rx="6" ry="2.2"/>',
  cylinder: '<ellipse cx="8" cy="3.5" rx="5" ry="2"/><path d="M3 3.5v9c0 1.1 2.2 2 5 2s5-.9 5-2v-9"/>',
  cone: '<path d="M8 1.5 3 12.5c0 1.1 2.2 2 5 2s5-.9 5-2z"/><path d="M3 12.5c0-1.1 2.2-2 5-2s5 .9 5 2" stroke-opacity=".5"/>',
  torus: '<ellipse cx="8" cy="8" rx="6.5" ry="4"/><ellipse cx="8" cy="7.6" rx="2.6" ry="1.2"/>',
  union:
    '<path d="M8 3.97A4.5 4.5 0 1 0 8 12.03 4.5 4.5 0 1 0 8 3.97z" fill="currentColor" fill-opacity=".45"/><circle cx="6" cy="8" r="4.5"/><circle cx="10" cy="8" r="4.5"/>',
  subtract:
    '<path d="M8 3.97A4.5 4.5 0 1 0 8 12.03 4.5 4.5 0 0 1 8 3.97z" fill="currentColor" fill-opacity=".45"/><circle cx="6" cy="8" r="4.5"/><circle cx="10" cy="8" r="4.5" stroke-dasharray="1.5 1.5"/>',
  intersect:
    '<path d="M8 3.97A4.5 4.5 0 0 1 8 12.03 4.5 4.5 0 0 1 8 3.97z" fill="currentColor" fill-opacity=".45"/><circle cx="6" cy="8" r="4.5"/><circle cx="10" cy="8" r="4.5"/>',
  complement:
    '<path d="M1.5 3h13v10h-13z M8 4.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 1 0 0-6.4z" fill="currentColor" fill-opacity=".45" fill-rule="evenodd"/><circle cx="8" cy="8" r="3.2"/>',
  halfspace: '<rect x="2" y="2" width="12" height="12" rx="1"/><path d="M2 14 14 2v12z" fill="currentColor" fill-opacity=".45"/>',
  cell: '<rect x="2" y="2" width="12" height="12" rx="2.5"/><circle cx="8" cy="8" r="2.6" fill="currentColor"/>',
  universe: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2.6 2 2.6 10 0 12M8 2c-2.6 2-2.6 10 0 12"/>',
  ungroup: '<rect x="1.5" y="1.5" width="6" height="6" rx="1"/><rect x="8.5" y="8.5" width="6" height="6" rx="1"/><path d="M10 2.5h3.5V6M6 13.5H2.5V10" stroke-dasharray="1.5 1.5"/>',
  duplicate: '<rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 3v-.5a1 1 0 0 0-1-1H2.5a1 1 0 0 0-1 1V10a1 1 0 0 0 1 1H3"/>',
  composite: '<path d="M2 14V6l4-3 4 3v8z" fill="currentColor" fill-opacity=".3"/><path d="M2 14V6l4-3 4 3v8M10 9h4v5h-4"/><circle cx="12" cy="5" r="2.2"/>',
  expand: '<path d="M2 8h12M8 2v12" stroke-dasharray="1.6 1.4"/><rect x="2" y="2" width="12" height="12" rx="1.5"/>',
  plane: '<path d="M4.5 4h10l-3 8h-10z" fill="currentColor" fill-opacity=".3"/>',
  infcylinder: '<path d="M4 1.5v13M12 1.5v13"/><ellipse cx="8" cy="8" rx="4" ry="1.6"/><path d="M4 1.5h8M4 14.5h8" stroke-dasharray="1.2 1.4" stroke-opacity=".6"/>',
  infcone: '<path d="M3 1.5l10 13M13 1.5l-10 13"/><ellipse cx="8" cy="2" rx="5" ry="1.1" stroke-opacity=".5"/><ellipse cx="8" cy="14" rx="5" ry="1.1" stroke-opacity=".5"/>',
  ref: '<path d="M6.3 9.7l3.4-3.4"/><path d="M7.2 4.6l1.1-1.1a2.7 2.7 0 0 1 3.8 3.8l-1.1 1.1"/><path d="M8.8 11.4l-1.1 1.1a2.7 2.7 0 0 1-3.8-3.8l1.1-1.1"/>',
};

const $ = (id) => document.getElementById(id);

function icon(name, color) {
  const span = document.createElement("span");
  span.innerHTML = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
  const svg = span.firstChild;
  if (color) svg.style.color = color;
  return svg;
}

const leafColor = (id) => PALETTE[id % PALETTE.length];
const css = ([r, g, b]) => `rgb(${(r * 255) | 0} ${(g * 255) | 0} ${(b * 255) | 0})`;
const fmt = (v) => (Math.abs(v) >= 1000 ? v.toFixed(0) : Number(v.toPrecision(5)).toString());

/** Well-separated colors for integer keys: golden-angle hues at fixed saturation/lightness. */
function distinctColor(n, offset = 0) {
  const h = (((n * 0.61803398875 + offset) % 1) + 1) % 1;
  const sat = 0.55;
  const light = 0.6;
  const k = (m) => (m + h * 12) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (m) => light - a * Math.max(-1, Math.min(k(m) - 3, 9 - k(m), 1));
  return [f(0), f(8), f(4)];
}

/** First material of a fill ("1", "void", or a distributed list "1 2 void"). */
const firstMaterial = (material) => String(material).trim().split(/\s+/)[0];

function materialColor(material) {
  const m = firstMaterial(material);
  if (m === "void") return VOID_COLOR;
  const custom = scene?.materials?.[m]?.color;
  if (/^#[0-9a-f]{6}$/i.test(custom ?? "")) return fromHex(custom);
  if (/^\d+$/.test(m)) return distinctColor(Number(m), 0.11);
  let hash = 0;
  for (const ch of m) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return distinctColor(hash, 0.11);
}

/** Colors cells by material ("material" mode) or give each cell its own color ("cell" mode). */
const toHex = (rgb) => `#${rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
const fromHex = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

/** Automatic cell color (ignoring any custom display color). */
function autoCellColor(cell) {
  if (cell.fill.type !== "material") return PLACEHOLDER_COLOR;
  if (colorBy === "material") return materialColor(cell.fill.material);
  return isVoidCell(cell) ? VOID_COLOR : distinctColor(cell.id);
}

/** Cell color: a custom display color wins when coloring by cell. */
function cellColor(cell) {
  if (colorBy === "cell" && /^#[0-9a-f]{6}$/i.test(cell.color ?? "")) return fromHex(cell.color);
  return autoCellColor(cell);
}

const isVoidCell = (n) => isCell(n) && n.fill.type === "material" && String(n.fill.material).trim() === "void";

// ---- state -------------------------------------------------------------------

const geo = await init();
const evaluator = new Evaluator(geo);
const meshCache = new WeakMap(); // Solid -> mesh
// ---- theme (a viewer preference: browser storage, not part of the scene) ----
const THEME_KEY = "critica.theme";
const systemLight = window.matchMedia("(prefers-color-scheme: light)");
let themePref = document.documentElement.dataset.theme || "dark"; // set early by index.html
const effectiveTheme = () => (themePref === "system" ? (systemLight.matches ? "light" : "dark") : themePref);

const viewer = createViewer($("canvas"), { onPick, onContext: onViewContext, theme: effectiveTheme() });

function setTheme(pref) {
  themePref = pref;
  document.documentElement.dataset.theme = pref;
  viewer.setTheme(effectiveTheme());
  if (showWorldBox) renderViewport(); // its wire color follows the theme
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    // Storage unavailable: the choice lasts for this session.
  }
}
systemLight.addEventListener("change", () => {
  viewer.setTheme(effectiveTheme());
  if (showWorldBox) renderViewport();
});

let scene = loadScene();
let selection = []; // ordered ids; last one is the "primary" shown in properties
// A surface picked in the tree or viewport: "s:<id>" for a scene surface, or
// "nodeId:index" (into nodeSurfaces) for one generated by a shape or composite.
// Exclusive with the node selection. Pinned surfaces stay drawn when not selected.
let surfaceSel = null;
let surfacesCollapsed = false; // the Surfaces section of the tree
let lastContainer = null; // operation or cell selected just before a surface (Half-space target)
const shownSurfaces = new Set();
const SURFACE_TAG = 1 << 23; // pick tags from here on are displayed surfaces
let lastMesh = null; // the mesh on screen, for ray picks
let displayed = []; // surfaces drawn this frame: [{ key, owner, surface }], tag = SURFACE_TAG + index
let results = { parts: new Map(), solids: new Map(), values: new Map(), errors: new Map(), world: null };
let nodeById = new Map();
let isolate = false;
let xray = true;
let showVoid = false;
const WORLD_BOX_KEY = "critica.builder.worldbox";
let showWorldBox = (() => {
  try {
    return localStorage.getItem(WORLD_BOX_KEY) === "on";
  } catch {
    return false;
  }
})();
let colorBy = "cell"; // "cell" | "material" (toggled with M)
// Cutaway view (GPU clipping, no re-evaluation). Positions are per model axis.
// `signs` choose which side of each axis is removed (+1: the side above pos).
const cutaway = { mode: "off", lastMode: "section", axis: "x", pos: null, signs: [1, 1, 1], flip: false };
let sceneBounds = null; // bounds of the visible mesh, for the cutaway sliders
let lastEvalMs = 0;
const history = { states: [], index: -1 };

function loadScene() {
  try {
    // Fall back to keys from before the rename (critica) so saved scenes carry over.
    const saved = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem("geomium.builder.scene.v2") ?? localStorage.getItem("geomium.builder.scene.v1");
    if (saved) return Scene.fromJSON(JSON.parse(saved));
  } catch {
    // Corrupt or blocked storage: start empty.
  }
  return new Scene();
}

function persist(json = JSON.stringify(scene)) {
  try {
    localStorage.setItem(STORAGE_KEY, json);
  } catch {
    // Storage unavailable (private mode, quota): the session still works.
  }
}

/** Records the current scene as an undo step. */
function commit() {
  const json = JSON.stringify(scene);
  if (json === history.states[history.index]) return;
  history.states.splice(history.index + 1);
  history.states.push(json);
  if (history.states.length > HISTORY_LIMIT) history.states.shift();
  history.index = history.states.length - 1;
  persist(json);
  updateToolbar();
}

function restore(index) {
  if (index < 0 || index >= history.states.length) return;
  history.index = index;
  scene = Scene.fromJSON(JSON.parse(history.states[index]));
  selection = selection.filter((id) => scene.find(id));
  if (surfaceSel && !surfaceAt(surfaceSel)) surfaceSel = null;
  const owner = surfaceSel && surfaceAt(surfaceSel).owner;
  if (owner) owner.surfacesOpen = true; // keep its row on screen
  for (const key of shownSurfaces) if (!surfaceAt(key)) shownSurfaces.delete(key);
  persist(history.states[index]);
  refresh();
}

const primary = () => (selection.length ? scene.find(selection[selection.length - 1])?.node : null);

function select(ids, { additive = false } = {}) {
  surfaceSel = null;
  if (!additive) selection = [...ids];
  else
    for (const id of ids) {
      const i = selection.indexOf(id);
      if (i >= 0) selection.splice(i, 1);
      else selection.push(id);
    }
  for (const id of selection) for (const a of scene.ancestors(id)) scene.find(a).node.collapsed = false;
  refresh();
  document.querySelector(`.row[data-id="${selection.at(-1)}"]`)?.scrollIntoView({ block: "nearest" });
}

function selectSurface(key) {
  const found = surfaceAt(key);
  if (!found) return;
  // Already selected: leave the tree alone, so a double-click still finds its row.
  if (surfaceSel === key && !selection.length) return;
  // Where a half-space made from this surface goes: the container selected before.
  const p = primary();
  lastContainer = selection.length === 1 && p?.children && !isUniverse(p) ? p : surfaceSel ? lastContainer : null;
  selection = [];
  surfaceSel = key;
  if (found.owner) {
    for (const a of scene.ancestors(found.owner.id)) scene.find(a).node.collapsed = false;
    found.owner.surfacesOpen = true;
  } else surfacesCollapsed = false;
  refresh();
  document.querySelector(`.surface-row[data-surface="${key}"]`)?.scrollIntoView({ block: "nearest" });
}

// ---- evaluation + rendering --------------------------------------------------

let pendingFrame = 0;
let pendingProps = false;
/** Schedules a full refresh on the next frame (coalesces rapid input). */
function schedule({ props = false } = {}) {
  pendingProps ||= props;
  if (!pendingFrame)
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = 0;
      refresh({ props: pendingProps });
      pendingProps = false;
    });
}

function refresh({ props = true, fit = false } = {}) {
  setMessage("");
  nodeById = new Map();
  scene.walk((n) => nodeById.set(n.id, n));
  try {
    const t0 = performance.now();
    displayed = displayedSurfaces();
    const curved = displayed.map((d, i) => ({ key: d.key, surface: d.surface, tag: SURFACE_TAG + i })).filter((d) => !isPlane(d.surface.type));
    results = evaluator.run(scene, { focus: selection, surfaces: curved });
    lastEvalMs = performance.now() - t0;
  } catch (e) {
    // The evaluator disposed any stale solids, so drop the old results too.
    results = { parts: new Map(), solids: new Map(), values: new Map(), errors: new Map(), world: null };
    setMessage(`Evaluation failed: ${e.message ?? e}`, true);
  }
  if (results.errors.size) {
    const [id, msg] = results.errors.entries().next().value;
    setMessage(`⚠ ${results.errors.size} node${results.errors.size > 1 ? "s" : ""} failed — "${nodeById.get(id)?.name}": ${msg}`, true);
  }
  viewer.setUp(scene.world.up);
  renderViewport(fit);
  renderTree();
  if (props) renderProps();
  else updateInfo();
  updateToolbar();
  if (activeTab === "materials") materialsUI.render();
  if (activeTab === "sources") sourcesUI.render();
  if (activeTab === "settings") settingsUI.render();
}

function meshOf(solid) {
  if (!solid || solid.isEmpty) return null;
  let m = meshCache.get(solid);
  if (!m) meshCache.set(solid, (m = solid.toMesh()));
  return m;
}

/** Parts to draw for a node: cells/roots/universes have parts, other nodes a single solid. */
function partsOf(id) {
  if (results.parts.has(id)) return results.parts.get(id);
  const s = results.solids.get(id);
  return s ? [{ solid: s }] : [];
}

/** Ids whose faces get highlighted: tags under the selected nodes. */
function highlightedTags() {
  const tags = new Set();
  for (const id of selection) {
    const hit = scene.find(id);
    if (hit) scene.walk((n) => tags.add(n.id), [hit.node]);
    // A reference highlights the faces of its source.
    const source = hit && hit.node.kind === "ref" ? scene.resolveRef(hit.node) : null;
    if (source) scene.walk((n) => tags.add(n.id), [source]);
    for (const p of partsOf(id)) if (p.tag) tags.add(p.tag);
  }
  return tags;
}

function tagColor(tag) {
  const node = nodeById.get(tag);
  if (node && isCell(node)) return cellColor(node);
  return colorBy === "material" ? NO_MATERIAL_COLOR : leafColor(tag);
}

/** Legend of the materials visible in material mode. */
function renderLegend(tags) {
  const legend = $("legend");
  if (colorBy !== "material") {
    legend.hidden = true;
    return;
  }
  const entries = new Map(); // key → { color, label }
  for (const tag of tags) {
    const node = nodeById.get(tag);
    if (node && isCell(node)) {
      if (node.fill.type !== "material") entries.set("~placeholder", { color: PLACEHOLDER_COLOR, label: "lattice / DAGMC fill" });
      else {
        const m = firstMaterial(node.fill.material);
        const name = scene.materials[m]?.name;
        entries.set(m, { color: materialColor(m), label: m === "void" ? "void" : `${m}${name ? ` · ${name}` : ""}` });
      }
    } else {
      entries.set("~none", { color: NO_MATERIAL_COLOR, label: "no material (not in a cell)" });
    }
  }
  const order = [...entries.keys()].sort((a, b) => {
    const na = /^\d+$/.test(a) ? Number(a) : Infinity;
    const nb = /^\d+$/.test(b) ? Number(b) : Infinity;
    return na - nb || a.localeCompare(b);
  });
  const rows = order.map((k) => {
    const e = entries.get(k);
    return h("div", { class: "legend-row" }, h("span", { class: "swatch", style: `background:${css(e.color)}` }), h("span", {}, e.label));
  });
  legend.replaceChildren(h("div", { class: "legend-title" }, "Materials"), ...(rows.length ? rows : [h("div", { class: "legend-row muted" }, "nothing visible")]));
  legend.hidden = false;
}

// ---- plane half-spaces drawn as planes with arrows ----

/** Whether a node is a half-space of a plane surface. */
function isPlaneHalfspace(node) {
  return node?.kind === "halfspace" && isPlane(scene.surfaces.get(node.params.surface)?.type ?? "");
}

/**
 * Transform from a node's frame to the root frame (product of ancestor
 * region transforms; cells do not transform their region). Null when the node
 * lives in a universe, whose frame is not the root's.
 */
function rootMatrixOf(id) {
  let m = IDENTITY;
  for (const a of scene.ancestors(id)) {
    const n = scene.find(a).node;
    if (isUniverse(n)) return null;
    if (!isCell(n) && !isIdentity(n.transform)) m = multiply(fromTransform(n.transform), m);
  }
  return m;
}

/**
 * Square the plane sheets are drawn in: centred on the projection of the frame
 * centre onto the plane. The frame comes from the manual world box, else from
 * the bounded content on screen, never from the auto world box: that one is
 * fitted to the planes themselves, so sheets would grow as planes move apart.
 */
function sheetFrame(contentBounds) {
  const box = !scene.world.auto ? scene.world : contentBounds;
  if (!box) return { center: [0, 0, 0], half: 5 };
  return {
    center: box.min.map((v, i) => (v + box.max[i]) / 2),
    half: Math.max(1, 0.75 * Math.max(...box.max.map((v, i) => v - box.min[i]))),
  };
}

function planeSquare(n, d, frame) {
  const cr = (x, y) => [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  // Edges follow the world axis least aligned with n, so axis planes stay axis-aligned.
  const k = [0, 1, 2].reduce((a, b) => (Math.abs(n[b]) < Math.abs(n[a]) ? b : a));
  const u = cr(n, [0, 1, 2].map((i) => (i === k ? 1 : 0)));
  const ul = Math.hypot(...u);
  const uu = u.map((x) => x / ul);
  const v = cr(n, uu);
  const c = frame.center;
  const off = n[0] * c[0] + n[1] * c[1] + n[2] * c[2] - d;
  const center = c.map((x, i) => x - off * n[i]);
  const at = (a, b) => center.map((x, i) => x + frame.half * (a * uu[i] + b * v[i]));
  return { polygon: [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)], center, at };
}

function planeGizmo(node, color, frame) {
  const m = rootMatrixOf(node.id);
  if (!m) return null;
  const local = isIdentity(node.transform) ? m : multiply(m, fromTransform(node.transform));
  const form = transformForm(toForm(scene.surfaces.get(node.params.surface)), local);
  const [a, b, c, e] = form.L;
  const len = Math.hypot(a, b, c);
  if (!(len > 0)) return null;
  const n = [a / len, b / len, c / len];
  const sq = planeSquare(n, -e / len, frame);
  // f = n·p − d < 0 is the negative side.
  const dir = node.params.sense === "-" ? n.map((x) => -x) : n;
  const length = 0.45 * frame.half;
  const anchors = [sq.center, sq.at(0.55, 0), sq.at(-0.55, 0), sq.at(0, 0.55), sq.at(0, -0.55)];
  return {
    plane: { polygon: sq.polygon, normal: n, color, tag: node.id },
    arrows: anchors.map((from) => ({ from, dir, length, color, tag: node.id })),
  };
}

/**
 * Directions in which the item `id` (or its cell `tag`) is unbounded, as
 * [axis][0 = min side, 1 = max side]. Its faces on those sides of the world box
 * are not real boundaries: the world box only cuts the region for display.
 */
function openDirections(id, tag) {
  const w = results.world;
  // Bounds are in the item's own frame: only use them where that is the world frame.
  const m = rootMatrixOf(id);
  if (!w || !m || m.some((v, i) => Math.abs(v - IDENTITY[i]) > 1e-12)) return null;
  const boxes = [scene.regionBounds(nodeById.get(id))];
  const cell = tag && tag !== id ? nodeById.get(tag) : null;
  if (cell && isCell(cell) && rootMatrixOf(tag)) boxes.push(scene.regionBounds(cell));
  const dirs = [0, 1, 2].map((k) => [boxes.every((b) => b.min[k] === -Infinity), boxes.every((b) => b.max[k] === Infinity)]);
  return dirs.some((d) => d[0] || d[1]) ? dirs : null;
}

/** Per-vertex 1/0: whether the vertex belongs to a face lying on an open side of the world box. */
function openSides(mesh, dirs) {
  const flags = new Float32Array(mesh.tags.length);
  if (!dirs) return flags;
  const w = results.world;
  const p = mesh.positions;
  const idx = mesh.indices;
  const eps = 1e-6 * Math.max(1, ...w.max.map((v, i) => v - w.min[i]));
  const on = (vi, k, x) => Math.abs(p[vi * 3 + k] - x) < eps;
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
    for (let k = 0; k < 3; k++) {
      const hit = [w.min[k], w.max[k]].some((x, side) => dirs[k][side] && on(a, k, x) && on(b, k, x) && on(c, k, x));
      if (hit) {
        flags[a] = flags[b] = flags[c] = 1;
        break;
      }
    }
  }
  return flags;
}

/**
 * Construction lines of a selected cylinder sector inside its hole (r < r1):
 * spokes from the axis to the two inner edges at both ends of the displayed
 * length, and the axis itself. Model coordinates; [] for other nodes.
 */
function sectorWires(node) {
  if (node?.kind !== "composite" || node.params.type !== "cylinder-sector" || !results.world) return [];
  const root = rootMatrixOf(node.id);
  if (!root) return [];
  const m = isIdentity(node.transform) ? root : multiply(root, fromTransform(node.transform));
  const { r1, theta1, theta2, center, axis } = node.params.values ?? {};
  const k = { x: 0, y: 1, z: 2 }[axis];
  if (k === undefined || !(r1 >= 0)) return [];
  // In-plane coordinates (a, b) and the axial one h, mapped as OpenMC does.
  const order = { z: [0, 1, 2], y: [0, 2, 1], x: [2, 0, 1] }[axis];
  const point = (a, b, h) => transformPoint(m, order.map((i) => [a, b, h][i]));
  // Axial extent: the world box seen from the sector's own frame.
  const inv = invert(m);
  const w = results.world;
  const hs = [];
  for (let c = 0; c < 8; c++) hs.push(transformPoint(inv, [0, 1, 2].map((i) => ((c >> i) & 1 ? w.max[i] : w.min[i])))[k]);
  const [h0, h1] = [Math.min(...hs), Math.max(...hs)];
  const [c0, c1] = center;
  const color = HIGHLIGHT;
  const out = [{ from: point(c0, c1, h0), to: point(c0, c1, h1), color }];
  for (const h of [h0, h1])
    for (const t of [theta1, theta2]) {
      const phi = (Math.PI / 180) * t;
      out.push({ from: point(c0, c1, h), to: point(c0 + r1 * Math.cos(phi), c1 + r1 * Math.sin(phi), h), color });
    }
  return out;
}

/** The 12 edges of the world box: black, or light grey on the dark theme where black would vanish. */
function worldBoxWires() {
  const w = results.world;
  if (!showWorldBox || !w) return [];
  const color = effectiveTheme() === "light" ? [0, 0, 0] : [0.85, 0.87, 0.9];
  const corner = (c) => [0, 1, 2].map((k) => ((c >> k) & 1 ? w.max[k] : w.min[k]));
  const out = [];
  for (let c = 0; c < 8; c++)
    for (let k = 0; k < 3; k++) if (!((c >> k) & 1)) out.push({ from: corner(c), to: corner(c | (1 << k)), color });
  return out;
}

const SOURCE_COLOR = [1.0, 0.45, 0.75];

/**
 * Wireframes of the external sources: a star for a point, the edges of a box,
 * three great circles for a sphere, rims and four sides for a cylinder. Shown
 * in the Source workspace, and in Geometry when View → Sources is on.
 */
function sourceWires() {
  if (activeTab !== "sources" && !showSources) return [];
  const w = results.world;
  const size = w ? Math.max(...w.max.map((v, i) => v - w.min[i])) : 2;
  const out = [];
  const line = (from, to, color) => out.push({ from, to, color });
  const add = (a, b) => a.map((v, i) => v + b[i]);
  const scale = (a, k) => a.map((v) => v * k);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a) => scale(a, 1 / (Math.hypot(...a) || 1));
  const circle = (center, u, v, r, color, segments = 48) => {
    for (let k = 0; k < segments; k++) {
      const p = (t) => add(center, add(scale(u, r * Math.cos(t)), scale(v, r * Math.sin(t))));
      line(p((k / segments) * 2 * Math.PI), p(((k + 1) / segments) * 2 * Math.PI), color);
    }
  };
  for (const src of scene.sources) {
    const shape = sourceShape(src);
    if (!shape) continue;
    const color = activeTab === "sources" && src.id === sourcesUI.selected ? HIGHLIGHT : SOURCE_COLOR;
    if (shape.kind === "point") {
      const l = 0.03 * size;
      for (const d of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, -1]].map(unit)) line(add(shape.at, scale(d, -l)), add(shape.at, scale(d, l)), color);
    } else if (shape.kind === "box") {
      const corner = (c) => [0, 1, 2].map((k) => ((c >> k) & 1 ? shape.max[k] : shape.min[k]));
      for (let c = 0; c < 8; c++) for (let k = 0; k < 3; k++) if (!((c >> k) & 1)) line(corner(c), corner(c | (1 << k)), color);
    } else if (shape.kind === "sphere") {
      const [x, y, z] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      circle(shape.center, x, y, shape.radius, color);
      circle(shape.center, x, z, shape.radius, color);
      circle(shape.center, y, z, shape.radius, color);
    } else if (shape.kind === "cylinder") {
      const zDir = unit(shape.axis);
      const rDir = unit(shape.rDir);
      const pDir = cross(zDir, rDir);
      const bottom = add(shape.center, scale(zDir, shape.z0));
      const top = add(shape.center, scale(zDir, shape.z1));
      circle(bottom, rDir, pDir, shape.radius, color);
      circle(top, rDir, pDir, shape.radius, color);
      for (const d of [rDir, pDir, scale(rDir, -1), scale(pDir, -1)]) line(add(bottom, scale(d, shape.radius)), add(top, scale(d, shape.radius)), color);
    }
  }
  return out;
}

const PLUS_COLOR = [0.95, 0.42, 0.32];
const MINUS_COLOR = [0.32, 0.6, 0.98];

/**
 * Evenly spread points of a shell with their unit normals, spaced for about
 * forty over its area: points are taken across each triangle (long strips, like a
 * cylinder's sides, get several), and one is kept only when no kept point is
 * closer than the spacing. Returns { samples: [{ p, n }], spacing }.
 */
function shellSamples(m, indices) {
  const P = m.positions;
  const N = m.normals;
  const at = (arr, v) => [arr[v * 3], arr[v * 3 + 1], arr[v * 3 + 2]];
  let area = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]].map((v) => at(P, v));
    const e1 = b.map((x, k) => x - a[k]);
    const e2 = c.map((x, k) => x - a[k]);
    area += Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2;
  }
  const spacing = Math.sqrt(area / 40) || 1;
  const grid = new Map(); // cell → kept points
  const cellOf = (p) => p.map((x) => Math.floor(x / spacing));
  const farEnough = (p) => {
    const [cx, cy, cz] = cellOf(p);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++)
      for (const q of grid.get(`${cx + i},${cy + j},${cz + k}`) ?? []) if (Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < spacing) return false;
    return true;
  };
  const samples = [];
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]].map((v) => ({ p: at(P, v), n: at(N, v) }));
    const edge = Math.max(...[[a, b], [b, c], [c, a]].map(([x, y]) => Math.hypot(...x.p.map((q, k) => q - y.p[k]))));
    const steps = Math.min(40, Math.max(1, Math.ceil((2 * edge) / spacing)));
    for (let i = 0; i <= steps; i++)
      for (let j = 0; i + j <= steps; j++) {
        const wb = (i + 1 / 3) / (steps + 1);
        const wc = (j + 1 / 3) / (steps + 1);
        const wa = 1 - wb - wc;
        if (wa < 0) continue;
        const p = [0, 1, 2].map((k) => wa * a.p[k] + wb * b.p[k] + wc * c.p[k]);
        if (!farEnough(p)) continue;
        const n = [0, 1, 2].map((k) => wa * a.n[k] + wb * b.n[k] + wc * c.n[k]);
        const len = Math.hypot(...n);
        if (!(len > 0)) continue;
        samples.push({ p, n: n.map((x) => x / len) });
        const key = cellOf(p).join(",");
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(p);
      }
  }
  return { samples, spacing };
}

/**
 * Small + signs on the positive side of a surface and − signs on its negative
 * side, just off each sample point. The side is read from the surface
 * equation, so it holds whatever way the mesh normals face.
 */
function sideMarks(surface, input, spacing, tag) {
  const { samples, spacing: sp } = Array.isArray(input) ? { samples: input, spacing } : input;
  const size = sp * 0.3;
  const off = sp * 0.1;
  const out = [];
  for (const { p, n } of samples) {
    const ahead = p.map((x, k) => x + n[k] * off);
    let f;
    try {
      f = evaluateSurface(surface, ahead);
    } catch {
      continue;
    }
    if (!Number.isFinite(f)) continue;
    const toPlus = f >= 0 ? n : n.map((x) => -x);
    const helper = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u0 = [n[1] * helper[2] - n[2] * helper[1], n[2] * helper[0] - n[0] * helper[2], n[0] * helper[1] - n[1] * helper[0]];
    const ul = Math.hypot(...u0);
    const u = u0.map((x) => x / ul);
    for (const [sign, dir] of [[true, toPlus], [false, toPlus.map((x) => -x)]]) {
      out.push({ center: p.map((x, k) => x + dir[k] * off), normal: dir, u, size, plus: sign, color: sign ? PLUS_COLOR : MINUS_COLOR, tag });
    }
  }
  return out;
}

function renderViewport(fit) {
  const visibleIds = isolate && selection.length ? selection : scene.roots.filter((n) => n.enabled).map((n) => n.id);
  // Plane half-spaces shown on their own (top level, isolated or selected) are
  // drawn as a sheet with arrows instead of half the world box.
  const asPlane = new Set([...visibleIds, ...selection].filter((id) => isPlaneHalfspace(nodeById.get(id)) && nodeById.get(id).enabled && rootMatrixOf(id)));
  const keep = (p) => showVoid || !p.tag || !isVoidCell(nodeById.get(p.tag) ?? {});
  const meshes = [];
  const openFlags = [];
  const leafTags = []; // per mesh: the leaf that made each face (cells re-tag their faces)
  for (const id of visibleIds) {
    if (asPlane.has(id)) continue;
    for (const p of partsOf(id).filter(keep)) {
      const m = meshOf(p.solid);
      if (!m) continue;
      meshes.push(m);
      openFlags.push(openSides(m, openDirections(id, p.tag)));
      const src = p.source && meshOf(p.source);
      leafTags.push(src && src.tags.length === m.tags.length ? src.tags : m.tags);
    }
  }
  const mesh = mergeMeshes(meshes);
  lastMesh = mesh;
  const open = new Float32Array(mesh.tags.length);
  openFlags.reduce((at, f) => (open.set(f, at), at + f.length), 0);
  const leaves = new Uint32Array(mesh.tags.length);
  leafTags.reduce((at, t) => (leaves.set(t, at), at + t.length), 0);

  const hl = highlightedTags();
  const colors = new Float32Array(mesh.positions.length);
  const colorCache = new Map();
  for (let i = 0; i < mesh.tags.length; i++) {
    const tag = mesh.tags[i];
    let c = colorCache.get(tag);
    if (!c) {
      const base = tagColor(tag);
      c = hl.has(tag) ? base.map((v, k) => v * 0.35 + HIGHLIGHT[k] * 0.65) : base;
      colorCache.set(tag, c);
    }
    colors[i * 3] = c[0];
    colors[i * 3 + 1] = c[1];
    colors[i * 3 + 2] = c[2];
  }
  viewer.setMesh(mesh, colors, open, leaves);
  renderLegend(colorCache.keys());

  // Ghost the selected nodes that are not directly visible (cutters, void cells, universe content).
  const ghostIds = isolate || !xray ? [] : selection.filter((id) => !asPlane.has(id) && (!visibleIds.includes(id) || isVoidCell(nodeById.get(id) ?? {})));
  const planes = [];
  const arrows = [];
  const contentBounds = meshBounds(mesh);
  const frame = sheetFrame(contentBounds);
  for (const id of asPlane) {
    const node = nodeById.get(id);
    const color = selection.includes(id) ? HIGHLIGHT : leafColor(id);
    const g = planeGizmo(node, color, frame);
    if (g) {
      planes.push(g.plane);
      arrows.push(...g.arrows);
    }
  }
  // Surfaces shown as surfaces: plane sheets, or the shell of the surface's
  // inside without its faces on the world box.
  const surfaces = [];
  const shellPoints = [];
  const marks = [];
  displayed.forEach((d, i) => {
    const tag = SURFACE_TAG + i;
    const color = d.key === surfaceSel ? HIGHLIGHT : surfaceColor(d);
    if (isPlane(d.surface.type)) {
      const [a, b, c, e] = toForm(d.surface).L;
      const len = Math.hypot(a, b, c);
      if (!(len > 0)) return;
      const n = [a / len, b / len, c / len];
      const sq = planeSquare(n, -e / len, frame);
      planes.push({ polygon: sq.polygon, normal: n, color, tag });
      const samples = [];
      for (const a of [-0.6, 0, 0.6]) for (const b of [-0.6, 0, 0.6]) samples.push({ p: sq.at(a, b), n });
      marks.push(...sideMarks(d.surface, samples, (frame.half * 2) / 5, tag));
      return;
    }
    const m = meshOf(results.surfaces?.get(d.key));
    if (!m) return;
    const onBox = openSides(m, [0, 1, 2].map(() => [true, true]));
    const indices = [];
    for (let t = 0; t < m.indices.length; t += 3) if (!onBox[m.indices[t]]) indices.push(m.indices[t], m.indices[t + 1], m.indices[t + 2]);
    if (!indices.length) return;
    surfaces.push({ positions: m.positions, normals: m.normals, indices, color, tag });
    marks.push(...sideMarks(d.surface, shellSamples(m, indices), null, tag));
    for (const v of indices) shellPoints.push([m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]]);
  });
  const wires = [...selection.flatMap((id) => sectorWires(nodeById.get(id))), ...worldBoxWires(), ...sourceWires()];
  viewer.setGizmos({ planes, arrows, surfaces, marks, wires });
  // Fit should frame the sheets and shells too.
  const sheetPoints = [...planes.flatMap((p) => p.polygon), ...shellPoints];
  const ghostMeshes = ghostIds.flatMap((id) => partsOf(id).map((p) => meshOf(p.solid))).filter(Boolean);
  viewer.setGhost(ghostMeshes.length ? mergeMeshes(ghostMeshes) : null);

  sceneBounds = contentBounds ?? (sheetPoints.length ? null : results.world);
  if (sheetPoints.length) {
    const b = sceneBounds ?? { min: [...sheetPoints[0]], max: [...sheetPoints[0]] };
    for (const p of sheetPoints) for (let k = 0; k < 3; k++) {
      b.min[k] = Math.min(b.min[k], p[k]);
      b.max[k] = Math.max(b.max[k], p[k]);
    }
    sceneBounds = b;
  }
  if (fit) viewer.fit(sceneBounds ?? { min: [-1, -1, -1], max: [1, 1, 1] });

  $("stats").textContent = `${mesh.indices.length / 3} tris · ${lastEvalMs.toFixed(1)} ms · ${geo.liveCount} solids`;
}

function setMessage(text, error = false) {
  $("msg").textContent = text;
  $("status").classList.toggle("error", error);
  // The Materials workspace has its own status line.
  $("mat-status").textContent = text;
  $("mat-status").classList.toggle("error", error);
}

// ---- tree --------------------------------------------------------------------

let refCounts = new Map(); // source id → number of references

function renderTree() {
  const tree = $("tree");
  const scroll = tree.scrollTop;
  refCounts = new Map();
  scene.walk((n) => n.kind === "ref" && refCounts.set(n.params.target, (refCounts.get(n.params.target) ?? 0) + 1));
  const rows = [];
  const addRows = (nodes, depth, parent) => {
    nodes.forEach((node, index) => {
      rows.push(treeRow(node, depth, parent, index));
      if (!node.children && node.surfacesOpen) rows.push(...surfaceRows(node, depth + 1));
      if (node.children && !node.collapsed) {
        if (node.children.length === 0) {
          const hint = isCell(node) ? "no region — fills all space" : isUniverse(node) ? "empty — drop cells here" : "empty — drop shapes here";
          rows.push(h("div", { class: "placeholder", style: `--depth:${depth + 1}`, dataset: { into: node.id } }, hint));
        }
        addRows(node.children, depth + 1, node);
      }
    });
  };
  addRows(scene.roots, 0, null);
  if (scene.roots.length === 0)
    rows.push(
      h(
        "div",
        { class: "empty-props" },
        scene.surfaces.size ? "No regions yet. Select a surface and press Half-space, or add a shape." : "The scene is empty. Add a shape or a surface, or import an OpenMC file.",
      ),
    );
  if (scene.surfaces.size) {
    rows.push(
      h(
        "div",
        { class: "section-header toggle", dataset: { action: "toggle-surface-section" }, title: "Every surface of the scene, used or not" },
        `${surfacesCollapsed ? "▸" : "▾"} Surfaces (${scene.surfaces.size})`,
      ),
    );
    if (!surfacesCollapsed) {
      const users = new Map();
      scene.walk((n) => n.kind === "halfspace" && users.set(n.params.surface, (users.get(n.params.surface) ?? 0) + 1));
      for (const sf of [...scene.surfaces.values()].sort((a, b) => a.id - b.id)) rows.push(sceneSurfaceRow(sf, users.get(sf.id) ?? 0));
    }
  }
  if (scene.universes.length) {
    rows.push(h("div", { class: "section-header" }, "Universes"));
    addRows(scene.universes, 0, null);
  }
  tree.replaceChildren(...rows);
  tree.scrollTop = scroll;
}

function fillBadge(cell) {
  const f = cell.fill;
  if (f.type === "universe") return h("span", { class: "badge", title: "Filled with a universe" }, `→ ${nodeById.get(f.universe)?.name ?? "?"}`);
  if (f.type === "lattice") return h("span", { class: "badge warn", title: "Lattice fills are preserved for export but not displayed yet" }, `lattice ${f.id}`);
  if (f.type === "external") return h("span", { class: "badge warn", title: "DAGMC universe (preserved, not displayed)" }, `dagmc ${f.id}`);
  const name = scene.materials[String(f.material).trim()]?.name;
  return h("span", { class: "badge", title: name ? `Material ${f.material} (${name})` : `Material ${f.material}` }, f.material === "void" ? "void" : `m${f.material}`);
}

// ---- surface level of the tree ----

const hasSurfaces = (node) => node.kind === "halfspace" || isPrimitive(node) || node.kind === "composite";

const SURFACE_ICON = (type) =>
  type.endsWith("plane") ? "plane" : type.endsWith("cylinder") ? "infcylinder" : type.endsWith("cone") ? "infcone" : type === "sphere" ? "sphere" : type.endsWith("torus") ? "torus" : "halfspace";

/**
 * Surfaces a leaf node is made of, in its parent's frame (node transform
 * applied, simplified like the exporter): [{ surface, sense, id?, users? }].
 * `id` is set for shared scene surfaces (half-spaces).
 */
function nodeSurfaces(node) {
  if (node.kind === "halfspace") {
    const s = scene.surfaces.get(node.params.surface);
    return s ? [{ surface: s, sense: node.params.sense, id: s.id, users: scene.surfaceUsers(s.id) }] : [];
  }
  let local;
  if (isPrimitive(node)) local = primitiveSurfaces(node).map(([surface, sense]) => ({ surface, sense }));
  else if (node.kind === "composite") {
    try {
      const { surfaces, region } = compositeExpansion(node);
      // Senses as used in the region (first occurrence); "±" when used on both sides.
      const senses = new Map();
      const walk = (ast) => {
        if (ast.op === "half") senses.set(ast.surface, senses.has(ast.surface) && senses.get(ast.surface) !== ast.sense ? "±" : ast.sense);
        else if (ast.op === "not") walk(ast.arg);
        else ast.args.forEach(walk);
      };
      walk(region);
      local = surfaces.map((surface, i) => ({ surface, sense: senses.get(i) ?? "±" }));
    } catch {
      return [];
    }
  } else return [];
  if (isIdentity(node.transform)) return local;
  const m = fromTransform(node.transform);
  return local.map(({ surface, sense }) => {
    try {
      const t = transformSurface(surface, m);
      const flipped = sense === "±" ? "±" : t.flip ? (sense === "-" ? "+" : "-") : sense;
      return { surface: { type: t.type, coeffs: t.coeffs }, sense: flipped };
    } catch {
      return { surface, sense, note: "cannot be transformed exactly" };
    }
  });
}

function surfaceSummary(s) {
  const names = SURFACE_TYPES[s.type]?.coeffs ?? [];
  return names.map((n, i) => `${n}=${fmt(s.coeffs[i])}`).join("  ");
}

function surfaceRows(node, depth) {
  return nodeSurfaces(node).map(({ surface, sense, id, users, note }, k) => {
    const key = id != null ? `s:${id}` : `${node.id}:${k}`;
    const shown = shownSurfaces.has(key);
    return h(
      "div",
      {
        class: ["row", "surface-row", surfaceSel === key && "selected primary"].filter(Boolean).join(" "),
        style: `--depth:${depth}`,
        dataset: { id: node.id, surface: key },
        title: `${sense === "±" ? "used on both sides" : `${sense === "-" ? "negative (inside)" : "positive (outside)"} side`} of ${surface.type} ${surfaceSummary(surface)}${id != null ? ` — surface #${id}` : " — generated by this node"}${note ? ` (${note})` : ""}`,
      },
      h("span", { class: "caret" }),
      icon(SURFACE_ICON(surface.type)),
      h("span", { class: "sense" }, sense === "-" ? "−" : sense),
      surfaceLabel(surface),
      id != null && h("span", { class: "oid" }, `#${id}`),
      users > 1 && h("span", { class: "badge shared", title: `Shared by ${users} half-spaces` }, `×${users}`),
      h("button", { class: "eye", dataset: { action: "show-surface" }, title: shown ? "Stop showing this surface" : "Keep this surface shown in the viewport" }, shown ? "◉" : "○"),
    );
  });
}

/** "name  type coeffs" (name only when set). */
function surfaceLabel(sf) {
  return h(
    "span",
    { class: "name" },
    sf.name && h("span", { class: "surface-name" }, sf.name),
    sf.name && " ",
    h("span", { class: "surface-type" }, sf.type),
    " ",
    h("span", { class: "surface-coeffs" }, surfaceSummary(sf)),
  );
}

/** Renames the half-spaces of a surface whose names are still generated ("−3 sphere (fuel)"). */
function syncHalfspaceNames(id) {
  const sf = scene.surfaces.get(id);
  if (!sf) return;
  scene.walk((n) => {
    if (n.kind === "halfspace" && n.params.surface === id && /^[−+]\d+ [\w-]+( \(.*\))?$/.test(n.name)) n.name = halfspaceName(sf, n.params.sense);
  });
}

function renameSurface(id, name) {
  const sf = scene.surfaces.get(id);
  if (!sf) return;
  const next = name.trim();
  if ((sf.name ?? "") === next) return;
  if (next) sf.name = next;
  else delete sf.name;
  syncHalfspaceNames(id);
  commit();
  refresh();
}

/**
 * Edits a scene surface's name in place in the tree: Enter or leaving the field
 * keeps it, Escape cancels, an empty name clears it.
 */
function startSurfaceRename(key) {
  if (!key?.startsWith("s:")) {
    setMessage("Surfaces generated by a shape cannot be renamed: add a half-space on it to get an editable copy.", true);
    return;
  }
  const id = Number(key.slice(2));
  const sf = scene.surfaces.get(id);
  if (!sf) return;
  if (surfacesCollapsed) {
    surfacesCollapsed = false;
    renderTree();
  }
  const row = document.querySelector(`.scene-surface[data-surface="${key}"]`) ?? document.querySelector(`.surface-row[data-surface="${key}"]`);
  const label = row?.querySelector(".name");
  if (!label) return;
  row.draggable = false;
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    if (keep) renameSurface(id, input.value);
    else renderTree();
  };
  const input = h("input", {
    type: "text",
    class: "rename",
    value: sf.name ?? "",
    placeholder: `name of ${sf.type} #${id}`,
    onkeydown: (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    },
    onblur: () => finish(true),
  });
  label.replaceWith(input);
  input.focus();
  input.select();
}

/** A row of the Surfaces section: one scene surface and how many half-spaces use it. */
function sceneSurfaceRow(sf, users) {
  const key = `s:${sf.id}`;
  const shown = shownSurfaces.has(key);
  return h(
    "div",
    {
      class: ["row", "surface-row", "scene-surface", surfaceSel === key && "selected primary"].filter(Boolean).join(" "),
      style: "--depth:0",
      draggable: true,
      dataset: { surface: key },
      title: `${sf.type} ${surfaceSummary(sf)} — surface #${sf.id}${users ? `, used by ${users} half-space(s)` : ", not used by any half-space"}`,
    },
    h("span", { class: "caret" }),
    icon(SURFACE_ICON(sf.type), css(distinctColor(sf.id, 0.5))),
    surfaceLabel(sf),
    h("span", { class: "oid" }, `#${sf.id}`),
    users ? users > 1 && h("span", { class: "badge shared", title: `Used by ${users} half-spaces` }, `×${users}`) : h("span", { class: "badge", title: "No half-space uses it yet: it is not exported" }, "unused"),
    h("button", { class: "eye", dataset: { action: "show-surface" }, title: shown ? "Stop showing this surface" : "Keep this surface shown in the viewport" }, shown ? "◉" : "○"),
  );
}

const surfaceColor = (d) => (d.owner ? leafColor(d.owner.id) : distinctColor(Number(d.key.slice(2)), 0.5));

/**
 * The surface behind a key: { owner, entry }, entry as from nodeSurfaces.
 * Scene surfaces ("s:<id>") have no owner. Null when it no longer exists.
 */
function surfaceAt(key) {
  if (key.startsWith("s:")) {
    const id = Number(key.slice(2));
    const surface = scene.surfaces.get(id);
    return surface ? { owner: null, entry: { surface, id, users: scene.surfaceUsers(id) } } : null;
  }
  const [id, k] = key.split(":").map(Number);
  const owner = scene.find(id)?.node;
  const entry = owner && hasSurfaces(owner) ? nodeSurfaces(owner)[k] : null;
  return entry ? { owner, entry } : null;
}

/** Selected and pinned surfaces, in world coordinates (universe content in its own). */
function displayedSurfaces() {
  const out = [];
  for (const key of new Set([...shownSurfaces, surfaceSel].filter(Boolean))) {
    const found = surfaceAt(key);
    if (!found) continue;
    let surface = found.entry.surface;
    const m = (found.owner && rootMatrixOf(found.owner.id)) ?? IDENTITY;
    if (m.some((v, i) => Math.abs(v - IDENTITY[i]) > 1e-12)) {
      try {
        const t = transformSurface(surface, m);
        surface = { type: t.type, coeffs: t.coeffs };
      } catch {
        continue;
      }
    }
    out.push({ key, owner: found.owner, surface });
  }
  return out;
}

function treeRow(node, depth, parent, index) {
  const op = isOperation(node);
  const order = selection.length > 1 ? selection.indexOf(node.id) : -1;
  let role = null;
  if (parent?.kind === "subtract") {
    role = index === 0 ? h("span", { class: "role", title: "The solid that is cut" }, "base") : h("span", { class: "role cut", title: "Removed from the base" }, "cut");
  }
  const parts = results.parts.get(node.id);
  const solid = results.solids.get(node.id);
  const tris = parts ? parts.reduce((s, p) => s + p.solid.triangleCount, 0) : solid?.triangleCount;
  const error = results.errors.get(node.id);
  const tip = error ?? (tris != null ? `${tris} triangles` : node.enabled ? "" : "disabled");
  let iconColor = null;
  if (isCell(node)) iconColor = css(cellColor(node));
  else if (!op && !isUniverse(node)) iconColor = css(leafColor(node.id));
  const canToggle = !isUniverse(node);
  return h(
    "div",
    {
      class: ["row", selection.includes(node.id) && "selected", primary()?.id === node.id && "primary", !node.enabled && "disabled", error && "error"].filter(Boolean).join(" "),
      style: `--depth:${depth}`,
      draggable: true,
      title: tip,
      dataset: { id: node.id },
    },
    node.children
      ? h("span", { class: "caret", dataset: { action: "toggle" } }, node.collapsed ? "▸" : "▾")
      : hasSurfaces(node)
        ? h("span", { class: "caret", dataset: { action: "toggle-surfaces" }, title: "Show the surfaces this is made of" }, node.surfacesOpen ? "▾" : "▸")
        : h("span", { class: "caret" }),
    icon(node.kind, iconColor),
    node.kind === "ref"
      ? h("span", { class: "name ref-name", title: "Reference: reuses this region" }, `↪ ${scene.find(node.params.target)?.node.name ?? "(deleted)"}`)
      : h("span", { class: "name" }, node.name),
    refCounts.get(node.id) && h("span", { class: "badge shared", title: `Also used by ${refCounts.get(node.id)} reference(s)` }, `shared ×${refCounts.get(node.id) + 1}`),
    error && h("span", { class: "badge err", title: error }, "⚠"),
    isCell(node) && fillBadge(node),
    node.kind === "composite" &&
      h("span", { class: "badge", title: `${COMPOSITE_TYPES[node.params.type]?.openmc}, ${node.params.sense === "-" ? "inside (−)" : "outside (+)"}` }, node.params.sense === "-" ? "−" : "+"),
    (isCell(node) || isUniverse(node)) && node.openmc?.id != null && h("span", { class: "oid", title: "OpenMC id" }, `#${node.openmc.id}`),
    role,
    order >= 0 && h("span", { class: "order", title: "Selection order" }, String(order + 1)),
    canToggle &&
      h("button", { class: "eye", dataset: { action: "enable" }, title: node.enabled ? "Disable (exclude from result)" : "Enable" }, node.enabled ? "●" : "○"),
  );
}

const tree = $("tree");

tree.addEventListener("click", (e) => {
  if (e.target.closest("[data-action=toggle-surface-section]")) {
    surfacesCollapsed = !surfacesCollapsed;
    renderTree();
    return;
  }
  if (e.target.closest("input.rename")) return;
  const row = e.target.closest(".row");
  if (!row) {
    if (e.target === tree) select([]);
    return;
  }
  const action = e.target.closest("[data-action]")?.dataset.action;
  const key = row.dataset.surface;
  if (key) {
    if (action === "show-surface") {
      if (!shownSurfaces.delete(key)) shownSurfaces.add(key);
      refresh({ props: !primary() });
    } else selectSurface(key);
    return;
  }
  const node = scene.find(Number(row.dataset.id))?.node;
  if (!node) return;
  if (action === "toggle") {
    node.collapsed = !node.collapsed;
    persist();
    renderTree();
  } else if (action === "toggle-surfaces") {
    node.surfacesOpen = !node.surfacesOpen;
    persist();
    renderTree();
  } else if (action === "enable") {
    node.enabled = !node.enabled;
    commit();
    refresh({ props: false });
  } else {
    select([node.id], { additive: e.ctrlKey || e.metaKey || e.shiftKey });
  }
});

tree.addEventListener("contextmenu", (e) => {
  const surfaceRow = e.target.closest(".surface-row");
  if (surfaceRow) {
    e.preventDefault();
    surfaceMenu(surfaceRow.dataset.surface, e.clientX, e.clientY);
    return;
  }
  const row = e.target.closest(".row[data-id]");
  if (!row) return;
  e.preventDefault();
  nodeMenu(Number(row.dataset.id), e.clientX, e.clientY);
});

tree.addEventListener("dblclick", (e) => {
  const surfaceRow = e.target.closest(".surface-row");
  if (surfaceRow && !e.target.closest("[data-action], input")) return startSurfaceRename(surfaceRow.dataset.surface);
  if (e.target.closest(".row") && !e.target.closest("[data-action]")) {
    const input = document.querySelector('#props [data-path="name"]');
    input?.focus();
    input?.select();
  }
});

// Drag and drop: top/bottom quarter = before/after, middle of a container = inside.
let dragId = null;

function dropTarget(e) {
  const placeholder = e.target.closest(".placeholder");
  if (placeholder) return { el: placeholder, id: Number(placeholder.dataset.into), where: "inside" };
  const row = e.target.closest(".row");
  if (!row) return e.target === tree ? { el: tree, id: null, where: "root" } : null;
  const id = Number(row.dataset.id);
  const node = scene.find(id)?.node;
  const r = row.getBoundingClientRect();
  const f = (e.clientY - r.top) / r.height;
  let where;
  if (node.children) where = f < 0.25 ? "before" : f > 0.75 ? "after" : "inside";
  else where = f < 0.5 ? "before" : "after";
  return { el: row, id, where };
}

/** Validates a drop by trying it on a throwaway copy of the scene. */
function validDrop(t) {
  if (!t || dragId == null) return false;
  if (t.id === dragId) return false;
  const probe = Scene.fromJSON(JSON.parse(JSON.stringify(scene)));
  return probe.move(dragId, t.id, t.where === "root" ? "inside" : t.where);
}

function clearDropMarks() {
  document.querySelectorAll(".drop-before,.drop-after,.drop-inside,.drop-root").forEach((el) => el.classList.remove("drop-before", "drop-after", "drop-inside", "drop-root"));
}

let lastProbe = { key: "", ok: false };
// Surfaces reorder among themselves (which renumbers them), apart from nodes.
let dragSurface = null;

function surfaceDropTarget(e) {
  const row = e.target.closest(".scene-surface");
  if (!row) return null;
  const id = Number(row.dataset.surface.slice(2));
  const r = row.getBoundingClientRect();
  const where = e.clientY - r.top < r.height / 2 ? "before" : "after";
  return id === dragSurface ? null : { el: row, id, where };
}

function reorderSurface(id, targetId, where) {
  const map = scene.reorderSurface(id, targetId, where);
  if (!map) return;
  const remap = (key) => (key?.startsWith("s:") && map.has(Number(key.slice(2))) ? `s:${map.get(Number(key.slice(2)))}` : key);
  surfaceSel = remap(surfaceSel);
  const shown = [...shownSurfaces].map(remap);
  shownSurfaces.clear();
  shown.forEach((k) => shownSurfaces.add(k));
  commit();
  refresh();
  const moved = map.get(id) ?? id;
  setMessage(`Surface #${id} is now #${moved}; ${map.size} surface id(s) changed and their half-spaces were updated.`);
}

tree.addEventListener("dragstart", (e) => {
  const row = e.target.closest(".row");
  if (!row) return;
  if (row.classList.contains("scene-surface")) {
    dragSurface = Number(row.dataset.surface.slice(2));
    dragId = null;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", `surface ${dragSurface}`);
    return;
  }
  dragSurface = null;
  dragId = Number(row.dataset.id);
  lastProbe = { key: "", ok: false };
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", String(dragId));
});
tree.addEventListener("dragover", (e) => {
  if (dragSurface != null) {
    const t = surfaceDropTarget(e);
    clearDropMarks();
    if (!t) return;
    e.preventDefault();
    t.el.classList.add(`drop-${t.where}`);
    return;
  }
  const t = dropTarget(e);
  clearDropMarks();
  if (!t) return;
  const key = `${t.id}:${t.where}`;
  if (lastProbe.key !== key) lastProbe = { key, ok: validDrop(t) };
  if (!lastProbe.ok) return;
  e.preventDefault();
  t.el.classList.add(`drop-${t.where}`);
});
tree.addEventListener("dragleave", (e) => {
  if (!tree.contains(e.relatedTarget)) clearDropMarks();
});
tree.addEventListener("drop", (e) => {
  if (dragSurface != null) {
    const t = surfaceDropTarget(e);
    clearDropMarks();
    if (!t) return;
    e.preventDefault();
    run(reorderSurface, dragSurface, t.id, t.where);
    return;
  }
  const t = dropTarget(e);
  clearDropMarks();
  if (!t) return;
  e.preventDefault();
  if (scene.move(dragId, t.id, t.where === "root" ? "inside" : t.where)) {
    commit();
    refresh({ props: false });
  }
});
tree.addEventListener("dragend", () => {
  dragId = null;
  dragSurface = null;
  clearDropMarks();
});

// ---- properties panel --------------------------------------------------------

/** Resolves a data-path to [object, key]: "surface.*" targets the half-space's shared surface. */
function resolvePath(node, path) {
  let obj = node;
  let keys = path.split(".");
  if (keys[0] === "surface") {
    obj = scene.surfaces.get(node.params.surface);
    keys = keys.slice(1);
  } else if (keys[0] === "world") {
    obj = scene.world;
    keys = keys.slice(1);
  }
  const last = keys.pop();
  for (const k of keys) {
    if (obj[k] == null) obj[k] = {};
    obj = obj[k];
  }
  return [obj, last];
}

const getPath = (node, path) => {
  const [o, k] = resolvePath(node, path);
  return o[k];
};
const setPath = (node, path, value) => {
  const [o, k] = resolvePath(node, path);
  o[k] = value;
};

// ---- editing several nodes at once ----
// With several nodes selected, a property edit applies to every selected node
// of the primary's kind (and composite type): select three spheres, set the
// radius, and all three change. Names and OpenMC ids stay per node.

const PER_NODE_PATHS = new Set(["name", "openmc.id"]);
const sameKind = (a, b) => a.kind === b.kind && (a.kind !== "composite" || a.params.type === b.params.type);

/** The nodes an edit of `path` applies to (the primary first). */
function editTargets(path) {
  const p = primary();
  if (!p || PER_NODE_PATHS.has(path) || path.startsWith("world.")) return [targetNode()];
  let nodes = selection.map((id) => scene.find(id)?.node).filter((n) => n && sameKind(n, p));
  // Surface fields only make sense across surfaces of the same type.
  if (path.startsWith("surface.") && path !== "surface.type") {
    const type = scene.surfaces.get(p.params.surface)?.type;
    nodes = nodes.filter((n) => scene.surfaces.get(n.params.surface)?.type === type);
  }
  return [p, ...nodes.filter((n) => n !== p)];
}

/** Reads a data-path without creating anything (unlike resolvePath). */
function peekPath(node, path) {
  let keys = path.split(".");
  let obj = node;
  if (keys[0] === "surface") {
    obj = scene.surfaces.get(node.params?.surface);
    keys = keys.slice(1);
  }
  for (const k of keys) obj = obj?.[k];
  return obj;
}

/** True when the nodes an edit of `path` would reach do not all share one value. */
function isMixed(path) {
  const nodes = editTargets(path);
  if (nodes.length < 2) return false;
  const first = JSON.stringify(peekPath(nodes[0], path));
  return nodes.some((n) => JSON.stringify(peekPath(n, path)) !== first);
}

function numberInput(node, path, { step = 0.1, min, integer = false, disabled = false, value } = {}) {
  const mixed = value === undefined && node === primary() && isMixed(path);
  return h("input", {
    type: "number",
    step: String(step),
    min: min == null ? null : String(min),
    value: mixed ? "" : String(value ?? getPath(node, path) ?? ""),
    placeholder: mixed ? "mixed" : null,
    title: mixed ? "Differs between the selected nodes; a new value applies to all of them" : null,
    disabled,
    dataset: { path, integer: integer ? "1" : "", min: min == null ? "" : String(min) },
  });
}

function field(label, control, title) {
  return h("div", { class: "field", title }, h("label", {}, label), control);
}

function vecField(label, node, path, opts) {
  return field(label, h("div", { class: "vec" }, [0, 1, 2].map((i) => numberInput(node, `${path}.${i}`, opts))));
}

function select_(path, options, value) {
  const mixed = Boolean(primary()) && isMixed(path);
  return h(
    "select",
    { dataset: { path } },
    mixed && h("option", { value: "", selected: true, disabled: true }, "— mixed —"),
    options.map(([v, label]) => h("option", { value: String(v), selected: !mixed && String(v) === String(value) }, label)),
  );
}

const PARAM_OPTS = {
  size: { step: 0.1, min: 0.001 },
  radius: { step: 0.05, min: 0.001 },
  height: { step: 0.1, min: 0.001 },
  major: { step: 0.05, min: 0.001 },
  minor: { step: 0.02, min: 0.001 },
};

function transformSection(node, { title = "Transform", note } = {}) {
  return h(
    "div",
    { class: "section" },
    h("h3", {}, title),
    note && h("div", { class: "note" }, note),
    vecField("Position", node, "transform.position", { step: 0.1 }),
    vecField("Rotation°", node, "transform.rotation", { step: 5 }),
    !isCell(node) && vecField("Scale", node, "transform.scale", { step: 0.1 }),
    h(
      "div",
      { class: "props-actions" },
      h("button", { class: "tb", onclick: resetTransform }, "Reset transform"),
      isOperation(node) && node.kind !== "complement" && h("button", { class: "tb", onclick: () => run(ungroup) }, "Ungroup"),
    ),
  );
}

function appearanceSettings() {
  // Not a scene field: applied directly, no undo step.
  const select = h(
    "select",
    { onchange: (e) => setTheme(e.target.value) },
    [["dark", "Dark"], ["light", "Light"], ["system", "System (follow the OS)"]].map(([v, l]) => h("option", { value: v, selected: v === themePref }, l)),
  );
  const stats = h("input", {
    type: "checkbox",
    checked: showStats,
    style: "justify-self:start",
    title: "Triangles drawn, last evaluation time, and live CSG solids, in the viewport's bottom-right corner",
    onchange: (e) => setShowStats(e.target.checked),
  });
  return h("div", { class: "section" }, h("h3", {}, "Appearance"), field("Theme", select), field("Statistics", stats, "Show performance statistics in the viewport"));
}

// Viewport statistics (triangles · evaluation ms · live solids): a per-browser
// preference, off by default.
const STATS_KEY = "critica.builder.stats";
let showStats = false;
try {
  showStats = localStorage.getItem(STATS_KEY) === "on";
} catch {
  // Storage unavailable: hidden.
}
function setShowStats(on) {
  showStats = on;
  $("stats").hidden = !on;
  try {
    localStorage.setItem(STATS_KEY, on ? "on" : "off");
  } catch {
    // Storage unavailable: the choice lasts for this session.
  }
}
$("stats").hidden = !showStats;

function worldSettings() {
  const w = scene.world;
  const resolved = results.world ?? scene.resolveWorld();
  // Show the resolved box while auto is on (the stored min/max are only used when it is off).
  const shown = { min: w.auto ? resolved.min : w.min, max: w.auto ? resolved.max : w.max };
  const vec = (label, key) =>
    field(label, h("div", { class: "vec" }, [0, 1, 2].map((i) => numberInput({}, `world.${key}.${i}`, { step: 1, disabled: w.auto, value: Number(shown[key][i].toPrecision(6)) }))));
  return h(
    "div",
    { class: "section" },
    h("h3", {}, "World box"),
    h("div", { class: "note" }, "Bounds the infinite half-spaces (planes, cylinders, complements). Auto fits the bounded content."),
    field("Auto", h("input", { type: "checkbox", checked: w.auto, dataset: { path: "world.auto" }, style: "justify-self:start" })),
    vec("Min", "min"),
    vec("Max", "max"),
    h("h3", {}, "Display"),
    field("Segments", numberInput({}, "world.segments", { step: 4, min: 8, integer: true }), "Facets around a full circle for curved OpenMC surfaces (display only); with Adaptive, for the largest ones"),
    field(
      "Adaptive",
      h("input", { type: "checkbox", checked: w.adaptive !== false, dataset: { path: "world.adaptive" }, style: "justify-self:start" }),
      "Fewer segments for smaller surfaces (∝ √radius), keeping facets about the same size: much faster for models with many small curved surfaces",
    ),
    field("Up axis", select_("world.up", [["z", "Z up (OpenMC)"], ["y", "Y up"]], w.up)),
  );
}


function renderSettings() {
  keepFocus($("settings-body"), renderSettingsBody);
}

function renderSettingsBody() {
  $("settings-body").replaceChildren(appearanceSettings(), worldSettings());
}

// Every modal closes with its ✕ button, Esc (native), or a click on the backdrop.
const dialogs = [...document.querySelectorAll("dialog.modal")];
for (const dialog of dialogs) {
  dialog.querySelector(".dialog-close").onclick = () => dialog.close();
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
}
const anyDialogOpen = () => dialogs.some((d) => d.open);

function openDialog(id) {
  for (const d of dialogs) if (d.open) d.close();
  if (id === "settings") renderSettings();
  if (id === "tutorial") renderTutorial();
  if (id === "shortcuts") renderShortcuts();
  if (id === "xml-preview") renderXmlPreview();
  $(id).showModal();
}

$("settings-open").onclick = () => openDialog("settings");
$("xml-preview-open").append(icon("xml"), h("span", { class: "label" }, "Preview XML"));
$("xml-preview-open").onclick = () => {
  if (previewKind === "settings") previewKind = "geometry";
  openDialog("xml-preview");
};

function renderProps() {
  keepFocus($("props"), renderPropsBody);
}

function renderPropsBody() {
  const panel = $("props");
  const node = primary();
  const picked = !node && surfaceSel ? surfaceAt(surfaceSel) : null;
  if (picked) {
    panel.replaceChildren(...surfacePanel(picked));
    return;
  }
  if (!node) {
    panel.replaceChildren(
      h("h2", {}, "Properties"),
      h(
        "div",
        { class: "empty-props" },
        h("div", {}, "Select a node to edit it."),
        h("div", {}, "New here? ", h("button", { class: "link-button", onclick: () => openDialog("tutorial") }, "Open the tutorial"), "."),
      ),
    );
    return;
  }

  const sections = [
    h("h2", {}, OPERATIONS[node.kind]?.label ?? PRIMITIVES[node.kind]?.label ?? { halfspace: "Half-space", cell: "Cell", universe: "Universe", composite: "Composite surface", ref: "Reference" }[node.kind], selection.length > 1 ? h("span", {}, `${selection.length} selected`) : null),
  ];
  const editing = editTargets("params").length;
  if (selection.length > 1) {
    const others = selection.length - editing;
    sections.push(
      h(
        "div",
        { class: "multi-note" },
        editing > 1 ? `Editing ${editing} nodes of this type: changes apply to all of them (names stay individual).` : "Changes apply to this node only.",
        others > 0 ? ` ${others} other selected node${others > 1 ? "s are" : " is"} of another type and left unchanged.` : "",
      ),
    );
  }
  const basics = node.kind === "ref" ? [] : [field("Name", h("input", { type: "text", value: node.name, dataset: { path: "name" } }))];
  if (isOperation(node)) {
    basics.push(field("Type", select_("kind", Object.entries(OPERATIONS).map(([k, d]) => [k, `${d.symbol}  ${d.label}`]), node.kind)));
  }
  if (isCell(node) || isUniverse(node)) {
    basics.push(field("OpenMC id", numberInput(node, "openmc.id", { step: 1, min: 1, integer: true }), "Kept on export when unique"));
  }
  if (!isUniverse(node)) {
    basics.push(field("Enabled", h("input", { type: "checkbox", checked: node.enabled, dataset: { path: "enabled" }, style: "justify-self:start" })));
  }
  sections.push(h("div", { class: "section" }, basics));

  if (isPrimitive(node)) {
    const params = Object.entries(node.params).map(([key, value]) =>
      Array.isArray(value)
        ? vecField(key, node, `params.${key}`, PARAM_OPTS[key])
        : key === "axis"
          ? field("axis", select_(`params.${key}`, [["x", "X"], ["y", "Y"], ["z", "Z"]], value))
          : field(key, numberInput(node, `params.${key}`, INT_PARAMS.has(key) ? { step: 1, min: key === "stacks" ? 2 : 3, integer: true } : PARAM_OPTS[key])),
    );
    sections.push(
      h(
        "div",
        { class: "section" },
        h("h3", {}, "Shape"),
        params,
        h(
          "div",
          { class: "props-actions" },
          h("button", { class: "tb", title: "Replace this shape by the intersection of its half-spaces, on editable scene surfaces", onclick: () => run(flattenNode, node.id) }, "Flatten to half-spaces"),
        ),
      ),
    );
  }

  if (node.kind === "halfspace") sections.push(...halfspaceSections(node));
  if (node.kind === "composite") sections.push(...compositeSections(node));
  if (node.kind === "ref") sections.push(referenceSection(node));
  if (isCell(node)) sections.push(...cellSections(node));
  if (isUniverse(node)) {
    let users = 0;
    scene.walk((n) => isCell(n) && n.fill.type === "universe" && n.fill.universe === node.id && users++);
    sections.push(
      h(
        "div",
        { class: "section" },
        h("h3", {}, "Usage"),
        h("div", { class: "info" }, `${node.children.length} item(s) · filled into ${users} cell(s)`),
        h("div", { class: "note" }, "Shown in its own coordinates when selected (x-ray) or isolated."),
      ),
    );
  }

  if (isRegionNode(node)) sections.push(transformSection(node));
  sections.push(h("div", { class: "section" }, h("h3", {}, "Result"), h("div", { class: "info", id: "info" })));
  panel.replaceChildren(...sections);
  updateInfo();
}

function compositeSections(node) {
  const def = COMPOSITE_TYPES[node.params.type];
  if (!def) return [h("div", { class: "section" }, h("div", { class: "note" }, `Unknown composite type "${node.params.type}".`))];
  const path = (name) => `params.values.${name}`;
  const values = node.params.values;
  const fields = def.params.map((p) => {
    const label = p.label ?? (p.kind === "boundary" ? "Boundary" : p.name);
    switch (p.kind) {
      case "number":
        return field(label, numberInput(node, path(p.name), { step: p.step ?? 0.1, min: p.min }), p.title);
      case "vec2":
        return field(label, h("div", { class: "vec vec2" }, [0, 1].map((i) => numberInput(node, `${path(p.name)}.${i}`, { step: 0.1 }))), p.title);
      case "vec3":
        return vecField(label, node, path(p.name), { step: 0.1 });
      case "axis":
        return field(label, select_(path(p.name), [["x", "x"], ["y", "y"], ["z", "z"]], values[p.name]));
      case "orientation":
        return field(label, select_(path(p.name), [["y", "y (flat sides ⟂ x)"], ["x", "x (flat sides ⟂ y)"]], values[p.name]));
      case "basis":
        return field(label, select_(path(p.name), [["xy", "xy (prism along z)"], ["yz", "yz (prism along x)"], ["xz", "xz (prism along y)"], ["rz", "rz (revolved about z)"]], values[p.name]));
      case "boundary":
        return field(label, select_(path(p.name), p.options.map((b) => [b, b]), values[p.name]));
      case "bool":
        return field(label, h("input", { type: "checkbox", checked: values[p.name], dataset: { path: path(p.name) }, style: "justify-self:start" }), p.title);
      case "numbers":
        return field(label, h("input", { type: "text", value: values[p.name].join(", "), dataset: { path: path(p.name), kind: "numbers" } }), p.title);
      case "points":
        return h(
          "div",
          { class: "field field-wide", title: "One point per line: two numbers in the chosen basis" },
          h("label", {}, label),
          h("textarea", { rows: Math.min(10, values[p.name].length + 1), spellcheck: false, value: values[p.name].map((pt) => pt.join("  ")).join("\n"), dataset: { path: path(p.name), kind: "points" } }),
        );
    }
    return null;
  });
  return [
    h(
      "div",
      { class: "section" },
      h("h3", {}, def.label),
      h("div", { class: "note" }, def.description, " ", h("span", { class: "oid" }, `openmc.model.${def.openmc}`)),
      field("Side", select_("params.sense", [["-", "− negative (inside)"], ["+", "+ positive (outside)"]], node.params.sense)),
    ),
    h(
      "div",
      { class: "section" },
      h("h3", {}, "Parameters"),
      fields,
      h(
        "div",
        { class: "props-actions" },
        h("button", { class: "tb", title: "Replace by editable half-spaces on shared surfaces", onclick: () => run(expandComposite) }, icon("expand"), "Expand to half-spaces"),
      ),
    ),
  ];
}

function referenceSection(node) {
  const source = scene.find(node.params.target)?.node;
  const uses = source ? scene.refsTo(source.id).length + 1 : 0;
  return h(
    "div",
    { class: "section" },
    h("h3", {}, "Reuses"),
    source
      ? [
          field("Source", h("button", { class: "link-button", title: "Select the source node", onclick: () => select([source.id]) }, source.name)),
          h("div", { class: "note" }, `This region is used in ${uses} places. Edit the source to change all of them; the transform below applies to this use only.`),
          h("div", { class: "props-actions" }, h("button", { class: "tb", title: "Replace this reference by its own copy of the source", onclick: () => run(unlinkReference) }, "Make independent copy")),
        ]
      : h("div", { class: "note" }, "The referenced node was deleted. Undo (Ctrl+Z) or delete this reference."),
  );
}

function halfspaceSections(node) {
  const s = scene.surfaces.get(node.params.surface);
  if (!s) return [h("div", { class: "section" }, h("div", { class: "note" }, `Surface ${node.params.surface} is missing.`))];
  const users = scene.surfaceUsers(s.id);
  return [
    h(
      "div",
      { class: "section" },
      h("h3", {}, "Half-space"),
      field("Side", select_("params.sense", [["-", "− negative (inside)"], ["+", "+ positive (outside)"]], node.params.sense)),
    ),
    h(
      "div",
      { class: "section" },
      h("h3", {}, `Surface #${s.id}`),
      surfaceFields(node, s, users),
      users > 1 && h("div", { class: "props-actions" }, h("button", { class: "tb", onclick: () => run(uniquifySurface) }, "Use a private copy")),
    ),
  ];
}

/** Editable fields of the shared surface `s` used by the half-space `node`. */
function surfaceFields(node, s, users) {
  const def = SURFACE_TYPES[s.type];
  return [
    users > 1 && h("div", { class: "note" }, `Shared by ${users} half-spaces: edits apply to all of them.`),
    field("Type", select_("surface.type", Object.keys(SURFACE_TYPES).map((t) => [t, t]), s.type)),
    def.coeffs.map((name, i) => field(name, numberInput(node, `surface.coeffs.${i}`, { step: 0.1 }))),
    field("Boundary", select_("surface.boundary", BOUNDARY_TYPES.map((b) => [b, b]), s.boundary ?? "transmission")),
    field("Name", h("input", { type: "text", value: s.name ?? "", dataset: { path: "surface.name" } })),
  ];
}

/** Properties of a selected surface: editable when shared, read-only when generated by a shape. */
function surfacePanel({ owner, entry }) {
  const shared = entry.id != null ? scene.surfaces.get(entry.id) : null;
  const key = surfaceSel;
  const pinned = shownSurfaces.has(key);
  const out = [h("h2", {}, "Surface", h("span", {}, shared ? `#${shared.id}` : "generated"))];
  if (shared) {
    const users = [];
    scene.walk((n) => n.kind === "halfspace" && n.params.surface === shared.id && users.push(n));
    out.push(
      h("div", { class: "section" }, surfaceFields(targetNode(), shared, users.length)),
      h(
        "div",
        { class: "section" },
        h("h3", {}, "Used by"),
        users.length
          ? users.map((n) =>
              h("div", { class: "info" }, h("button", { class: "link-button", onclick: () => select([n.id]) }, n.name), ` (${n.params.sense === "-" ? "− inside" : "+ outside"})`),
            )
          : h("div", { class: "note" }, "No half-space uses this surface yet, so it is not exported. Add one with Half-space above the scene tree."),
        h(
          "div",
          { class: "props-actions" },
          h("button", { class: "tb", onclick: () => run(addHalfspaceOnSurface) }, icon("halfspace"), "Add half-space"),
          !users.length && h("button", { class: "tb", title: "Delete this unused surface (Del)", onclick: () => run(deleteSurface, shared.id) }, "Delete"),
        ),
      ),
    );
  } else {
    const s = entry.surface;
    const names = SURFACE_TYPES[s.type]?.coeffs ?? [];
    out.push(
      h(
        "div",
        { class: "section" },
        field("Type", h("span", { class: "info" }, s.type)),
        names.map((name, i) => field(name, h("span", { class: "info" }, fmt(s.coeffs[i])))),
        h("div", { class: "note" }, `Generated by “${owner.name}”${entry.note ? ` (${entry.note})` : ""}: change that node to change this surface. Half-space makes an editable copy of it.`),
        h(
          "div",
          { class: "props-actions" },
          h("button", { class: "tb", onclick: () => select([owner.id]) }, `Select ${owner.name}`),
          h("button", { class: "tb", onclick: () => run(addHalfspaceOnSurface) }, icon("halfspace"), "Add half-space"),
        ),
      ),
    );
  }
  out.push(
    h(
      "div",
      { class: "section" },
      h("h3", {}, "Display"),
      field(
        "Keep shown",
        h("input", {
          type: "checkbox",
          checked: pinned,
          style: "justify-self:start",
          title: "Keep drawing this surface after selecting something else",
          onchange: () => {
            if (!shownSurfaces.delete(key)) shownSurfaces.add(key);
            refresh({ props: false });
          },
        }),
      ),
    ),
  );
  return out;
}

function cellSections(node) {
  const f = node.fill;
  const universes = scene.universes.map((u) => [u.id, u.name]);
  const fillOptions = [["material", "Material"], ["universe", "Universe"]];
  if (f.type === "lattice") fillOptions.push(["lattice", `Lattice ${f.id} (preserved)`]);
  if (f.type === "external") fillOptions.push(["external", `DAGMC ${f.id} (preserved)`]);
  const out = [
    h(
      "div",
      { class: "section" },
      h("h3", {}, "Fill"),
      field("Type", select_("fill.type", fillOptions, f.type)),
      f.type === "material" &&
        field(
          "Material",
          h("input", { type: "text", value: String(f.material), list: "materials-list", dataset: { path: "fill.material" } }),
          "Material id, \"void\", or several ids for distributed materials",
        ),
      f.type === "material" && h("datalist", { id: "materials-list" }, ["void", ...Object.keys(scene.materials)].map((m) => h("option", { value: m }, scene.materials[m]?.name ?? ""))),
      f.type === "universe" && (universes.length ? field("Universe", select_("fill.universe", universes, f.universe)) : h("div", { class: "note" }, "Create a universe first.")),
      (f.type === "lattice" || f.type === "external") && h("div", { class: "note" }, "Lattice and DAGMC fills are written back unchanged on export; editing them is not supported yet."),
    ),
  ];
  if (f.type !== "material") {
    out.push(transformSection(node, { title: "Fill transform", note: "Moves the filling universe. Rotation follows OpenMC: about Z, then Y, then X." }));
  }
  out.push(displaySection(node));
  return out;
}

function displaySection(cell) {
  const custom = /^#[0-9a-f]{6}$/i.test(cell.color ?? "");
  const shown = custom ? cell.color : toHex(colorBy === "cell" ? autoCellColor(cell) : isVoidCell(cell) ? VOID_COLOR : distinctColor(cell.id));
  const universeFill = cell.fill.type === "universe";
  return h(
    "div",
    { class: "section" },
    h("h3", {}, "Display"),
    field(
      "Color",
      h(
        "div",
        { class: "color-field" },
        h("input", { type: "color", value: shown, dataset: { path: "color" }, title: "Display color of this cell" }),
        h("span", { class: "oid" }, custom ? cell.color : "auto"),
        custom && h("button", { class: "tb", title: "Go back to the automatic color", onclick: () => run(resetCellColor) }, "Auto"),
      ),
    ),
    h(
      "div",
      { class: "note" },
      universeFill
        ? "This cell shows the cells of its filling universe, which keep their own colors."
        : "Used when coloring by cell; Materials (M) colors by material instead. Not exported to OpenMC.",
    ),
  );
}

function resetCellColor() {
  const node = primary();
  if (!node) return;
  delete node.color;
  commit();
  refresh();
}

function updateInfo() {
  const info = $("info");
  const node = primary();
  if (!info || !node) return;
  if (!node.enabled) {
    info.textContent = "Disabled — excluded from its parent.";
    return;
  }
  if (results.errors.has(node.id)) {
    info.textContent = `Error: ${results.errors.get(node.id)}`;
    return;
  }
  const solids = partsOf(node.id).map((p) => p.solid);
  if (!solids.length) {
    info.textContent = isCell(node) && isVoidCell(node) ? "Void cell." : "Empty result.";
    return;
  }
  const volume = solids.reduce((s, x) => s + x.volume, 0);
  const tris = solids.reduce((s, x) => s + x.triangleCount, 0);
  const bounds = solids.map((s) => s.bounds).reduce((a, b) => ({ min: a.min.map((v, i) => Math.min(v, b.min[i])), max: a.max.map((v, i) => Math.max(v, b.max[i])) }));
  const size = bounds.max.map((v, i) => fmt(v - bounds.min[i])).join(" × ");
  info.replaceChildren(
    ...[
      ...infoRow("triangles", tris),
      ...infoRow("volume", fmt(volume)),
      ...infoRow("size", size),
      ...(solids.length > 1 ? infoRow("parts", solids.length) : []),
    ].filter(Boolean),
  );
}

/** A label/value pair for the two-column Result grid. */
const infoRow = (label, value) => [h("span", { class: "info-label" }, label), h("span", {}, String(value))];

function readInput(el) {
  if (el.type === "checkbox") return el.checked;
  if (el.dataset.kind === "numbers") {
    const nums = el.value.split(/[\s,;]+/).filter(Boolean).map(Number);
    return nums.length && nums.every(Number.isFinite) ? nums : undefined;
  }
  if (el.dataset.kind === "points") {
    const rows = el.value.split(/\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(/[\s,;]+/).map(Number));
    return rows.length && rows.every((r) => r.length === 2 && r.every(Number.isFinite)) ? rows : undefined;
  }
  if (el.type !== "number") return el.value;
  let v = parseFloat(el.value);
  if (!Number.isFinite(v)) return undefined;
  if (el.dataset.integer) v = Math.round(v);
  if (el.dataset.min !== "") v = Math.max(Number(el.dataset.min), v);
  return v;
}

// With a scene surface selected, "surface.*" paths resolve through a stand-in half-space.
const targetNode = () => primary() ?? (surfaceSel?.startsWith("s:") ? { params: { surface: Number(surfaceSel.slice(2)) } } : {});

/** Shared input handling for the properties panel and the settings dialog. */
function onFormInput(e) {
  const path = e.target.dataset?.path;
  if (!path || e.target.tagName === "SELECT") return;
  const value = readInput(e.target);
  if (value === undefined) return;
  if (path === "world.auto") return; // handled on change
  for (const node of editTargets(path)) setPath(node, path, value);
  if (path.startsWith("world.")) scene.world.auto = path === "world.segments" || path === "world.up" || path === "world.adaptive" ? scene.world.auto : false;
  schedule();
}

function onFormChange(e) {
  const path = e.target.dataset?.path;
  if (!path) return;
  const node = targetNode();
  if (e.target.tagName === "SELECT") for (const n of editTargets(path)) onSelectChange(n, path, e.target.value);
  else if (path === "world.auto") {
    scene.world.auto = e.target.checked;
    if (!scene.world.auto && results.world) {
      scene.world.min = [...results.world.min];
      scene.world.max = [...results.world.max];
    }
  } else if (path === "surface.name") {
    for (const n of editTargets(path)) {
      const sf = scene.surfaces.get(n.params?.surface);
      if (sf && !sf.name) delete sf.name;
      if (sf) syncHalfspaceNames(sf.id);
    }
  } else if (e.target.type === "number") {
    // Reflect clamping (e.g. slices < 3) back into the field.
    const v = getPath(node, path);
    if (v !== undefined) e.target.value = String(v);
  }
  commit();
  // `change` fires while focus is moving to the field the user just clicked.
  // Rebuilding the form right now would replace that field and drop the
  // focus, so wait until the focus has landed, then rebuild around it.
  const fromSettings = path.startsWith("world.");
  const rebuildProps = e.target.tagName === "SELECT" || path === "color" || editTargets(path).length > 1;
  setTimeout(() => {
    if (fromSettings) {
      refresh({ props: false });
      renderSettings(); // reflect auto/manual state and the resolved box
    } else {
      refresh({ props: rebuildProps });
    }
  }, 0);
}

for (const form of [$("props"), $("settings-body")]) {
  form.addEventListener("input", onFormInput);
  form.addEventListener("change", onFormChange);
}

function onSelectChange(node, path, value) {
  if (path === "surface.type") {
    const s = scene.surfaces.get(node.params.surface);
    s.type = value;
    s.coeffs = [...SURFACE_TYPES[value].defaults];
  } else if (path === "fill.type") {
    if (value === "universe") {
      if (!scene.universes.length) scene.add("universe", { name: `Universe ${scene.nextId}` });
      node.fill = { type: "universe", universe: scene.universes[0].id };
      node.transform.order = "zyx";
    } else if (value === "material") {
      node.fill = { type: "material", material: "void" };
    }
  } else if (path === "fill.universe") {
    node.fill.universe = Number(value);
  } else {
    setPath(node, path, value);
  }
  if (path === "params.sense" || path === "surface.type") {
    // Keep generated half-space names in sync (every user, for a type change).
    const s = scene.surfaces.get(node.params.surface);
    const sync = (n) => {
      if (/^[−+]\d+ /.test(n.name)) n.name = halfspaceName(s, n.params.sense);
    };
    if (path === "surface.type") scene.walk((n) => n.kind === "halfspace" && n.params.surface === s.id && sync(n));
    else sync(node);
  }
}

function resetTransform() {
  if (!primary()) return;
  for (const node of editTargets("transform")) node.transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], ...(isCell(node) ? { order: "zyx" } : {}) };
  commit();
  refresh();
}

// ---- actions -----------------------------------------------------------------

/** Runs an action, reporting thrown errors in the status bar. */
function run(action, ...args) {
  try {
    action(...args);
  } catch (e) {
    setMessage(e.message ?? String(e), true);
  }
}

/** The container new nodes go into: a single selected operation, cell or universe. */
function insertionTarget(node) {
  const p = primary();
  if (selection.length !== 1 || !p || !p.children) return null;
  return scene.canContain(p, node) ? p.id : null;
}

function addPrimitive(kind) {
  const added = scene.add(kind, {}, insertionTarget({ kind }));
  commit();
  select([added.id]);
}

function addComposite(type) {
  const node = scene.addComposite(type, insertionTarget({ kind: "composite" }));
  commit();
  select([node.id]);
}

/**
 * Replaces a builder shape (cube, sphere, cylinder, cone, …) by the intersection of
 * the half-spaces it is made of, on scene surfaces, with its transform applied:
 * the same region, built from editable surfaces.
 */
function flattenNode(id) {
  const node = scene.find(id)?.node;
  if (!node || !isPrimitive(node)) throw new Error("Only shapes (cube, sphere, cylinder, cone) can be flattened.");
  const entries = nodeSurfaces(node);
  const inexact = entries.find((e) => e.note);
  if (inexact) throw new Error(`"${node.name}" cannot be flattened: its transform ${inexact.note}.`);
  const top = scene.replaceWithHalfspaces(id, entries.map(({ surface, sense }) => ({ surface, sense })));
  top.surfacesOpen = false;
  commit();
  select([top.id]);
  setMessage(`Flattened "${node.name}" into ${entries.length} half-space${entries.length > 1 ? "s" : ""}.`);
}

/** Right-click menu of a node: flatten (shapes), expand (composites), rename, duplicate, delete. */
function nodeMenu(id, x, y) {
  const node = scene.find(id)?.node;
  if (!node) return;
  if (!(selection.length === 1 && selection[0] === id) && !selection.includes(id)) select([id]);
  const several = selection.length > 1;
  openContextMenu(x, y, [
    isPrimitive(node) && {
      label: "Flatten to half-spaces",
      title: "Replace this shape by the intersection of the half-spaces it is made of, on editable scene surfaces",
      run: () => flattenNode(id),
    },
    node.kind === "composite" && { label: "Expand to half-spaces", run: () => (select([id]), expandComposite()) },
    (isPrimitive(node) || node.kind === "composite") && "sep",
    !several && { label: "Rename…", hint: "F2", run: () => renameSelection() },
    { label: several ? `Duplicate ${selection.length} nodes` : "Duplicate", hint: "Ctrl+D", run: () => duplicateSelection() },
    { label: several ? `Delete ${selection.length} nodes` : "Delete", hint: "Del", run: () => deleteSelection() },
  ]);
}

function expandComposite() {
  const node = primary();
  if (!node || node.kind !== "composite") return;
  const top = scene.expandCompositeNode(node.id);
  commit();
  select([top.id]);
}

/** Adds the inside (negative) half-space of a new OpenMC surface with default coefficients. */
const halfspaceName = (s, sense) => `${sense === "-" ? "−" : "+"}${s.id} ${s.type}${s.name ? ` (${s.name})` : ""}`;

/** Adds a bare surface (no half-space) and selects it. */
function addSurface(type) {
  const id = scene.addSurface({ type, coeffs: [...SURFACE_TYPES[type].defaults] });
  commit();
  selectSurface(`s:${id}`);
}

/**
 * Adds a half-space (negative side by default) on the selected surface, inside
 * the operation or cell selected just before it, if any. A surface generated
 * by a shape is first copied into a scene surface.
 */
function addHalfspaceOnSurface(sense = "-") {
  const found = surfaceSel && surfaceAt(surfaceSel);
  if (!found) throw new Error("Select a surface first (in the Surfaces section or under a leaf), then add a half-space on it.");
  let id = found.entry.id;
  if (id == null) id = scene.addSurface({ type: found.entry.surface.type, coeffs: [...found.entry.surface.coeffs] });
  const s = scene.surfaces.get(id);
  const node = scene.add("halfspace", { params: { surface: id, sense }, name: halfspaceName(s, sense) }, lastContainer?.id && scene.find(lastContainer.id) ? lastContainer.id : null);
  commit();
  select([node.id]);
}

function renameSelection() {
  if (!primary() && surfaceSel) return startSurfaceRename(surfaceSel);
  const input = document.querySelector('#props [data-path="name"]');
  input?.focus();
  input?.select();
}

function deleteSurface(id) {
  const users = scene.surfaceUsers(id);
  if (users) throw new Error(`Surface #${id} is used by ${users} half-space(s): delete those first.`);
  scene.surfaces.delete(id);
  shownSurfaces.delete(`s:${id}`);
  surfaceSel = null;
  commit();
  refresh();
}

function addUniverse() {
  const u = scene.add("universe", { name: `Universe ${scene.nextId}` });
  commit();
  select([u.id]);
}

function makeCells() {
  const cells = scene.makeCells(selection);
  if (!cells.length) {
    // Nothing suitable selected: add an empty cell (inside a selected universe if any).
    const p = primary();
    const cell = scene.add("cell", {}, p && isUniverse(p) ? p.id : null);
    commit();
    return select([cell.id]);
  }
  commit();
  select(cells.map((c) => c.id));
}

function combine(kind) {
  if (!selection.length) return;
  const group = scene.combine(kind, selection);
  if (!group) return;
  commit();
  select([group.id]);
  const refs = scene.lastCombineRefs;
  if (refs) setMessage(`${refs} region${refs > 1 ? "s" : ""} reused by reference: ${refs > 1 ? "their cells keep them" : "its cell keeps it"}, and edits to the source update every use.`);
}

function addReferences() {
  const refs = scene.addReferences(selection);
  if (!refs.length) return;
  commit();
  select(refs.map((r) => r.id));
}

function unlinkReference() {
  const node = primary();
  if (!node || node.kind !== "ref") return;
  const copy = scene.unlinkRef(node.id);
  commit();
  select([copy.id]);
}

function ungroup() {
  const node = primary();
  if (!node || !isOperation(node)) return;
  const children = scene.ungroup(node.id);
  commit();
  select(children.map((c) => c.id));
}

function uniquifySurface() {
  const node = primary();
  if (!node) return;
  scene.uniquifySurface(node.id);
  commit();
  refresh();
}

function duplicateSelection() {
  const copies = selection.map((id) => scene.duplicate(id)).filter(Boolean);
  if (!copies.length) return;
  commit();
  select(copies.map((c) => c.id));
}

function deleteSelection() {
  if (!selection.length && surfaceSel?.startsWith("s:")) return deleteSurface(Number(surfaceSel.slice(2)));
  if (!selection.length) return;
  const removed = new Set();
  for (const id of selection) {
    const node = scene.detach(id);
    if (node) scene.walk((n) => removed.add(n.id), [node]);
  }
  selection = [];
  commit();
  refresh();
  let dangling = 0;
  scene.walk((n) => n.kind === "ref" && removed.has(n.params.target) && dangling++);
  if (dangling) setMessage(`${dangling} reference${dangling > 1 ? "s" : ""} now point${dangling > 1 ? "" : "s"} to a deleted node (Ctrl+Z to undo).`, true);
}

// ---- context menu ----

let contextMenu = null;

function closeContextMenu() {
  contextMenu?.remove();
  contextMenu = null;
}

/** Opens a menu at the pointer. Items: { label, hint?, run, disabled? } or "sep". */
function openContextMenu(x, y, items) {
  closeContextMenu();
  contextMenu = h(
    "div",
    { class: "menu-list context-menu", role: "menu" },
    items.filter(Boolean).map((it) =>
      it === "sep"
        ? h("div", { class: "menu-sep" })
        : h(
            "button",
            {
              class: "menu-item",
              role: "menuitem",
              disabled: it.disabled || null,
              title: it.title ?? null,
              onclick: () => {
                closeContextMenu();
                run(it.run);
              },
            },
            h("span", {}, it.label),
            it.hint && h("kbd", {}, it.hint),
          ),
    ),
  );
  document.body.append(contextMenu);
  // Keep it on screen.
  const r = contextMenu.getBoundingClientRect();
  contextMenu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  contextMenu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  contextMenu.querySelector(".menu-item:not([disabled])")?.focus();
}

document.addEventListener("pointerdown", (e) => contextMenu && !contextMenu.contains(e.target) && closeContextMenu(), true);
document.addEventListener(
  "keydown",
  (e) => {
    if (contextMenu && e.key === "Escape") {
      e.stopPropagation();
      closeContextMenu();
    }
  },
  true,
);
addEventListener("blur", closeContextMenu);
addEventListener("resize", closeContextMenu);

/** What the two sides of a surface are, in words: [negative, positive]. */
function sideHints(s) {
  const axis = { "x-plane": "x", "y-plane": "y", "z-plane": "z" }[s.type];
  if (axis) return [`${axis} < ${fmt(s.coeffs[0])}`, `${axis} > ${fmt(s.coeffs[0])}`];
  if (s.type === "plane") return ["Ax+By+Cz < D", "Ax+By+Cz > D"];
  return ["inside", "outside"];
}

/** Right-click menu of a surface (key as in surfaceAt): make either half-space, show, delete. */
function surfaceMenu(key, x, y) {
  selectSurface(key);
  const found = surfaceAt(key);
  if (!found) return;
  const { owner, entry } = found;
  const [neg, pos] = sideHints(entry.surface);
  const shown = shownSurfaces.has(key);
  const target = lastContainer && scene.find(lastContainer.id) ? ` in ${lastContainer.name}` : "";
  const copy = entry.id == null ? " (on an editable copy)" : "";
  openContextMenu(x, y, [
    { label: `Create − half-space${target}`, hint: neg, title: `Negative side${copy}`, run: () => addHalfspaceOnSurface("-") },
    { label: `Create + half-space${target}`, hint: pos, title: `Positive side${copy}`, run: () => addHalfspaceOnSurface("+") },
    "sep",
    !owner && { label: "Rename…", hint: "F2", run: () => startSurfaceRename(key) },
    {
      label: shown ? "Stop keeping shown" : "Keep shown",
      run: () => {
        if (!shownSurfaces.delete(key)) shownSurfaces.add(key);
        refresh();
      },
    },
    owner && { label: `Select ${owner.name}`, run: () => select([owner.id]) },
    ...(!owner ? surfaceMoves(entry.id) : []),
    !owner && {
      label: "Delete surface",
      hint: "Del",
      disabled: entry.users > 0,
      title: entry.users ? `Used by ${entry.users} half-space(s)` : null,
      run: () => deleteSurface(entry.id),
    },
  ]);
}

/** Move up / down items for a scene surface (renumbers, like dragging it). */
function surfaceMoves(id) {
  const ids = [...scene.surfaces.keys()].sort((a, b) => a - b);
  const i = ids.indexOf(id);
  return [
    { label: "Move up", hint: i > 0 ? `→ #${ids[i - 1]}` : "", disabled: i <= 0, run: () => reorderSurface(id, ids[i - 1], "before") },
    { label: "Move down", hint: i < ids.length - 1 ? `→ #${ids[i + 1]}` : "", disabled: i >= ids.length - 1, run: () => reorderSurface(id, ids[i + 1], "after") },
  ];
}

function onViewContext(tag, e, leaf) {
  if (tag >= SURFACE_TAG) {
    const key = displayed[tag - SURFACE_TAG]?.key;
    if (key) surfaceMenu(key, e.clientX, e.clientY);
    return;
  }
  if (!tag || !scene.find(tag)) return;
  // The shape under the pointer, so it can be flattened even inside a region.
  const target = pickTarget(tag, leaf, true, () => hitPoint(e));
  const node = scene.find(target)?.node;
  if (node && isPrimitive(node)) return nodeMenu(target, e.clientX, e.clientY);
  nodeMenu(pickTarget(tag, leaf, false, () => hitPoint(e)), e.clientX, e.clientY);
}

function onPick(tag, e, leaf) {
  if (tag >= SURFACE_TAG) {
    const key = displayed[tag - SURFACE_TAG]?.key;
    if (key) selectSurface(key);
    return;
  }
  if (!tag || !scene.find(tag)) {
    if (!(e.ctrlKey || e.metaKey || e.shiftKey)) select([]);
    return;
  }
  select([pickTarget(tag, leaf, e.altKey, () => hitPoint(e))], { additive: e.ctrlKey || e.metaKey || e.shiftKey });
}

/**
 * What a click on a face of `tag` selects: the whole region it belongs to
 * (the top-level item or cell; inside a universe, the item under it). Clicking
 * again inside the selected node steps one level down toward the leaf that
 * made the face; `toLeaf` (Alt) jumps straight to that leaf.
 */
function pickTarget(tag, leaf, toLeaf, point) {
  // A cell's faces carry the cell's tag; `leaf` is the shape inside it that made the face.
  const inside = leaf && leaf !== tag && scene.find(leaf) && scene.isDescendant(leaf, tag);
  let end = inside ? leaf : tag;
  const pathTo = (id) => [...scene.ancestors(id).reverse(), id].filter((a) => !isUniverse(scene.find(a).node));
  let path = pathTo(end);
  const sel = selection.length === 1 ? selection[0] : null;
  const inRegion = sel != null && (sel === path[0] || scene.isDescendant(sel, path[0]));
  if (!toLeaf && !inRegion) return path[0];
  // Coplanar faces keep the tag of one operand only (all six faces of a box of
  // half-spaces may say "first plane"), so find the leaf of the whole region
  // whose surface the clicked point is actually on.
  const real = closestLeaf(path[0], end, point());
  if (real !== end) {
    end = real;
    path = pathTo(end);
  }
  if (toLeaf) return end;
  const at = path.indexOf(sel);
  if (at >= 0) return path[Math.min(at + 1, path.length - 1)]; // inside the selection: one level down
  // Another branch of the same region (a sibling face): same depth there.
  const depth = pathTo(sel).length - 1;
  return path[Math.min(depth, path.length - 1)];
}

/** Model-space point where the pointer ray first meets the displayed mesh, or null. */
function hitPoint(e) {
  const m = lastMesh;
  if (!m || !m.indices.length) return null;
  const { origin: o, dir: d } = viewer.rayAt(e.clientX, e.clientY);
  const P = m.positions;
  const I = m.indices;
  let best = Infinity;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3;
    const b = I[t + 1] * 3;
    const c = I[t + 2] * 3;
    const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < 1e-12) continue;
    const s = [o[0] - P[a], o[1] - P[a + 1], o[2] - P[a + 2]];
    const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
    if (u < 0 || u > 1) continue;
    const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
    if (v < 0 || u + v > 1) continue;
    const dist = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
    if (dist > 1e-9 && dist < best) best = dist;
  }
  return Number.isFinite(best) ? o.map((x, k) => x + d[k] * best) : null;
}

/**
 * Among the leaves (half-spaces, shapes, composites) under `rootId`, the one
 * with a surface nearest to `point` (distance ≈ |f| / |∇f|). Keeps `fallback`
 * when it is as close as the best, or when there is no point.
 */
function closestLeaf(rootId, fallback, point) {
  const root = scene.find(rootId)?.node;
  if (!point || !root) return fallback;
  const distance = (n) => {
    const m = rootMatrixOf(n.id);
    if (!m) return Infinity;
    const world = !m.some((v, i) => Math.abs(v - IDENTITY[i]) > 1e-12);
    let best = Infinity;
    for (const { surface } of nodeSurfaces(n)) {
      let s = surface;
      if (!world) {
        try {
          const t = transformSurface(surface, m);
          s = { type: t.type, coeffs: t.coeffs };
        } catch {
          continue;
        }
      }
      try {
        const f = evaluateSurface(s, point);
        const h = 1e-6 * (1 + Math.hypot(...point));
        const g = [0, 1, 2].map((k) => (evaluateSurface(s, point.map((x, j) => (j === k ? x + h : x))) - f) / h);
        const d = Math.abs(f) / Math.max(Math.hypot(...g), 1e-12);
        if (d < best) best = d;
      } catch {
        // Unknown surface type: skip it.
      }
    }
    return best;
  };
  const leaves = [];
  scene.walk((n) => n.enabled && hasSurfaces(n) && leaves.push(n), [root]);
  const own = scene.find(fallback)?.node;
  let bestId = fallback;
  let bestD = own && hasSurfaces(own) ? distance(own) : Infinity;
  for (const n of leaves) {
    const d = distance(n);
    if (d < bestD - 1e-9) {
      bestD = d;
      bestId = n.id;
    }
  }
  return bestId;
}

function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  h("a", { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The XML File → Export as writes for `kind` ("geometry", "materials" or "model"), with its warnings. */
function openmcXML(kind) {
  if (kind === "materials") return { text: exportMaterialsXML(scene), warnings: [] };
  if (kind === "settings") return exportSettingsXML(scene);
  const out = exportOpenMC(scene);
  return { text: kind === "model" ? out.model : out.geometry, warnings: [...out.warnings, ...(kind === "model" ? (out.modelWarnings ?? []) : [])] };
}

function exportXML(kind) {
  const { text, warnings } = openmcXML(kind);
  download(`${kind}.xml`, text, "application/xml");
  if (kind === "materials") setMessage(`Exported materials.xml (${Object.keys(scene.materials).length} materials).`);
  else if (kind === "settings") setMessage(warnings.length ? `Exported settings.xml with ${warnings.length} warning(s): ${warnings.join(" ")}` : `Exported settings.xml (${scene.sources.length} source(s)).`, warnings.length > 0);
  else setMessage(warnings.length ? `Exported ${kind}.xml with ${warnings.length} warning(s): ${warnings.join(" ")}` : `Exported ${kind}.xml.`, warnings.length > 0);
}

// ---- XML preview (Geometry ribbon → OpenMC → Preview XML) ----
let previewKind = "geometry";

function renderXmlPreview() {
  let result;
  try {
    result = openmcXML(previewKind);
  } catch (e) {
    result = { error: e.message ?? String(e), warnings: [] };
  }
  const file = `${previewKind}.xml`;
  const copy = h("button", { class: "tb", disabled: Boolean(result.error), title: "Copy the XML to the clipboard" }, "Copy");
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(result.text);
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Copy failed";
    }
    setTimeout(() => (copy.textContent = "Copy"), 1500);
  };
  // replaceChildren would print `false` for a skipped part: filter them out.
  const parts = [
    h(
      "div",
      { class: "xml-preview-bar" },
      h(
        "div",
        { class: "segmented", role: "tablist" },
        [["geometry", "geometry.xml"], ["materials", "materials.xml"], ["settings", "settings.xml"], ["model", "model.xml"]].map(([kind, label]) =>
          h(
            "button",
            {
              class: `tb seg${kind === previewKind ? " on" : ""}`,
              role: "tab",
              "aria-selected": String(kind === previewKind),
              onclick: () => {
                previewKind = kind;
                renderXmlPreview();
              },
            },
            label,
          ),
        ),
      ),
      h("span", { class: "spacer" }),
      copy,
      h("button", { class: "tb", disabled: Boolean(result.error), title: `Download ${file}`, onclick: () => exportXML(previewKind) }, "Download"),
    ),
    result.warnings.length > 0 && h("ul", { class: "xml-preview-warnings" }, result.warnings.map((w) => h("li", {}, w))),
    result.error
      ? h("div", { class: "msg-err" }, `This file cannot be exported yet: ${result.error}`)
      : h("pre", { class: "xml-preview" }, result.text),
  ];
  $("xml-preview-body").replaceChildren(...parts.filter(Boolean));
}

function replaceScene(next, message = "") {
  scene = next;
  selection = [];
  commit();
  refresh({ fit: true });
  if (message) setMessage(message, /warning/i.test(message));
}

async function openFile(file) {
  const text = await file.text();
  if (/^\s*\{/.test(text)) return replaceScene(Scene.fromJSON(JSON.parse(text)));
  // A settings.xml (no geometry): its sources replace the scene's, the rest is kept for export.
  if (!/<geometry[\s>]/.test(text) && /<settings[\s>]/.test(text) && !/<model[\s>]/.test(text)) {
    const imported = importSettingsXML(text);
    if (imported) {
      scene.sources = imported.sources;
      scene.openmc.settings = imported.settings;
      scene.settings = imported.values;
      commit();
      setTab("sources");
      refresh({ props: false });
      const note = `Imported ${imported.sources.length} source(s) and the settings of ${file.name}.`;
      setMessage(imported.warnings.length ? `${note} ${imported.warnings.join(" ")}` : note, imported.warnings.length > 0);
      return;
    }
  }
  // A materials.xml (no geometry) merges into the library of the current scene.
  if (!/<geometry[\s>]/.test(text)) {
    const lib = importMaterialsXML(text);
    if (lib) {
      const ids = Object.keys(lib.materials);
      const replaced = ids.filter((id) => scene.materials[id]).length;
      Object.assign(scene.materials, lib.materials);
      if (lib.crossSections) scene.openmc.crossSections = lib.crossSections;
      commit();
      setTab("materials");
      refresh({ props: false });
      const note = `Imported ${ids.length} material(s) from ${file.name}${replaced ? ` (${replaced} replaced existing ids)` : ""}.`;
      setMessage(lib.warnings.length ? `${note} ${lib.warnings.length} warning(s): ${lib.warnings.join(" ")}` : note, lib.warnings.length > 0);
      return;
    }
  }
  const { scene: imported, warnings } = importOpenMC(text, { fileName: file.name });
  let cells = 0;
  imported.walk((n) => isCell(n) && cells++);
  const summary = `Imported ${file.name}: ${cells} cells, ${imported.surfaces.size} surfaces, ${imported.universes.length} universes.`;
  replaceScene(imported, warnings.length ? `${summary} ${warnings.length} warning(s): ${warnings.join(" ")}` : summary);
}

// ---- toolbar -----------------------------------------------------------------

// ---- ribbon tools ----
// Flyouts: a ribbon button that drops down a menu of choices.
const flyouts = [];

/**
 * A ribbon button with a dropdown of `items` below it: { label, title, run,
 * iconName? } entries, or { heading } to start a titled section.
 */
function flyoutButton({ id, iconName, label, title, heading, items }) {
  const menu = h(
    "div",
    { class: "ribbon-menu", role: "menu", hidden: true },
    heading && h("div", { class: "ribbon-menu-title" }, heading),
    items.map((item) =>
      item.heading
        ? h("div", { class: "ribbon-menu-title" }, item.heading)
        : h(
            "button",
            {
              class: "tb",
              role: "menuitem",
              title: item.title ?? "",
              onclick: () => {
                menu.hidden = true;
                run(item.run);
              },
            },
            item.iconName && icon(item.iconName),
            item.label,
          ),
    ),
  );
  const button = h(
    "button",
    {
      class: "tb",
      id,
      title,
      "aria-haspopup": "menu",
      onclick: (e) => {
        e.stopPropagation();
        const open = menu.hidden;
        for (const f of flyouts) f.menu.hidden = true;
        if (open) {
          // Drop down under the button, kept inside the window.
          const r = button.getBoundingClientRect();
          menu.hidden = false;
          menu.style.top = `${r.bottom + 2}px`;
          menu.style.left = `${Math.max(4, Math.min(r.left, innerWidth - menu.offsetWidth - 4))}px`;
        }
      },
    },
    icon(iconName),
    h("span", { class: "label" }, `${label} ▾`),
  );
  flyouts.push({ button, menu });
  document.body.append(menu);
  return button;
}
// Dropdowns are positioned once on opening: close them when the layout moves.
for (const ev of ["resize", "blur"]) addEventListener(ev, () => flyouts.forEach((f) => (f.menu.hidden = true)));
$("ribbon").addEventListener("scroll", () => flyouts.forEach((f) => (f.menu.hidden = true)));

document.addEventListener("click", (e) => {
  for (const f of flyouts) if (!f.menu.hidden && !f.menu.contains(e.target)) f.menu.hidden = true;
});

// Finite shapes (builder primitives that export as several surfaces).
// ---- Surfaces group: the common surfaces up front, cones and tori under Others.
// Each adds a bare surface; the Half-space button above the tree then makes
// half-spaces on the selected surface.
const AXES_XYZ = ["x", "y", "z"];
const surfaceItems = (family, noun) =>
  AXES_XYZ.map((a) => ({ label: `${a.toUpperCase()} ${noun}`, title: `${a}-${family}`, run: () => addSurface(`${a}-${family}`) }));
$("surfaces").append(
  flyoutButton({
    id: "surface-plane",
    iconName: "plane",
    label: "Plane",
    heading: "Plane",
    title: "Add a plane surface (x/y/z-plane or an arbitrary plane)",
    items: [...surfaceItems("plane", "plane"), { label: "Arbitrary plane", title: "plane: Ax + By + Cz = D", run: () => addSurface("plane") }],
  }),
  h("button", { class: "tb", id: "surface-sphere", title: "Add a sphere surface", onclick: () => run(addSurface, "sphere") }, icon("sphere"), h("span", { class: "label" }, "Sphere")),
  flyoutButton({
    id: "surface-cylinder",
    iconName: "infcylinder",
    label: "Cylinder",
    heading: "Infinite cylinder",
    title: "Add an infinite cylinder surface along X, Y or Z",
    items: surfaceItems("cylinder", "cylinder"),
  }),
  flyoutButton({
    id: "surface-others",
    iconName: "more",
    label: "Others",
    title: "Less common surfaces: infinite cones and tori along X, Y or Z",
    items: [{ heading: "Infinite cone" }, ...surfaceItems("cone", "cone"), { heading: "Torus" }, ...surfaceItems("torus", "torus")],
  }),
);

// ---- Shapes group: finite regions. Cube, sphere and cylinder up front; the
// cone and OpenMC's composite surfaces (openmc.model.*) under Others.
for (const kind of ["cube", "sphere", "cylinder"]) {
  const def = PRIMITIVES[kind];
  $("primitives").append(
    h(
      "button",
      { class: "tb", title: `Add a finite ${def.label.toLowerCase()} (inside the selected operation or cell, if any)`, onclick: () => run(addPrimitive, kind) },
      icon(kind),
      h("span", { class: "label" }, def.label),
    ),
  );
}
$("primitives").append(
  flyoutButton({
    id: "shape-others",
    iconName: "more",
    label: "Others",
    title: "More shapes: a finite cone and OpenMC's composite surfaces (cylinder sector, hexagonal prism, polygon, …)",
    items: [
      { label: "Cone", iconName: "cone", title: "Add a finite cone (inside the selected operation or cell, if any)", run: () => addPrimitive("cone") },
      { heading: "OpenMC composites" },
      ...Object.entries(COMPOSITE_TYPES).map(([type, def]) => ({ label: def.label, title: `${def.description} (openmc.model.${def.openmc})`, run: () => addComposite(type) })),
    ],
  }),
);

const OP_KEYS = { union: "U", subtract: "S", intersect: "N", complement: "C" };
for (const [kind, def] of Object.entries(OPERATIONS)) {
  $("operations").append(
    h(
      "button",
      {
        class: "tb",
        id: `op-${kind}`,
        title: `${def.label} the selected nodes (${OP_KEYS[kind]})${kind === "subtract" ? " — the first selected is the base" : ""}${kind === "complement" ? " — everything outside each node" : ""}`,
        onclick: () => run(combine, kind),
      },
      icon(kind),
      h("span", { class: "label" }, def.label),
    ),
  );
}
$("operations-more").append(
  h("button", { class: "tb", id: "ungroup", title: "Replace the selected operation by its children", onclick: () => run(ungroup) }, icon("ungroup"), h("span", { class: "label" }, "Ungroup")),
  h("button", { class: "tb", id: "duplicate", title: "Duplicate the selection (Ctrl+D)", onclick: () => run(duplicateSelection) }, icon("duplicate"), h("span", { class: "label" }, "Duplicate")),
  h("button", { class: "tb", id: "reference", title: "Reuse the selected regions elsewhere: adds live references (R)", onclick: () => run(addReferences) }, icon("ref"), h("span", { class: "label" }, "Reference")),
);



$("tree-actions").append(
  h("button", { class: "tb", id: "make-cell", title: "Wrap the selected shapes into OpenMC cells", onclick: () => run(makeCells) }, icon("cell"), "Cell"),
  h("button", { class: "tb", title: "Add a universe that cells can be filled with", onclick: () => run(addUniverse) }, icon("universe"), "Universe"),
  h(
    "button",
    { class: "tb", id: "make-halfspace", title: "Add a half-space on the selected surface (its negative side; flip it in the properties)", onclick: () => run(addHalfspaceOnSurface) },
    icon("halfspace"),
    "Half-space",
  ),
);

// View group: big Cutaway and Fit buttons around the stacked toggles.
$("cutaway-toggle").append(icon("cutaway"), h("span", { class: "label" }, "Cutaway"));
$("fit").append(icon("fit"), h("span", { class: "label" }, "Fit"));
for (const [id, name] of [["color-material", "palette"], ["void", "void"], ["world-box", "worldbox"], ["isolate", "isolate"], ["xray", "xray"], ["grid-toggle", "grid"], ["axes-toggle", "axes"]]) $(id).prepend(icon(name));

// Grid plane toggle (the axis lines always show); remembered per browser.
const GRID_KEY = "critica.builder.grid";
let showGrid = true;
try {
  showGrid = localStorage.getItem(GRID_KEY) !== "off";
} catch {
  // Storage unavailable: shown.
}
function setShowGrid(on) {
  showGrid = on;
  viewer.setGrid(on);
  $("grid-toggle").classList.toggle("on", on);
  try {
    localStorage.setItem(GRID_KEY, on ? "on" : "off");
  } catch {
    // Storage unavailable: the choice lasts for this session.
  }
}
setShowGrid(showGrid);
$("grid-toggle").onclick = () => setShowGrid(!showGrid);

// Draw the external sources in the Geometry workspace too; remembered per browser.
const SOURCES_KEY = "critica.builder.sources";
let showSources = true;
try {
  showSources = localStorage.getItem(SOURCES_KEY) !== "off";
} catch {
  // Storage unavailable: shown.
}
$("sources-toggle").prepend(icon("sources"));
$("sources-toggle").classList.toggle("on", showSources);
$("sources-toggle").onclick = () => {
  showSources = !showSources;
  $("sources-toggle").classList.toggle("on", showSources);
  try {
    localStorage.setItem(SOURCES_KEY, showSources ? "on" : "off");
  } catch {
    // Storage unavailable: the choice lasts for this session.
  }
  renderViewport();
};

// Axis lines toggle; remembered per browser.
const AXES_KEY = "critica.builder.axes";
let showAxes = true;
try {
  showAxes = localStorage.getItem(AXES_KEY) !== "off";
} catch {
  // Storage unavailable: shown.
}
function setShowAxes(on) {
  showAxes = on;
  viewer.setAxes(on);
  $("axes-toggle").classList.toggle("on", on);
  try {
    localStorage.setItem(AXES_KEY, on ? "on" : "off");
  } catch {
    // Storage unavailable: the choice lasts for this session.
  }
}
setShowAxes(showAxes);
$("axes-toggle").onclick = () => setShowAxes(!showAxes);

// Materials ribbon: the library actions of the workspace's list panel.
$("ribbon-mat-library").append(
  h("button", { class: "tb", title: "New empty material", onclick: () => materialsUI.newMaterial() }, icon("add"), h("span", { class: "label" }, "New")),
  h("button", { class: "tb", title: "Add a reference material from the PNNL compendium bundled with OpenMC", onclick: () => materialsUI.openLibrary() }, icon("library"), h("span", { class: "label" }, "From library")),
);
$("ribbon-mat-edit").append(
  h("button", { class: "tb", title: "Duplicate the selected material", onclick: () => materialsUI.duplicateMaterial() }, icon("duplicate"), h("span", { class: "label" }, "Duplicate")),
  h("button", { class: "tb", title: "Delete the selected material", onclick: () => materialsUI.deleteMaterial() }, icon("trash"), h("span", { class: "label" }, "Delete")),
);

// Source ribbon: add, duplicate and delete sources, preview the settings.
const sourceButton = (label, iconName, title, onclick) => h("button", { class: "tb", title, onclick }, icon(iconName), h("span", { class: "label" }, label));
$("ribbon-src-add").append(
  sourceButton("Point", "srcpoint", "Add an isotropic point source at the middle of the world box", () => run(() => sourcesUI.addSource("point"))),
  sourceButton("Box", "cube", "Add a source sampled uniformly in a box", () => run(() => sourcesUI.addSource("box"))),
  sourceButton("Sphere", "sphere", "Add a source sampled uniformly in a sphere", () => run(() => sourcesUI.addSource("spherical"))),
  sourceButton("Cylinder", "cylinder", "Add a source sampled uniformly in a cylinder along z", () => run(() => sourcesUI.addSource("cylindrical"))),
  flyoutButton({
    id: "source-others",
    iconName: "more",
    label: "Others",
    title: "Other spatial distributions",
    items: [{ label: "Cartesian (x, y, z)", title: "Independent distributions of x, y and z", run: () => sourcesUI.addSource("cartesian") }],
  }),
);
$("ribbon-src-edit").append(
  sourceButton("Duplicate", "duplicate", "Duplicate the selected source", () => run(() => sourcesUI.duplicateSource())),
  sourceButton("Delete", "trash", "Delete the selected source", () => run(() => sourcesUI.deleteSource())),
);
$("ribbon-src-openmc").append(
  sourceButton("Preview XML", "xml", "Show the settings.xml that File → Export as would write", () => {
    previewKind = "settings";
    openDialog("xml-preview");
  }),
);

// Settings ribbon: run mode, reset, preview.
const modeButton = (label, iconName, mode, title) => {
  const b = sourceButton(label, iconName, title, () => run(() => settingsUI.setRunMode(mode)));
  b.dataset.runMode = mode;
  return b;
};
$("ribbon-set-mode").append(
  modeButton("Eigenvalue", "keff", "eigenvalue", "Criticality (k-eff) calculation"),
  modeButton("Fixed source", "srcpoint", "fixed source", "Fixed source calculation from the sources of the Source tab"),
  flyoutButton({
    id: "run-mode-others",
    iconName: "more",
    label: "Others",
    title: "Other run modes",
    items: [
      { label: "Volume", title: "Stochastic volume calculation (needs <volume_calc>)", run: () => settingsUI.setRunMode("volume") },
      { label: "Plot", title: "Geometry plots (needs plots.xml)", run: () => settingsUI.setRunMode("plot") },
      { label: "Particle restart", title: "Replay a lost particle", run: () => settingsUI.setRunMode("particle restart") },
    ],
  }),
);
$("ribbon-set-edit").append(
  sourceButton("Reset", "reset", "Back to the settings of a new scene: eigenvalue, 1000 particles, 100 batches, 10 inactive", () => run(() => settingsUI.resetDefaults(defaultSettings().values))),
);
$("ribbon-set-openmc").append(
  sourceButton("Preview XML", "xml", "Show the settings.xml that File → Export as would write", () => {
    previewKind = "settings";
    openDialog("xml-preview");
  }),
);

// The ribbon can be collapsed to give the canvas more room; remembered.
const RIBBON_KEY = "critica.builder.ribbon";
function setRibbon(open) {
  $("ribbon").classList.toggle("collapsed", !open);
  $("ribbon-toggle").textContent = open ? "▴" : "▾";
  $("ribbon-toggle").title = open ? "Collapse the ribbon" : "Expand the ribbon";
  $("ribbon-toggle").setAttribute("aria-expanded", String(open));
  viewer.redraw();
  try {
    localStorage.setItem(RIBBON_KEY, open ? "open" : "closed");
  } catch {
    // Storage unavailable: the ribbon simply resets next time.
  }
}
let ribbonOpen = true;
try {
  ribbonOpen = localStorage.getItem(RIBBON_KEY) !== "closed";
} catch {
  // Storage unavailable: default to open.
}
setRibbon(ribbonOpen);
$("ribbon-toggle").onclick = () => setRibbon($("ribbon").classList.contains("collapsed"));
// Double-clicking the active tab also collapses or expands it, as in office suites.
for (const t of ["geometry", "materials", "sources", "settings"]) $(`tab-${t}`).addEventListener("dblclick", () => setRibbon($("ribbon").classList.contains("collapsed")));

// ---- Menus (File, Help) ----
// Desktop-style dropdowns: click to open, hover entries with ▸ to open their
// submenu, arrows/Esc to navigate, clicking an action or outside closes.
const menus = [];

function setMenu(menu, open) {
  menu.list.hidden = !open;
  menu.button.setAttribute("aria-expanded", String(open));
}

function closeMenus() {
  for (const m of menus) setMenu(m, false);
}

const anyMenuOpen = () => menus.some((m) => !m.list.hidden);

function setupMenu(buttonId, listId) {
  const menu = { button: $(buttonId), list: $(listId), submenus: [] };
  menus.push(menu);
  for (const sub of menu.list.querySelectorAll(".submenu")) {
    const s = { button: sub.querySelector(":scope > .menu-item"), list: sub.querySelector(":scope > .menu-list") };
    menu.submenus.push(s);
    menus.push(s);
    s.button.addEventListener("mouseenter", () => setMenu(s, true));
    s.button.onclick = (e) => {
      e.stopPropagation();
      setMenu(s, s.list.hidden);
      if (!s.list.hidden) s.list.querySelector(".menu-item")?.focus();
    };
  }
  const isSubButton = (item) => menu.submenus.some((s) => s.button === item);
  for (const item of menu.list.querySelectorAll(".menu-item")) {
    if (isSubButton(item)) continue;
    item.addEventListener("mouseenter", () => {
      for (const s of menu.submenus) if (!s.list.contains(item)) setMenu(s, false);
    });
    // Choosing an action closes the menu (action handlers are set separately).
    item.addEventListener("click", closeMenus);
  }
  menu.button.onclick = (e) => {
    e.stopPropagation();
    const open = menu.list.hidden;
    closeMenus();
    setMenu(menu, open);
    if (open) menu.list.querySelector(".menu-item")?.focus();
  };
  // Moving the pointer to another top-level menu while one is open switches to it.
  menu.button.addEventListener("mouseenter", () => {
    if (anyMenuOpen() && menu.list.hidden) menu.button.click();
  });
  menu.list.addEventListener("keydown", (e) => {
    const items = [...menu.list.querySelectorAll(".menu-item")].filter((el) => el.offsetParent);
    const i = items.indexOf(document.activeElement);
    const openSub = menu.submenus.find((s) => !s.list.hidden && s.list.contains(document.activeElement));
    if (e.key === "Escape") {
      if (openSub) {
        setMenu(openSub, false);
        openSub.button.focus();
      } else {
        closeMenus();
        menu.button.focus();
      }
    } else if (e.key === "ArrowDown") items[(i + 1) % items.length]?.focus();
    else if (e.key === "ArrowUp") items[(i - 1 + items.length) % items.length]?.focus();
    else if (e.key === "ArrowRight" && isSubButton(document.activeElement)) document.activeElement.click();
    else if (e.key === "ArrowLeft" && openSub) {
      setMenu(openSub, false);
      openSub.button.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
  return menu;
}

setupMenu("file-menu-button", "file-menu");
setupMenu("help-menu-button", "help-menu");
document.addEventListener("click", (e) => {
  if (anyMenuOpen() && !e.target.closest(".menu-list")) closeMenus();
});
$("tutorial-open").onclick = () => openDialog("tutorial");
$("shortcuts-open").onclick = () => openDialog("shortcuts");

$("new").onclick = () => replaceScene(new Scene());
$("save").onclick = () => download("scene.critica.json", JSON.stringify(scene, null, 2), "application/json");
$("export-model").onclick = () => run(exportXML, "model");
$("export-geometry").onclick = () => run(exportXML, "geometry");
$("export-materials").onclick = () => run(exportXML, "materials");
$("export-settings").onclick = () => run(exportXML, "settings");

// ---- workspaces ----
const TAB_KEY = "critica.builder.tab";
let activeTab = "geometry";
const materialsUI = createMaterialsWorkspace({
  scene: () => scene,
  commit,
  changed: () => schedule(),
  colorOf: (id) => materialColor(String(id)),
  selectCell: (id) => {
    setTab("geometry");
    select([id]);
  },
  setMessage,
});

const sourcesUI = createSourcesWorkspace({
  scene: () => scene,
  commit,
  changed: () => schedule(),
  icon,
  setMessage,
  // New sources go at the middle of the world box, a quarter of its size.
  frame: () => {
    const w = results.world;
    if (!w) return { center: [0, 0, 0], half: 1 };
    const center = w.min.map((v, i) => (v + w.max[i]) / 2);
    const half = Math.max(1e-3, 0.25 * Math.max(...w.max.map((v, i) => v - w.min[i])));
    return { center, half: Number(half.toPrecision(2)) };
  },
});

const settingsUI = createSettingsWorkspace({
  scene: () => scene,
  commit,
  changed: () => schedule(),
  settingsXML: () => exportSettingsXML(scene),
  setMessage,
});

function setTab(tab) {
  activeTab = tab;
  // The Source workspace shows the geometry viewport too: move it there and back.
  if (tab === "sources") $("src-view-slot").append($("view"));
  else if (tab === "geometry") $("ws-geometry").insertBefore($("view"), $("props"));
  for (const t of ["geometry", "materials", "sources", "settings"]) {
    $(`ws-${t}`).hidden = t !== tab;
    $(`ribbon-${t}`).hidden = t !== tab;
    $(`tab-${t}`).classList.toggle("on", t === tab);
    $(`tab-${t}`).setAttribute("aria-selected", String(t === tab));
  }
  if (tab === "materials") materialsUI.render();
  else if (tab === "settings") settingsUI.render();
  else {
    if (tab === "sources") sourcesUI.render();
    renderViewport(); // sources are always drawn in the Source workspace
    viewer.redraw();
  }
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    // Storage unavailable: the tab resets next time.
  }
}
$("tab-geometry").onclick = () => setTab("geometry");
$("tab-materials").onclick = () => setTab("materials");
$("tab-sources").onclick = () => setTab("sources");
$("tab-settings").onclick = () => setTab("settings");
$("open").onclick = () => $("file").click();
$("file").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    await openFile(file);
  } catch (err) {
    setMessage(`Could not open ${file.name}: ${err.message}`, true);
  }
};
$("fit").onclick = () => refresh({ props: false, fit: true });
$("isolate").onclick = () => {
  isolate = !isolate;
  refresh({ props: false });
};
$("xray").onclick = () => {
  xray = !xray;
  refresh({ props: false });
};
// ---- cutaway ----
const AXIS_NAMES = ["x", "y", "z"];

function cutawayRange(k) {
  const b = sceneBounds ?? { min: [-1, -1, -1], max: [1, 1, 1] };
  const pad = 0.02 * Math.max(1e-9, b.max[k] - b.min[k]);
  return [b.min[k] - pad, b.max[k] + pad];
}

function centerCutaway() {
  const b = sceneBounds ?? { min: [-1, -1, -1], max: [1, 1, 1] };
  cutaway.pos = b.min.map((v, i) => (v + b.max[i]) / 2);
}

/** Removes the side (or quadrant) facing the camera, so the cut reveals the inside. */
function faceCamera() {
  if (!cutaway.pos) centerCutaway();
  const eye = viewer.eye();
  cutaway.signs = eye.map((v, i) => (v >= cutaway.pos[i] ? 1 : -1));
  cutaway.flip = false;
}

/** Planes for the current cutaway: the hidden region is where all hold n·p > d. */
function cutawayPlanes() {
  if (cutaway.mode === "off") return [];
  if (!cutaway.pos) centerCutaway();
  const k = AXIS_NAMES.indexOf(cutaway.axis);
  const plane = (axis) => {
    const s = cutaway.signs[axis] * (cutaway.flip ? -1 : 1);
    const n = [0, 0, 0];
    n[axis] = s;
    return { n, d: s * cutaway.pos[axis] };
  };
  if (cutaway.mode === "section") return [plane(k)];
  // Eighth: remove one octant (all three axes).
  if (cutaway.mode === "eighth") return [0, 1, 2].map(plane);
  // Quarter: remove one quadrant around the chosen axis.
  return [0, 1, 2].filter((i) => i !== k).map(plane);
}

function applyCutaway() {
  viewer.setClip(cutawayPlanes());
  $("cutaway-toggle").classList.toggle("on", cutaway.mode !== "off");
}

function setCutawayMode(mode) {
  if (mode !== "off") cutaway.lastMode = mode;
  if (mode !== "off" && !cutaway.pos) centerCutaway();
  if (mode !== "off" && cutaway.mode === "off") faceCamera();
  cutaway.mode = mode;
  applyCutaway();
  renderCutawayPanel();
}

function renderCutawayPanel() {
  const panel = $("cutaway-panel");
  if (panel.hidden) return;
  const k = AXIS_NAMES.indexOf(cutaway.axis);
  const sliderAxes =
    cutaway.mode === "section" ? [k] : cutaway.mode === "quarter" ? [0, 1, 2].filter((i) => i !== k) : cutaway.mode === "eighth" ? [0, 1, 2] : [];
  if (!cutaway.pos) centerCutaway();
  const modeButton = (mode, label, title) =>
    h("button", { class: `tb seg${cutaway.mode === mode ? " on" : ""}`, title, onclick: () => setCutawayMode(mode) }, label);
  const slider = (axis) => {
    const [lo, hi] = cutawayRange(axis);
    const step = (hi - lo) / 400 || 0.01;
    // Flush float noise (e.g. 1e-16) to 0 in the readout.
    const show = (v) => fmt(Math.abs(v) < 1e-9 * (hi - lo) ? 0 : v);
    const readout = h("span", { class: "cut-value" }, show(cutaway.pos[axis]));
    return h(
      "div",
      { class: "cut-row" },
      h("label", {}, AXIS_NAMES[axis].toUpperCase()),
      h("input", {
        type: "range",
        min: String(lo),
        max: String(hi),
        step: String(step),
        value: String(cutaway.pos[axis]),
        oninput: (e) => {
          cutaway.pos[axis] = Number(e.target.value);
          readout.textContent = show(cutaway.pos[axis]);
          applyCutaway();
        },
      }),
      readout,
    );
  };
  const rows = [
    h("div", { class: "cut-title" }, "Cutaway"),
    h(
      "div",
      { class: "segmented" },
      modeButton("off", "Off", "Show everything"),
      modeButton("section", "Section", "Cut with one plane"),
      modeButton("quarter", "Quarter", "Remove one quadrant around an axis"),
      modeButton("eighth", "Eighth", "Remove one octant (cut along X, Y and Z)"),
    ),
    (cutaway.mode === "section" || cutaway.mode === "quarter") &&
      h(
        "div",
        { class: "cut-row" },
        h("label", {}, cutaway.mode === "section" ? "Normal" : "Around"),
        h(
          "div",
          { class: "segmented" },
          AXIS_NAMES.map((a) =>
            h(
              "button",
              {
                class: `tb seg${cutaway.axis === a ? " on" : ""}`,
                onclick: () => {
                  cutaway.axis = a;
                  faceCamera();
                  applyCutaway();
                  renderCutawayPanel();
                },
              },
              a.toUpperCase(),
            ),
          ),
        ),
      ),
    ...sliderAxes.map(slider),
    cutaway.mode !== "off" &&
      h(
        "div",
        { class: "cut-row cut-actions" },
        h(
          "label",
          { class: "check" },
          h("input", {
            type: "checkbox",
            checked: cutaway.flip,
            onchange: (e) => {
              cutaway.flip = e.target.checked;
              applyCutaway();
            },
          }),
          " Flip side",
        ),
        h(
          "button",
          {
            class: "tb",
            title: "Center the cut and turn it toward the camera",
            onclick: () => {
              centerCutaway();
              faceCamera();
              applyCutaway();
              renderCutawayPanel();
            },
          },
          "Reset",
        ),
      ),
  ];
  panel.replaceChildren(...rows.filter(Boolean));
}

$("cutaway-toggle").onclick = (e) => {
  e.stopPropagation();
  const panel = $("cutaway-panel");
  panel.hidden = !panel.hidden;
  // Opening the panel turns the cutaway on if it was off.
  if (!panel.hidden && cutaway.mode === "off") setCutawayMode(cutaway.lastMode);
  else renderCutawayPanel();
};
// Clicks inside the panel stay there: its controls re-render it, which would
// otherwise look like an outside click by the time the document sees it.
$("cutaway-panel").addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", (e) => {
  const panel = $("cutaway-panel");
  if (!panel.hidden && e.target !== $("cutaway-toggle")) panel.hidden = true;
});

$("color-material").onclick = () => {
  colorBy = colorBy === "material" ? "cell" : "material";
  refresh({ props: false });
};
$("void").onclick = () => {
  showVoid = !showVoid;
  refresh({ props: false });
};
$("world-box").onclick = () => {
  showWorldBox = !showWorldBox;
  try {
    localStorage.setItem(WORLD_BOX_KEY, showWorldBox ? "on" : "off");
  } catch {
    // Storage unavailable: the toggle just resets next time.
  }
  refresh({ props: false });
};

// Drop a file anywhere to open it.
document.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
document.addEventListener("drop", async (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  e.preventDefault();
  try {
    await openFile(file);
  } catch (err) {
    setMessage(`Could not open ${file.name}: ${err.message}`, true);
  }
});

function updateToolbar() {
  const node = primary();
  for (const kind of Object.keys(OPERATIONS)) $(`op-${kind}`).disabled = selection.length === 0 || selection.some((id) => !isRegionNode(nodeById.get(id) ?? scene.find(id)?.node ?? {}));
  $("ungroup").disabled = !(node && isOperation(node));
  $("duplicate").disabled = selection.length === 0;
  $("make-halfspace").disabled = !surfaceSel;
  $("reference").disabled = selection.length === 0 || selection.some((id) => !isRegionNode(nodeById.get(id) ?? scene.find(id)?.node ?? {}));
  $("isolate").classList.toggle("on", isolate);
  $("xray").classList.toggle("on", xray);
  $("void").classList.toggle("on", showVoid);
  $("world-box").classList.toggle("on", showWorldBox);
  $("color-material").classList.toggle("on", colorBy === "material");
}

// One table drives both the key handling and the Keyboard shortcuts dialog.
// `keys` are normalized combos: "ctrl+" for Ctrl/Cmd, "shift+" only with letters.
const SHORTCUTS = [
  { group: "File", keys: ["ctrl+o"], global: true, label: "Open a scene or OpenMC file", run: () => $("open").click() },
  { group: "File", keys: ["ctrl+s"], global: true, label: "Save the scene (JSON)", run: () => $("save").click() },
  { group: "Edit", keys: ["ctrl+z"], global: true, label: "Undo", run: () => restore(history.index - 1) },
  { group: "Edit", keys: ["ctrl+y", "ctrl+shift+z"], global: true, label: "Redo", run: () => restore(history.index + 1) },
  { group: "Edit", keys: ["delete", "backspace"], label: "Delete the selection", run: () => run(deleteSelection) },
  { group: "Edit", keys: ["ctrl+d"], label: "Duplicate the selection", run: () => run(duplicateSelection) },
  { group: "Edit", keys: ["f2"], label: "Rename the selected node or surface", run: renameSelection },
  { group: "Edit", keys: ["ctrl+a"], label: "Select all top-level items", run: () => select(scene.roots.map((n) => n.id)) },
  { group: "Edit", keys: ["escape"], label: "Clear the selection", run: () => select([]) },
  { group: "Combine selection", keys: ["u"], label: "Union", run: () => run(combine, "union") },
  { group: "Combine selection", keys: ["s"], label: "Subtract (first selected is the base)", run: () => run(combine, "subtract") },
  { group: "Combine selection", keys: ["n"], label: "Intersect", run: () => run(combine, "intersect") },
  { group: "Combine selection", keys: ["c"], label: "Complement", run: () => run(combine, "complement") },
  { group: "Combine selection", keys: ["r"], label: "Reference: reuse the selected regions elsewhere", run: () => run(addReferences) },
  { group: "View", keys: ["f"], label: "Fit the view to the geometry", run: () => $("fit").click() },
  { group: "View", keys: ["i"], label: "Isolate the selection", run: () => $("isolate").click() },
  { group: "View", keys: ["x"], label: "Toggle x-ray ghosts of hidden selections", run: () => $("xray").click() },
  { group: "View", keys: ["v"], label: "Show or hide void cells", run: () => $("void").click() },
  { group: "View", keys: ["w"], label: "Show or hide the world box wireframe", run: () => $("world-box").click() },
  { group: "View", keys: ["g"], label: "Show or hide the grid plane", run: () => $("grid-toggle").click() },
  { group: "View", keys: ["a"], label: "Show or hide the axis lines", run: () => $("axes-toggle").click() },
  { group: "View", keys: ["m"], label: "Color by material (with a legend) or by cell", run: () => $("color-material").click() },
  { group: "View", keys: ["k"], label: "Toggle the cutaway (section, quarter or eighth cut)", run: () => setCutawayMode(cutaway.mode === "off" ? cutaway.lastMode : "off") },
  { group: "Help", keys: ["?"], global: true, label: "Show this list", run: () => openDialog("shortcuts") },
];

const MOUSE_HELP = [
  ["Click", "Select (in the tree or on a face in the viewport)"],
  ["Ctrl + click", "Add to / remove from the selection (order matters for Subtract)"],
  ["Alt + click", "Select the top-level item under the cursor"],
  ["Drag", "Orbit the camera"],
  ["Right-drag or Shift + drag", "Pan the camera"],
  ["Wheel", "Zoom"],
  ["Drag a tree row", "Move it before, after or inside another node"],
  ["Drop a file", "Open it (scene JSON, geometry.xml or model.xml)"],
];

function comboOf(e) {
  const key = e.key.toLowerCase();
  const letter = key.length === 1 && key >= "a" && key <= "z";
  return `${e.ctrlKey || e.metaKey ? "ctrl+" : ""}${e.shiftKey && letter ? "shift+" : ""}${key}`;
}

const keyLabel = (combo) =>
  combo
    .split("+")
    .map((k) => ({ ctrl: "Ctrl", shift: "Shift", delete: "Del", backspace: "Backspace", escape: "Esc" })[k] ?? k.toUpperCase())
    .join("+");

document.addEventListener("keydown", (e) => {
  if (anyDialogOpen() || anyMenuOpen() || e.target.closest("input, select, textarea")) return;
  const combo = comboOf(e);
  const shortcut = SHORTCUTS.find((s) => s.keys.includes(combo));
  if (!shortcut) return;
  // Geometry shortcuts (selection, combine, view) do nothing on the Materials tab.
  // Geometry shortcuts work in Geometry; the Source tab (which shows the viewport) keeps the View ones.
  if (!shortcut.global && activeTab !== "geometry" && !(activeTab === "sources" && shortcut.group === "View")) return;
  e.preventDefault();
  shortcut.run();
});

function renderShortcuts() {
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
  $("shortcuts-body").replaceChildren(
    ...groups.flatMap((g) => [
      h("h3", {}, g),
      h(
        "table",
        { class: "shortcut-table" },
        h(
          "tbody",
          {},
          SHORTCUTS.filter((s) => s.group === g).map((s) =>
            h("tr", {}, h("td", {}, s.keys.map((k) => h("kbd", {}, keyLabel(k)))), h("td", {}, s.label)),
          ),
        ),
      ),
    ]),
    h("h3", {}, "Mouse"),
    h("table", { class: "shortcut-table" }, h("tbody", {}, MOUSE_HELP.map(([k, v]) => h("tr", {}, h("td", {}, k), h("td", {}, v))))),
  );
}

function renderTutorial() {
  const b = (t) => h("b", {}, t);
  const k = (t) => h("kbd", {}, t);
  $("tutorial-body").replaceChildren(
    h("p", {}, "Critica builds solids with constructive solid geometry (CSG) and reads and writes OpenMC geometry."),
    h("h3", {}, "1 · Add shapes"),
    h(
      "ul",
      {},
      h("li", {}, "Use the ", b("Geometry"), " ribbon at the top: ", b("Surfaces"), " add an OpenMC surface (planes, spheres, infinite cylinders; cones and tori under ", b("Others"), "), listed under ", b("Surfaces"), " in the scene tree; ", b("Shapes"), " are finite regions (cube, sphere, cylinder; a cone and OpenMC composites under ", b("Others"), ")."),
      h("li", {}, "A surface is not a region yet: select it, then press ", b("Half-space"), " (above the scene tree) to use one of its sides. Several half-spaces can share a surface."),
      h("li", {}, b("Shapes → Others"), " also has OpenMC composite surfaces: hexagonal prisms, cylinder sectors, polygons, vessels and more."),
      h("li", {}, "With one operation, cell or universe selected, new shapes go inside it."),
      h("li", {}, "Edit sizes, surface coefficients and position/rotation/scale in the ", b("Properties"), " panel on the right."),
    ),
    h("h3", {}, "2 · Combine them"),
    h(
      "ul",
      {},
      h("li", {}, "Select several nodes with ", k("Ctrl"), "-click, then press ", b("Union"), ", ", b("Subtract"), ", ", b("Intersect"), " or ", b("Complement"), "."),
      h("li", {}, "For Subtract, the ", b("first"), " node you select is the base; the numbers in the tree show the order."),
      h("li", {}, "Drag rows in the scene tree to reorganize. The ● toggle excludes a node without deleting it; references to it keep working, so a shape used only through references can be hidden this way."),
      h("li", {}, "A region can be used by several cells: combining a new shape with a region that belongs to a cell ", b("reuses it by reference"), " (↪) instead of moving it, e.g. water = box − fuel. ", b("Reference"), " (", k("R"), ") does it explicitly; edits to the source update every use."),
    ),
    h("h3", {}, "3 · Make OpenMC cells"),
    h(
      "ul",
      {},
      h("li", {}, b("Cell"), " (above the scene tree) wraps a shape into a cell; give it a material id, ", k("void"), ", or fill it with a universe."),
      h("li", {}, b("Universe"), " adds a universe that cells can be filled with; set the fill translation and rotation on the cell."),
      h("li", {}, "Void cells are hidden in the viewport; toggle ", b("Void"), " to show them. ", b("Materials"), " (", k("M"), ") colors cells by material and shows a legend."),
      h("li", {}, "The ", b("Settings"), " tab sets the run: eigenvalue or fixed source, particles, batches, triggers, physics, temperature and output files."),
      h("li", {}, "The ", b("Source"), " tab defines the external source: a point, box, sphere or cylinder with its particle, energy spectrum (eV), direction and constraints, drawn in the viewport. It is written into the settings of model.xml or settings.xml."),
    ),
    h("h3", {}, "4 · Look around"),
    h(
      "ul",
      {},
      h("li", {}, "Drag to orbit, right-drag to pan, scroll to zoom; ", b("Fit"), " frames everything."),
      h("li", {}, "Click a face to select its region (the top-level item or cell); click again to step down toward the shape that made the face, or ", k("Alt"), "-click to jump to it. Selected parts that are hidden (like a subtracted cutter) appear as an ", b("x-ray"), " ghost."),
      h("li", {}, b("Isolate"), " shows only the selection. ", b("Preferences"), " holds the world box, curve smoothness and up axis."),
      h("li", {}, b("Cutaway"), " (", k("K"), ") slices the view with a section plane or removes a quarter or an eighth, so you can see and click the cells inside."),
    ),
    h("h3", {}, "5 · Materials"),
    h(
      "ul",
      {},
      h("li", {}, "The ", b("Materials"), " tab holds the material library that cells refer to by id."),
      h("li", {}, b("New"), " starts a material; ", b("From library"), " adds one of 411 reference materials (PNNL compendium, bundled with OpenMC)."),
      h("li", {}, "Add nuclides (", k("U235"), ") or elements (", k("Fe"), "), or a whole formula like ", k("UO2"), ". Elements can be enriched (⇅) and are expanded into natural isotopes on export, as OpenMC's Python API does."),
      h("li", {}, "The summary shows the mass and atom densities, the nuclide breakdown, problems OpenMC would reject, which cells use the material, and the exact XML."),
    ),
    h("h3", {}, "6 · Files"),
    h(
      "ul",
      {},
      h("li", {}, b("File → Open…"), " reads a saved scene or an OpenMC ", k("geometry.xml"), " / ", k("model.xml"), "; you can also drop a file on the window."),
      h("li", {}, b("File → Export as"), " writes OpenMC ", k("model.xml"), ", ", k("geometry.xml"), " (exact analytic surfaces) or ", k("materials.xml"), ". Opening a ", k("materials.xml"), " adds its materials to the library."),
      h("li", {}, "Your work is saved in the browser automatically; ", k("Ctrl+Z"), " undoes any change."),
    ),
    h("p", {}, "See ", h("button", { class: "link-button", onclick: () => openDialog("shortcuts") }, "Keyboard shortcuts"), " for all keys."),
  );
}

commit();
// Show the interface first: building the CSG solids of a large scene takes a
// moment (about 1.5 s for a 22-cell benchmark), and the page used to stay
// blank until it was done.
scene.walk((n) => nodeById.set(n.id, n));
setMessage("Building geometry…");
renderTree();
renderProps();
updateToolbar();
try {
  const savedTab = localStorage.getItem(TAB_KEY) ?? localStorage.getItem("geomium.builder.tab");
  if (["materials", "sources", "settings"].includes(savedTab)) setTab(savedTab);
} catch {
  // Storage unavailable: start on Geometry.
}
// Two frames: the first paints the interface, the second builds the geometry.
requestAnimationFrame(() => requestAnimationFrame(() => refresh({ fit: true })));
