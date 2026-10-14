// Evaluation off the page: several workers (eval-worker.js), each with its own
// CSG engine, build the scene's top-level items in parallel and stream their
// meshes back. Each item stays with the worker that first built it, so edits
// hit a warm cache. Without module workers (or if they fail), one in-page
// "lane" runs the same jobs in chunks between frames.
//
//   const service = createEvalService({ onUpdate(results) {} });
//   service.run(scene, { focus, surfaces, skip });   // results arrive via onUpdate
//   (skip: ids of top-level items not to build, e.g. hidden void cells)
//
// results: { parts: Map<id, [part data]>, solids: Map<id, part data> (focus
// nodes), errors: Map<id, message>, surfaces: Map<key, mesh|null>, world,
// partial, done, total, live (solids in all engines), ms, cached (items served
// from the mesh cache), fatal? }, with part data as in eval-data.js (always
// with its mesh and leaves).
//
// With a `store` (mesh-store.js, or a promise of one), built items are saved
// under their item key (item-keys.js) and served from it later: an unchanged
// item is drawn at once, without a worker, across sessions. A recent-items
// memory in front of it serves undo and redo without even a lookup.

import { Scene } from "./scene.js";
import { EvalRunner, runJob } from "./eval-data.js";
import { itemKeys } from "./item-keys.js";

const defaultWorkers = () => Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency || 2) - 1));

const MEMORY_ITEMS = 2000; // recently built or loaded items kept in memory

