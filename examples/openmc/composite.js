// OpenMC composite surfaces (openmc/model/surface_composite.py).
//
// In OpenMC these are Python-only helpers: each builds several primitive
// surfaces and defines its negative side as a region over them; geometry.xml
// only ever contains the primitives. Here a composite is a parametric node that
// expands on demand into
//   { surfaces: [{ type, coeffs, boundary?, albedo?, periodic? (index) }],
//     region:   AST over surface indices (the negative side, "inside") }
// The positive side is the complement, as in OpenMC's default `__pos__`.
// Constructions follow the OpenMC source literally (including plane normal
// conventions) so expanded surfaces match what the Python API writes.

import { evaluate, toForm, transformForm } from "./surfaces.js";
import * as M4 from "../mat4.js";

const SQRT2 = Math.SQRT2;
const SQRT3 = Math.sqrt(3);
const AXES = ["x", "y", "z"];

const BC_NO_PERIODIC = ["transmission", "vacuum", "reflective", "white"];
const BC_ALL = [...BC_NO_PERIODIC, "periodic"];

/**
 * Parameter kinds: number, vec2, vec3, axis, orientation, bool, basis,
 * numbers (list), points (list of 2D points), boundary.
 */
export const COMPOSITE_TYPES = {
  "cylinder-sector": {
    label: "Cylinder sector",
    openmc: "CylinderSector",
    description: "Annular sector between two concentric cylinders and two planes (infinite along the axis).",
    params: [
      { name: "r1", kind: "number", default: 0.5, min: 0, label: "Inner radius" },
      { name: "r2", kind: "number", default: 1, min: 0, label: "Outer radius" },
      { name: "theta1", kind: "number", default: 0, step: 5, label: "θ₁ (°)" },
      { name: "theta2", kind: "number", default: 90, step: 5, label: "θ₂ (°)" },
      { name: "center", kind: "vec2", default: [0, 0], label: "Center" },
      { name: "axis", kind: "axis", default: "z", label: "Axis" },
      { name: "boundary", kind: "boundary", default: "transmission", options: BC_NO_PERIODIC },
    ],
  },
  "isogonal-octagon": {
    label: "Isogonal octagon",
    openmc: "IsogonalOctagon",
    description: "Octagonal prism with axis-parallel and 45° faces (infinite along the axis).",
    params: [
      { name: "center", kind: "vec2", default: [0, 0], label: "Center" },
      { name: "r1", kind: "number", default: 1, min: 0, label: "Half-width (flat)" },
      { name: "r2", kind: "number", default: 1.1, min: 0, label: "Half-width (45°)" },
      { name: "axis", kind: "axis", default: "z", label: "Axis" },
      { name: "boundary", kind: "boundary", default: "transmission", options: BC_NO_PERIODIC },
    ],
  },
  rcc: {
    label: "Right circular cylinder",
    openmc: "RightCircularCylinder",
    description: "Finite cylinder (MCNP RCC), optionally with filleted edges.",
    params: [
      { name: "center_base", kind: "vec3", default: [0, 0, -1], label: "Base center" },
      { name: "height", kind: "number", default: 2, min: 0, label: "Height" },
      { name: "radius", kind: "number", default: 1, min: 0, label: "Radius" },
      { name: "axis", kind: "axis", default: "z", label: "Axis" },
      { name: "upper_fillet_radius", kind: "number", default: 0, min: 0, step: 0.05, label: "Upper fillet" },
      { name: "lower_fillet_radius", kind: "number", default: 0, min: 0, step: 0.05, label: "Lower fillet" },
      { name: "boundary", kind: "boundary", default: "transmission", options: BC_NO_PERIODIC },
    ],
  },
  rpp: {
    label: "Rectangular parallelepiped",
    openmc: "RectangularParallelepiped",
    description: "Axis-aligned box from six planes (MCNP RPP).",
    params: [
      { name: "min", kind: "vec3", default: [-1, -1, -1], label: "Min" },
      { name: "max", kind: "vec3", default: [1, 1, 1], label: "Max" },
      { name: "boundary", kind: "boundary", default: "transmission", options: BC_NO_PERIODIC },
    ],
  },
  "orthogonal-box": {
    label: "Orthogonal box",
    openmc: "OrthogonalBox",
    description: "Arbitrarily oriented box from a corner and edge vectors (MCNP BOX).",
    params: [
      { name: "v", kind: "vec3", default: [-1, -1, -1], label: "Corner" },
      { name: "a1", kind: "vec3", default: [2, 0, 0], label: "Edge a₁" },
      { name: "a2", kind: "vec3", default: [0, 2, 0], label: "Edge a₂" },
      { name: "a3", kind: "vec3", default: [0, 0, 2], label: "Edge a₃" },
      { name: "finite", kind: "bool", default: true, label: "Use a₃", title: "When off, the box is infinite along a₁ × a₂" },
      { name: "boundary", kind: "boundary", default: "transmission", options: BC_NO_PERIODIC },
    ],
  },
  "cone-one-sided": {
    label: "One-sided cone",
    openmc: "XConeOneSided / YConeOneSided / ZConeOneSided",
    description: "A single nappe of a cone, selected with a disambiguation plane through the apex.",
    params: [
      { name: "apex", kind: "vec3", default: [0, 0, 0], label: "Apex" },
      { name: "r2", kind: "number", default: 0.25, min: 0, step: 0.05, label: "Slope² (r/h)²" },
      { name: "up", kind: "bool", default: true, label: "Up", title: "Keep the nappe extending toward +axis" },
      { name: "axis", kind: "axis", default: "z", label: "Axis" },
      { name: "boundary", kind: "boundary", default: "transmission", options: BC_NO_PERIODIC },
    ],
  },
  polygon: {
    label: "Polygon",
    openmc: "Polygon",
    description: "Prism (xy, yz, xz) or solid of revolution (rz) from a closed 2D outline.",
    params: [
      { name: "points", kind: "points", default: [[-1, -1], [1, -1], [1, 1], [0, 0.2], [-1, 1]], label: "Points" },
      { name: "basis", kind: "basis", default: "xy", label: "Basis" },
      { name: "boundary", kind: "boundary", default: "transmission", options: BC_NO_PERIODIC },
    ],
  },
  "cruciform-prism": {
    label: "Cruciform prism",
    openmc: "CruciformPrism",
    description: "Stepped cross from nested square half-widths (Serpent gcross).",
    params: [
      { name: "distances", kind: "numbers", default: [1, 0.4], label: "Distances", title: "Monotonic, positive half-widths" },
      { name: "center", kind: "vec2", default: [0, 0], label: "Center" },
      { name: "axis", kind: "axis", default: "z", label: "Axis" },
      { name: "boundary", kind: "boundary", default: "transmission", options: BC_NO_PERIODIC },
    ],
  },
  "rectangular-prism": {
    label: "Rectangular prism",
    openmc: "RectangularPrism",
    description: "Infinite rectangular prism, optionally with rounded corners.",
    params: [
      { name: "width", kind: "number", default: 2, min: 0, label: "Width" },
      { name: "height", kind: "number", default: 1, min: 0, label: "Height" },
      { name: "axis", kind: "axis", default: "z", label: "Axis" },
      { name: "origin", kind: "vec2", default: [0, 0], label: "Origin" },
      { name: "corner_radius", kind: "number", default: 0, min: 0, step: 0.05, label: "Corner radius" },
      { name: "boundary", kind: "boundary", default: "transmission", options: BC_ALL },
      { name: "albedo", kind: "number", default: 1, min: 0, step: 0.05, label: "Albedo" },
    ],
  },
  "hexagonal-prism": {
    label: "Hexagonal prism",
    openmc: "HexagonalPrism",
    description: "Infinite hexagonal prism along z, optionally with rounded corners.",
    params: [
      { name: "edge_length", kind: "number", default: 1, min: 0, label: "Edge length" },
      { name: "orientation", kind: "orientation", default: "y", label: "Orientation" },
      { name: "origin", kind: "vec2", default: [0, 0], label: "Origin" },
      { name: "corner_radius", kind: "number", default: 0, min: 0, step: 0.05, label: "Corner radius" },
      { name: "boundary", kind: "boundary", default: "transmission", options: BC_ALL },
      { name: "albedo", kind: "number", default: 1, min: 0, step: 0.05, label: "Albedo" },
    ],
  },
  "conical-frustum": {
    label: "Conical frustum",
    openmc: "ConicalFrustum",
    description: "Truncated cone along any axis (MCNP TRC).",
    params: [
      { name: "center_base", kind: "vec3", default: [0, 0, -1], label: "Base center" },
      { name: "axis", kind: "vec3", default: [0, 0, 2], label: "Axis vector" },
      { name: "r1", kind: "number", default: 1, min: 0, label: "Base radius" },
      { name: "r2", kind: "number", default: 0.5, min: 0, label: "Top radius" },
      { name: "boundary", kind: "boundary", default: "transmission", options: BC_NO_PERIODIC },
    ],
  },
  vessel: {
    label: "Vessel",
    openmc: "Vessel",
    description: "Cylinder with semi-ellipsoidal heads (Serpent vessel).",
    params: [
      { name: "r", kind: "number", default: 1, min: 0, label: "Radius" },
      { name: "p1", kind: "number", default: -1, label: "Cylinder min" },
      { name: "p2", kind: "number", default: 1, label: "Cylinder max" },
      { name: "h1", kind: "number", default: 0.5, min: 0, label: "Bottom head" },
      { name: "h2", kind: "number", default: 0.5, min: 0, label: "Top head" },
      { name: "center", kind: "vec2", default: [0, 0], label: "Center" },
      { name: "axis", kind: "axis", default: "z", label: "Axis" },
      { name: "boundary", kind: "boundary", default: "transmission", options: BC_NO_PERIODIC },
    ],
  },
};

