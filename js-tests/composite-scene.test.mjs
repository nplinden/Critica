import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "../pkg/critica.js";
import { Scene, Evaluator } from "../app/scene.js";
import { COMPOSITE_TYPES } from "../app/openmc/composite.js";
import { importOpenMC } from "../app/openmc/import.js";
import { exportOpenMC } from "../app/openmc/export.js";
import { locate } from "../app/openmc/locate.js";

const geo = await init();

function rng(seed = 1) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

/** Leaf label at a point: auto cells are named after their shape; "outside" is empty space. */
const label = (hit) => (!hit || hit.node.name === "outside" ? "nothing" : hit.node.name);

function samePoints(a, b, n, box) {
  const rand = rng(5);
  const size = box.max.map((v, i) => v - box.min[i]);
  for (let i = 0; i < n; i++) {
    const p = box.min.map((v, k) => v + (rand() * 1.1 - 0.05) * size[k]);
    const la = label(locate(a, p));
    const lb = label(locate(b, p));
    if (la !== lb) assert.fail(`${p.map((v) => v.toFixed(3))}: ${la} vs ${lb}`);
  }
}

/** Builds a scene holding one composite (inside a cell so it gets a material). */
function sceneWith(type, values = {}, { transform, sense = "-" } = {}) {
  const scene = new Scene();
  const node = scene.addComposite(type);
  Object.assign(node.params.values, values);
  node.params.sense = sense;
  if (transform) Object.assign(node.transform, transform);
  // Bound infinite composites so the world box is finite in every axis.
  const box = scene.add("cube", { params: { size: [4, 4, 4] }, name: "bounds" });
  const clip = scene.combine("intersect", [node.id, box.id]);
  clip.name = "shape";
  return { scene, node };
}

const VARIANTS = {
  "cylinder-sector": [{}, { theta1: 0, theta2: 270, axis: "x" }],
  "isogonal-octagon": [{}, { axis: "y", r1: 1, r2: 1.2 }],
  rcc: [{}, { upper_fillet_radius: 0.3, lower_fillet_radius: 0.2, axis: "y" }],
  rpp: [{}],
  "orthogonal-box": [{ v: [-1, -1, -1], a1: [1.4, -0.6, 0], a2: [0.6, 1.4, 0], a3: [0, 0, 1.8] }, { finite: false, a1: [1, 1, 0], a2: [-1, 1, 0] }],
  "cone-one-sided": [{}, { up: false, axis: "x", r2: 0.5 }],
  polygon: [{}, { basis: "rz", points: [[0.2, -1], [1.2, -1], [1.2, 0], [0.6, 1], [0.2, 1]] }, { basis: "yz" }],
  "cruciform-prism": [{}, { distances: [0.5, 1.2], axis: "x" }],
  "rectangular-prism": [{}, { corner_radius: 0.3, axis: "y" }],
  "hexagonal-prism": [{}, { corner_radius: 0.2, orientation: "x" }],
  "conical-frustum": [{}, { center_base: [-1, -0.5, 0], axis: [1.5, 1, 0.5], r1: 0.8, r2: 0.3 }],
  vessel: [{}, { axis: "x", h1: 0.8, h2: 0.3 }],
};

