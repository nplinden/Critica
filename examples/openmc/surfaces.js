// OpenMC surface types: coefficients, analytic evaluation, bounding boxes,
// quadric classification, and exact affine transforms with simplification
// back to the most specific surface type.
//
// Sign convention (as in OpenMC): the negative half-space is f(p) < 0.

import { at, invert } from "../mat4.js";

export const SURFACE_TYPES = {
  "x-plane": { coeffs: ["x0"], defaults: [0] },
  "y-plane": { coeffs: ["y0"], defaults: [0] },
  "z-plane": { coeffs: ["z0"], defaults: [0] },
  plane: { coeffs: ["a", "b", "c", "d"], defaults: [0, 0, 1, 0] },
  "x-cylinder": { coeffs: ["y0", "z0", "r"], defaults: [0, 0, 1] },
  "y-cylinder": { coeffs: ["x0", "z0", "r"], defaults: [0, 0, 1] },
  "z-cylinder": { coeffs: ["x0", "y0", "r"], defaults: [0, 0, 1] },
  sphere: { coeffs: ["x0", "y0", "z0", "r"], defaults: [0, 0, 0, 1] },
  "x-cone": { coeffs: ["x0", "y0", "z0", "r2"], defaults: [0, 0, 0, 1] },
  "y-cone": { coeffs: ["x0", "y0", "z0", "r2"], defaults: [0, 0, 0, 1] },
  "z-cone": { coeffs: ["x0", "y0", "z0", "r2"], defaults: [0, 0, 0, 1] },
  quadric: { coeffs: ["a", "b", "c", "d", "e", "f", "g", "h", "j", "k"], defaults: [1, 1, 1, 0, 0, 0, 0, 0, 0, -1] },
  "x-torus": { coeffs: ["x0", "y0", "z0", "a", "b", "c"], defaults: [0, 0, 0, 2, 0.5, 0.5] },
  "y-torus": { coeffs: ["x0", "y0", "z0", "a", "b", "c"], defaults: [0, 0, 0, 2, 0.5, 0.5] },
  "z-torus": { coeffs: ["x0", "y0", "z0", "a", "b", "c"], defaults: [0, 0, 0, 2, 0.5, 0.5] },
};

export const BOUNDARY_TYPES = ["transmission", "vacuum", "reflective", "white", "periodic"];

const AXIS = { x: 0, y: 1, z: 2 };
export const axisOf = (type) => AXIS[type[0]];
export const isPlane = (type) => type.endsWith("plane");
export const isTorus = (type) => type.endsWith("torus");

export function validateSurface(s) {
  const def = SURFACE_TYPES[s.type];
  if (!def) throw new Error(`surface ${s.id}: unsupported type "${s.type}"`);
  if (s.coeffs.length !== def.coeffs.length || s.coeffs.some((c) => !Number.isFinite(c))) {
    throw new Error(`surface ${s.id}: ${s.type} expects ${def.coeffs.length} coefficients, got "${s.coeffs.join(" ")}"`);
  }
}

// ---- evaluation --------------------------------------------------------------

