import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { init } from "../pkg/geomium.js";
import { Scene, Evaluator, isCell } from "../examples/scene.js";
import { demoScene } from "./fixtures.mjs";
import { importOpenMC } from "../examples/openmc/import.js";
import { exportOpenMC } from "../examples/openmc/export.js";
import { locate } from "../examples/openmc/locate.js";

const geo = await init();
const CORPUS = new URL("../knowledge/openmc/tests/", import.meta.url);

function rng(seed = 1) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

/** Mesh volume per leaf (cell id via tag, or root item id). */
function meshVolumes(scene, out) {
  const vols = new Map();
  for (const [id, parts] of out.parts) {
    if (!scene.roots.some((n) => n.id === id)) continue;
    for (const p of parts) {
      const key = p.tag ?? id;
      vols.set(key, (vols.get(key) ?? 0) + p.solid.volume);
    }
  }
  return vols;
}

/** Monte Carlo volume per located leaf inside the world box. */
function sampledVolumes(scene, world, n, seed = 7) {
  const rand = rng(seed);
  const size = world.max.map((v, i) => v - world.min[i]);
  const vol = size[0] * size[1] * size[2];
  const counts = new Map();
  let overlaps = 0;
  for (let i = 0; i < n; i++) {
    const p = world.min.map((v, k) => v + rand() * size[k]);
    const hit = locate(scene, p);
    if (hit) counts.set(hit.node.id, (counts.get(hit.node.id) ?? 0) + 1);
    const containing = scene.roots.filter((item) => item.enabled && locate(scene, p, [item]));
    if (containing.length > 1) overlaps++;
  }
  return { vols: new Map([...counts].map(([k, c]) => [k, (c / n) * vol])), total: vol, n, overlaps };
}

/** Compares mesh and sampled volumes; returns false (without asserting) for models with overlapping cells. */
function compareVolumes(scene, out, n = 20000, relTess = 0.02) {
  const mesh = meshVolumes(scene, out);
  const mc = sampledVolumes(scene, out.world, n);
  if (mc.overlaps) return false;
  const keys = new Set([...mesh.keys(), ...mc.vols.keys()]);
  for (const k of keys) {
    const m = mesh.get(k) ?? 0;
    const s = mc.vols.get(k) ?? 0;
    const p = s / mc.total;
    const sigma = Math.sqrt(Math.max(p * (1 - p), 1 / mc.n) / mc.n) * mc.total;
    const name = scene.find(k)?.node.name ?? k;
    assert.ok(Math.abs(m - s) <= 4 * sigma + relTess * m, `${name}: mesh ${m.toFixed(3)} vs sampled ${s.toFixed(3)} (σ ${sigma.toFixed(3)})`);
  }
  return true;
}

const COMPLEX_CELL = `<?xml version="1.0"?>
<geometry>
  <surface id="1" type="x-plane" coeffs="-10" boundary="vacuum" />
  <surface id="2" type="x-plane" coeffs="-7" />
  <surface id="3" type="x-plane" coeffs="-4" />
  <surface id="4" type="x-plane" coeffs="4" />
  <surface id="5" type="x-plane" coeffs="7" />
  <surface id="6" type="x-plane" coeffs="10" boundary="vacuum" />
  <surface id="7" type="x-plane" coeffs="0" />
  <surface id="11" type="y-plane" coeffs="-10" boundary="vacuum" />
  <surface id="12" type="y-plane" coeffs="-7" />
  <surface id="13" type="y-plane" coeffs="-4" />
  <surface id="14" type="y-plane" coeffs="4" />
  <surface id="15" type="y-plane" coeffs="7" />
  <surface id="16" type="y-plane" coeffs="10" boundary="vacuum" />
  <surface id="17" type="y-plane" coeffs="0" />
  <cell id="1" material="1" region="3 -4 13 -14" />
  <cell id="2" material="2" region="2 -5 12 -15 ~(3 -4 13 -14)" />
  <cell id="3" material="3" region="(1 -7 17 -16 | 7 -6 11 -17) (-2 | 5 | -12 | 15)" />
  <cell id="4" material="4" region="((1 -7 11 -17) | (7 -6 17 -16)) ~(2 -5 12 -15)" />
</geometry>`;