export function defaultCompositeParams(type) {
  const def = COMPOSITE_TYPES[type];
  if (!def) throw new Error(`unknown composite type ${type}`);
  return Object.fromEntries(def.params.map((p) => [p.name, JSON.parse(JSON.stringify(p.default))]));
}

// ---- region helpers -------------------------------------------------------------

const neg = (i) => ({ op: "half", surface: i, sense: "-" });
const pos = (i) => ({ op: "half", surface: i, sense: "+" });
const and = (...args) => ({ op: "and", args: args.flat() });
const or = (...args) => ({ op: "or", args: args.flat() });
const not = (arg) => ({ op: "not", arg });

/** Collects surfaces; identical surfaces (same type, coeffs, boundary) share an index. */
class Builder {
  constructor() {
    this.surfaces = [];
    this.keys = new Map();
  }
  add(type, coeffs, extra = {}) {
    const s = { type, coeffs: coeffs.map((v) => (Object.is(v, -0) ? 0 : v)), ...extra };
    const key = JSON.stringify([s.type, s.coeffs, s.boundary ?? "", s.albedo ?? ""]);
    if (this.keys.has(key)) return this.keys.get(key);
    this.surfaces.push(s);
    this.keys.set(key, this.surfaces.length - 1);
    return this.surfaces.length - 1;
  }
}

