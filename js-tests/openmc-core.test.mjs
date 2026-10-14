import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseXML, getText, getList, children, element, serializeXML } from "../app/openmc/xml.js";
import { parseRegion, formatRegion, contains, regionBounds } from "../app/openmc/region.js";
import {
  SURFACE_TYPES,
  evaluate,
  toForm,
  transformForm,
  fromForm,
  transformSurface,
  classifyQuadric,
  symmetricEigen,
  halfspaceBounds,
} from "../app/openmc/surfaces.js";
import { fromTransform, compose, translation, rotationAxis, scaling, transformPoint, invert, rotationToOpenMCAngles, linear3 } from "../app/mat4.js";

const CORPUS = new URL("../knowledge/openmc/", import.meta.url);

// Deterministic PRNG for property tests.
function rng(seed = 1) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

test("xml: attributes, child elements, entities, comments", () => {
  const [root] = parseXML(`<?xml version="1.0"?>
    <!-- comment -->
    <geometry>
      <surface id="1" type="sphere" coeffs="0 0 0 1" name="a &amp; b"/>
      <cell id="2"><region>-1 &amp; </region><material>void</material></cell>
    </geometry>`);
  assert.equal(root.name, "geometry");
  const [s] = children(root, "surface");
  assert.equal(s.attrs.name, "a & b");
  assert.deepEqual(getList(s, "coeffs"), [0, 0, 0, 1]);
  const [c] = children(root, "cell");
  assert.equal(getText(c, "material"), "void");
  assert.equal(getText(c, "region"), "-1 &");
  const out = serializeXML(element("cell", { id: 1, region: "-1 | 2", skip: undefined }));
  assert.equal(out, '<cell id="1" region="-1 | 2"/>\n');
  assert.throws(() => parseXML("<a><b></a>"), /unexpected <\/a>/);
});

test("region: precedence and formatting", () => {
  const cases = [
    ["-1 2 | 3", "-1 2 | 3"],
    ["-3 | ~(5 -2)", "-3 | ~(5 -2)"],
    ["(1 -7 17 -16 | 7 -6 11 -17) (-2 | 5 | -12 | 15)", "(1 -7 17 -16 | 7 -6 11 -17) (-2 | 5 | -12 | 15)"],
    ["((1 -7 11 -17) | (7 -6 17 -16)) ~(2 -5 12 -15)", "(1 -7 11 -17 | 7 -6 17 -16) ~(2 -5 12 -15)"],
    ["+1 ~-2", "1 ~-2"],
    ["~~1", "~~1"],
    ["(1)(2)", "1 2"],
  ];
  for (const [src, expected] of cases) {
    const ast = parseRegion(src);
    assert.equal(formatRegion(ast), expected, src);
    assert.deepEqual(parseRegion(formatRegion(ast)), ast, `round trip ${src}`);
  }
  assert.deepEqual(parseRegion("1 | 2 3"), {
    op: "or",
    args: [{ op: "half", surface: 1, sense: "+" }, { op: "and", args: [{ op: "half", surface: 2, sense: "+" }, { op: "half", surface: 3, sense: "+" }] }],
  });
  assert.equal(parseRegion("  "), null);
  assert.throws(() => parseRegion("1 & 2"), /invalid character/);
  assert.throws(() => parseRegion("(1 2"), /missing/);
  assert.throws(() => parseRegion("1 |"), /unexpected end/);
});

test("region: membership and bounds", () => {
  const surfaces = new Map([
    [1, { id: 1, type: "x-plane", coeffs: [-1] }],
    [2, { id: 2, type: "x-plane", coeffs: [1] }],
    [3, { id: 3, type: "z-cylinder", coeffs: [0, 0, 0.5] }],
  ]);
  const ast = parseRegion("1 -2 ~-3");
  assert.equal(contains(ast, surfaces, [0, 0, 0]), false);
  assert.equal(contains(ast, surfaces, [0.8, 0, 0]), true);
  assert.equal(contains(ast, surfaces, [2, 0, 0]), false);
  const b = regionBounds(parseRegion("1 -2 -3"), surfaces);
  assert.deepEqual(b, { min: [-0.5, -0.5, -Infinity], max: [0.5, 0.5, Infinity] });
  // ~(+1) == -1 → bounded above by x = -1.
  assert.deepEqual(regionBounds(parseRegion("~1"), surfaces).max[0], -1);
});