test("import: complex_cell volumes are exact", () => {
  const { scene, warnings } = importOpenMC(COMPLEX_CELL);
  assert.deepEqual(warnings, []);
  assert.equal(scene.roots.length, 4);
  assert.equal(scene.surfaces.size, 14);
  assert.equal(scene.world.up, "z");
  const ev = new Evaluator(geo);
  const out = ev.run(scene);
  assert.equal(out.errors.size, 0);
  // z is unbounded: the world takes the x/y span.
  assert.deepEqual(out.world, { min: [-10, -10, -10], max: [10, 10, 10] });
  const vol = (i) => out.parts.get(scene.roots[i].id).reduce((s, p) => s + p.solid.volume, 0);
  const expected = [1280, 2640, 2040, 2040];
  expected.forEach((v, i) => assert.ok(Math.abs(vol(i) - v) < 1e-6, `cell ${i + 1}: ${vol(i)} vs ${v}`));
  compareVolumes(scene, out, 4000, 0);
  ev.dispose();
});

const PINCELL = `<?xml version='1.0' encoding='utf-8'?>
<model>
  <materials>
    <material id="1" name="fuel">
      <density value="10.4" units="g/cm3"/>
      <nuclide name="U235" wo="0.04"/><nuclide name="U238" wo="0.84"/><nuclide name="O16" wo="0.12"/>
    </material>
    <material id="2" name="water">
      <density value="1.0" units="g/cc"/>
      <nuclide name="H1" ao="2.0"/><nuclide name="O16" ao="1.0"/>
      <sab name="c_H_in_H2O"/>
    </material>
  </materials>
  <geometry>
    <surface id="1" type="z-cylinder" coeffs="0 0 0.4"/>
    <surface id="2" type="sphere" coeffs="0 0 0.9 0.3"/>
    <surface id="3" type="z-torus" coeffs="0 0 -0.5 0.6 0.1 0.15"/>
    <surface id="10" type="x-plane" coeffs="-1" boundary="reflective"/>
    <surface id="11" type="x-plane" coeffs="1" boundary="reflective"/>
    <surface id="12" type="y-plane" coeffs="-1" boundary="reflective"/>
    <surface id="13" type="y-plane" coeffs="1" boundary="reflective"/>
    <surface id="14" type="z-plane" coeffs="-1.5" boundary="vacuum"/>
    <surface id="15" type="z-plane" coeffs="1.5" boundary="vacuum"/>
    <cell id="1" universe="5" material="1" region="-1 | -2"/>
    <cell id="2" universe="5" material="void" region="-3"/>
    <cell id="3" universe="5" material="2" region="1 2 3"/>
    <cell id="10" fill="5" region="10 -11 12 -13 14 -15" rotation="70 0 30" translation="0.2 -0.1 0"/>
  </geometry>
  <settings><particles>100</particles></settings>
</model>`;

test("import: universe fill with rotation matches OpenMC point location", () => {
  const { scene } = importOpenMC(PINCELL);
  assert.equal(scene.universes.length, 1);
  assert.equal(scene.roots.length, 1);
  const fillCell = scene.roots[0];
  assert.equal(fillCell.fill.type, "universe");
  assert.deepEqual(fillCell.transform.rotation, [70, 0, 30]);
  assert.equal(scene.materials["1"].name, "fuel");
  const ev = new Evaluator(geo);
  const out = ev.run(scene);
  assert.equal(out.errors.size, 0, [...out.errors.values()].join("; "));
  assert.deepEqual(out.world, { min: [-1, -1, -1.5], max: [1, 1, 1.5] });
  const tags = new Set(out.parts.get(fillCell.id).map((p) => p.tag));
  assert.equal(tags.size, 3, "fuel, void and water parts");
  compareVolumes(scene, out, 30000, 0.03);
  ev.dispose();
});