const sub = (a, b) => a.map((v, i) => v - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** openmc.Plane.from_points: n = (p2 − p1) × (p3 − p1), d = n·p1. */
function planeFromPoints(p1, p2, p3) {
  const n = cross(sub(p2, p1), sub(p3, p1));
  if (Math.hypot(...n) < 1e-14) throw new Error("plane points are collinear");
  return [...n, dot(n, p1)];
}

const flipped = (coeffs) => coeffs.map((v) => -v);

/** Boundary options for component surfaces. */
function bcOf(p) {
  const out = {};
  if (p.boundary && p.boundary !== "transmission") out.boundary = p.boundary;
  if (p.albedo !== undefined && p.albedo !== 1 && out.boundary) out.albedo = p.albedo;
  return out;
}

const check = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const isAxis = (a) => AXES.includes(a);

// ---- expansion ------------------------------------------------------------------

/** Expands a composite into surfaces and the region of its negative side. */
export function expandComposite(type, params) {
  const p = { ...defaultCompositeParams(type), ...params };
  const b = new Builder();
  const region = EXPANDERS[type](p, b);
  return { surfaces: b.surfaces, region };
}

const EXPANDERS = {
  "cylinder-sector"(p, b) {
    const { r1, r2, theta1, theta2, center, axis } = p;
    check(isAxis(axis), "axis must be x, y or z");
    check(r2 > r1, "r2 must be greater than r1");
    check(theta2 > theta1, "θ₂ must be greater than θ₁");
    const reflex = theta2 - theta1 > 180;
    const phi1 = (Math.PI / 180) * theta1;
    const phi2 = (Math.PI / 180) * theta2;
    const [c0, c1] = center;
    const pts = [
      [c0, c1, 1],
      [r1 * Math.cos(phi1) + c0, r1 * Math.sin(phi1) + c1, 0],
      [r2 * Math.cos(phi1) + c0, r2 * Math.sin(phi1) + c1, 0],
      [r1 * Math.cos(phi2) + c0, r1 * Math.sin(phi2) + c1, 0],
      [r2 * Math.cos(phi2) + c0, r2 * Math.sin(phi2) + c1, 0],
    ];
    const map = { z: [0, 1, 2], y: [0, 2, 1], x: [2, 0, 1] }[axis];
    const q = pts.map((pt) => map.map((i) => pt[i]));
    const bc = bcOf(p);
    const outer = b.add(`${axis}-cylinder`, [c0, c1, r2], bc);
    const inner = b.add(`${axis}-cylinder`, [c0, c1, r1], bc);
    let pl1 = planeFromPoints(q[0], q[1], q[2]);
    let pl2 = planeFromPoints(q[0], q[3], q[4]);
    if (axis === "y") {
      pl1 = flipped(pl1);
      pl2 = flipped(pl2);
    }
    const plane1 = b.add("plane", pl1, bc);
    const plane2 = b.add("plane", pl2, bc);
    return reflex ? and(neg(outer), pos(inner), or(neg(plane1), pos(plane2))) : and(neg(outer), pos(inner), neg(plane1), pos(plane2));
  },

  "isogonal-octagon"(p, b) {
    const { center, r1, r2, axis } = p;
    check(isAxis(axis), "axis must be x, y or z");
    check(!(r2 > r1 * SQRT2), "r2 is greater than √2·r1; the octagon would be malformed");
    check(!(r1 > r2 * SQRT2), "r1 is greater than √2·r2; the octagon would be malformed");
    const [c1, c2] = center;
    const bc = bcOf(p);
    const [tb, lr] = { z: ["y", "x"], y: ["z", "x"], x: ["z", "y"] }[axis];
    const top = b.add(`${tb}-plane`, [c2 + r1], bc);
    const bottom = b.add(`${tb}-plane`, [c2 - r1], bc);
    const right = b.add(`${lr}-plane`, [c1 + r1], bc);
    const left = b.add(`${lr}-plane`, [c1 - r1], bc);
    const L = r2 * SQRT2 - r1;
    const ur = [[L, r1, 0], [r1, L, 0], [r1, L, 1]];
    const lrp = [[r1, -L, 0], [L, -r1, 0], [L, -r1, 1]];
    const ll = ur.map((pt) => pt.map((v) => -v));
    const ul = lrp.map((pt) => pt.map((v) => -v));
    const map = { z: [0, 1, 2], y: [0, 2, 1], x: [2, 0, 1] }[axis];
    const place = (pts) => pts.map((pt) => {
      const o = [pt[0] + c1, pt[1] + c2, pt[2]];
      return map.map((i) => o[i]);
    });
    const upperRight = b.add("plane", planeFromPoints(...place(ur)), bc);
    const lowerRight = b.add("plane", planeFromPoints(...place(lrp)), bc);
    const lowerLeft = b.add("plane", planeFromPoints(...place(ll)), bc);
    const upperLeft = b.add("plane", planeFromPoints(...place(ul)), bc);
    const sides = [neg(top), pos(bottom), neg(right), pos(left)];
    return axis === "y"
      ? and(sides, neg(upperRight), neg(lowerRight), pos(lowerLeft), pos(upperLeft))
      : and(sides, pos(upperRight), pos(lowerRight), neg(lowerLeft), neg(upperLeft));
  },

  rcc(p, b) {
    const { center_base: cb, height: h, radius: r, axis } = p;
    check(isAxis(axis), "axis must be x, y or z");
    check(h > 0, "height must be positive");
    check(r > 0, "radius must be positive");
    check(p.upper_fillet_radius <= r && p.lower_fillet_radius <= r, "fillet radii cannot exceed the radius");
    check(!((p.upper_fillet_radius > 0 || p.lower_fillet_radius > 0) && p.boundary === "periodic"), "periodic boundaries are not allowed with fillets");
    const ax = AXES.indexOf(axis);
    const [i1, i2] = [0, 1, 2].filter((k) => k !== ax);
    const bc = bcOf(p);
    const cyl = b.add(`${axis}-cylinder`, [cb[i1], cb[i2], r], bc);
    const bottom = b.add(`${axis}-plane`, [cb[ax]], bc);
    const top = b.add(`${axis}-plane`, [cb[ax] + h], bc);
    const fillet = (fr, sign) => {
      // Fillet surfaces carry no boundary condition in OpenMC.
      const coord = cb[ax] + h / 2 + sign * (h / 2 - fr);
      const fcyl = b.add(`${axis}-cylinder`, [cb[i1], cb[i2], r - fr]);
      const center = [...cb];
      center[ax] = coord;
      const torus = b.add(`${axis}-torus`, [...center, r - fr, fr, fr]);
      const plane = b.add(`${axis}-plane`, [coord]);
      return and(pos(fcyl), pos(torus), sign > 0 ? pos(plane) : neg(plane));
    };
    const fillets = [];
    if (p.upper_fillet_radius > 0) fillets.push(fillet(p.upper_fillet_radius, 1));
    if (p.lower_fillet_radius > 0) fillets.push(fillet(p.lower_fillet_radius, -1));
    const prism = [neg(cyl), pos(bottom), neg(top)];
    if (!fillets.length) return and(prism);
    return and(prism, not(fillets.length === 1 ? fillets[0] : or(fillets)));
  },

  rpp(p, b) {
    const { min, max } = p;
    for (let k = 0; k < 3; k++) check(min[k] < max[k], `${AXES[k]}min must be less than ${AXES[k]}max`);
    const bc = bcOf(p);
    const s = [0, 1, 2].map((k) => [b.add(`${AXES[k]}-plane`, [min[k]], bc), b.add(`${AXES[k]}-plane`, [max[k]], bc)]);
    return and(neg(s[0][1]), pos(s[0][0]), neg(s[1][1]), pos(s[1][0]), neg(s[2][1]), pos(s[2][0]));
  },

  "orthogonal-box"(p, b) {
    const { v, a1, a2, finite } = p;
    const a3 = finite ? p.a3 : cross(a1, a2);
    const add = (u, w) => u.map((x, i) => x + w[i]);
    const p1 = v;
    const p2 = add(v, a1);
    const p3 = add(v, a2);
    const p4 = add(v, a3);
    const p5 = add(add(v, a1), a2);
    const p6 = add(add(v, a2), a3);
    const p7 = add(add(v, a1), a3);
    const planes = [
      [planeFromPoints(p1, p3, p4), planeFromPoints(p2, p5, p7)],
      [planeFromPoints(p1, p4, p2), planeFromPoints(p3, p6, p5)],
    ];
    if (finite) planes.push([planeFromPoints(p1, p2, p3), planeFromPoints(p4, p7, p6)]);
    // Flip normals so the box midpoint is on the + side of min and − side of max.
    const mid = v.map((x, i) => x + (a1[i] + a2[i] + a3[i]) / 2);
    const bc = bcOf(p);
    const parts = [];
    for (let [mn, mx] of planes) {
      if (evaluate({ type: "plane", coeffs: mn }, mid) < 0) mn = flipped(mn);
      if (evaluate({ type: "plane", coeffs: mx }, mid) > 0) mx = flipped(mx);
      parts.push(pos(b.add("plane", mn, bc)), neg(b.add("plane", mx, bc)));
    }
    return and(parts);
  },

  "cone-one-sided"(p, b) {
    const { apex, r2, up, axis } = p;
    check(isAxis(axis), "axis must be x, y or z");
    check(r2 > 0, "slope² must be positive");
    const cone = b.add(`${axis}-cone`, [...apex, r2], bcOf(p));
    // The disambiguation plane never takes the boundary condition.
    const plane = b.add(`${axis}-plane`, [apex[AXES.indexOf(axis)]]);
    return and(neg(cone), up ? pos(plane) : neg(plane));
  },

  polygon(p, b) {
    return polygonRegion(p.points, p.basis, b, bcOf(p));
  },

  "cruciform-prism"(p, b) {
    const { distances: d, center, axis } = p;
    check(isAxis(axis), "axis must be x, y or z");
    check(d.length > 0 && d.every((v) => v > 0), "distances must be positive");
    const inc = d.every((v, i) => i === 0 || v > d[i - 1]);
    const dec = d.every((v, i) => i === 0 || v < d[i - 1]);
    check(inc || dec, "distances must be monotonic");
    const [hAxis, vAxis] = { x: ["y", "z"], y: ["x", "z"], z: ["x", "y"] }[axis];
    const [x0, y0] = center;
    const bc = bcOf(p);
    const s = d.map((di) => ({
      hmin: b.add(`${hAxis}-plane`, [x0 - di], bc),
      hmax: b.add(`${hAxis}-plane`, [x0 + di], bc),
      vmin: b.add(`${vAxis}-plane`, [y0 - di], bc),
      vmax: b.add(`${vAxis}-plane`, [y0 + di], bc),
    }));
    const n = d.length;
    return or(s.map((si, i) => and(pos(si.hmin), neg(si.hmax), pos(s[n - 1 - i].vmin), neg(s[n - 1 - i].vmax))));
  },

  "rectangular-prism"(p, b) {
    const { width: w, height: h, axis, origin: o, corner_radius: cr } = p;
    check(isAxis(axis), "axis must be x, y or z");
    check(w > 0 && h > 0, "width and height must be positive");
    check(!(cr > 0 && p.boundary === "periodic"), "periodic boundaries are not allowed with rounded corners");
    const [x1, x2] = { x: ["y", "z"], y: ["x", "z"], z: ["x", "y"] }[axis];
    const bc = bcOf(p);
    const minX1 = b.add(`${x1}-plane`, [-w / 2 + o[0]], bc);
    const maxX1 = b.add(`${x1}-plane`, [w / 2 + o[0]], bc);
    const minX2 = b.add(`${x2}-plane`, [-h / 2 + o[1]], bc);
    const maxX2 = b.add(`${x2}-plane`, [h / 2 + o[1]], bc);
    if (p.boundary === "periodic") pairPeriodic(b, [minX1, maxX1], [minX2, maxX2]);
    const prism = and(pos(minX1), neg(maxX1), pos(minX2), neg(maxX2));
    if (!(cr > 0)) return prism;
    // Cylinder coefficients are in the (x1, x2) basis, which matches OpenMC's
    // X/Y/ZCylinder argument order for each axis.
    const cyl = (c1, c2) => b.add(`${axis}-cylinder`, [c1, c2, cr], bc);
    const lo1 = o[0] - w / 2 + cr;
    const hi1 = o[0] + w / 2 - cr;
    const lo2 = o[1] - h / 2 + cr;
    const hi2 = o[1] + h / 2 - cr;
    const c_mm = cyl(lo1, lo2);
    const c_mM = cyl(lo1, hi2);
    const c_Mm = cyl(hi1, lo2);
    const c_MM = cyl(hi1, hi2);
    const x1min = b.add(`${x1}-plane`, [lo1], bc);
    const x1max = b.add(`${x1}-plane`, [hi1], bc);
    const x2min = b.add(`${x2}-plane`, [lo2], bc);
    const x2max = b.add(`${x2}-plane`, [hi2], bc);
    const corners = or(
      and(pos(c_mm), neg(x1min), neg(x2min)),
      and(pos(c_mM), neg(x1min), pos(x2max)),
      and(pos(c_Mm), pos(x1max), neg(x2min)),
      and(pos(c_MM), pos(x1max), pos(x2max)),
    );
    return and(prism, not(corners));
  },

  "hexagonal-prism"(p, b) {
    const { edge_length: l, orientation, origin, corner_radius: cr } = p;
    check(orientation === "x" || orientation === "y", "orientation must be x or y");
    check(l > 0, "edge length must be positive");
    check(!(cr > 0 && p.boundary === "periodic"), "periodic boundaries are not allowed with rounded corners");
    const [x, y] = origin;
    const bc = bcOf(p);
    let pmax;
    let pmin;
    let ur;
    let ul;
    let lr;
    let ll;
    if (orientation === "y") {
      pmax = b.add("x-plane", [x + (SQRT3 / 2) * l], bc);
      pmin = b.add("x-plane", [x - (SQRT3 / 2) * l], bc);
      const c = SQRT3 / 3;
      ur = b.add("plane", [c, 1, 0, l + x * c + y], bc);
      ul = b.add("plane", [-c, 1, 0, l - x * c + y], bc);
      lr = b.add("plane", [-c, 1, 0, -l - x * c + y], bc);
      ll = b.add("plane", [c, 1, 0, -l + x * c + y], bc);
    } else {
      pmax = b.add("y-plane", [y + (SQRT3 / 2) * l], bc);
      pmin = b.add("y-plane", [y - (SQRT3 / 2) * l], bc);
      const c = SQRT3;
      ur = b.add("plane", [c, 1, 0, c * l + x * c + y], bc);
      lr = b.add("plane", [-c, 1, 0, -c * l - x * c + y], bc);
      ll = b.add("plane", [c, 1, 0, -c * l + x * c + y], bc);
      ul = b.add("plane", [-c, 1, 0, c * l - x * c + y], bc);
    }
    if (p.boundary === "periodic") pairPeriodic(b, [pmin, pmax], [ur, ll], [lr, ul]);
    const prism = and(neg(pmax), pos(pmin), neg(ur), neg(ul), pos(lr), pos(ll));
    if (!(cr > 0)) return prism;
    const c = SQRT3 / 2;
    const t = l - cr / c;
    const inn = (x0, y0) => b.add("z-cylinder", [x0, y0, cr], bc);
    const out = (x0, y0) => b.add("z-cylinder", [x0, y0, cr / (2 * c)], bc);
    const pairs =
      orientation === "x"
        ? [
            [inn(x - t / 2, y - c * t), out(x - l / 2, y - c * l)],
            [inn(x + t / 2, y - c * t), out(x + l / 2, y - c * l)],
            [inn(x - t / 2, y + c * t), out(x - l / 2, y + c * l)],
            [inn(x + t / 2, y + c * t), out(x + l / 2, y + c * l)],
            [inn(x - t, y), out(x - l, y)],
            [inn(x + t, y), out(x + l, y)],
          ]
        : [
            [inn(x - c * t, y - t / 2), out(x - c * l, y - l / 2)],
            [inn(x - c * t, y + t / 2), out(x - c * l, y + l / 2)],
            [inn(x + c * t, y - t / 2), out(x + c * l, y - l / 2)],
            [inn(x + c * t, y + t / 2), out(x + c * l, y + l / 2)],
            [inn(x, y - t), out(x, y - l)],
            [inn(x, y + t), out(x, y + l)],
          ];
    return and(prism, not(or(pairs.map(([i, o]) => and(pos(i), neg(o))))));
  },

  "conical-frustum"(p, b) {
    const { center_base: cb, axis, r1, r2 } = p;
    const h = Math.hypot(...axis);
    check(h > 0, "axis vector must be non-zero");
    check(r1 >= 0 && r2 >= 0 && (r1 > 0 || r2 > 0), "radii must be non-negative and not both zero");
    const bc = bcOf(p);
    const [x0, y0, z0] = cb;
    const local = [
      r1 !== r2 ? { type: "z-cone", coeffs: [x0, y0, z0 + (r1 * h) / (r1 - r2), ((r1 - r2) / h) ** 2] } : { type: "z-cylinder", coeffs: [x0, y0, r1] },
      { type: "z-plane", coeffs: [z0] },
      { type: "z-plane", coeffs: [z0 + h] },
    ];
    const R = rotationBetween([0, 0, 1], axis);
    const identity = R.every((row, i) => row.every((v, j) => v === (i === j ? 1 : 0)));
    const m = M4.compose(
      M4.translation(cb),
      [R[0][0], R[1][0], R[2][0], 0, R[0][1], R[1][1], R[2][1], 0, R[0][2], R[1][2], R[2][2], 0, 0, 0, 0, 1],
      M4.translation(cb.map((v) => -v)),
    );
    const [cone, bottom, top] = local.map((s) => {
      // Rotation keeps the sign of f, so senses carry over (like Surface.rotate).
      const t = identity ? s : rawSurface(transformForm(toForm(s), m));
      return b.add(t.type, t.coeffs, bc);
    });
    return and(pos(bottom), neg(top), neg(cone));
  },

  vessel(p, b) {
    const { r, p1, p2, h1, h2, center, axis } = p;
    check(isAxis(axis), "axis must be x, y or z");
    check(p1 < p2, "cylinder min must be less than max");
    check(r > 0 && h1 > 0 && h2 > 0, "radius and head heights must be positive");
    const [c1, c2] = center;
    const bc = bcOf(p);
    const cyl = b.add(`${axis}-cylinder`, [c1, c2, r], bc);
    // OpenMC does not apply the boundary condition to these planes.
    const pb = b.add(`${axis}-plane`, [p1]);
    const pt = b.add(`${axis}-plane`, [p2]);
    const head = (pz, hh) => {
      const s2 = (r / hh) ** 2;
      // Quadric coefficients [a b c d e f g h j k] as in Vessel.__init__.
      const q = [1, 1, 1, 0, 0, 0, 0, 0, 0, c1 * c1 + c2 * c2 + pz * pz * s2 - r * r];
      const ax = AXES.indexOf(axis);
      q[ax] *= s2;
      const lin = { x: [-2 * pz * s2, -2 * c1, -2 * c2], y: [-2 * c1, -2 * pz * s2, -2 * c2], z: [-2 * c1, -2 * c2, -2 * pz * s2] }[axis];
      q[6] = lin[0];
      q[7] = lin[1];
      q[8] = lin[2];
      return b.add("quadric", q, bc);
    };
    const bottom = head(p1, h1);
    const top = head(p2, h2);
    return or(and(neg(cyl), pos(pb), neg(pt)), and(neg(bottom), neg(pb)), and(neg(top), pos(pt)));
  },
};

function pairPeriodic(b, ...pairs) {
  for (const [i, j] of pairs) {
    b.surfaces[i].periodic = j;
    b.surfaces[j].periodic = i;
  }
}

/** Rotation matrix taking v1 to v2 (surface_composite._rotation_matrix, including its ±I special case). */
export function rotationBetween(v1, v2) {
  const n = (v) => v.map((x) => x / Math.hypot(...v));
  const u1 = n(v1);
  const u2 = n(v2);
  const c = dot(u1, u2);
  if (Math.abs(Math.abs(c) - 1) <= 1e-8) {
    const s = Math.sign(c);
    return [
      [s, 0, 0],
      [0, s, 0],
      [0, 0, s],
    ];
  }
  const s = Math.sqrt(1 - c * c);
  const k = n(cross(u1, u2));
  const K = [
    [0, -k[2], k[1]],
    [k[2], 0, -k[0]],
    [-k[1], k[0], 0],
  ];
  const KK = K.map((row) => [0, 1, 2].map((j) => row.reduce((acc, v, m) => acc + v * K[m][j], 0)));
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => (i === j ? 1 : 0) + K[i][j] * s + KK[i][j] * (1 - c)));
}

