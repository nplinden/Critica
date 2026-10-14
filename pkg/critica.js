// critica — JavaScript bindings for the CSG WebAssembly module.
//
// Usage:
//   import { init } from "critica";
//   const geo = await init();
//   const part = geo.cube({ radius: 1 }).subtract(geo.sphere({ radius: 1.3 }));
//   const { positions, normals, indices } = part.toMesh();

const MESH_POSITIONS = 0;
const MESH_NORMALS = 1;
const MESH_TAGS = 2;
const MESH_INDICES = 3;

const vec3 = (v, fallback) => {
  if (v === undefined) return fallback;
  if (typeof v === "number") return [v, v, v];
  if (v.length !== 3) throw new TypeError(`expected a number or [x, y, z], got ${v}`);
  return v;
};

async function loadBytes(source) {
  if (source instanceof WebAssembly.Module) return source;
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) return source;
  if (typeof Response !== "undefined" && source instanceof Response) {
    return source.arrayBuffer();
  }
  const url = source instanceof URL ? source : new URL(source, import.meta.url);
  if (url.protocol === "file:") {
    const { readFile } = await import("node:fs/promises");
    return readFile(url);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`);
  return res.arrayBuffer();
}

/**
 * Loads the WebAssembly module and returns a {@link Critica} instance.
 * @param {URL|string|Response|BufferSource|WebAssembly.Module} [source]
 *   Where to load `critica.wasm` from; defaults to the file next to this one.
 */
export async function init(source = new URL("./critica.wasm", import.meta.url)) {
  const bytes = await loadBytes(source);
  const { instance } =
    bytes instanceof WebAssembly.Module
      ? { instance: await WebAssembly.instantiate(bytes, {}) }
      : await WebAssembly.instantiate(bytes, {});
  return new Critica(instance.exports);
}

export class Critica {
  #wasm;
  #registry;

  constructor(exports) {
    this.#wasm = exports;
    // Free solids that become unreachable without an explicit dispose().
    this.#registry = new FinalizationRegistry((handle) => exports.geo_free(handle));
  }

  /** @internal Wraps a raw handle, throwing on failure. */
  _wrap(handle) {
    if (handle === 0) throw new Error("critica: operation on a disposed or invalid solid");
    const solid = new Solid(this, handle);
    this.#registry.register(solid, handle, solid);
    return solid;
  }

  /** @internal */
  _release(solid) {
    this.#registry.unregister(solid);
    this.#wasm.geo_free(solid._handle);
  }

  /** @internal */
  get _wasm() {
    return this.#wasm;
  }

  /** @internal Copies `data` into wasm memory, runs `fn(ptr)`, then frees it. */
  _withBuffer(data, fn) {
    const w = this.#wasm;
    const ptr = w.geo_alloc(data.byteLength);
    try {
      new Uint8Array(w.memory.buffer, ptr, data.byteLength).set(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
      return fn(ptr);
    } finally {
      w.geo_dealloc(ptr, data.byteLength);
    }
  }

  /** Box centered at `center`. Give half-extents with `radius` or full extents with `size`. */
  cube({ center, radius, size } = {}) {
    const [cx, cy, cz] = vec3(center, [0, 0, 0]);
    const r = size !== undefined ? vec3(size).map((s) => s / 2) : vec3(radius, [1, 1, 1]);
    return this._wrap(this.#wasm.geo_cube(cx, cy, cz, r[0], r[1], r[2]));
  }

  /** UV sphere (Y-up). */
  sphere({ center, radius = 1, slices = 32, stacks = 16 } = {}) {
    const [cx, cy, cz] = vec3(center, [0, 0, 0]);
    return this._wrap(this.#wasm.geo_sphere(cx, cy, cz, radius, slices, stacks));
  }

  /** Cylinder from `start` to `end`. Set `radiusEnd` for a truncated cone. */
  cylinder({ start, end, radius = 1, radiusEnd = radius, slices = 32 } = {}) {
    const s = vec3(start, [0, -1, 0]);
    const e = vec3(end, [0, 1, 0]);
    return this._wrap(
      this.#wasm.geo_cylinder(s[0], s[1], s[2], e[0], e[1], e[2], radius, radiusEnd, slices),
    );
  }

  /**
   * Annular tube between `start` and `end` (a plain cylinder when
   * `innerRadius` is 0), with the ring vertices of `cylinder`. `tags` labels
   * the faces: { outer, inner, start, end }.
   */
  tube({ start, end, innerRadius = 0, radius = 1, slices = 32, tags = {} } = {}) {
    const s = vec3(start, [0, -1, 0]);
    const e = vec3(end, [0, 1, 0]);
    const t = (k) => (tags[k] ?? 0) >>> 0;
    return this._wrap(this.#wasm.geo_tube(s[0], s[1], s[2], e[0], e[1], e[2], innerRadius, radius, slices, t("outer"), t("inner"), t("start"), t("end")));
  }

  /** Cone with its base at `start` and apex at `end`. */
  cone({ start, end, radius = 1, slices = 32 } = {}) {
    return this.cylinder({ start, end, radius, radiusEnd: 0, slices });
  }

  /** Torus around the Y axis. */
  torus({ center, major = 1, minor = 0.25, segments = 48, rings = 24 } = {}) {
    const [cx, cy, cz] = vec3(center, [0, 0, 0]);
    return this._wrap(this.#wasm.geo_torus(cx, cy, cz, major, minor, segments, rings));
  }

  /**
   * Imports a closed, outward-wound (CCW) indexed triangle mesh.
   * @param {ArrayLike<number>} positions xyz triplets
   * @param {ArrayLike<number>} indices triangle vertex indices
   */
  fromMesh(positions, indices) {
    const pos = Float64Array.from(positions);
    const idx = Uint32Array.from(indices);
    return this._withBuffer(pos, (pp) =>
      this._withBuffer(idx, (ip) =>
        this._wrap(this.#wasm.geo_from_triangles(pp, pos.length, ip, idx.length)),
      ),
    );
  }

  /** Union of all given solids. */
  union(...solids) {
    return reduce(solids, "union");
  }

  /** Intersection of all given solids. */
  intersect(...solids) {
    return reduce(solids, "intersect");
  }

  /** Number of solids currently alive in wasm memory. */
  get liveCount() {
    return this.#wasm.geo_live_count();
  }
}

function reduce(solids, op) {
  const list = solids.flat();
  if (list.length === 0) throw new Error(`critica: ${op} needs at least one solid`);
  return list[0][op](...list.slice(1));
}

/** Immutable solid. Every operation returns a new Solid. */
export class Solid {
  #geo;
  #handle;

  constructor(geo, handle) {
    this.#geo = geo;
    this.#handle = handle;
  }

  /** @internal */
  get _handle() {
    if (this.#handle === 0) throw new Error("critica: solid was disposed");
    return this.#handle;
  }

  get #w() {
    return this.#geo._wasm;
  }

  #binary(fn, others) {
    let acc = this;
    for (const other of others.flat()) {
      const next = this.#geo._wrap(fn(acc._handle, other._handle));
      if (acc !== this) acc.dispose();
      acc = next;
    }
    return acc === this ? this.clone() : acc;
  }

  union(...others) {
    return this.#binary(this.#w.geo_union, others);
  }

  subtract(...others) {
    return this.#binary(this.#w.geo_subtract, others);
  }

  intersect(...others) {
    return this.#binary(this.#w.geo_intersect, others);
  }

  /** All polygons of this and `others`, without booleans: only for boundaries that do not cross. */
  merge(...others) {
    return this.#binary(this.#w.geo_merge, others);
  }

  /** Swaps inside and outside. */
  inverse() {
    return this.#geo._wrap(this.#w.geo_inverse(this._handle));
  }

  clone() {
    return this.#geo._wrap(this.#w.geo_clone(this._handle));
  }

  /** translate(x, y, z) or translate([x, y, z]) */
  translate(x, y, z) {
    const t = Array.isArray(x) ? x : [x ?? 0, y ?? 0, z ?? 0];
    return this.#geo._wrap(this.#w.geo_translate(this._handle, t[0], t[1], t[2]));
  }

  /** Rotates `degrees` around `axis` through the origin. */
  rotate(axis, degrees) {
    const [x, y, z] = vec3(axis);
    return this.#geo._wrap(this.#w.geo_rotate(this._handle, x, y, z, degrees));
  }

  rotateX(degrees) {
    return this.rotate([1, 0, 0], degrees);
  }

  rotateY(degrees) {
    return this.rotate([0, 1, 0], degrees);
  }

  rotateZ(degrees) {
    return this.rotate([0, 0, 1], degrees);
  }

  /** scale(s), scale(x, y, z) or scale([x, y, z]) */
  scale(x, y, z) {
    const s = Array.isArray(x) ? x : y === undefined ? [x, x, x] : [x, y, z ?? 1];
    return this.#geo._wrap(this.#w.geo_scale(this._handle, s[0], s[1], s[2]));
  }

  /** Mirrors across the plane through the origin with the given normal axis ("x", "y" or "z"). */
  mirror(axis = "x") {
    const s = { x: [-1, 1, 1], y: [1, -1, 1], z: [1, 1, -1] }[axis];
    if (!s) throw new TypeError(`critica: mirror axis must be "x", "y" or "z"`);
    return this.scale(s);
  }

  /** Applies a column-major 4x4 matrix (e.g. three.js `Matrix4.elements`). */
  transform(matrix) {
    const m = Float64Array.from(matrix);
    if (m.length !== 16) throw new TypeError("critica: transform expects 16 numbers");
    return this.#geo._withBuffer(m, (ptr) =>
      this.#geo._wrap(this.#w.geo_transform(this._handle, ptr)),
    );
  }

  /** Returns a copy whose polygons all carry `tag` (exported per vertex in toMesh().tags). */
  tag(tag) {
    return this.#geo._wrap(this.#w.geo_tag(this._handle, tag >>> 0));
  }

  get volume() {
    return this.#w.geo_volume(this._handle);
  }

  get surfaceArea() {
    return this.#w.geo_surface_area(this._handle);
  }

  get polygonCount() {
    return this.#w.geo_polygon_count(this._handle);
  }

  get triangleCount() {
    return this.#w.geo_triangle_count(this._handle);
  }

  get isEmpty() {
    return this.polygonCount === 0;
  }

  /** `{ min: [x, y, z], max: [x, y, z] }`, or `null` for an empty solid. */
  get bounds() {
    const out = new Float64Array(6);
    let ok = 0;
    this.#geo._withBuffer(out, (ptr) => {
      ok = this.#w.geo_bounds(this._handle, ptr);
      out.set(new Float64Array(this.#w.memory.buffer, ptr, 6));
    });
    return ok ? { min: [...out.subarray(0, 3)], max: [...out.subarray(3)] } : null;
  }

  /**
   * Triangulated, GPU-ready buffers (copies, safe to keep).
   * @returns {{positions: Float32Array, normals: Float32Array, tags: Uint32Array, indices: Uint32Array}}
   */
  toMesh() {
    const w = this.#w;
    w.geo_mesh(this._handle);
    // Read the memory buffer only after the call: wasm memory may have grown.
    const view = (Kind, kind) =>
      new Kind(w.memory.buffer, w.geo_mesh_ptr(kind), w.geo_mesh_len(kind)).slice();
    return {
      positions: view(Float32Array, MESH_POSITIONS),
      normals: view(Float32Array, MESH_NORMALS),
      tags: view(Uint32Array, MESH_TAGS),
      indices: view(Uint32Array, MESH_INDICES),
    };
  }

  /** Binary STL file contents. */
  toSTL() {
    const w = this.#w;
    const len = w.geo_stl(this._handle);
    return new Uint8Array(w.memory.buffer, w.geo_bytes_ptr(), len).slice();
  }

  /** Frees the solid's wasm memory now. Further use throws. */
  dispose() {
    if (this.#handle !== 0) {
      this.#geo._release(this);
      this.#handle = 0;
    }
  }

  [Symbol.dispose]() {
    this.dispose();
  }
}
