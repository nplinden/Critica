import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  expandElement,
  expandMaterial,
  composition,
  validate,
  parseFormula,
  groupIntoElements,
  materialFromXML,
  materialToXML,
  materialsElement,
  newMaterial,
  fromLibrary,
  atomicMass,
  atomicWeight,
} from "../examples/materials/material.js";
import { parseXML, children, serializeXML } from "../examples/openmc/xml.js";
import PNNL from "../examples/materials/pnnl_v2.js";

const close = (a, b, rel = 1e-9) => assert.ok(Math.abs(a - b) <= rel * Math.max(Math.abs(b), 1e-300), `expected ${b}, got ${a}`);

test("element expansion matches natural abundances", () => {
  const h = expandElement("H", 2);
  assert.deepEqual(h.map((n) => n.name), ["H1", "H2"]);
  close(h[0].percent + h[1].percent, 2);
  // Weight percent: fractions follow mass-weighted abundances and sum to the input.
  const fe = expandElement("Fe", 1, "wo");
  close(fe.reduce((s, n) => s + n.percent, 0), 1);
  assert.throws(() => expandElement("Xx", 1), /not an element/);
  close(atomicWeight("O"), 15.999, 1e-4);
  close(atomicMass("Am242_m1"), atomicMass("Am242"));
});

test("uranium and two-isotope enrichment", () => {
  // 4.95 wo% U235: weight fractions follow the ORNL correlation.
  const u = expandElement("U", 1, "wo", 4.95);
  const w = Object.fromEntries(u.map((n) => [n.name, n.percent]));
  close(w.U235, 0.0495, 1e-9);
  close(w.U234, 0.0089 * 0.0495, 1e-9);
  close(w.U238, 1 - 1.0135 * 0.0495, 1e-9);
  // Boron enriched to 90 ao% B10.
  const b = Object.fromEntries(expandElement("B", 1, "ao", 90, "B10", "ao").map((n) => [n.name, n.percent]));
  close(b.B10, 0.9);
  close(b.B11, 0.1);
  assert.throws(() => expandElement("Fe", 1, "ao", 50, "Fe56"), /two natural isotopes/);
  assert.throws(() => expandElement("Fe", 1, "wo", 5), /only defined for uranium/);
});

test("densities: g/cm3, atom/b-cm and sum agree", () => {
  // Light water at 1 g/cm3: ~0.1003 atom/b-cm in total.
  const water = newMaterial(1, { density: { value: 1, units: "g/cm3" }, components: [{ kind: "element", name: "H", percent: 2, type: "ao" }, { kind: "element", name: "O", percent: 1, type: "ao" }] });
  const c = composition(water);
  close(c.massDensity, 1, 1e-12);
  close(c.atomDensity, 0.10030, 1e-3);
  close(c.molarMass, 18.0153 / 3, 1e-3);
  // Same material expressed as absolute densities ("sum").
  const sum = newMaterial(2, { density: { value: null, units: "sum" }, components: c.nuclides.map((n) => ({ kind: "nuclide", name: n.name, percent: n.atomDensity, type: "ao" })) });
  close(composition(sum).massDensity, 1, 1e-12);
  // atom/b-cm and kg/m3 units.
  close(composition({ ...water, density: { value: c.atomDensity, units: "atom/b-cm" } }).massDensity, 1, 1e-12);
  close(composition({ ...water, density: { value: 1000, units: "kg/m3" } }).atomDensity, c.atomDensity, 1e-12);
  close(composition({ ...water, density: { value: c.atomDensity * 1e24, units: "atom/cm3" } }).massDensity, 1, 1e-12);
  // Weight fractions of H and O in water.
  const wH = c.nuclides.filter((n) => n.name.startsWith("H")).reduce((s, n) => s + n.weightFraction, 0);
  close(wH, 0.1119, 1e-3);
});

test("validation catches what OpenMC rejects", () => {
  const ok = newMaterial(1, { components: [{ kind: "nuclide", name: "U235", percent: 1, type: "ao" }] });
  assert.deepEqual(validate(ok).errors, []);
  const mixed = { ...ok, components: [...ok.components, { kind: "nuclide", name: "U238", percent: 1, type: "wo" }] };
  assert.match(validate(mixed).errors[0], /same percent type/);
  assert.match(validate({ ...ok, components: [] }).errors[0], /at least one/);
  assert.match(validate({ ...ok, components: [{ kind: "nuclide", name: "u235", percent: 1, type: "ao" }] }).errors[0], /not a nuclide/);
  assert.match(validate({ ...ok, density: { value: 0, units: "g/cm3" } }).errors[0], /positive/);
  assert.match(validate({ ...ok, macroscopic: "UO2" }).errors.join(), /macroscopic/);
  assert.match(validate({ ...ok, sab: [{ name: "c_H_in_H2O", fraction: 2 }] }).errors.join(), /fraction/);
});

test("chemical formulas", () => {
  assert.deepEqual(parseFormula("H2O"), [{ symbol: "H", fraction: 2 / 3 }, { symbol: "O", fraction: 1 / 3 }]);
  assert.deepEqual(parseFormula("Ca(OH)2").map((e) => [e.symbol, e.fraction * 5]), [["Ca", 1], ["O", 2], ["H", 2]]);
  assert.throws(() => parseFormula("H2O.5"), /non-integer/);
  assert.throws(() => parseFormula("Xy2"), /not an element/);
  assert.throws(() => parseFormula("(H2O"), /brackets/);
});