test("export: model.xml round trip keeps other sections and semantics", () => {
  const { scene } = importOpenMC(PINCELL);
  const { geometry, model, warnings } = exportOpenMC(scene);
  assert.deepEqual(warnings, []);
  assert.match(model, /<settings>/);
  // Materials are regenerated from the library (same content, canonical units).
  assert.match(model, /<material id="1" name="fuel">\s*<density value="10.4" units="g\/cm3"\/>/);
  assert.match(model, /<nuclide name="U235" wo="0.04"\/>/);
  assert.match(model, /<sab name="c_H_in_H2O"\/>/);
  assert.match(geometry, /<cell id="10" name="Cell 10" fill="5" region="10 -11 12 -13 14 -15" translation="0.2 -0.1 0" rotation="70 0 30"\/>/);
  // No world boundary added: the file already has boundary conditions.
  assert.doesNotMatch(geometry, /outside/);
  const again = importOpenMC(model).scene;
  assertSameSemantics(scene, again, 5000);
});

/** Same leaf (by OpenMC cell id, or by name for auto cells) at random points. */
function assertSameSemantics(a, b, n, { byName = false, box = a.resolveWorld() } = {}) {
  const rand = rng(99);
  const size = box.max.map((v, i) => v - box.min[i]);
  // The exporter's filler cell around builder shapes counts as empty space.
  const label = (hit) =>
    !hit || hit.node.name === "outside"
      ? "nothing"
      : !byName && isCell(hit.node) && hit.node.openmc?.id != null
        ? `cell ${hit.node.openmc.id}`
        : hit.node.name;
  let mismatches = 0;
  let first = "";
  for (let i = 0; i < n; i++) {
    const p = box.min.map((v, k) => v + (rand() * 1.1 - 0.05) * size[k]);
    const la = label(locate(a, p));
    const lb = label(locate(b, p));
    if (la !== lb) {
      mismatches++;
      first ||= `${p.map((v) => v.toFixed(4))}: ${la} vs ${lb}`;
    }
  }
  assert.equal(mismatches, 0, first);
}

test("export: builder shapes become exact OpenMC surfaces", () => {
  const scene = new Scene();
  scene.add("cube", { name: "tilted box", transform: { rotation: [0, 30, 15], position: [3, 0, 0] } });
  scene.add("sphere", { name: "ellipsoid", transform: { scale: [1, 2, 0.5], position: [-3, 0, 0] } });
  scene.add("torus", { name: "ring", params: { major: 1.5, minor: 0.3 }, transform: { rotation: [90, 0, 0], scale: [1, 2, 1] } });
  scene.add("cone", { name: "spike", params: { radius: 0.5, height: 2 }, transform: { position: [0, 3, 0] } });
  const holed = scene.add("subtract", { name: "holed" });
  scene.add("cube", { params: { size: [1, 1, 1] } }, holed.id);
  scene.add("cylinder", { params: { radius: 0.3, height: 2, axis: "y" } }, holed.id);
  holed.transform.position = [0, -3, 0];
  // Overlapping shape: earlier items win.
  scene.add("cube", { name: "overlap", params: { size: [1, 1, 1] }, transform: { position: [3.5, 0, 0] } });

  const { geometry, warnings } = exportOpenMC(scene);
  assert.deepEqual(warnings, []);
  assert.match(geometry, /type="quadric"/, "scaled sphere → quadric");
  assert.match(geometry, /type="z-torus" coeffs="0 0 0 1.5 0.6 0.3"/, "rotated, axially scaled torus");
  assert.match(geometry, /type="y-cone" coeffs="0 4 0 0.0625"/);
  assert.match(geometry, /type="plane"/, "tilted cube faces");
  assert.match(geometry, /boundary="vacuum"/, "world boundary added");
  assert.match(geometry, /name="outside"/);

  const back = importOpenMC(geometry).scene;
  assertSameSemantics(scene, back, 20000, { byName: true });
});

test("export: demo scene volume survives the round trip", () => {
  const scene = demoScene();
  const back = importOpenMC(exportOpenMC(scene).geometry).scene;
  const ev = new Evaluator(geo);
  const a = ev.run(scene);
  const original = a.solids.get(scene.roots[0].id).volume;
  const ev2 = new Evaluator(geo);
  const b = ev2.run(back);
  const part = back.roots.find((n) => n.name === "Part");
  const exported = b.parts.get(part.id).reduce((s, p) => s + p.solid.volume, 0);
  // Exact surfaces vs facets: tessellation differs slightly.
  assert.ok(Math.abs(exported - original) / original < 0.02, `${exported} vs ${original}`);
  ev.dispose();
  ev2.dispose();
});

