// Co-simulation vectors (P6 of WEFT-001): the port changes the Go side replays against the RTL and the netlist.
// node --test app/test/vectors.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { vectors, VECTORS_SCHEMA, DEFAULT_COSIM_HZ } from "../src/core/vectors.js";
import { HwError } from "../src/core/hardware.js";

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, "../../examples");
const example = (prefix) => {
  const f = readdirSync(examples).find((x) => x.startsWith(prefix));
  return { file: f, src: readFileSync(join(examples, f), "utf8") };
};
const vec = (prefix, opt = {}) => { const { file, src } = example(prefix); return vectors(src, { file, ...opt }); };
const portIndex = (v, name) => v.bundle.ports.findIndex((p) => p.name === name);

test("F-01 at 1 MHz: the LED toggles every 250,000 cycles from cycle 250,001", async () => {
  const v = await vec("F-01");
  assert.equal(v.schema, VECTORS_SCHEMA);
  assert.equal(v.cosimHz, DEFAULT_COSIM_HZ);
  assert.equal(v.bundle.clocks.length, 1);
  assert.equal(v.bundle.clocks[0].hz, 1e6);
  assert.equal(v.skip, undefined);
  const [s] = v.scenarios;
  assert.equal(s.cycles, 1_100_000);
  assert.equal(s.sim.status, "pass");
  const led = portIndex(v, "led");
  assert.deepEqual(s.changes.filter((c) => c[1] === led).map((c) => c[0]), [250001, 500001, 750001, 1000001]);
  assert.deepEqual(s.changes.filter((c) => c[1] === led).map((c) => c[2]), ["1", "0", "1", "0"]);
});

test("changes are ordered by cycle and hex-encoded", async () => {
  const v = await vec("F-02");
  for (const s of v.scenarios.filter((x) => !x.skip)) {
    let prev = 0;
    for (const [c, p, h] of s.changes) {
      assert.ok(c >= prev && c >= 1 && c <= s.cycles, `${s.name}: cycle ${c}`);
      assert.ok(p >= 0 && p < v.bundle.ports.length);
      assert.match(h, /^[0-9a-f]+$/);
      prev = c;
    }
  }
});

test("a scenario that pokes internals is skipped with a reason", async () => {
  const v = await vec("F-02");
  const skipped = v.scenarios.filter((s) => s.skip);
  assert.ok(skipped.length >= 1);
  assert.match(skipped[0].skip, /poke/);
  assert.ok(v.scenarios.some((s) => !s.skip && s.changes.length > 0));
});

test("scenario selects one scenario, and an unknown name is refused", async () => {
  const all = await vec("F-02");
  const name = all.scenarios.find((s) => !s.skip).name;
  const one = await vec("F-02", { scenario: name });
  assert.deepEqual(one.scenarios.map((s) => s.name), [name]);
  await assert.rejects(vec("F-02", { scenario: "no such scenario" }), (e) => e instanceof HwError && e.code === "scenario");
});

const TWO_DOMAINS = `
const a = module("a").out("led", bit).every("250ms", $ => { $.led = !$.led; }).bind({ led: "led:0" });
const b = module("b").domain("fast").out("led", bit).every("250ms", $ => { $.led = !$.led; }).bind({ led: "led:1" });
return design("two").board("pico")
  .clocks(c => c.pin("sys", "clk").pll("fast", { from: "sys", hz: "25 MHz", tolerance: "1%" }))
  .use(a, b);`;

test("a design with several clock domains is skipped as a whole", async () => {
  const v = await vectors(TWO_DOMAINS, { file: "two.js" });
  assert.equal(v.bundle.clocks.length, 2);
  assert.match(v.skip, /clock domains/);
  assert.deepEqual(v.scenarios, []);
});

test("a design that cannot go to the board is refused, not recorded", async () => {
  await assert.rejects(vec("F-05"), (e) => e instanceof HwError);
});
