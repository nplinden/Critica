// 4x4 affine matrices, column-major (same layout as Solid.transform and WebGL).

export const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export const at = (m, row, col) => m[col * 4 + row];

export function multiply(a, b) {
  const r = new Array(16).fill(0);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k];
      r[col * 4 + row] = s;
    }
  return r;
}

export const compose = (...ms) => ms.reduce((acc, m) => multiply(acc, m), IDENTITY);

export const translation = ([x, y, z]) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

export const scaling = ([x, y, z]) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];

/** Right-handed rotation of `degrees` around coordinate axis 0, 1 or 2. */
export function rotationAxis(axis, degrees) {
  const r = (degrees * Math.PI) / 180;
  // Snap exact multiples of 90° so cos/sin give clean 0/±1.
  const quarter = degrees / 90;
  const [c, s] = Number.isInteger(quarter)
    ? [[1, 0], [0, 1], [-1, 0], [0, -1]][((quarter % 4) + 4) % 4]
    : [Math.cos(r), Math.sin(r)];
  if (axis === 0) return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
  if (axis === 1) return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/**
 * Matrix of a node transform `{ position, rotation, scale, order }`.
 * order "xyz" (builder default): scale, then rotate about X, Y, Z, then translate.
 * order "zyx" (OpenMC cell fills): scale, then rotate about Z, Y, X, then translate,
 * which equals OpenMC's universe rotation Rx(φ)·Ry(θ)·Rz(ψ).
 */
export function fromTransform(t) {
  const [rx, ry, rz] = t.rotation;
  const rot =
    t.order === "zyx"
      ? compose(rotationAxis(0, rx), rotationAxis(1, ry), rotationAxis(2, rz))
      : compose(rotationAxis(2, rz), rotationAxis(1, ry), rotationAxis(0, rx));
  return compose(translation(t.position), rot, scaling(t.scale));
}

export function transformPoint(m, [x, y, z]) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

export function transformVector(m, [x, y, z]) {
  return [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
}

/** Inverse of an affine matrix. */
export function invert(m) {
  const a = (r, c) => at(m, r, c);
  const det =
    a(0, 0) * (a(1, 1) * a(2, 2) - a(1, 2) * a(2, 1)) -
    a(0, 1) * (a(1, 0) * a(2, 2) - a(1, 2) * a(2, 0)) +
    a(0, 2) * (a(1, 0) * a(2, 1) - a(1, 1) * a(2, 0));
  if (Math.abs(det) < 1e-300) throw new Error("singular transform");
  const inv3 = [
    [a(1, 1) * a(2, 2) - a(1, 2) * a(2, 1), a(0, 2) * a(2, 1) - a(0, 1) * a(2, 2), a(0, 1) * a(1, 2) - a(0, 2) * a(1, 1)],
    [a(1, 2) * a(2, 0) - a(1, 0) * a(2, 2), a(0, 0) * a(2, 2) - a(0, 2) * a(2, 0), a(0, 2) * a(1, 0) - a(0, 0) * a(1, 2)],
    [a(1, 0) * a(2, 1) - a(1, 1) * a(2, 0), a(0, 1) * a(2, 0) - a(0, 0) * a(2, 1), a(0, 0) * a(1, 1) - a(0, 1) * a(1, 0)],
  ].map((row) => row.map((v) => v / det));
  const t = [a(0, 3), a(1, 3), a(2, 3)];
  const r = new Array(16).fill(0);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) r[col * 4 + row] = inv3[row][col];
    r[12 + row] = -(inv3[row][0] * t[0] + inv3[row][1] * t[1] + inv3[row][2] * t[2]);
  }
  r[15] = 1;
  return r;
}

export function isIdentityMatrix(m, eps = 1e-12) {
  return m.every((v, i) => Math.abs(v - IDENTITY[i]) <= eps);
}

/** Upper-left 3x3 as row-major nested arrays. */
export const linear3 = (m) => [0, 1, 2].map((r) => [0, 1, 2].map((c) => at(m, r, c)));

/**
 * Decomposes a rotation matrix (row-major 3x3) into OpenMC angles (φ, θ, ψ)
 * in degrees such that R = Rx(φ)·Ry(θ)·Rz(ψ).
 */
export function rotationToOpenMCAngles(R) {
  const deg = (r) => (r * 180) / Math.PI;
  const s = Math.max(-1, Math.min(1, R[0][2]));
  const theta = Math.asin(s);
  if (Math.abs(Math.cos(theta)) > 1e-9) {
    return [deg(Math.atan2(-R[1][2], R[2][2])), deg(theta), deg(Math.atan2(-R[0][1], R[0][0]))];
  }
  // Gimbal lock: fold ψ into φ.
  return [deg(Math.atan2(R[2][1], R[1][1])), deg(theta), 0];
}

/** Axis-aligned bounds of a transformed box `{ min, max }`. */
export function transformBox(m, box) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const p = transformPoint(m, [0, 1, 2].map((k) => ((i >> k) & 1 ? box.max[k] : box.min[k])));
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  }
  return { min, max };
}