/** f(p) for a surface; negative inside the negative half-space. */
export function evaluate(s, p) {
  const c = s.coeffs;
  switch (s.type) {
    case "x-plane":
    case "y-plane":
    case "z-plane":
      return p[axisOf(s.type)] - c[0];
    case "plane":
      return c[0] * p[0] + c[1] * p[1] + c[2] * p[2] - c[3];
    case "x-cylinder":
      return (p[1] - c[0]) ** 2 + (p[2] - c[1]) ** 2 - c[2] ** 2;
    case "y-cylinder":
      return (p[0] - c[0]) ** 2 + (p[2] - c[1]) ** 2 - c[2] ** 2;
    case "z-cylinder":
      return (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 - c[2] ** 2;
    case "sphere":
      return (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2 - c[3] ** 2;
    case "x-cone":
    case "y-cone":
    case "z-cone": {
      const k = axisOf(s.type);
      const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
      return d[0] ** 2 + d[1] ** 2 + d[2] ** 2 - d[k] ** 2 * (1 + c[3]);
    }
    case "quadric": {
      const [A, B, C, D, E, F, G, H, J, K] = c;
      const [x, y, z] = p;
      return x * (A * x + D * y + G) + y * (B * y + E * z + H) + z * (C * z + F * x + J) + K;
    }
    case "x-torus":
    case "y-torus":
    case "z-torus": {
      const k = axisOf(s.type);
      const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
      const axial = d[k];
      const radial = Math.sqrt(d[0] ** 2 + d[1] ** 2 + d[2] ** 2 - axial ** 2);
      return axial ** 2 / c[4] ** 2 + (radial - c[3]) ** 2 / c[5] ** 2 - 1;
    }
  }
  throw new Error(`unsupported surface type ${s.type}`);
}

// ---- bounding boxes ------------------------------------------------------------

export const infiniteBox = () => ({ min: [-Infinity, -Infinity, -Infinity], max: [Infinity, Infinity, Infinity] });

/** Axis-aligned bounds of a half-space (may contain ±Infinity). */
export function halfspaceBounds(s, sense) {
  const box = infiniteBox();
  const c = s.coeffs;
  const neg = sense === "-";
  if (s.type === "plane") {
    const n = [c[0], c[1], c[2]];
    const nonzero = n.map((v) => Math.abs(v) > 1e-12 * Math.hypot(...n));
    if (nonzero.filter(Boolean).length === 1) {
      const k = nonzero.indexOf(true);
      const x0 = c[3] / n[k];
      // n_k x < d  ⇔  x < x0 when n_k > 0.
      if (neg === n[k] > 0) box.max[k] = x0;
      else box.min[k] = x0;
    }
    return box;
  }
  if (isPlane(s.type)) {
    const k = axisOf(s.type);
    if (neg) box.max[k] = c[0];
    else box.min[k] = c[0];
    return box;
  }
  if (!neg) return box;
  switch (s.type) {
    case "x-cylinder":
    case "y-cylinder":
    case "z-cylinder": {
      const k = axisOf(s.type);
      const [i, j] = [0, 1, 2].filter((a) => a !== k);
      box.min[i] = c[0] - c[2];
      box.max[i] = c[0] + c[2];
      box.min[j] = c[1] - c[2];
      box.max[j] = c[1] + c[2];
      return box;
    }
    case "sphere":
      return { min: [0, 1, 2].map((k) => c[k] - c[3]), max: [0, 1, 2].map((k) => c[k] + c[3]) };
    case "x-torus":
    case "y-torus":
    case "z-torus": {
      const k = axisOf(s.type);
      const ext = [0, 1, 2].map((a) => (a === k ? c[4] : c[3] + c[5]));
      return { min: ext.map((e, a) => c[a] - e), max: ext.map((e, a) => c[a] + e) };
    }
    case "quadric": {
      let q;
      try {
        q = classifyQuadric(c);
      } catch {
        return box;
      }
      if (q.kind !== "ellipsoid" || q.sign < 0) return box;
      const ext = [0, 1, 2].map((i) => Math.hypot(...q.basis[i].map((v, j) => v * q.semi[j])));
      return { min: q.center.map((v, i) => v - ext[i]), max: q.center.map((v, i) => v + ext[i]) };
    }
  }
  return box;
}

// ---- quadric classification ------------------------------------------------------

/** Eigen-decomposition of a symmetric 3x3 (Jacobi). Returns { values, vectors } with vectors as columns. */
export function symmetricEigen(S) {
  const a = S.map((r) => [...r]);
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-300) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p];
        const akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k];
        const aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p];
        const vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: [a[0][0], a[1][1], a[2][2]], vectors: v };
}

const quadricParts = ([A, B, C, D, E, F, G, H, J, K]) => ({
  S: [
    [A, D / 2, F / 2],
    [D / 2, B, E / 2],
    [F / 2, E / 2, C],
  ],
  g: [G, H, J],
  k: K,
});

/**
 * Classifies a general quadric into a shape Critica can mesh:
 *  - ellipsoid: { center, basis (rows = world axes, cols = principal axes), semi[3] }
 *  - cylinder:  elliptic cylinder along principal axis `axis`, semi[] for the other two
 *  - cone:      elliptic double cone with apex `center` along `axis`, slopes in semi[]
 * `sign` is +1 when {f < 0} is the inside of the shape, -1 when it is the outside.
 * Throws for hyperboloids, paraboloids and degenerate quadrics.
 */
