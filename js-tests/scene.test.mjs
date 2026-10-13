import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "../pkg/critica.js";
import { Scene, Evaluator, mergeMeshes, meshBounds } from "../examples/scene.js";
import { demoScene } from "./fixtures.mjs";

const geo = await init();
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `expected ${b}, got ${a}`);
const shape = (scene) => {
  const describe = (n) => (n.children ? `${n.kind}(${n.children.map(describe).join(",")})` : n.kind);
  return scene.roots.map(describe).join(" ");
};

test("combine keeps order and position", () => {
  const s = new Scene();
  const a = s.add("cube");
  const b = s.add("sphere");
  const c = s.add("torus");
  const g = s.combine("subtract", [c.id, a.id]);
  assert.equal(shape(s), "subtract(torus,cube) sphere");
  assert.equal(s.roots[0], g);
  // Nested selections collapse to their top-most ancestor.
  s.combine("union", [g.id, a.id, b.id]);
  assert.equal(shape(s), "union(subtract(torus,cube),sphere)");
});

test("move, ungroup, duplicate", () => {
  const s = new Scene();
  const a = s.add("cube");
  const b = s.add("sphere");
  const g = s.combine("union", [a.id]);
  assert.ok(s.move(b.id, g.id, "inside"));
  assert.equal(shape(s), "union(cube,sphere)");
  assert.ok(s.move(b.id, a.id, "before"));
  assert.equal(shape(s), "union(sphere,cube)");
  assert.equal(s.move(g.id, a.id, "inside"), false, "cannot move into own subtree");
  assert.equal(s.move(a.id, b.id, "inside"), false, "primitives have no children");
  assert.ok(s.move(a.id, null));
  assert.equal(shape(s), "union(sphere) cube");

  const copy = s.duplicate(g.id);
  assert.equal(shape(s), "union(sphere) union(sphere) cube");
  assert.notEqual(copy.children[0].id, b.id);

  g.transform.position = [1, 0, 0];
  assert.throws(() => s.ungroup(g.id), /transform/);
  g.transform.position = [0, 0, 0];
  s.ungroup(g.id);
  assert.equal(shape(s), "sphere union(sphere) cube");
});

test("json round trip", () => {
  const s = demoScene();
  const r = Scene.fromJSON(JSON.parse(JSON.stringify(s)));
  assert.equal(shape(r), shape(s));
  assert.ok(r.add("cube").id > Math.max(...[...collectIds(s)]));
});

function collectIds(scene) {
  const ids = new Set();
  scene.walk((n) => ids.add(n.id));
  return ids;
}

test("evaluator computes CSG and caches", () => {
  const s = new Scene();
  const a = s.add("cube");
  const b = s.add("cube", { transform: { position: [1, 1, 1] } });
  const g = s.combine("subtract", [a.id, b.id]);
  const ev = new Evaluator(geo);
  const solid = (r, id) => r.solids.get(id) ?? null;

  let r = ev.run(s, { focus: [a.id] });
  close(solid(r, g.id).volume, 7);
  const cachedA = solid(r, a.id);

  // Editing b only rebuilds b and its ancestors.
  b.transform.position = [10, 0, 0];
  r = ev.run(s, { focus: [a.id] });
  assert.equal(solid(r, a.id), cachedA);
  close(solid(r, g.id).volume, 8);

  // Disabled children are skipped; disabled roots disappear.
  b.enabled = false;
  r = ev.run(s);
  close(solid(r, g.id).volume, 8);
  assert.equal(r.values.has(b.id), false);

  g.kind = "intersect";
  b.enabled = true;
  r = ev.run(s);
  assert.equal(solid(r, g.id), null, "disjoint intersection is empty");

  // Leaf ids are carried as tags.
  b.transform.position = [1, 1, 1];
  g.kind = "union";
  r = ev.run(s);
  assert.deepEqual([...new Set(solid(r, g.id).toMesh().tags)].sort(), [a.id, b.id]);

  ev.dispose();
});

test("evaluator: half-spaces, complements and cells", () => {
  const s = new Scene();
  const box = s.add("intersect", { name: "box" });
  for (const [type, c, sense] of [
    ["x-plane", -1, "+"], ["x-plane", 1, "-"], ["y-plane", -1, "+"], ["y-plane", 1, "-"], ["z-plane", -1, "+"], ["z-plane", 1, "-"],
  ]) s.addHalfspace(type, [c], sense, box.id);
  const hole = s.addHalfspace("z-cylinder", [0, 0, 0.5], "+", box.id); // outside the cylinder
  const [cell] = s.makeCells([box.id]);
  cell.fill = { type: "material", material: "1" };
  const ev = new Evaluator(geo);
  let r = ev.run(s);
  assert.equal(r.errors.size, 0);
  const vol = (id) => r.parts.get(id).reduce((t, p) => t + p.solid.volume, 0);
  // 2×2×2 box minus a faceted r=0.5 cylinder (48 segments).
  const cyl = 0.5 * 48 * 0.25 * Math.sin((2 * Math.PI) / 48) * 2;
  close(vol(cell.id), 8 - cyl, 1e-6);
  assert.ok(r.parts.get(cell.id).every((p) => p.tag === cell.id));

  // A complement of the "+" half-space is the cylinder interior.
  s.combine("complement", [hole.id]);
  r = ev.run(s);
  close(vol(cell.id), cyl, 1e-6);

  // An unbounded half-space alone is clipped to the world box.
  const lone = s.addHalfspace("x-plane", [0], "-");
  r = ev.run(s);
  const w = r.world;
  // The cell is now the cylinder interior, so the world hugs it.
  assert.deepEqual(w, { min: [-0.5, -0.5, -1], max: [0.5, 0.5, 1] });
  close(r.solids.get(lone.id).volume, 1);
  ev.dispose();
});