test("surfaces: forms agree with direct evaluation", () => {
  const rand = rng(3);
  const samples = {
    "x-plane": [0.3],
    plane: [1, -2, 0.5, 0.7],
    "y-cylinder": [0.1, -0.2, 0.9],
    sphere: [0.1, 0.2, -0.3, 1.1],
    "z-cone": [0.2, -0.1, 0.3, 0.6],
    "x-cone": [0.2, -0.1, 0.3, 0.6],
    quadric: [1, 2, 3, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, -2],
  };
  for (const [type, coeffs] of Object.entries(samples)) {
    const s = { type, coeffs };
    const form = toForm(s);
    for (let i = 0; i < 20; i++) {
      const p = [rand() * 4 - 2, rand() * 4 - 2, rand() * 4 - 2];
      const f =
        form.kind === "linear"
          ? form.L[0] * p[0] + form.L[1] * p[1] + form.L[2] * p[2] + form.L[3]
          : [...p, 1].reduce((acc, xi, r) => acc + [...p, 1].reduce((a2, xj, c) => a2 + xi * form.Q[r][c] * xj, 0), 0);
      assert.ok(Math.abs(f - evaluate(s, p)) < 1e-9, `${type} at ${p}`);
    }
    // Canonicalization of an untransformed surface gives it back.
    const canon = fromForm(form);
    assert.equal(canon.type, type);
    assert.equal(canon.flip, false);
  }
});

test("surfaces: transforms preserve point membership", () => {
  const rand = rng(11);
  const m = compose(translation([0.3, -1.2, 2]), rotationAxis(1, 37), rotationAxis(0, -20), scaling([1.5, 0.7, 2]));
  const inv = invert(m);
  const surfaces = [
    { type: "x-plane", coeffs: [0.4] },
    { type: "sphere", coeffs: [0.1, 0.2, 0.3, 1] },
    { type: "z-cylinder", coeffs: [0.1, 0.2, 0.8] },
    { type: "y-cone", coeffs: [0, 0.5, 0, 0.3] },
  ];
  for (const s of surfaces) {
    const t = transformSurface(s, m);
    for (let i = 0; i < 50; i++) {
      const q = [rand() * 6 - 3, rand() * 6 - 3, rand() * 6 - 3];
      const fOrig = evaluate(s, transformPoint(inv, q));
      if (Math.abs(fOrig) < 1e-6) continue;
      const fNew = evaluate(t, q) * (t.flip ? -1 : 1);
      assert.equal(Math.sign(fNew), Math.sign(fOrig), `${s.type} → ${t.type}`);
    }
  }
});

test("surfaces: simplification back to specific types", () => {
  const rot90 = rotationAxis(0, 90); // y → z
  assert.deepEqual(transformSurface({ type: "y-cylinder", coeffs: [1, 2, 0.5] }, rot90), { type: "z-cylinder", coeffs: [1, -2, 0.5], flip: false });
  assert.deepEqual(transformSurface({ type: "sphere", coeffs: [0, 0, 0, 1] }, compose(translation([1, 2, 3]), scaling([2, 2, 2]))), {
    type: "sphere",
    coeffs: [1, 2, 3, 2],
    flip: false,
  });
  // Mirrored x-plane flips the sense.
  assert.deepEqual(transformSurface({ type: "x-plane", coeffs: [1] }, scaling([-1, 1, 1])), { type: "x-plane", coeffs: [-1], flip: true });
  assert.deepEqual(transformSurface({ type: "y-cone", coeffs: [0, 1, 0, 0.25] }, rot90), { type: "z-cone", coeffs: [0, 0, 1, 0.25], flip: false });
  // Non-uniform scale of a sphere becomes a general quadric.
  assert.equal(transformSurface({ type: "sphere", coeffs: [0, 0, 0, 1] }, scaling([1, 2, 3])).type, "quadric");
  // Tori: axis-aligned rotations and axial scaling are fine, tilts are not.
  assert.deepEqual(transformSurface({ type: "y-torus", coeffs: [0, 0, 0, 2, 0.5, 0.5] }, compose(rotationAxis(0, 90), scaling([1, 3, 1]))), {
    type: "z-torus",
    coeffs: [0, 0, 0, 2, 1.5, 0.5],
    flip: false,
  });
  assert.throws(() => transformSurface({ type: "y-torus", coeffs: [0, 0, 0, 2, 0.5, 0.5] }, rotationAxis(0, 30)), /aligned/);
});

