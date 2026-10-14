// Evaluation worker: its own CSG engine and evaluator, building the top-level
// items the page assigns to it and streaming their meshes back as they are
// done (see eval-data.js for the messages). A newer job supersedes the
// running one between chunks.

import { init } from "../pkg/critica.js";
import { Scene } from "./scene.js";
import { EvalRunner, runJob } from "./eval-data.js";

let runner = null;
const ready = init().then((geo) => (runner = new EvalRunner(geo)));
let latest = 0;

self.onmessage = async ({ data: job }) => {
  latest = job.gen;
  try {
    await ready;
  } catch (e) {
    self.postMessage({ gen: job.gen, fatal: String(e?.message ?? e) });
    return;
  }
  if (job.gen !== latest) return;
  const scene = Scene.fromJSON(job.scene);
  try {
    for (const { msg, transfer } of runJob(runner, scene, { only: new Set(job.roots), focus: job.focus, surfaces: job.surfaces, chunkMs: 60 })) {
      self.postMessage({ gen: job.gen, ...msg }, transfer);
      if (!msg.partial) return;
      // Let a newer job arrive; drop this one if it did.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (job.gen !== latest) return;
    }
  } catch (e) {
    self.postMessage({ gen: job.gen, fatal: String(e?.message ?? e) });
  }
};