test("export: unsupported transforms are reported", () => {
  const scene = new Scene();
  scene.add("torus", { name: "tilted ring", transform: { rotation: [30, 0, 0] } });
  assert.throws(() => exportOpenMC(scene), /tilted ring.*aligned/);
});

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}

async function corpusFiles() {
  try {
    await stat(CORPUS);
  } catch {
    return null;
  }
  const files = [];
  for await (const path of walk(CORPUS.pathname)) {
    if (!/(geometry\.xml|model\.xml|inputs_true.*\.dat)$/.test(path)) continue;
    const text = await readFile(path, "utf8");
    if (text.includes("<geometry")) files.push({ path, text });
  }
  return files;
}

test("corpus: import → export → import preserves cell membership", async (t) => {
  const files = await corpusFiles();
  if (!files) return t.skip("knowledge/openmc not present");
  let checked = 0;
  for (const { path, text } of files) {
    const { scene } = importOpenMC(text);
    const xml = exportOpenMC(scene);
    const again = importOpenMC(xml.model ?? xml.geometry).scene;
    try {
      assertSameSemantics(scene, again, 300);
    } catch (e) {
      e.message = `${path}: ${e.message}`;
      throw e;
    }
    checked++;
  }
  t.diagnostic(`${checked} files round-tripped`);
});

test("corpus: mesh volumes agree with point sampling", async (t) => {
  const files = await corpusFiles();
  if (!files) return t.skip("knowledge/openmc not present");
  let checked = 0;
  const skipped = [];
  for (const { path, text } of files) {
    const { scene } = importOpenMC(text);
    let cells = 0;
    scene.walk((n) => isCell(n) && cells++);
    if (scene.openmc.preserved.length || cells > 40) continue;
    const short = path.split("tests/")[1];
    const ev = new Evaluator(geo);
    const out = ev.run(scene);
    if (out.errors.size) {
      skipped.push(`${short}: ${[...out.errors.values()][0]}`);
      ev.dispose();
      continue;
    }
    try {
      if (compareVolumes(scene, out, 3000, 0.03)) checked++;
      else skipped.push(`${short}: overlapping cells`);
    } catch (e) {
      e.message = `${path}: ${e.message}`;
      throw e;
    } finally {
      ev.dispose();
    }
  }
  t.diagnostic(`${checked} files checked; skipped: ${skipped.join(" | ") || "none"}`);
  assert.ok(checked > 50);
});

test("cylinder axis: rendering, bounds, export and legacy scenes", () => {
  const ev = new Evaluator(geo);
  for (const axis of ["x", "y", "z"]) {
    const scene = new Scene();
    const cyl = scene.add("cylinder", { params: { radius: 0.5, height: 3, axis }, name: "rod" });
    const out = ev.run(scene);
    const b = out.solids.get(cyl.id).bounds;
    const k = { x: 0, y: 1, z: 2 }[axis];
    for (let i = 0; i < 3; i++) {
      const half = i === k ? 1.5 : 0.5;
      assert.ok(Math.abs(b.max[i] - half) < 1e-9 && Math.abs(b.min[i] + half) < 1e-9, `${axis}: bounds on axis ${i}`);
    }
    assert.deepEqual(scene.regionBounds(cyl).max.map((v) => +v.toFixed(9)), b.max.map((v) => +v.toFixed(9)));
    const { geometry } = exportOpenMC(scene);
    assert.match(geometry, new RegExp(`type="${axis}-cylinder" coeffs="0 0 0.5"`));
    assert.equal((geometry.match(new RegExp(`type="${axis}-plane"`, "g")) ?? []).length >= 2, true);
    assertSameSemantics(scene, importOpenMC(geometry).scene, 3000, { byName: true });
  }
  // New cylinders stand along Z; cylinders from older saves stay along Y.
  assert.equal(new Scene().create("cylinder").params.axis, "z");
  const legacy = Scene.fromJSON({ roots: [{ id: 1, kind: "cylinder", name: "old", enabled: true, params: { radius: 1, height: 2, slices: 32 } }] });
  assert.equal(legacy.roots[0].params.axis, "y");
  ev.dispose();
});