export function classifyQuadric(coeffs) {
  const { S, g, k } = quadricParts(coeffs);
  const { values, vectors } = symmetricEigen(S);
  const scale = Math.max(...values.map(Math.abs));
  if (scale === 0) throw new Error("quadric is a plane; use a plane surface");
  const zero = values.map((l) => Math.abs(l) < 1e-10 * scale);
  // Rotate g into the principal frame.
  const gp = [0, 1, 2].map((j) => vectors[0][j] * g[0] + vectors[1][j] * g[1] + vectors[2][j] * g[2]);
  const nz = zero.filter((z) => !z).length;
  const right = (basis) => {
    // Make the principal frame right-handed so it is a proper rotation.
    const c = basis;
    const det =
      c[0][0] * (c[1][1] * c[2][2] - c[1][2] * c[2][1]) -
      c[0][1] * (c[1][0] * c[2][2] - c[1][2] * c[2][0]) +
      c[0][2] * (c[1][0] * c[2][1] - c[1][1] * c[2][0]);
    if (det < 0) for (let i = 0; i < 3; i++) c[i][2] = -c[i][2];
    return c;
  };

  if (nz === 3) {
    const cp = values.map((l, j) => -gp[j] / (2 * l));
    const center = [0, 1, 2].map((i) => vectors[i][0] * cp[0] + vectors[i][1] * cp[1] + vectors[i][2] * cp[2]);
    const kk = k + values.reduce((s, l, j) => s - l * cp[j] ** 2, 0);
    const signs = values.map(Math.sign);
    if (signs.every((s) => s === signs[0])) {
      const s = signs[0];
      if (Math.abs(kk) < 1e-12 * scale || Math.sign(kk) === s) throw new Error("degenerate (imaginary) ellipsoid");
      return { kind: "ellipsoid", center, basis: right(vectors), semi: values.map((l) => Math.sqrt(-kk / l)), sign: s };
    }
    if (Math.abs(kk) < 1e-9 * Math.max(scale, Math.abs(k))) {
      // Cone: the odd-signed eigenvalue gives the axis.
      const pos = signs.filter((s) => s > 0).length;
      const axisSign = pos === 2 ? -1 : 1;
      const axis = signs.indexOf(axisSign);
      const la = Math.abs(values[axis]);
      const semi = values.map((l, j) => (j === axis ? 1 : Math.sqrt(la / Math.abs(l))));
      return { kind: "cone", center, basis: right(vectors), axis, semi, sign: pos === 2 ? 1 : -1 };
    }
    throw new Error("hyperboloids are not supported");
  }
  if (nz === 2) {
    const axis = zero.indexOf(true);
    if (Math.abs(gp[axis]) > 1e-10 * Math.max(scale, ...g.map(Math.abs))) throw new Error("paraboloids are not supported");
    const cp = values.map((l, j) => (j === axis ? 0 : -gp[j] / (2 * l)));
    const center = [0, 1, 2].map((i) => vectors[i][0] * cp[0] + vectors[i][1] * cp[1] + vectors[i][2] * cp[2]);
    const kk = k + values.reduce((s, l, j) => (j === axis ? s : s - l * cp[j] ** 2), 0);
    const others = [0, 1, 2].filter((j) => j !== axis);
    const s = Math.sign(values[others[0]]);
    if (Math.sign(values[others[1]]) !== s) throw new Error("hyperbolic cylinders are not supported");
    if (Math.abs(kk) < 1e-12 * scale || Math.sign(kk) === s) throw new Error("degenerate cylinder");
    const semi = values.map((l, j) => (j === axis ? 1 : Math.sqrt(-kk / l)));
    return { kind: "cylinder", center, basis: right(vectors), axis, semi, sign: s };
  }
  throw new Error("parabolic cylinders and plane pairs are not supported");
}

// ---- forms: exact transforms -----------------------------------------------------

/**
 * Converts a surface to an algebraic form:
 *  { kind: "linear", L: [a, b, c, e] }        f = ax + by + cz + e
 *  { kind: "quadric", Q: 4x4 symmetric }       f = [p 1] Q [p 1]ᵀ
 *  { kind: "torus", axis, center, A, B, C }
 */
