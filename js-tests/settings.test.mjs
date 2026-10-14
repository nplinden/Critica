import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { SETTINGS_FIELDS, readSettings, applySettings, validateSettings, defaultSettings, fieldApplies } from "../app/settings/settings.js";
import { parseXML, serializeXML } from "../app/openmc/xml.js";
import { Scene } from "../app/scene.js";
import { importOpenMC } from "../app/openmc/import.js";
import { exportOpenMC, exportSettingsXML } from "../app/openmc/export.js";

const xmlOf = (el) => serializeXML(el).replace(/>\s+</g, "><").trim();

test("new scenes get runnable eigenvalue settings", () => {
  const s = new Scene();
  assert.deepEqual(s.settings, defaultSettings());
  assert.deepEqual(validateSettings(s.settings.values).errors, []);
  const { text, warnings } = exportSettingsXML(s);
  assert.match(text.replace(/>\s+</g, "><"), /<settings><run_mode>eigenvalue<\/run_mode><particles>1000<\/particles><batches>100<\/batches><inactive>10<\/inactive><\/settings>/);
  assert.deepEqual(warnings, []);
});

test("every field is written and read back", () => {
  const values = {};
  for (const f of SETTINGS_FIELDS) {
    values[f.key] = { enum: f.options?.[1], int: 3, float: 2.5, bool: true, text: "out", ints: [1, 2], floats: [300, 900] }[f.type];
  }
  values.run_mode = "eigenvalue";
  const el = applySettings(null, values);
  assert.deepEqual(readSettings(el).values, values);
  assert.match(xmlOf(el), /<cutoff><weight>2.5<\/weight><weight_avg>2.5<\/weight_avg>/);
  assert.match(xmlOf(el), /<keff_trigger><type>rel_err<\/type><threshold>2.5<\/threshold><\/keff_trigger>/);
  assert.match(xmlOf(el), /<temperature_range>300 900<\/temperature_range>/);
});

test("unmodelled elements and children are kept; cleared values are removed", () => {
  const [base] = parseXML(`<settings><run_mode>fixed source</run_mode><particles>10</particles><batches>2</batches>
    <cutoff><weight>0.1</weight><time_photon>5</time_photon></cutoff><entropy_mesh>1</entropy_mesh><mesh id="1"/></settings>`);
  const { values } = readSettings(base);
  assert.equal(values.run_mode, "fixed source");
  assert.equal(values["cutoff.weight"], 0.1);
  delete values["cutoff.weight"];
  values.particles = 500;
  const out = xmlOf(applySettings(base, values));
  assert.match(out, /<particles>500<\/particles>/);
  assert.match(out, /<cutoff><time_photon>5<\/time_photon><\/cutoff>/, "unmodelled cutoff child kept, cleared weight removed");
  assert.match(out, /<entropy_mesh>1<\/entropy_mesh><mesh id="1"\/>/);
});

test("validation", () => {
  const errs = (v) => validateSettings(v).errors.join(" | ");
  assert.match(errs({ run_mode: "eigenvalue", particles: 10 }), /batches/);
  assert.match(errs({ run_mode: "eigenvalue", particles: 10, batches: 5, inactive: 5 }), /inactive/);
  assert.match(errs({ run_mode: "eigenvalue", particles: 10, batches: 5, "keff_trigger.type": "std_dev" }), /threshold/);
  assert.match(errs({ run_mode: "eigenvalue", particles: 10, batches: 5, "trigger.active": true }), /max batches/);
  assert.match(errs({ run_mode: "plot", verbosity: 11 }), /at most 10/);
  assert.equal(errs({ run_mode: "plot" }), "");
  assert.match(validateSettings({ run_mode: "fixed source", particles: 1, batches: 1 }).warnings.join(), /no source/);
  assert.equal(validateSettings({ run_mode: "fixed source", particles: 1, batches: 1 }, { sources: 1 }).warnings.length, 0);
  assert.equal(fieldApplies(SETTINGS_FIELDS.find((f) => f.key === "inactive"), { run_mode: "fixed source" }), false);
});

test("model.xml settings are edited and written back", () => {
  const { scene } = importOpenMC(`<model><geometry><surface id="1" type="sphere" coeffs="0 0 0 5" boundary="vacuum"/><cell id="1" material="void" region="-1"/></geometry>
    <settings><run_mode>eigenvalue</run_mode><particles>100</particles><batches>20</batches><inactive>5</inactive><ptables>false</ptables></settings></model>`);
  assert.deepEqual(scene.settings.values, { run_mode: "eigenvalue", particles: 100, batches: 20, inactive: 5 });
  scene.settings.values.batches = 50;
  scene.settings.values.photon_transport = true;
  const model = exportOpenMC(scene).model.replace(/>\s+</g, "><");
  assert.match(model, /<batches>50<\/batches>/);
  assert.match(model, /<photon_transport>true<\/photon_transport>/);
  assert.match(model, /<ptables>false<\/ptables>/, "unmodelled element kept");
  assert.equal((model.match(/<batches>/g) ?? []).length, 1);
  // Scenes saved before the Settings tab read the kept settings.
  const json = JSON.parse(JSON.stringify(scene));
  delete json.settings;
  assert.equal(Scene.fromJSON(json).settings.values.batches, 20);
});

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

test("corpus: ICSBEP settings round-trip", async (t) => {
  const files = await filesUnder(new URL("../knowledge/benchmarks/icsbep", import.meta.url).pathname, (f) => f === "settings.xml");
  if (!files.length) return t.skip("knowledge/ not present");
  for (const file of files) {
    const [el] = parseXML(await readFile(file, "utf8"));
    const { values } = readSettings(el);
    const again = applySettings(el, values);
    assert.deepEqual(readSettings(again).values, values, file);
    // Every element survives (modelled ones rewritten, others kept).
    assert.deepEqual(new Set(again.children.map((c) => c.name)), new Set(el.children.map((c) => c.name)), file);
  }
  t.diagnostic(`${files.length} settings files`);
});

test("fields that do not apply to the run mode are not written", () => {
  const values = { run_mode: "fixed source", particles: 10, batches: 5, inactive: 3, "keff_trigger.type": "std_dev", "keff_trigger.threshold": 0.01 };
  const out = xmlOf(applySettings(null, values));
  assert.doesNotMatch(out, /inactive|keff_trigger/);
  values.run_mode = "eigenvalue";
  assert.match(xmlOf(applySettings(null, values)), /<inactive>3<\/inactive>.*<keff_trigger>/);
});
