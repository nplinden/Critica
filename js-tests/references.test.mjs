import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "../pkg/critica.js";
import { Scene, Evaluator, isCell } from "../examples/scene.js";
import { exportOpenMC } from "../examples/openmc/export.js";
import { importOpenMC } from "../examples/openmc/import.js";
import { locate } from "../examples/openmc/locate.js";

const geo = await init();

/** The scene from the screenshot: a fuel cell whose region is (cube ∩ sphere) − 3 cylinders. */
function fuelScene() {
  const s = new Scene();
  const body = s.add("intersect", { name: "Intersect 3" });
  s.add("cube", {}, body.id);
  s.add("sphere", { params: { radius: 1.35 } }, body.id);
  const fuel = s.combine("subtract", [body.id]);
  fuel.name = "Fuel Cuboid";
  for (const [axis] of [["x"], ["y"], ["z"]]) s.add("cylinder", { params: { radius: 0.6, height: 4, axis } }, fuel.id);
  const [cell] = s.makeCells([fuel.id]);
  cell.name = "Fuel Cuboid Cell";
  cell.fill = { type: "material", material: "1" };
  return { s, fuel, cell };
}

test("combining a free box with a cell's region references it instead of moving it", () => {
  const { s, fuel, cell } = fuelScene();
  const box = s.add("cube", { params: { size: [5, 5, 5] }, name: "Box" });
  const water = s.combine("subtract", [box.id, fuel.id]);
  // The fuel cell still owns its region.
  assert.equal(cell.children[0], fuel);
  // The new group sits at the root where the box was, holding the box and a reference.
  assert.ok(s.roots.includes(water));
  assert.deepEqual(water.children.map((c) => c.kind), ["cube", "ref"]);
  assert.equal(water.children[1].params.target, fuel.id);
  assert.equal(s.lastCombineRefs, 1);
  // Nodes of a single cell are still moved (restructuring inside the cell).
  const [a, b] = fuel.children[0].children;
  const g = s.combine("union", [a.id, b.id]);
  assert.equal(s.lastCombineRefs, 0);
  assert.equal(s.ownerCell(g.id), cell.id);
});

test("a reused region renders, exports and locates like its source", () => {
  const { s, fuel, cell } = fuelScene();
  const box = s.add("cube", { params: { size: [5, 5, 5] }, name: "Box" });
  const waterRegion = s.combine("subtract", [box.id, fuel.id]);
  const [water] = s.makeCells([waterRegion.id]);
  water.name = "Water";
  water.fill = { type: "material", material: "2" };
  s.addMaterial({ id: 1, name: "fuel", components: [{ kind: "element", name: "U", percent: 1, type: "ao" }], density: { value: 19, units: "g/cm3" } });
  s.addMaterial({ id: 2, name: "water", components: [{ kind: "element", name: "H", percent: 2, type: "ao" }, { kind: "element", name: "O", percent: 1, type: "ao" }] });

  const ev = new Evaluator(geo);
  let out = ev.run(s);
  assert.equal(out.errors.size, 0, [...out.errors.values()].join());
  const vol = (id) => out.parts.get(id).reduce((t, p) => t + p.solid.volume, 0);
  const fuelVol = vol(cell.id);
  assert.ok(Math.abs(vol(water.id) - (125 - fuelVol)) < 1e-6, `${vol(water.id)} vs ${125 - fuelVol}`);

  // Editing the source updates every use.
  fuel.children[0].children[1].params.radius = 1.2;
  out = ev.run(s);
  assert.ok(Math.abs(vol(water.id) + vol(cell.id) - 125) < 1e-6);

  // Point location and export: the two cells partition the box exactly.
  assert.equal(locate(s, [0.8, 0.8, 0.1]).node, cell);
  assert.equal(locate(s, [2.3, 0, 0]).node, water);
  assert.equal(locate(s, [0, 0, 0]).node, water, "inside a hole is water");
  const { geometry, warnings } = exportOpenMC(s);
  assert.deepEqual(warnings, []);
  // The fuel surfaces are written once and shared by both cells.
  assert.equal((geometry.match(/type="sphere"/g) ?? []).length, 1);
  const back = importOpenMC(geometry).scene;
  for (const p of [[0.8, 0.8, 0.1], [2.3, 0, 0], [0, 0, 0], [1.1, -0.3, 0.8], [-2.4, 2.4, -2.4]]) {
    const a = locate(s, p)?.node;
    const b = locate(back, p)?.node;
    assert.equal(b && isCell(b) ? b.name : null, a?.name ?? null, `${p}`);
  }
  ev.dispose();
});

test("reference tools: add, unlink, cycles and deleted sources", () => {
  const { s, fuel } = fuelScene();
  const [ref] = s.addReferences([fuel.id]);
  assert.equal(ref.kind, "ref");
  assert.equal(s.resolveRef(ref), fuel);
  assert.deepEqual(s.refsTo(fuel.id), [ref]);
  // Self-reference is refused up front…
  assert.throws(() => s.addReferences([fuel.id], fuel.id), /itself/);
  // …and a cycle built by hand is reported, not looped.
  const loop = s.create("ref", { params: { target: fuel.id } });
  fuel.children.push(loop);
  const ev = new Evaluator(geo);
  let out = ev.run(s);
  assert.ok([...out.errors.values()].some((e) => /cycle/.test(e)));
  fuel.children.pop();
  // Unlink gives an independent copy.
  const copy = s.unlinkRef(ref.id);
  assert.equal(copy.kind, "subtract");
  assert.notEqual(copy.id, fuel.id);
  assert.equal(s.refsTo(fuel.id).length, 0);
  // A reference whose source is deleted reports an error.
  const [r2] = s.addReferences([fuel.id]);
  s.detach(s.find(fuel.id).parent.id); // delete the fuel cell
  out = ev.run(s);
  assert.match(out.errors.get(r2.id), /no longer exists/);
  // JSON round trip keeps references.
  const again = Scene.fromJSON(JSON.parse(JSON.stringify(s)));
  assert.equal(again.find(r2.id).node.params.target, fuel.id);
  ev.dispose();
});
