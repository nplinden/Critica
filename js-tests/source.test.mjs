import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { newSource, validateSource, sourceToXML, sourceFromXML, settingsWithSources, defaultDist, defaultSpace, defaultAngle, sourceShape, DIST_TYPES } from "../app/source/source.js";
import { parseXML, serializeXML, children } from "../app/openmc/xml.js";
import { Scene } from "../app/scene.js";
import { importOpenMC, importSettingsXML } from "../app/openmc/import.js";
import { exportOpenMC, exportSettingsXML } from "../app/openmc/export.js";

const xmlOf = (el) => serializeXML(el).replace(/>\s+</g, "><").trim();
const roundTrip = (src) => sourceFromXML(parseXML(xmlOf(sourceToXML(src)))[0], src.id);
const strip = ({ name: _n, ...rest }) => rest;

test("a new source is a point with OpenMC's defaults left unset", () => {
  const s = newSource(1);
  assert.deepEqual(validateSource(s).errors, []);
  assert.equal(s.particle, "neutron");
  assert.equal(s.angle, null, "isotropic by default");
  assert.equal(s.energy, null, "Watt spectrum by default");
  assert.equal(s.time, null);
  const xml = xmlOf(sourceToXML(s));
  assert.equal(xml, '<source type="independent" strength="1" particle="neutron"><space type="point"><parameters>0 0 0</parameters></space></source>');
  // Unset parts stay unset through XML; set ones are written.
  assert.deepEqual(strip(roundTrip(s)), strip(s));
  s.energy = { type: "discrete", x: [14.1e6], p: [1] };
  s.angle = { type: "monodirectional", uvw: [0, 0, 1] };
  assert.match(xmlOf(sourceToXML(s)), /<angle type="monodirectional" reference_uvw="0 0 1"\/><energy type="discrete"><parameters>14100000 1<\/parameters><\/energy>/);
});

test("every space, angle and distribution type round-trips through XML", () => {
  for (const space of ["point", "box", "spherical", "cylindrical", "cartesian"]) {
    for (const angle of ["isotropic", "monodirectional", "mu-phi"]) {
      const s = newSource(3, space, { size: 2 });
      s.angle = defaultAngle(angle);
      s.time = { type: "uniform", a: 0, b: 1e-6 };
      assert.deepEqual(validateSource(s).errors, [], `${space}/${angle}`);
      assert.deepEqual(strip(roundTrip(s)), strip(s), `${space}/${angle}`);
    }
  }
  for (const type of Object.keys(DIST_TYPES)) {
    const s = newSource(4);
    s.energy = defaultDist(type, [1e5, 2e6]);
    assert.deepEqual(validateSource(s).errors, [], type);
    assert.deepEqual(roundTrip(s).energy, s.energy, type);
  }
  const fission = newSource(5, "box");
  fission.space.fissionOnly = true;
  assert.match(xmlOf(sourceToXML(fission)), /<space type="fission">/);
  assert.equal(roundTrip(fission).space.fissionOnly, true);
});

test("constraints are written and read back", () => {
  const s = newSource(1);
  s.constraints = { domainType: "cell", domainIds: [3, 7], fissionable: true, energyBounds: [1, 2e7], timeBounds: null, rejectionStrategy: "kill" };
  const xml = xmlOf(sourceToXML(s));
  assert.match(xml, /<domain_type>cell<\/domain_type><domain_ids>3 7<\/domain_ids>/);
  assert.match(xml, /<rejection_strategy>kill<\/rejection_strategy>/);
  assert.deepEqual(roundTrip(s).constraints, s.constraints);
});

test("validation catches what OpenMC would reject", () => {
  const box = newSource(1, "box");
  box.space.upperRight = [1, -2, 1];
  assert.match(validateSource(box).errors.join(), /upper corner/);
  const e = newSource(2);
  e.energy = { type: "uniform", a: 2, b: 1 };
  e.strength = 0;
  const errs = validateSource(e).errors.join();
  assert.match(errs, /strength/);
  assert.match(errs, /max must be greater/);
  const c = newSource(3);
  c.constraints.domainIds = [1];
  assert.match(validateSource(c).errors.join(), /domain type/);
  const d = newSource(4);
  d.energy = { type: "discrete", x: [1e6, 2e6], p: [1] };
  assert.match(validateSource(d).errors.join(), /as many probabilities/);
});

test("other source types and unknown distributions are kept verbatim", () => {
  const [file] = parseXML('<source type="file" file="source.h5" strength="2"/>');
  const src = sourceFromXML(file, 1);
  assert.equal(src.raw, file);
  assert.equal(sourceToXML(src), file);
  const [mixed] = parseXML(`<source><space type="point"><parameters>1 2 3</parameters></space>
    <energy type="mixture"><pair probability="1"><dist type="watt" parameters="1e6 2e-6"/></pair></energy></source>`);
  const m = sourceFromXML(mixed, 2);
  assert.deepEqual(m.space, { type: "point", xyz: [1, 2, 3] });
  assert.equal(m.energy.type, "raw");
  assert.match(xmlOf(sourceToXML(m)), /<energy type="mixture"><pair probability="1"><dist type="watt"/);
});