export function toForm(s) {
  const c = s.coeffs;
  const quadric = (A, B, C, D, E, F, G, H, J, K) => ({
    kind: "quadric",
    Q: [
      [A, D / 2, F / 2, G / 2],
      [D / 2, B, E / 2, H / 2],
      [F / 2, E / 2, C, J / 2],
      [G / 2, H / 2, J / 2, K],
    ],
  });
  switch (s.type) {
    case "x-plane":
    case "y-plane":
    case "z-plane": {
      const L = [0, 0, 0, -c[0]];
      L[axisOf(s.type)] = 1;
      return { kind: "linear", L };
    }
    case "plane":
      return { kind: "linear", L: [c[0], c[1], c[2], -c[3]] };
    case "sphere": {
      const [x0, y0, z0, r] = c;
      return quadric(1, 1, 1, 0, 0, 0, -2 * x0, -2 * y0, -2 * z0, x0 * x0 + y0 * y0 + z0 * z0 - r * r);
    }
    case "x-cylinder":
    case "y-cylinder":
    case "z-cylinder": {
      const k = axisOf(s.type);
      const center = [0, 0, 0];
      const [i, j] = [0, 1, 2].filter((a) => a !== k);
      center[i] = c[0];
      center[j] = c[1];
      const diag = [1, 1, 1];
      diag[k] = 0;
      const lin = center.map((v, a) => (a === k ? 0 : -2 * v));
      return quadric(...diag, 0, 0, 0, ...lin, center[i] ** 2 + center[j] ** 2 - c[2] ** 2);
    }
    case "x-cone":
    case "y-cone":
    case "z-cone": {
      const k = axisOf(s.type);
      const r2 = c[3];
      const diag = [1, 1, 1];
      diag[k] = -r2;
      const lin = [0, 1, 2].map((a) => -2 * diag[a] * c[a]);
      const K = [0, 1, 2].reduce((acc, a) => acc + diag[a] * c[a] ** 2, 0);
      return quadric(...diag, 0, 0, 0, ...lin, K);
    }
    case "quadric":
      return quadric(...c);
    case "x-torus":
    case "y-torus":
    case "z-torus":
      return { kind: "torus", axis: axisOf(s.type), center: c.slice(0, 3), A: c[3], B: c[4], C: c[5] };
  }
  throw new Error(`unsupported surface type ${s.type}`);
}

/** Applies point transform `m` (column-major 4x4) to a form, keeping f's sign. */
export function transformForm(form, m) {
  if (form.kind === "torus") return transformTorus(form, m);
  const inv = invert(m);
  if (form.kind === "linear") {
    return { kind: "linear", L: [0, 1, 2, 3].map((col) => [0, 1, 2, 3].reduce((s, r) => s + form.L[r] * at(inv, r, col), 0)) };
  }
  // Q' = Minvᵀ Q Minv
  const Mi = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => at(inv, r, c)));
  const QM = form.Q.map((row) => [0, 1, 2, 3].map((c) => row.reduce((s, q, k) => s + q * Mi[k][c], 0)));
  const Q = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => [0, 1, 2, 3].reduce((s, k) => s + Mi[k][r] * QM[k][c], 0)));
  return { kind: "quadric", Q };
}

function transformTorus(form, m) {
  const J = [0, 1, 2].map((r) => [0, 1, 2].map((c) => at(m, r, c)));
  const a = [0, 0, 0];
  a[form.axis] = 1;
  const ja = J.map((row) => row[form.axis]);
  const sa = Math.hypot(...ja);
  const newAxis = ja.map((v) => Math.abs(v) / sa).findIndex((v) => Math.abs(v - 1) < 1e-9);
  // Radial scale: J must act as a similarity in the plane ⊥ axis.
  const others = [0, 1, 2].filter((k) => k !== form.axis);
  const u = J.map((row) => row[others[0]]);
  const v = J.map((row) => row[others[1]]);
  const su = Math.hypot(...u);
  const sv = Math.hypot(...v);
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const ok =
    newAxis >= 0 &&
    Math.abs(su - sv) < 1e-9 * su &&
    Math.abs(dot(u, v)) < 1e-9 * su * sv &&
    Math.abs(dot(u, ja)) < 1e-9 * su * sa &&
    Math.abs(dot(v, ja)) < 1e-9 * sv * sa;
  if (!ok) throw new Error("OpenMC tori must stay aligned with x, y or z and keep a circular cross-section in the radial plane");
  const center = [0, 1, 2].map((r) => J[r].reduce((s, q, k) => s + q * form.center[k], at(m, r, 3)));
  return { kind: "torus", axis: newAxis, center, A: form.A * su, B: form.B * sa, C: form.C * su };
}

// ---- canonicalization --------------------------------------------------------------

/** Rounds to 12 significant digits and flushes values tiny relative to `scale` to 0. */
export function clean(v, scale = 1) {
  if (Math.abs(v) <= 1e-12 * Math.max(scale, 1e-300)) return 0;
  const r = Number(v.toPrecision(12));
  return Object.is(r, -0) ? 0 : r;
}