export function createEvalService({ onUpdate, workers = defaultWorkers(), store = null } = {}) {
  const meshes = new Map(); // `${lane}:${key}` → { mesh, leaves }
  const memory = new Map(); // item key → parts (insertion order = recency)
  let storeReady = Promise.resolve(store).catch(() => null);
  let meshStore = null;
  storeReady.then((s) => (meshStore = s));
  const owner = new Map(); // top-level item (or universe) id → lane
  let lanes = [];
  let gen = 0;
  let job = null;
  let lastRun = null;
  let inline = false;
  let unloading = false;
  // Navigating away aborts the workers' module loads, which Firefox reports as
  // (empty) worker errors, sometimes before pagehide: ignore those.
  for (const ev of ["beforeunload", "pagehide"]) globalThis.addEventListener?.(ev, () => (unloading = true));

  function workerLane(i) {
    const worker = new Worker(new URL("./eval-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => handle(i, e.data);
    worker.onerror = (e) => {
      e.preventDefault?.();
      if (unloading) return; // workers torn down with the page
      console.warn(`Evaluation worker failed (${e.message ?? "error"} ${e.filename ?? ""}:${e.lineno ?? ""}); evaluating in the page instead.`);
      useInline();
    };
    return { post: (msg) => worker.postMessage(msg), terminate: () => worker.terminate(), live: 0 };
  }

  /** The in-page lane: the same jobs, in chunks between frames. */
  function inlineLane() {
    let runner = null;
    let latest = 0;
    const ready = import("../pkg/critica.js").then((m) => m.init()).then((geo) => (runner = new EvalRunner(geo)));
    return {
      live: 0,
      terminate() {},
      async post(msg) {
        latest = msg.gen;
        await ready;
        if (msg.gen !== latest) return;
        const scene = Scene.fromJSON(msg.scene);
        for (const { msg: out } of runJob(runner, scene, { only: new Set(msg.roots), focus: msg.focus, surfaces: msg.surfaces, chunkMs: 40 })) {
          handle(0, { gen: msg.gen, ...out });
          if (!out.partial) return;
          await new Promise((resolve) => requestAnimationFrame(resolve));
          if (msg.gen !== latest) return;
        }
      },
    };
  }

  function useInline() {
    if (inline) return;
    inline = true;
    for (const lane of lanes) lane.terminate();
    lanes = [inlineLane()];
    owner.clear();
    meshes.clear();
    if (lastRun) run(lastRun.scene, lastRun.options);
  }

  try {
    if (typeof Worker === "undefined" || !(workers > 0)) throw new Error("no workers");
    for (let i = 0; i < workers; i++) lanes.push(workerLane(i));
  } catch {
    inline = true;
    lanes = [inlineLane()];
  }

  /** Gives new items to the lane with the fewest, keeping existing ones in place. */
  function assign(ids) {
    const present = new Set(ids);
    for (const id of owner.keys()) if (!present.has(id)) owner.delete(id);
    const load = lanes.map(() => 0);
    for (const lane of owner.values()) load[lane]++;
    for (const id of ids) {
      if (owner.has(id)) continue;
      const lane = load.indexOf(Math.min(...load));
      owner.set(id, lane);
      load[lane]++;
    }
  }

  function remember(key, parts) {
    memory.delete(key);
    memory.set(key, parts);
    if (memory.size > MEMORY_ITEMS) memory.delete(memory.keys().next().value);
  }

  function run(scene, options = {}) {
    lastRun = { scene, options };
    const { focus = [], surfaces = [], skip = [] } = options;
    gen++;
    const skipped = new Set(skip);
    const items = scene.roots.filter((n) => n.enabled && !skipped.has(n.id)).map((n) => n.id);
    assign([...items, ...scene.universes.map((u) => u.id)]);
    const top = (id) => scene.ancestors(id).at(-1) ?? id;
    const world = scene.resolveWorld();
    const keys = itemKeys(scene, items, world);
    job = { gen, world, keys, cached: new Map(), states: new Map(), started: performance.now(), saved: false };
    // Items holding a selected node are built anyway: its ghost and result need their solids.
    const forced = new Set(focus.map(top).filter((t) => keys.has(t) && !focus.includes(t)));
    for (const id of items) {
      const parts = memory.get(keys.get(id));
      if (parts) {
        job.cached.set(id, parts);
        remember(keys.get(id), parts);
      }
    }
    const missing = items.filter((id) => !job.cached.has(id));
    const thisJob = job;
    const dispatch = () => {
      if (job !== thisJob) return;
      dispatchJob(scene, items.filter((id) => !job.cached.has(id) || forced.has(id)), focus, surfaces, top);
    };
    if (missing.length && store) {
      // Look the rest up in the persistent cache first.
      storeReady
        .then((s) => (s ? s.getMany(missing.map((id) => keys.get(id))) : new Map()))
        .then((found) => {
          if (job !== thisJob) return;
          for (const id of missing) {
            const parts = found.get(keys.get(id));
            if (!parts) continue;
            job.cached.set(id, parts);
            remember(keys.get(id), parts);
          }
          dispatch();
        })
        .catch(dispatch);
      emit();
    } else dispatch();
  }

  function dispatchJob(scene, toBuild, focus, surfaces, top) {
    const json = scene.toJSON();
    const gen = job.gen;
    lanes.forEach((lane, i) => {
      const roots = toBuild.filter((id) => owner.get(id) === i);
      const f = focus.filter((id) => (owner.get(top(id)) ?? 0) === i);
      const sf = i === 0 ? surfaces : [];
      const state = { final: false, parts: new Map(), errors: [], solids: [], surfaces: [], done: 0, total: roots.length };
      job.states.set(i, state);
      if (!roots.length && !f.length && !sf.length) state.final = true;
      else lane.post({ gen, scene: json, roots, focus: f, surfaces: sf });
    });
    job.dispatched = true;
    emit();
  }

  function handle(i, data) {
    // Meshes are kept even from superseded jobs: the worker counts them as sent.
    for (const [, list] of data.parts ?? []) for (const d of list) if (d.mesh) meshes.set(`${i}:${d.key}`, { mesh: d.mesh, leaves: d.leaves });
    for (const key of data.dropped ?? []) meshes.delete(`${i}:${key}`);
    if (data.live !== undefined && lanes[i]) lanes[i].live = data.live;
    if (!job || data.gen !== job.gen) return;
    const state = job.states.get(i);
    if (data.fatal) {
      state.final = true;
      state.fatal = data.fatal;
    } else {
      for (const [id, list] of data.parts) state.parts.set(id, list);
      state.errors = data.errors;
      state.done = data.done;
      state.total = data.total;
      if (!data.partial) {
        state.final = true;
        state.solids = data.solids ?? [];
        state.surfaces = data.surfaces ?? [];
      }
    }
    emit();
  }

  function resolve(i, d) {
    if (d.mesh) return d;
    const cached = meshes.get(`${i}:${d.key}`);
    return cached ? { ...d, mesh: cached.mesh, leaves: cached.leaves } : null;
  }

  function emit() {
    const res = { parts: new Map(), solids: new Map(), errors: new Map(), surfaces: new Map(), world: job.world, partial: !job.dispatched, done: 0, total: 0, live: 0, ms: performance.now() - job.started, cached: job.cached.size };
    for (const [id, parts] of job.cached) res.parts.set(id, parts);
    res.done += job.cached.size;
    res.total += job.cached.size;
    for (const [i, state] of job.states) {
      for (const [id, list] of state.parts) res.parts.set(id, list.map((d) => resolve(i, d)).filter(Boolean));
      for (const [id, msg] of state.errors) res.errors.set(id, msg);
      for (const [id, d] of state.solids) res.solids.set(id, d);
      for (const [key, mesh] of state.surfaces) res.surfaces.set(key, mesh);
      if (state.fatal) res.fatal = state.fatal;
      res.done += state.done;
      res.total += state.total;
      res.partial ||= !state.final;
    }
    res.live = lanes.reduce((s, lane) => s + (lane.live ?? 0), 0);
    // Items built by the workers count once: subtract those also served from the cache.
    for (const [, state] of job.states) for (const id of state.parts.keys()) if (job.cached.has(id)) (res.done--, res.total--);
    if (!res.partial && !job.saved) save(res);
    onUpdate?.(res);
  }

  /** Saves the items the workers built in this job (complete, without errors) for later. */
  function save(res) {
    job.saved = true;
    for (const [i, state] of job.states) {
      for (const [id, list] of state.parts) {
        const key = job.keys.get(id);
        if (!key || job.cached.has(id) || res.errors.has(id)) continue;
        const parts = res.parts.get(id);
        if (!parts || parts.length !== list.length) continue; // a mesh was missing
        remember(key, parts);
        meshStore?.put(key, parts);
      }
    }
  }

  return {
    run,
    get workers() {
      return inline ? 0 : lanes.length;
    },
    /** The persistent cache (null without one): size, entries, clear(). */
    get store() {
      return meshStore;
    },
    /** Empties the persistent cache and the memory in front of it. */
    async clearCache() {
      memory.clear();
      await (await storeReady)?.clear();
    },
  };
}