/** A form as a raw plane / quadric surface, keeping the sign of f. */
function rawSurface(form) {
  if (form.kind === "linear") return { type: "plane", coeffs: [form.L[0], form.L[1], form.L[2], -form.L[3]] };
  const Q = form.Q;
  return { type: "quadric", coeffs: [Q[0][0], Q[1][1], Q[2][2], 2 * Q[0][1], 2 * Q[1][2], 2 * Q[0][2], 2 * Q[0][3], 2 * Q[1][3], 2 * Q[2][3], Q[3][3]] };
}

// ---- polygon ----------------------------------------------------------------------

const cross2 = (o, a, c) => (a[0] - o[0]) * (c[1] - o[1]) - (a[1] - o[1]) * (c[0] - o[0]);

/** Validates and orders polygon points counter-clockwise (Polygon._validate_points). */
export function validatePolygon(points) {
  let pts = points.map((pt) => {
    check(Array.isArray(pt) && pt.length === 2 && pt.every(Number.isFinite), "each point needs two numbers");
    return [pt[0], pt[1]];
  });
  const close = (a, c) => Math.abs(a[0] - c[0]) < 1e-8 && Math.abs(a[1] - c[1]) < 1e-8;
  if (pts.length > 1 && close(pts[0], pts[pts.length - 1])) pts = pts.slice(0, -1);
  check(pts.length >= 3, "a polygon needs at least 3 points");
  const seen = new Set(pts.map((pt) => pt.join(",")));
  check(seen.size === pts.length, "duplicate points in the polygon");
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    area += x1 * y2 - x2 * y1;
  }
  if (area < 0) pts.reverse();

  // Self-intersection: segments may only meet at shared endpoints, and
  // adjacent segments must not fold back onto each other.
  const n = pts.length;
  const eps = 1e-10 * Math.max(1, ...pts.flat().map(Math.abs));
  const onSeg = (a, c, q) => Math.min(a[0], c[0]) - eps <= q[0] && q[0] <= Math.max(a[0], c[0]) + eps && Math.min(a[1], c[1]) - eps <= q[1] && q[1] <= Math.max(a[1], c[1]) + eps;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const a2 = pts[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      const c = pts[j];
      const c2 = pts[(j + 1) % n];
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      const d1 = cross2(c, c2, a);
      const d2 = cross2(c, c2, a2);
      const d3 = cross2(a, a2, c);
      const d4 = cross2(a, a2, c2);
      if (adjacent) {
        // Shared vertex: fold-back if collinear and pointing back.
        const shared = j === i + 1 ? a2 : a;
        const other1 = j === i + 1 ? a : a2;
        const other2 = j === i + 1 ? c2 : c;
        const u = [other1[0] - shared[0], other1[1] - shared[1]];
        const w = [other2[0] - shared[0], other2[1] - shared[1]];
        if (Math.abs(u[0] * w[1] - u[1] * w[0]) <= eps * Math.hypot(...u) * Math.hypot(...w) && u[0] * w[0] + u[1] * w[1] > 0) {
          throw new Error("polygon cannot be self-intersecting");
        }
        continue;
      }
      const straddle = ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
      const touch =
        (Math.abs(d1) <= eps && onSeg(c, c2, a)) ||
        (Math.abs(d2) <= eps && onSeg(c, c2, a2)) ||
        (Math.abs(d3) <= eps && onSeg(a, a2, c)) ||
        (Math.abs(d4) <= eps && onSeg(a, a2, c2));
      if (straddle || touch) throw new Error("polygon cannot be self-intersecting");
    }
  }
  return pts;
}

