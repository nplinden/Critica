import { test } from "node:test";
import assert from "node:assert/strict";
import { Scene } from "../app/scene.js";
import { itemKeys } from "../app/item-keys.js";
import { createEvalService } from "../app/eval-service.js";

globalThis.requestAnimationFrame ??= (cb) => setTimeout(cb, 0);

function model() {
  const s = new Scene();
  const a = s.addSurface({ type: "sphere", coeffs: [0, 0, 0, 2] });
  const b = s.addSurface({ type: "sphere", coeffs: [0, 0, 0, 4] });
  const fuel = s.add("cell", { name: "fuel" });
  s.add("halfspace", { params: { surface: a, sense: "-" } }, fuel.id);
  const water = s.add("cell", { name: "water" });
  const and = s.add("intersect", {}, water.id);
  s.add("halfspace", { params: { surface: b, sense: "-" } }, and.id);
  const ref = s.add("complement", {}, and.id);
  s.add("ref", { params: { target: fuel.children[0].id } }, ref.id);
  const box = s.add("cube", { name: "box" });
  return { s, a, fuel, water, box };
}

const keysOf = (s) => itemKeys(s, s.roots.map((n) => n.id));

test("item keys are stable and follow what the geometry depends on", () => {
  const { s, a, fuel, water, box } = model();
  const k0 = keysOf(s);
  assert.deepEqual(keysOf(Scene.fromJSON(JSON.parse(JSON.stringify(s)))), k0, "same scene, same keys");
  fuel.name = "renamed";
  box.color = "#ff0000";
  assert.deepEqual(keysOf(s), k0, "display fields do not matter");
  s.surfaces.get(a).coeffs[3] = 2.5;
  const k1 = keysOf(s);
  assert.notEqual(k1.get(fuel.id), k0.get(fuel.id), "a surface of the item");
  assert.notEqual(k1.get(water.id), k0.get(water.id), "a surface reached through a reference");
  assert.equal(k1.get(box.id), k0.get(box.id), "unrelated item unchanged");
  box.params.size = [3, 3, 3];
  assert.notEqual(keysOf(s).get(box.id), k1.get(box.id), "the item's own parameters");
  const k2 = keysOf(s);
  s.world.segments = 32;
  assert.notEqual(keysOf(s).get(fuel.id), k2.get(fuel.id), "tessellation settings");
});

test("a universe fill is part of the key", () => {
  const s = new Scene();
  const u = s.add("universe");
  const inner = s.add("cell", {}, u.id);
  s.add("sphere", {}, inner.id);
  const host = s.add("cell", { fill: { type: "universe", universe: u.id } });
  s.add("cube", {}, host.id);
  const k0 = keysOf(s).get(host.id);
  inner.children[0].params.radius = 0.5;
  assert.notEqual(keysOf(s).get(host.id), k0);
});

function memoryStore() {
  const data = new Map();
  return {
    data,
    get bytes() {
      return 0;
    },
    get entries() {
      return data.size;
    },
    async getMany(keys) {
      return new Map(keys.filter((k) => data.has(k)).map((k) => [k, data.get(k)]));
    },
    put(k, parts) {
      data.set(k, structuredClone(parts));
    },
    async clear() {
      data.clear();
    },
  };
}

const finalResult = (service, scene) =>
  new Promise((resolve) => {
    service.onFinal = resolve;
    service.run(scene);
  });

function serviceWith(store) {
  const box = {};
  const service = createEvalService({ workers: 0, store, onUpdate: (res) => !res.partial && box.onFinal?.(res) });
  return Object.assign(box, { run: (scene) => service.run(scene), service });
}

test("built items are saved and served from the store by a new session", async () => {
  const store = memoryStore();
  const { s } = model();
  const first = serviceWith(store);
  const res1 = await finalResult(first, s);
  assert.equal(res1.cached, 0);
  assert.equal(store.data.size, 3, "every item saved");
  const volume = (res) => [...res.parts.values()].flat().reduce((v, p) => v + p.volume, 0);

  // A fresh service (a reload): everything comes from the store, nothing is built.
  const second = serviceWith(store);
  const res2 = await finalResult(second, Scene.fromJSON(JSON.parse(JSON.stringify(s))));
  assert.equal(res2.cached, 3);
  assert.equal(res2.live, 0, "no solid was built");
  assert.ok(Math.abs(volume(res2) - volume(res1)) < 1e-9);
  assert.ok([...res2.parts.values()].flat().every((p) => p.mesh.positions.length > 0));

  // An edit rebuilds only the edited item.
  const t = Scene.fromJSON(JSON.parse(JSON.stringify(s)));
  t.roots[2].params.size = [5, 5, 5];
  const res3 = await finalResult(second, t);
  assert.equal(res3.cached, 2);
  assert.equal(store.data.size, 4);
});