test("evaluator: universe fills, cycles and missing universes", () => {
  const s = new Scene();
  const u = s.add("universe", { name: "pin" });
  const pin = s.add("cell", { fill: { type: "material", material: "1" } }, u.id);
  s.add("sphere", { params: { radius: 0.5 } }, pin.id);
  const outer = s.add("cell", { fill: { type: "universe", universe: u.id }, transform: { position: [0.8, 0, 0] } });
  s.add("cube", { params: { size: [2, 2, 2] } }, outer.id);
  const ev = new Evaluator(geo);
  let r = ev.run(s);
  const parts = r.parts.get(outer.id);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].tag, pin.id);
  // The sphere is moved by the fill translation… but clipped by the cube region at the origin.
  assert.ok(parts[0].solid.volume > 0 && parts[0].solid.volume < (4 / 3) * Math.PI * 0.125);

  // Self reference is reported, not looped.
  const loop = s.add("cell", { fill: { type: "universe", universe: u.id } }, u.id);
  r = ev.run(s);
  assert.match(r.errors.get(loop.id), /contains itself/);

  // Deleting the universe resets fills to void.
  s.detach(u.id);
  assert.deepEqual(outer.fill, { type: "material", material: "void" });
  ev.dispose();
});

test("evaluator does not leak", () => {
  const before = geo.liveCount;
  const s = demoScene();
  const ev = new Evaluator(geo);
  for (let i = 0; i < 5; i++) {
    s.roots[0].children[0].children[1].params.radius = 1.2 + i * 0.05;
    ev.run(s);
  }
  // Only the latest pass's solids stay alive.
  const live = geo.liveCount - before;
  ev.run(s);
  assert.equal(geo.liveCount - before, live);
  ev.dispose();
  assert.equal(geo.liveCount, before);
});

test("demo scene volume matches the scripted version", () => {
  const ev = new Evaluator(geo);
  const scene = demoScene();
  const r = ev.run(scene);
  const scripted = (() => {
    const rod = geo.cylinder({ radius: 0.6, start: [0, -2, 0], end: [0, 2, 0] });
    return geo
      .cube()
      .intersect(geo.sphere({ radius: 1.35 }))
      .subtract(rod, rod.rotateX(90), rod.rotateZ(90));
  })();
  close(r.solids.get(scene.roots[0].id).volume, scripted.volume, 1e-9);
  ev.dispose();
});

test("mesh helpers", () => {
  const a = geo.cube().toMesh();
  const b = geo.cube({ center: [5, 0, 0] }).toMesh();
  const m = mergeMeshes([a, b]);
  assert.equal(m.indices.length, a.indices.length + b.indices.length);
  assert.equal(Math.max(...m.indices), m.tags.length - 1);
  assert.deepEqual(meshBounds(m), { min: [-1, -1, -1], max: [6, 1, 1] });
  assert.equal(meshBounds(mergeMeshes([])), null);
});

test("reordering surfaces renumbers them and updates their users", () => {
  const s = new Scene();
  const a = s.addHalfspace("x-plane", [0], "-");
  s.addSurface({ id: 5, type: "sphere", coeffs: [0, 0, 0, 1] });
  const c = s.addHalfspace("z-plane", [2], "+"); // surface 6
  const b = s.add("halfspace", { params: { surface: 5, sense: "+" }, name: "+5 sphere" });
  s.surfaces.get(1).periodic = 6;
  s.surfaces.get(6).periodic = 1;
  assert.deepEqual([...s.surfaces.keys()], [1, 5, 6]);

  const map = s.reorderSurface(6, 1, "before"); // z-plane first
  assert.deepEqual([...map], [[6, 1], [1, 5], [5, 6]]);
  assert.deepEqual([...s.surfaces.values()].map((x) => [x.id, x.type]), [[1, "z-plane"], [5, "x-plane"], [6, "sphere"]]);
  assert.equal(s.find(a.id).node.params.surface, 5);
  assert.equal(s.find(a.id).node.name, "−5 x-plane");
  assert.equal(s.find(b.id).node.params.surface, 6);
  assert.equal(s.find(c.id).node.params.surface, 1);
  assert.equal(s.find(c.id).node.name, "+1 z-plane");
  assert.equal(s.surfaces.get(1).periodic, 5);
  assert.equal(s.surfaces.get(5).periodic, 1);

  assert.equal(s.reorderSurface(5, 6, "before"), null); // already there
  assert.equal(s.reorderSurface(5, 5), null);
});

test("replacing a node by half-spaces keeps its id and reuses identical surfaces", () => {
  const s = new Scene();
  s.addSurface({ type: "x-plane", coeffs: [1] }); // already there: reused
  const cube = s.add("cube", { name: "Box" });
  const ref = s.add("ref", { params: { target: cube.id } });
  const top = s.replaceWithHalfspaces(cube.id, [
    { surface: { type: "x-plane", coeffs: [-1] }, sense: "+" },
    { surface: { type: "x-plane", coeffs: [1] }, sense: "-" },
  ]);
  assert.equal(top.id, cube.id);
  assert.equal(top.kind, "intersect");
  assert.equal(top.name, "Box");
  assert.deepEqual(top.children.map((c) => [c.params.surface, c.params.sense]), [[2, "+"], [1, "-"]]);
  assert.equal(s.surfaces.size, 2);
  assert.equal(s.find(ref.params.target).node, top);
  const one = s.replaceWithHalfspaces(top.id, [{ surface: { type: "sphere", coeffs: [0, 0, 0, 1] }, sense: "-" }]);
  assert.equal(one.kind, "halfspace");
  assert.equal(one.id, cube.id);
});