/** Splits a simple CCW polygon into convex pieces (ear clipping + Hertel–Mehlhorn). Returns index lists. */
export function convexDecomposition(pts) {
  // Drop collinear vertices: they do not change the outline.
  let idx = pts.map((_, i) => i);
  let changed = true;
  while (changed && idx.length > 3) {
    changed = false;
    for (let k = 0; k < idx.length; k++) {
      const a = pts[idx[(k - 1 + idx.length) % idx.length]];
      const o = pts[idx[k]];
      const c = pts[idx[(k + 1) % idx.length]];
      if (Math.abs(cross2(a, o, c)) <= 1e-12 * Math.max(1, Math.hypot(o[0] - a[0], o[1] - a[1]) * Math.hypot(c[0] - o[0], c[1] - o[1]))) {
        idx.splice(k, 1);
        changed = true;
        break;
      }
    }
  }

  // Ear clipping.
  const tris = [];
  const ring = [...idx];
  const inside = (p, a, b, c) => cross2(a, b, p) > 1e-12 && cross2(b, c, p) > 1e-12 && cross2(c, a, p) > 1e-12;
  let guard = 0;
  while (ring.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let k = 0; k < ring.length; k++) {
      const ia = ring[(k - 1 + ring.length) % ring.length];
      const io = ring[k];
      const ic = ring[(k + 1) % ring.length];
      if (cross2(pts[ia], pts[io], pts[ic]) <= 1e-12) continue; // reflex
      if (ring.some((j) => j !== ia && j !== io && j !== ic && inside(pts[j], pts[ia], pts[io], pts[ic]))) continue;
      tris.push([ia, io, ic]);
      ring.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) throw new Error("could not triangulate the polygon");
  }
  tris.push([...ring]);

  // Hertel–Mehlhorn: merge pieces across diagonals while they stay convex.
  const pieces = tris.map((t) => [...t]);
  const isConvex = (poly) =>
    poly.every((_, k) => cross2(pts[poly[(k - 1 + poly.length) % poly.length]], pts[poly[k]], pts[poly[(k + 1) % poly.length]]) >= -1e-12);
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        const P = pieces[i];
        const Q = pieces[j];
        // Find a shared edge: P has (u, v), Q has (v, u).
        for (let a = 0; a < P.length; a++) {
          const u = P[a];
          const v = P[(a + 1) % P.length];
          const bq = Q.findIndex((q, k) => q === v && Q[(k + 1) % Q.length] === u);
          if (bq < 0) continue;
          // Merge: walk P from v to u, then Q from u (exclusive) to v (exclusive).
          const res = [];
          for (let k = 0; k < P.length; k++) res.push(P[(a + 1 + k) % P.length]);
          for (let k = 2; k < Q.length; k++) res.push(Q[(bq + k) % Q.length]);
          if (isConvex(res)) {
            pieces[i] = res;
            pieces.splice(j, 1);
            merged = true;
            break outer;
          }
        }
      }
    }
  }
  return pieces;
}

