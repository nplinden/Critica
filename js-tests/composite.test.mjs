// Point-membership checks ported from OpenMC's tests/unit_tests/test_surface_composite.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { expandComposite, COMPOSITE_TYPES, defaultCompositeParams, validatePolygon, convexDecomposition } from "../app/openmc/composite.js";
import { contains, regionBounds } from "../app/openmc/region.js";

/** Returns inside(p) for the negative side ("-s") of a composite. */
function composite(type, params) {
  const { surfaces, region } = expandComposite(type, params);
  const map = new Map(surfaces.map((s, i) => [i, s]));
  const inside = (p) => contains(region, map, p);
  inside.bounds = () => regionBounds(region, map);
  inside.surfaces = surfaces;
  return inside;
}

const roll = (v, k) => v.map((_, i) => v[(i - k + 3) % 3]);

test("every composite type expands with its defaults", () => {
  for (const type of Object.keys(COMPOSITE_TYPES)) {
    const { surfaces, region } = expandComposite(type, defaultCompositeParams(type));
    assert.ok(surfaces.length > 0 && region, type);
  }
});

test("RectangularParallelepiped", () => {
  const s = composite("rpp", { min: [-1, -2, -3], max: [1, 2, 3] });
  assert.equal(s([-1.1, 0, 0]), false);
  assert.equal(s([0, 0, 0]), true);
  assert.throws(() => composite("rpp", { min: [1, 0, 0], max: [0, 1, 1] }), /less than/);
});

test("RightCircularCylinder, with and without fillets", () => {
  const [x, y, z] = [1, -2.5, 3];
  const [h, r] = [5, 3];
  for (const [axis, k] of [["x", 0], ["y", 1], ["z", 2]]) {
    for (const fillet of [0, 1.6]) {
      const s = composite("rcc", { center_base: [x, y, z], height: h, radius: r, axis, upper_fillet_radius: fillet, lower_fillet_radius: fillet });
      const at = (v) => roll(v, k).map((d, i) => d + [x, y, z][i]);
      assert.equal(s(at([h / 2, r + 1, r + 1])), false, `${axis} outside`);
      assert.equal(s(at([h / 2, 0, 0])), true, `${axis} inside`);
      const b = s.bounds();
      assert.deepEqual(b.min, at([0, -r, -r]));
      assert.deepEqual(b.max, at([h, r, r]));
      if (fillet) {
        // A point in the cut-away corner of the fillet is outside.
        assert.equal(s(at([0.05, r - 0.05, 0])), false);
        assert.equal(s(at([0.05, r - 1.6, 0])), true);
      }
    }
  }
});

test("ConeOneSided", () => {
  const cases = [
    ["x", [8, 0, 0], [12, 0, 0]],
    ["y", [10, -2, 0], [10, 2, 0]],
    ["z", [10, 0, -3], [10, 0, 3]],
  ];
  for (const [axis, outside, inside] of cases) {
    const s = composite("cone-one-sided", { apex: [10, 0, 0], r2: 4, up: true, axis });
    assert.equal(s(outside), false, axis);
    assert.equal(s(inside), true, axis);
    // The disambiguation plane keeps transmission.
    const plane = s.surfaces.find((q) => q.type.endsWith("plane"));
    assert.equal(plane.boundary, undefined);
  }
  const bc = composite("cone-one-sided", { boundary: "reflective" });
  assert.equal(bc.surfaces.find((q) => q.type.endsWith("cone")).boundary, "reflective");
});

test("CylinderSector, including reflex angles", () => {
  for (const [axis, idx] of [["x", [2, 0, 1]], ["y", [0, 2, 1]], ["z", [0, 1, 2]]]) {
    for (const [c1, c2] of [[0, 0], [10, 5]]) {
      const [r1, r2] = [0.5, 1.5];
      const d = (r2 - r1) / 2;
      const pick = (v) => idx.map((i) => v[i]);
      const s = composite("cylinder-sector", { r1, r2, theta1: -60, theta2: 60, center: [c1, c2], axis });
      assert.equal(s(pick([c1, r2 + 1 + c2, 0])), false, `${axis} outside`);
      assert.equal(s(pick([r1 + d + c1, r1 + d + c2, 0])), true, `${axis} inside`);
      const reflex = composite("cylinder-sector", { r1, r2, theta1: 0, theta2: 270, center: [c1, c2], axis });
      for (const q of [[c1 + r1 + d, c2 + 0.01, 0], [c1, c2 + r1 + d, 0], [c1 - r1 - d, c2, 0], [c1 - 0.01, c2 - r1 - d, 0]]) {
        assert.equal(reflex(pick(q)), true, `${axis} reflex ${q}`);
      }
    }
  }
  assert.throws(() => composite("cylinder-sector", { r1: 1.5, r2: 0.5 }), /r2 must be greater/);
  assert.throws(() => composite("cylinder-sector", { theta1: 60, theta2: -60 }), /θ₂/);
});

