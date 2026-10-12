import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "../pkg/geomium.js";

const geo = await init();

const close = (actual, expected, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);

test("boolean volumes", () => {
  const a = geo.cube();
  const b = geo.cube({ center: [1, 1, 1] });
  close(a.union(b).volume, 15);
  close(a.subtract(b).volume, 7);
  close(a.intersect(b).volume, 1);
  close(geo.cube({ size: [2, 4, 6] }).volume, 48);
});

test("variadic operations free intermediates", () => {
  const before = geo.liveCount;
  const parts = [0, 1, 2, 3].map((i) => geo.cube({ center: [i * 1.5, 0, 0] }));
  const u = geo.union(parts);
  close(u.volume, 8 * 4 - 4 * 0.5 * 3);
  parts.forEach((p) => p.dispose());
  u.dispose();
  assert.equal(geo.liveCount, before);
});

test("transforms", () => {
  const slab = geo.cube({ radius: [2, 1, 0.5] });
  const b = slab.rotateZ(90).translate(10, 0, 0).bounds;
  close(b.min[0], 9);
  close(b.max[1], 2);
  assert.ok(geo.sphere().mirror("x").volume > 0);

  const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1];
  assert.deepEqual(geo.cube().transform(m).bounds, { min: [4, 5, 6], max: [6, 7, 8] });
  close(geo.cube().scale(2).volume, 64);
});

test("mesh export", () => {
  const part = geo
    .cube()
    .intersect(geo.sphere({ radius: 1.35 }))
    .subtract(
      geo.cylinder({ radius: 0.6 }).scale(1, 2, 1),
      geo.cylinder({ radius: 0.6 }).scale(1, 2, 1).rotateX(90),
      geo.cylinder({ radius: 0.6 }).scale(1, 2, 1).rotateZ(90),
    )
    .tag(7);
  const mesh = part.toMesh();
  assert.equal(mesh.indices.length, part.triangleCount * 3);
  assert.equal(mesh.positions.length, mesh.normals.length);
  assert.ok(mesh.tags.every((t) => t === 7));
  const vertices = mesh.positions.length / 3;
  assert.ok(mesh.indices.every((i) => i < vertices));

  const stl = part.toSTL();
  assert.equal(stl.length, 84 + 50 * part.triangleCount);
});

test("fromMesh", () => {
  const tet = geo.fromMesh([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
  close(tet.volume, 1 / 6);
});

test("disposed solids throw", () => {
  const s = geo.sphere();
  s.dispose();
  s.dispose(); // idempotent
  assert.throws(() => s.volume, /disposed/);
  assert.throws(() => geo.cube().union(s), /disposed/);
});

test("empty results", () => {
  const empty = geo.cube().intersect(geo.cube({ center: [10, 0, 0] }));
  assert.ok(empty.isEmpty);
  assert.equal(empty.bounds, null);
  assert.equal(empty.toMesh().indices.length, 0);
});
