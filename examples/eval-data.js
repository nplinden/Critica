// Evaluation results as plain data, for the page: the evaluator's solids live
// in wasm memory (in a worker, out of the page's reach), so what crosses over
// is their meshes and measures.
//
// Part data: { key, tag, triangles, volume, bounds, mesh?, leaves? } where
// mesh = { positions, normals, tags, indices } and leaves = the leaf tag of
// each vertex for cells (whose faces carry the cell's tag), or null. A mesh is
// sent once per key; later results repeat only the key.

import { Evaluator } from "./scene.js";

/** Data of an evaluator part ({ key, solid, tag?, source? }); `withMesh` includes the arrays. */
export function partData(p, withMesh) {
  const s = p.solid;
  const data = { key: p.key, tag: p.tag ?? 0, triangles: s.triangleCount, volume: s.volume, bounds: s.bounds };
  if (withMesh) {
    data.mesh = s.toMesh();
    const leaves = p.source?.toMesh().tags;
    data.leaves = leaves && leaves.length === data.mesh.tags.length ? leaves : null;
  }
  return data;
}

/** The transferable buffers of a part's arrays. */
export const buffersOf = (d) => (d.mesh ? [d.mesh.positions.buffer, d.mesh.normals.buffer, d.mesh.tags.buffer, d.mesh.indices.buffer, ...(d.leaves ? [d.leaves.buffer] : [])] : []);

/** An evaluator plus the keys whose meshes the page already has. */
export class EvalRunner {
  constructor(geo) {
    this.geo = geo;
    this.evaluator = new Evaluator(geo);
    this.sent = new Set();
  }
}

/**
 * Runs a job in chunks of about `chunkMs`, yielding { msg, transfer } after
 * each: msg = { parts: [[id, [part data]]] (items not yet reported in this
 * job), errors, done, total, partial }, and, once complete, the `focus`
 * solids, the displayed `surfaces` meshes, the keys the page may drop and the
 * live solid count.
 */
export function* runJob(runner, scene, { only = null, focus = [], surfaces = [], chunkMs = 50 } = {}) {
  const reported = new Set();
  for (;;) {
    const out = runner.evaluator.run(scene, { only, focus, surfaces, deadline: performance.now() + chunkMs });
    const transfer = [];
    const msg = { parts: [], errors: [...out.errors], done: out.done, total: out.total, partial: out.partial };
    for (const [id, parts] of out.parts) {
      if (reported.has(id)) continue;
      reported.add(id);
      msg.parts.push([
        id,
        parts.map((p) => {
          const withMesh = !runner.sent.has(p.key);
          const d = partData(p, withMesh);
          if (withMesh) {
            runner.sent.add(p.key);
            transfer.push(...buffersOf(d));
          }
          return d;
        }),
      ]);
    }
    if (!out.partial) {
      // Selected nodes that are not top-level items (ghosts, properties): sent whole.
      msg.solids = [];
      for (const id of focus) {
        const solid = out.solids.get(id);
        if (!solid || solid.isEmpty) continue;
        const d = partData({ key: `focus:${id}`, solid }, true);
        transfer.push(...buffersOf(d));
        msg.solids.push([id, d]);
      }
      msg.surfaces = [...out.surfaces].map(([key, solid]) => {
        const mesh = solid && !solid.isEmpty ? solid.toMesh() : null;
        if (mesh) transfer.push(mesh.positions.buffer, mesh.normals.buffer, mesh.tags.buffer, mesh.indices.buffer);
        return [key, mesh];
      });
      // Meshes of parts that are gone: the evaluator disposed their solids.
      const live = new Set();
      for (const parts of out.parts.values()) for (const p of parts) live.add(p.key);
      msg.dropped = [...runner.sent].filter((k) => !live.has(k));
      for (const k of msg.dropped) runner.sent.delete(k);
      msg.live = runner.geo.liveCount;
    }
    yield { msg, transfer };
    if (!out.partial) return;
  }
}