test("IsogonalOctagon", () => {
  for (const [axis, k] of [["x", 0], ["y", 1], ["z", 2]]) {
    const s = composite("isogonal-octagon", { center: [0, 0], r1: 1, r2: 1, axis });
    const ins = (v2) => {
      const v = [...v2];
      v.splice(k, 0, 0);
      return v;
    };
    assert.equal(s(ins([0.8, 0.8])), false, axis);
    assert.equal(s(ins([0.7, 0.7])), true, axis);
  }
  assert.throws(() => composite("isogonal-octagon", { r1: 1, r2: 10 }), /√2/);
  assert.throws(() => composite("isogonal-octagon", { r1: 10, r2: 1 }), /√2/);
});

const STAR = [
  [1, 2], [0.70610737, 1.4045085], [0.04894348, 1.30901699], [0.52447174, 0.8454915], [0.41221475, 0.19098301],
  [1, 0.5], [1.58778525, 0.19098301], [1.47552826, 0.8454915], [1.95105652, 1.30901699], [1.29389263, 1.4045085], [1, 2],
];

test("Polygon: star in every basis", () => {
  const inside = { xy: [1, 1, 0], yz: [0, 1, 1], xz: [1, 0, 1], rz: [0.707, 0.707, 1] };
  for (const basis of ["xy", "yz", "xz", "rz"]) {
    const s = composite("polygon", { points: STAR, basis });
    assert.equal(s(inside[basis]), true, basis);
    assert.equal(s([0, 0, 0]), false, basis);
  }
});

test("Polygon: invalid outlines are rejected", () => {
  const bad = [
    // duplicate points
    [[6.88, 3.02], [6.88, 2.72], [6.88, 3.02], [7.63, 0], [5.75, 0], [5.75, 1.22], [7.63, 0], [6.3, 1.22], [6.3, 3.02], [6.88, 3.02]],
    // a segment traces back on the previous one
    [[6.88, 3.02], [6.88, 2.72], [6.88, 2.32], [6.88, 2.52], [7.63, 0], [5.75, 0], [6.75, 0], [5.75, 1.22], [6.3, 1.22], [6.3, 3.02], [6.88, 3.02]],
    // line-line intersection
    [[6.88, 3.02], [5.88, 2.32], [7.63, 0], [5.75, 0], [5.75, 1.22], [6.3, 1.22], [6.3, 3.02], [6.88, 3.02]],
    // a vertex lies on another segment
    [[6.88, 3.02], [6.3, 2.32], [7.63, 0], [5.75, 0], [5.75, 1.22], [6.3, 1.22], [6.3, 3.02], [6.88, 3.02]],
  ];
  for (const pts of bad) assert.throws(() => validatePolygon(pts), /duplicate|self-intersecting/);
});

test("Polygon: M shape, points just inside and outside every edge", () => {
  const M = [
    [8.5151581, -17.988337], [10.381711, -17.988337], [12.744357, -24.288728], [15.119406, -17.988337], [16.985959, -17.988337],
    [16.985959, -27.246687], [15.764328, -27.246687], [15.764328, -19.116951], [13.376877, -25.466951], [12.118039, -25.466951],
    [9.7305877, -19.116951], [9.7305877, -27.246687], [8.5151581, -27.246687],
  ];
  const s = composite("polygon", { points: M, basis: "xz" });
  const pts = validatePolygon(M);
  const n = pts.length;
  // Offset each edge midpoint along its outward normal (CCW → right-hand normal).
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const c = pts[(i + 1) % n];
    const t = [c[0] - a[0], c[1] - a[1]];
    const len = Math.hypot(...t);
    const nrm = [t[1] / len, -t[0] / len];
    const mid = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
    assert.equal(s([mid[0] - 0.05 * nrm[0], 0, mid[1] - 0.05 * nrm[1]]), true, `inside edge ${i}`);
    assert.equal(s([mid[0] + 0.05 * nrm[0], 0, mid[1] + 0.05 * nrm[1]]), false, `outside edge ${i}`);
  }
  // Convex decomposition covers the area exactly.
  const area = (poly) => poly.reduce((acc, i, k) => acc + pts[i][0] * pts[poly[(k + 1) % poly.length]][1] - pts[poly[(k + 1) % poly.length]][0] * pts[i][1], 0) / 2;
  const total = convexDecomposition(pts).reduce((acc, p) => acc + area(p), 0);
  const whole = area(pts.map((_, i) => i));
  assert.ok(Math.abs(total - whole) < 1e-9);
});