test("nuclides regroup into elements when they match a natural composition", () => {
  const fe = expandElement("Fe", 0.08);
  const grouped = groupIntoElements([...fe, { name: "U235", percent: 0.01, type: "ao" }, ...expandElement("Cr", 0.02)]);
  assert.deepEqual(grouped.map((c) => `${c.kind}:${c.name}`), ["element:Fe", "nuclide:U235", "element:Cr"]);
  close(grouped[0].percent, 0.08);
  // A partial or modified composition stays as nuclides.
  const tweaked = fe.map((n, i) => (i === 0 ? { ...n, percent: n.percent * 2 } : n));
  assert.ok(groupIntoElements(tweaked).every((c) => c.kind === "nuclide"));
});

test("XML round trip", () => {
  const [doc] = parseXML(`<materials>
    <material id="3" name="water" depletable="true" temperature="300">
      <density value="1.0" units="g/cc"/>
      <nuclide name="H1" ao="1.99968852"/><nuclide name="H2" ao="0.00031148"/>
      <nuclide name="O16" ao="0.99757"/><nuclide name="O17" ao="0.00038"/><nuclide name="O18" ao="0.00205"/>
      <sab name="c_H_in_H2O"/>
    </material>
  </materials>`);
  const m = materialFromXML(children(doc, "material")[0]);
  assert.equal(m.density.units, "g/cm3");
  assert.equal(m.temperature, 300);
  assert.equal(m.depletable, true);
  assert.deepEqual(m.sab, [{ name: "c_H_in_H2O", fraction: 1 }]);
  assert.equal(m.components.filter((c) => c.kind === "element").length >= 1, true, "H regrouped");
  const xml = serializeXML(materialToXML(m));
  assert.match(xml, /<density value="1" units="g\/cm3"\/>/);
  assert.match(xml, /<sab name="c_H_in_H2O"\/>/);
  const again = materialFromXML(parseXML(xml)[0]);
  close(composition(again).atomDensity, composition(m).atomDensity, 1e-10);
  assert.throws(() => materialToXML(newMaterial(9)), /at least one/);
  const all = serializeXML(materialsElement([m, newMaterial(1, { components: [{ kind: "element", name: "C", percent: 1, type: "ao" }] })]));
  assert.ok(all.indexOf('id="1"') < all.indexOf('id="3"'), "sorted by id");
});

test("PNNL library entries become valid materials", () => {
  assert.equal(Object.keys(PNNL.materials).length, 411);
  let checked = 0;
  for (const name of Object.keys(PNNL.materials)) {
    const m = fromLibrary(PNNL, name, 1);
    const { errors } = validate(m);
    assert.deepEqual(errors, [], name);
    close(composition(m).massDensity, PNNL.materials[name].density, 1e-9);
    checked++;
  }
  assert.equal(checked, 411);
});

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

test("benchmark corpus: every materials.xml imports, validates and round-trips", async (t) => {
  const root = new URL("../knowledge/benchmarks/", import.meta.url).pathname;
  try {
    await stat(root);
  } catch {
    return t.skip("knowledge/benchmarks not present");
  }
  let files = 0;
  let mats = 0;
  let grouped = 0;
  for await (const p of walk(root)) {
    if (!p.endsWith("materials.xml")) continue;
    const [doc] = parseXML(await readFile(p, "utf8"));
    for (const el of children(doc, "material")) {
      const m = materialFromXML(el);
      assert.deepEqual(validate(m).errors, [], `${p}: material ${m.id}`);
      grouped += m.components.filter((c) => c.kind === "element").length;
      // Re-exported nuclides must match the original file.
      const original = children(el, "nuclide").map((n) => [n.attrs.name, Number(n.attrs.ao ?? n.attrs.wo)]);
      const exported = expandMaterial(m).map((n) => [n.name, n.percent]);
      assert.equal(exported.length, original.length, `${p}: material ${m.id} nuclide count`);
      const sorted = (list) => [...list].sort((x, y) => x[0].localeCompare(y[0]) || x[1] - y[1]);
      sorted(exported).forEach(([name, v], i) => {
        const [oname, ov] = sorted(original)[i];
        assert.equal(name, oname, `${p}: material ${m.id}`);
        close(v, ov, 1e-9);
      });
      mats++;
    }
    files++;
  }
  t.diagnostic(`${files} files, ${mats} materials, ${grouped} element groups recovered`);
  assert.ok(files > 300);
});

test("scene material library: users, renaming, legacy scenes", async () => {
  const { Scene } = await import("../examples/scene.js");
  const scene = new Scene();
  const fuel = scene.addMaterial({ name: "fuel", components: [{ kind: "element", name: "U", percent: 1, type: "ao" }] });
  const water = scene.addMaterial({ name: "water" });
  assert.deepEqual([fuel.id, water.id], [1, 2]);
  const a = scene.add("cell", { fill: { type: "material", material: "1" } });
  const b = scene.add("cell", { fill: { type: "material", material: "2 1 void" } });
  assert.deepEqual(scene.materialUsers(1).map((c) => c.id), [a.id, b.id]);
  scene.renameMaterial(1, 10);
  assert.equal(a.fill.material, "10");
  assert.equal(b.fill.material, "2 10 void");
  assert.equal(scene.materials[10].name, "fuel");
  assert.throws(() => scene.renameMaterial(10, 2), /already exists/);
  // Scenes saved before the library existed stored only names.
  const legacy = Scene.fromJSON({ materials: { 3: { name: "old" } } });
  assert.equal(legacy.materials[3].name, "old");
  assert.deepEqual(legacy.materials[3].components, []);
  assert.equal(legacy.materials[3].id, 3);
});