/** Region of a polygon composite: union of its convex pieces (Polygon._get_convex_hull_surfs). */
function polygonRegion(points, basis, b, bc) {
  check(["xy", "yz", "xz", "rz"].includes(basis), "basis must be xy, yz, xz or rz");
  const pts = validatePolygon(points);
  const pieces = convexDecomposition(pts);
  const facet = (p1, p2) => {
    const t = [p2[0] - p1[0], p2[1] - p1[1]];
    const len = Math.hypot(...t);
    const dx = t[1] / len; // outward normal of a CCW edge
    const dy = -t[0] / len;
    const c = -(dx * p1[0] + dy * p1[1]);
    if (Math.abs(dx) <= 1e-8) {
      const surf = b.add(basis === "xy" ? "y-plane" : "z-plane", [-c / dy], bc);
      return dy < 0 ? pos(surf) : neg(surf);
    }
    if (Math.abs(dy) <= 1e-8) {
      const type = { xy: "x-plane", xz: "x-plane", yz: "y-plane" }[basis];
      const surf = type ? b.add(type, [-c / dx], bc) : b.add("z-cylinder", [0, 0, -c / dx], bc);
      return dx < 0 ? pos(surf) : neg(surf);
    }
    if (basis === "xy") return neg(b.add("plane", [dx, dy, 0, -c], bc));
    if (basis === "yz") return neg(b.add("plane", [0, dx, dy, -c], bc));
    if (basis === "xz") return neg(b.add("plane", [dx, 0, dy, -c], bc));
    // rz: a slanted edge is a one-sided cone around z.
    const z0 = -c / dy;
    const r2 = (dy * dy) / (dx * dx);
    const up = dy / dx < 0;
    const cone = b.add("z-cone", [0, 0, z0, r2], bc);
    const plane = b.add("z-plane", [z0]);
    const inside = and(neg(cone), up ? pos(plane) : neg(plane));
    return (up && dx - dy < 0) || (!up && dx + dy < 0) ? not(inside) : inside;
  };
  const regions = pieces.map((piece) => and(piece.map((i, k) => facet(pts[i], pts[piece[(k + 1) % piece.length]]))));
  return regions.length === 1 ? regions[0] : or(regions);
}