test("CruciformPrism", () => {
  for (const [axis, i1, i2] of [["x", 1, 2], ["y", 0, 2], ["z", 0, 1]]) {
    const s = composite("cruciform-prism", { distances: [2, 3, 5], center: [3, 4], axis });
    const outside = [0, 0, 0];
    const inside = [0, 0, 0];
    outside[i1] = 3 + 3.1;
    outside[i2] = 4 + 2.05;
    inside[i1] = 3 + 3.5;
    inside[i2] = 4 + 1.99;
    assert.equal(s(outside), false, axis);
    assert.equal(s(inside), true, axis);
    const b = s.bounds();
    assert.equal(b.max[i1], 8);
    assert.equal(b.min[i2], -1);
  }
  assert.throws(() => composite("cruciform-prism", { distances: [1, 0.5, 2, 3] }), /monotonic/);
});

test("OrthogonalBox, finite and infinite", () => {
  const box = { v: [-1, -1, -2.5], a1: [2, -1, 0], a2: [1, 2, 0], a3: [0, 0, 5] };
  const s = composite("orthogonal-box", { ...box, finite: true });
  assert.equal(s([0, 0, 0]), true);
  assert.equal(s([-2, 0, 0]), false);
  assert.equal(s([0, 0.9, 0]), true);
  assert.equal(s([0, 0, -3]), false);
  assert.equal(s([0, 0, 3]), false);
  const inf = composite("orthogonal-box", { ...box, finite: false });
  assert.equal(inf([0, 0, 0]), true);
  assert.equal(inf([-2, 0, 0]), false);
  assert.equal(inf([0, 0, -3]), true);
  assert.equal(inf([0, 0, 3]), true);
});

test("ConicalFrustum, including the cylinder case and tilted axes", () => {
  const s = composite("conical-frustum", { center_base: [0, 0, -3], axis: [0, 0, 3], r1: 2, r2: 0.5 });
  assert.equal(s([0, 0, -1]), true);
  assert.equal(s([0, 0, -4]), false);
  assert.equal(s([0, 0, 1]), false);
  assert.equal(s([1, 1, -2.99]), true);
  assert.equal(s([1, 1, -0.01]), false);
  assert.equal(composite("conical-frustum", { center_base: [0, 0, -3], axis: [0, 0, 3], r1: 2, r2: 2 })([1, 1, -0.01]), true);
  // Tilted along +x: same shape rotated.
  const t = composite("conical-frustum", { center_base: [-3, 0, 0], axis: [3, 0, 0], r1: 2, r2: 0.5 });
  assert.equal(t([-1, 0, 0]), true);
  assert.equal(t([-2.99, 1, 1]), true);
  assert.equal(t([-0.01, 1, 1]), false);
  assert.equal(t([1, 0, 0]), false);
});

test("Vessel", () => {
  const s = composite("vessel", { r: 1, p1: -5, p2: 5, h1: 1, h2: 1, center: [3, 2], axis: "z" });
  for (const z of [0, -5, 5, -5.9, 5.9]) assert.equal(s([3, 2, z]), true, `z=${z}`);
  for (const p of [[3, 2, -6.1], [3, 2, 6.1], [4.5, 2, 0], [3, 3.2, 0], [3, 2, 7]]) assert.equal(s(p), false, `${p}`);
  // Boundary conditions skip the disambiguation planes.
  const bc = composite("vessel", { boundary: "vacuum" });
  assert.deepEqual(bc.surfaces.map((q) => q.boundary ?? "transmission"), ["vacuum", "transmission", "transmission", "vacuum", "vacuum"]);
  // Other axes.
  const x = composite("vessel", { r: 1, p1: -5, p2: 5, h1: 1, h2: 1, center: [3, 2], axis: "x" });
  assert.equal(x([5.9, 3, 2]), true);
  assert.equal(x([6.1, 3, 2]), false);
});

test("RectangularPrism and HexagonalPrism: rounded corners and periodic pairs", () => {
  const r = composite("rectangular-prism", { width: 2, height: 1, corner_radius: 0.3 });
  assert.equal(r([0.99, 0.49, 0]), false, "rounded corner cut away");
  assert.equal(r([0.9, 0, 0]), true);
  const per = composite("rectangular-prism", { width: 2, height: 1, boundary: "periodic" });
  const xs = per.surfaces.filter((q) => q.type === "x-plane");
  assert.equal(per.surfaces[xs[0].periodic], xs[1]);
  assert.throws(() => composite("rectangular-prism", { corner_radius: 0.1, boundary: "periodic" }), /periodic/);

  for (const orientation of ["x", "y"]) {
    const h = composite("hexagonal-prism", { edge_length: 1, orientation });
    assert.equal(h([0, 0, 0]), true);
    // The flat-to-flat half width is √3/2; corners reach 1.
    const flat = orientation === "y" ? [0.85, 0, 0] : [0, 0.85, 0];
    const corner = orientation === "y" ? [0, 0.99, 0] : [0.99, 0, 0];
    assert.equal(h(flat), true);
    assert.equal(h(corner), true);
    const rounded = composite("hexagonal-prism", { edge_length: 1, orientation, corner_radius: 0.2 });
    assert.equal(rounded(corner), false, `${orientation}: rounded corner`);
  }
});
