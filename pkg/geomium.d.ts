export type Vec3 = [number, number, number];
export type Vec3Like = number | Vec3;

export interface Mesh {
  /** xyz triplets */
  positions: Float32Array;
  /** unit normals, xyz triplets */
  normals: Float32Array;
  /** per-vertex tag set with {@link Solid.tag} (0 by default) */
  tags: Uint32Array;
  /** triangle list, counter-clockwise seen from outside */
  indices: Uint32Array;
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export function init(
  source?: URL | string | Response | BufferSource | WebAssembly.Module,
): Promise<Geomium>;

export class Geomium {
  /** Box. `radius` = half-extents (default 1), or `size` = full extents. */
  cube(opts?: { center?: Vec3Like; radius?: Vec3Like; size?: Vec3Like }): Solid;
  sphere(opts?: { center?: Vec3Like; radius?: number; slices?: number; stacks?: number }): Solid;
  cylinder(opts?: {
    start?: Vec3Like;
    end?: Vec3Like;
    radius?: number;
    radiusEnd?: number;
    slices?: number;
  }): Solid;
  cone(opts?: { start?: Vec3Like; end?: Vec3Like; radius?: number; slices?: number }): Solid;
  torus(opts?: {
    center?: Vec3Like;
    major?: number;
    minor?: number;
    segments?: number;
    rings?: number;
  }): Solid;
  fromMesh(positions: ArrayLike<number>, indices: ArrayLike<number>): Solid;
  union(...solids: (Solid | Solid[])[]): Solid;
  intersect(...solids: (Solid | Solid[])[]): Solid;
  readonly liveCount: number;
}

/** Immutable solid; every operation returns a new Solid. */
export class Solid {
  union(...others: (Solid | Solid[])[]): Solid;
  subtract(...others: (Solid | Solid[])[]): Solid;
  intersect(...others: (Solid | Solid[])[]): Solid;
  inverse(): Solid;
  clone(): Solid;
  translate(v: Vec3): Solid;
  translate(x: number, y?: number, z?: number): Solid;
  rotate(axis: Vec3, degrees: number): Solid;
  rotateX(degrees: number): Solid;
  rotateY(degrees: number): Solid;
  rotateZ(degrees: number): Solid;
  scale(v: Vec3): Solid;
  scale(s: number): Solid;
  scale(x: number, y: number, z?: number): Solid;
  mirror(axis?: "x" | "y" | "z"): Solid;
  /** Column-major 4x4 matrix. */
  transform(matrix: ArrayLike<number>): Solid;
  tag(tag: number): Solid;
  readonly volume: number;
  readonly surfaceArea: number;
  readonly polygonCount: number;
  readonly triangleCount: number;
  readonly isEmpty: boolean;
  readonly bounds: Bounds | null;
  toMesh(): Mesh;
  toSTL(): Uint8Array;
  dispose(): void;
  [Symbol.dispose](): void;
}