test("settings keep their other elements and get the scene's sources", () => {
  const [settings] = parseXML('<settings><run_mode>fixed source</run_mode><source><space type="point"><parameters>9 9 9</parameters></space></source><batches>10</batches></settings>');
  const out = settingsWithSources(settings, [newSource(1, "box")]);
  assert.deepEqual(out.children.map((c) => c.name), ["run_mode", "batches", "source"]);
  assert.match(xmlOf(out), /<space type="box">/);
  assert.equal(settingsWithSources(null, []).children.length, 0);
});

test("model.xml sources become editable and are exported again", () => {
  const model = `<model><geometry><surface id="1" type="sphere" coeffs="0 0 0 5" boundary="vacuum"/><cell id="1" material="void" region="-1"/></geometry>
    <settings><run_mode>fixed source</run_mode><particles>100</particles><batches>5</batches>
      <source strength="2"><space type="box"><parameters>-1 -1 -1 1 1 1</parameters></space><energy type="discrete" parameters="14100000 1"/></source>
    </settings></model>`;
  const { scene } = importOpenMC(model);
  assert.equal(scene.sources.length, 1);
  assert.deepEqual(scene.sources[0].space.lowerLeft, [-1, -1, -1]);
  assert.deepEqual(scene.sources[0].energy, { type: "discrete", x: [14100000], p: [1] });
  scene.sources[0].strength = 3;
  scene.addSource("point");
  const out = exportOpenMC(scene).model;
  assert.match(out, /<run_mode>fixed source<\/run_mode>/);
  assert.equal((out.match(/<source /g) ?? []).length, 2, "sources replaced, not duplicated");
  assert.match(out, /strength="3"/);
  // Saved scenes keep their sources.
  assert.equal(Scene.fromJSON(JSON.parse(JSON.stringify(scene))).sources.length, 2);
});

test("settings.xml import and export", () => {
  const s = new Scene();
  s.settings.values = {};
  assert.throws(() => exportSettingsXML(s), /no settings or sources/);
  s.addSource("spherical", { size: 3 });
  const only = exportSettingsXML(s);
  assert.match(only.text, /<settings>\s*<source type="independent"/);
  assert.match(only.warnings.join(), /need a number of particles/);
  const imported = importSettingsXML('<settings><batches>7</batches><source><space type="point"><parameters>1 0 0</parameters></space></source></settings>');
  assert.equal(imported.sources.length, 1);
  assert.deepEqual(imported.settings.children.map((c) => c.name), ["batches"]);
});

test("source shapes for display", () => {
  assert.deepEqual(sourceShape(newSource(1)), { kind: "point", at: [0, 0, 0] });
  assert.deepEqual(sourceShape(newSource(2, "box", { size: 2 })), { kind: "box", min: [-2, -2, -2], max: [2, 2, 2] });
  assert.equal(sourceShape(newSource(3, "spherical", { size: 4 })).radius, 4);
  const cyl = sourceShape(newSource(4, "cylindrical", { size: 1.5 }));
  assert.equal(cyl.kind, "cylinder");
  assert.deepEqual([cyl.radius, cyl.z0, cyl.z1], [1.5, -1.5, 1.5]);
  const watt = newSource(5);
  watt.space = { ...defaultSpace("cartesian"), x: { type: "watt", a: 1, b: 1 } };
  assert.equal(sourceShape(watt), null, "unbounded distributions are not drawn");
});

// ---- corpus: ICSBEP settings and OpenMC regression inputs, when present ----

async function filesUnder(dir, keep, out = []) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if ((await stat(p)).isDirectory()) await filesUnder(p, keep, out);
    else if (keep(e)) out.push(p);
  }
  return out;
}

const findAll = (el, name, out = []) => {
  if (el.name === name) out.push(el);
  for (const c of el.children ?? []) findAll(c, name, out);
  return out;
};

test("corpus sources round-trip", async (t) => {
  const icsbep = await filesUnder(new URL("../knowledge/benchmarks/icsbep", import.meta.url).pathname, (f) => f === "settings.xml");
  const regression = await filesUnder(new URL("../knowledge/openmc/tests/regression_tests", import.meta.url).pathname, (f) => f === "inputs_true.dat" || f === "settings.xml");
  if (!icsbep.length && !regression.length) return t.skip("knowledge/ not present");
  let editable = 0;
  let kept = 0;
  for (const file of [...icsbep, ...regression]) {
    let roots;
    try {
      roots = parseXML(await readFile(file, "utf8"));
    } catch {
      continue; // not XML (some .dat files)
    }
    for (const settings of roots.flatMap((r) => findAll(r, "settings"))) {
      for (const el of children(settings, "source")) {
        const src = sourceFromXML(el, 1);
        if (src.raw) {
          kept++;
          continue;
        }
        if (validateSource(src).errors.length) continue; // e.g. sources relying on unsupported pieces
        editable++;
        // Compare the written XML: verbatim parts differ only in whitespace.
        assert.equal(xmlOf(sourceToXML(roundTrip(src))), xmlOf(sourceToXML(src)), file);
      }
    }
  }
  assert.ok(editable > 100, `only ${editable} editable sources`);
  t.diagnostic(`${editable} editable sources round-tripped, ${kept} kept verbatim`);
});

test("an invalid source is left out of the export with a warning", () => {
  const s = new Scene();
  const bad = s.addSource("box");
  bad.space.upperRight = [-5, 0, 0];
  s.addSource("point");
  const { text, warnings } = exportSettingsXML(s);
  assert.equal((text.match(/<source /g) ?? []).length, 1);
  assert.match(warnings.join(), /Not exported: source "Source 1"/);
});