test("surfaces: quadric classification", () => {
  const { values } = symmetricEigen([
    [2, 1, 0],
    [1, 2, 0],
    [0, 0, 5],
  ]);
  assert.deepEqual(values.map((v) => Math.round(v * 1e9) / 1e9 + 0).sort(), [1, 3, 5]);

  const tilted = compose(translation([1, 0, -1]), rotationAxis(2, 30), rotationAxis(0, 50));
  const asQuadric = (s, m) => {
    const t = transformForm(toForm(s), m);
    const Q = t.Q;
    return [Q[0][0], Q[1][1], Q[2][2], 2 * Q[0][1], 2 * Q[1][2], 2 * Q[0][2], 2 * Q[0][3], 2 * Q[1][3], 2 * Q[2][3], Q[3][3]];
  };
  const e = classifyQuadric(asQuadric({ type: "sphere", coeffs: [0, 0, 0, 1] }, compose(tilted, scaling([1, 2, 3]))));
  assert.equal(e.kind, "ellipsoid");
  assert.deepEqual(e.semi.map((v) => Math.round(v * 1e9) / 1e9 + 0).sort(), [1, 2, 3]);
  assert.deepEqual(e.center.map((v) => Math.round(v * 1e9) / 1e9 + 0), [1, 0, -1]);
  const c = classifyQuadric(asQuadric({ type: "z-cylinder", coeffs: [0, 0, 1] }, compose(tilted, scaling([2, 1, 1]))));
  assert.equal(c.kind, "cylinder");
  assert.equal(c.sign, 1);
  const k = classifyQuadric(asQuadric({ type: "z-cone", coeffs: [0, 0, 0, 0.5] }, tilted));
  assert.equal(k.kind, "cone");
  assert.deepEqual(k.center.map((v) => Math.round(v * 1e9) / 1e9 + 0), [1, 0, -1]);
  // Negated ellipsoid: f < 0 is the outside.
  assert.equal(classifyQuadric([-1, -1, -1, 0, 0, 0, 0, 0, 0, 1]).sign, -1);
  assert.throws(() => classifyQuadric([1, 1, -1, 0, 0, 0, 0, 0, 0, -1]), /hyperboloid/);
  assert.throws(() => classifyQuadric([1, 1, 0, 0, 0, 0, 0, 0, 1, 0]), /paraboloid/);
  const b = halfspaceBounds({ type: "quadric", coeffs: [1, 0.25, 1, 0, 0, 0, 0, 0, 0, -1] }, "-");
  assert.deepEqual(b.max.map((v) => Math.round(v * 1e9) / 1e9 + 0), [1, 2, 1]);
});

test("rotation: OpenMC angle convention", () => {
  // OpenMC maps world → local with M = formula(-angles) (src/cell.cpp), so the
  // universe moves by Mᵀ. Our "zyx" transform must equal Mᵀ.
  const openmcLocalMatrix = ([a, b, c]) => {
    const [phi, theta, psi] = [-a, -b, -c].map((d) => (d * Math.PI) / 180);
    const { cos, sin } = Math;
    return [
      [cos(theta) * cos(psi), -cos(phi) * sin(psi) + sin(phi) * sin(theta) * cos(psi), sin(phi) * sin(psi) + cos(phi) * sin(theta) * cos(psi)],
      [cos(theta) * sin(psi), cos(phi) * cos(psi) + sin(phi) * sin(theta) * sin(psi), -sin(phi) * cos(psi) + cos(phi) * sin(theta) * sin(psi)],
      [-sin(theta), sin(phi) * cos(theta), cos(phi) * cos(theta)],
    ];
  };
  const angles = [30, -50, 70];
  const M = openmcLocalMatrix(angles);
  const R = linear3(fromTransform({ position: [0, 0, 0], rotation: angles, scale: [1, 1, 1], order: "zyx" }));
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) assert.ok(Math.abs(R[i][j] - M[j][i]) < 1e-12);
  const back = rotationToOpenMCAngles(R);
  back.forEach((v, i) => assert.ok(Math.abs(v - angles[i]) < 1e-9));
});

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}

test("corpus: every region and surface in OpenMC's test inputs parses", async (t) => {
  try {
    await stat(CORPUS);
  } catch {
    t.skip("knowledge/openmc not present");
    return;
  }
  let files = 0;
  let regions = 0;
  let surfaces = 0;
  for await (const path of walk(new URL("tests/", CORPUS).pathname)) {
    if (!/(geometry\.xml|model\.xml|inputs_true.*\.dat)$/.test(path)) continue;
    const text = await readFile(path, "utf8");
    if (!text.includes("<geometry")) continue;
    const roots = parseXML(text);
    files++;
    const geometries = roots.flatMap((r) => (r.name === "geometry" ? [r] : children(r, "geometry")));
    for (const g of geometries) {
      for (const s of children(g, "surface")) {
        const type = getText(s, "type");
        const coeffs = getList(s, "coeffs");
        assert.ok(SURFACE_TYPES[type], `${path}: type ${type}`);
        assert.equal(coeffs.length, SURFACE_TYPES[type].coeffs.length, `${path}: surface ${getText(s, "id")}`);
        surfaces++;
      }
      for (const c of children(g, "cell")) {
        const r = getText(c, "region");
        if (r === undefined) continue;
        const ast = parseRegion(r);
        assert.deepEqual(parseRegion(formatRegion(ast)), ast, `${path}: ${r}`);
        regions++;
      }
    }
  }
  assert.ok(files > 200, `only ${files} files`);
  t.diagnostic(`${files} files, ${surfaces} surfaces, ${regions} regions`);
});