/**
 * Converts a form to the most specific OpenMC surface.
 * Returns { type, coeffs, flip } where `flip` means the half-space senses swap
 * (the canonical f is a negative multiple of the form's f).
 */
export function fromForm(form) {
  if (form.kind === "torus") {
    const s = Math.max(Math.abs(form.A), ...form.center.map(Math.abs));
    return { type: `${"xyz"[form.axis]}-torus`, coeffs: [...form.center, form.A, form.B, form.C].map((v) => clean(v, s)), flip: false };
  }
  if (form.kind === "linear") {
    const [a, b, c, e] = form.L;
    const n = Math.hypot(a, b, c);
    if (n === 0) throw new Error("degenerate plane");
    const comps = [a, b, c].map((v) => (Math.abs(v) > 1e-12 * n ? v : 0));
    const nonzero = comps.filter((v) => v !== 0);
    if (nonzero.length === 1) {
      const k = comps.findIndex((v) => v !== 0);
      const x0 = -e / comps[k];
      return { type: `${"xyz"[k]}-plane`, coeffs: [clean(x0, Math.abs(x0))], flip: comps[k] < 0 };
    }
    const d = -e / n;
    return { type: "plane", coeffs: [...comps.map((v) => clean(v / n, 1)), clean(d, Math.abs(d))], flip: false };
  }

  const Q = form.Q;
  const S = [0, 1, 2].map((r) => [0, 1, 2].map((c) => Q[r][c]));
  const g = [0, 1, 2].map((i) => 2 * Q[i][3]);
  const k = Q[3][3];
  const scale = Math.max(...S.flat().map(Math.abs));
  const tol = 1e-9 * scale;
  const diag = [S[0][0], S[1][1], S[2][2]];
  const offDiag = Math.abs(S[0][1]) + Math.abs(S[0][2]) + Math.abs(S[1][2]);
  if (scale > 0 && offDiag < tol) {
    // Sphere: equal diagonal.
    if (Math.abs(diag[0] - diag[1]) < tol && Math.abs(diag[1] - diag[2]) < tol) {
      const s = diag[0];
      const c = g.map((v) => -v / (2 * s));
      const r2 = c.reduce((acc, v) => acc + v * v, 0) - k / s;
      if (r2 > 0) {
        const r = Math.sqrt(r2);
        return { type: "sphere", coeffs: [...c.map((v) => clean(v, r)), clean(r, r)], flip: s < 0 };
      }
    }
    for (let ax = 0; ax < 3; ax++) {
      const [i, j] = [0, 1, 2].filter((a) => a !== ax);
      if (Math.abs(diag[i] - diag[j]) > tol) continue;
      const s = diag[i];
      // Cylinder: zero axial term and no linear axial term.
      if (Math.abs(diag[ax]) < tol && Math.abs(g[ax]) < 1e-9 * Math.max(scale, ...g.map(Math.abs))) {
        const ci = -g[i] / (2 * s);
        const cj = -g[j] / (2 * s);
        const r2 = ci * ci + cj * cj - k / s;
        if (r2 > 0) {
          const r = Math.sqrt(r2);
          return { type: `${"xyz"[ax]}-cylinder`, coeffs: [clean(ci, r), clean(cj, r), clean(r, r)], flip: s < 0 };
        }
      }
      // Cone: axial term of opposite sign and no constant remainder.
      const r2 = -diag[ax] / s;
      if (r2 > 0) {
        const c = g.map((v, a) => -v / (2 * diag[a]));
        const rem = k - c.reduce((acc, v, a) => acc + diag[a] * v * v, 0);
        const ref = Math.abs(k) + c.reduce((acc, v, a) => acc + Math.abs(diag[a] * v * v), 0);
        if (Math.abs(rem) <= 1e-9 * Math.max(ref, scale)) {
          const sc = Math.max(1, ...c.map(Math.abs));
          return { type: `${"xyz"[ax]}-cone`, coeffs: [...c.map((v) => clean(v, sc)), clean(r2, r2)], flip: s < 0 };
        }
      }
    }
  }
  const coeffs = [Q[0][0], Q[1][1], Q[2][2], 2 * Q[0][1], 2 * Q[1][2], 2 * Q[0][2], ...g, k];
  const norm = Math.max(...coeffs.map(Math.abs));
  return { type: "quadric", coeffs: coeffs.map((v) => clean(v / norm, 1)), flip: false };
}

/** Transforms a surface by `m`, returning { type, coeffs, flip }. */
export function transformSurface(s, m) {
  return fromForm(transformForm(toForm(s), m));
}