test("every composite renders with the volume OpenMC's point test gives", () => {
  assert.deepEqual(Object.keys(VARIANTS).sort(), Object.keys(COMPOSITE_TYPES).sort(), "all types covered");
  for (const [type, variants] of Object.entries(VARIANTS)) {
    for (const values of variants) {
      const { scene } = sceneWith(type, values);
      const ev = new Evaluator(geo);
      const out = ev.run(scene);
      assert.equal(out.errors.size, 0, `${type}: ${[...out.errors.values()]}`);
      const mesh = out.solids.get(scene.roots[0].id)?.volume ?? 0;
      // Monte Carlo with the analytic expansion.
      const w = out.world;
      const size = w.max.map((v, i) => v - w.min[i]);
      const total = size[0] * size[1] * size[2];
      const rand = rng(11);
      const n = 6000;
      let hits = 0;
      for (let i = 0; i < n; i++) if (locate(scene, w.min.map((v, k) => v + rand() * size[k]))) hits++;
      const sampled = (hits / n) * total;
      const sigma = Math.sqrt(Math.max(hits / n * (1 - hits / n), 1 / n) / n) * total;
      assert.ok(Math.abs(mesh - sampled) <= 4 * sigma + 0.03 * mesh, `${type} ${JSON.stringify(values)}: mesh ${mesh.toFixed(3)} vs sampled ${sampled.toFixed(3)}`);
      ev.dispose();
    }
  }
});

test("composites export as plain OpenMC surfaces with the same meaning", () => {
  for (const [type, variants] of Object.entries(VARIANTS)) {
    for (const values of variants) {
      for (const opts of [{}, { sense: "+" }, { transform: { rotation: [0, 0, 90], position: [0.3, -0.2, 0.1] } }]) {
        const { scene } = sceneWith(type, values, opts);
        let xml;
        try {
          xml = exportOpenMC(scene);
        } catch (e) {
          // Only tori (RCC fillets) may refuse transforms that tilt their axis.
          assert.match(e.message, /tori/, `${type}: ${e.message}`);
          continue;
        }
        const back = importOpenMC(xml.geometry).scene;
        samePoints(scene, back, 1500, scene.resolveWorld());
      }
    }
  }
});

test("boundary conditions and periodic pairs reach the XML", () => {
  const scene = new Scene();
  const node = scene.addComposite("hexagonal-prism");
  node.params.values.boundary = "periodic";
  const box = scene.add("cube", { params: { size: [4, 4, 4] } });
  const cell = scene.makeCells([scene.combine("intersect", [node.id, box.id]).id])[0];
  cell.fill.material = "1";
  const { geometry } = exportOpenMC(scene);
  const periodic = [...geometry.matchAll(/<surface id="(\d+)"[^>]*boundary="periodic"[^>]*periodic_surface_id="(\d+)"/g)].map((m) => [+m[1], +m[2]]);
  assert.equal(periodic.length, 6);
  for (const [a, b] of periodic) assert.ok(periodic.some(([c, d]) => c === b && d === a), `${a}↔${b}`);
  // No extra vacuum box: the file already has boundary conditions.
  assert.doesNotMatch(geometry, /name="outside"/);

  const v = new Scene();
  const vessel = v.addComposite("vessel");
  vessel.params.values.boundary = "vacuum";
  const xml = exportOpenMC(v).geometry;
  assert.equal([...xml.matchAll(/boundary="vacuum"/g)].length, 3, "cylinder and two heads, not the planes");
});

test("expanding a composite into half-spaces keeps its meaning", () => {
  for (const [type, variants] of Object.entries(VARIANTS)) {
    for (const values of variants) {
      for (const sense of ["-", "+"]) {
        const { scene, node } = sceneWith(type, values, { sense, transform: { position: [0.2, 0, -0.1] } });
        const expanded = Scene.fromJSON(JSON.parse(JSON.stringify(scene)));
        const top = expanded.expandCompositeNode(node.id);
        assert.ok(top, type);
        let composites = 0;
        expanded.walk((n) => n.kind === "composite" && composites++);
        assert.equal(composites, 0);
        samePoints(scene, expanded, 800, scene.resolveWorld());
      }
    }
  }
});

test("invalid parameters surface as node errors", () => {
  const { scene, node } = sceneWith("cylinder-sector", { r1: 2, r2: 1 });
  const ev = new Evaluator(geo);
  const out = ev.run(scene);
  assert.match(out.errors.get(node.id), /r2 must be greater/);
  assert.throws(() => exportOpenMC(scene), /r2 must be greater/);
  ev.dispose();
});
