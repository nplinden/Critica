import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "../pkg/critica.js";
import { Scene } from "../app/scene.js";
import { EvalRunner, runJob, partData } from "../app/eval-data.js";

const geo = await init();

function scene() {
  const s = new Scene();
  for (let i = 0; i < 3; i++) s.add("sphere", { transform: { position: [i * 4, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } });
  const cell = s.add("cell", { fill: { type: "material", material: "1" } });
  s.add("cube", {}, cell.id);
  return s;
}

const collect = (runner, s, opts) => [...runJob(runner, s, opts)].map((x) => x.msg);

test("a job reports every item once, with meshes sent once per key", () => {
  const s = scene();
  const runner = new EvalRunner(geo);
  const msgs = collect(runner, s, { chunkMs: 0 }); // one new item per chunk
  assert.ok(msgs.length >= 4, "several chunks");
  assert.ok(msgs.slice(0, -1).every((m) => m.partial));
  const last = msgs.at(-1);
  assert.equal(last.partial, false);
  assert.equal(last.done, 4);
  const reported = msgs.flatMap((m) => m.parts.map(([id]) => id));
  assert.deepEqual([...reported].sort(), s.roots.map((n) => n.id).sort(), "each item once");
  const parts = msgs.flatMap((m) => m.parts.flatMap(([, list]) => list));
  assert.ok(parts.every((p) => p.mesh && p.mesh.positions.length > 0 && p.volume > 0 && p.bounds));
  // The cell's faces carry its tag; leaves give the cube's.
  const cellPart = msgs.flatMap((m) => m.parts).find(([id]) => id === s.roots[3].id)[1][0];
  assert.equal(cellPart.tag, s.roots[3].id);
  assert.ok(cellPart.leaves.every((t) => t === s.roots[3].children[0].id));
  // A second job sends keys only, and nothing is dropped.
  const again = collect(runner, s, {});
  assert.equal(again.length, 1);
  assert.ok(again[0].parts.flatMap(([, l]) => l).every((p) => !p.mesh && p.key));
  assert.deepEqual(again[0].dropped, []);
  // An edit rebuilds one item: its old mesh is dropped, the new one sent.
  s.roots[0].params.radius = 2;
  const edited = collect(runner, s, {})[0];
  const withMesh = edited.parts.flatMap(([, l]) => l).filter((p) => p.mesh);
  assert.equal(withMesh.length, 1);
  assert.equal(edited.dropped.length, 1);
  assert.ok(edited.live > 0);
});

test("a job builds only its share, plus focus solids and surface shells", () => {
  const s = scene();
  const runner = new EvalRunner(geo);
  // The focus node lives in the cell: the share must hold the cell (the
  // service sends focus nodes to the worker that owns their top-level item).
  const share = new Set([s.roots[1].id, s.roots[3].id]);
  const cube = s.roots[3].children[0].id;
  const [msg] = collect(runner, s, { only: share, focus: [cube], surfaces: [{ key: "k", surface: { type: "sphere", coeffs: [0, 0, 0, 1] }, tag: 9 }] });
  assert.deepEqual(msg.parts.map(([id]) => id), [s.roots[1].id, s.roots[3].id]);
  assert.equal(msg.total, 2);
  assert.equal(msg.solids.length, 1);
  assert.equal(msg.solids[0][0], cube);
  assert.ok(msg.solids[0][1].mesh);
  assert.equal(msg.surfaces[0][0], "k");
  assert.ok(msg.surfaces[0][1].positions.length > 0);
});

test("part data measures match the solid", () => {
  const solid = geo.sphere({ radius: 2, slices: 16, stacks: 8 });
  const d = partData({ key: "x", solid }, true);
  assert.equal(d.triangles, solid.triangleCount);
  assert.equal(d.volume, solid.volume);
  assert.deepEqual(d.bounds, solid.bounds);
  assert.equal(d.mesh.indices.length / 3, d.triangles);
  assert.equal(partData({ key: "x", solid }, false).mesh, undefined);
});
