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
  await assert.rejects(vec("F-10"), (e) => e instanceof HwError && e.code === "compile");
});

// designs with cells are cut at the cell boundary: the domain module is the device under test
test("F-05 is cut at its debounce cell: presses come in as inputs, the raw buttons go out", async () => {
  const v = await vec("F-05");
  assert.equal(v.dut.module, "lights_sys");
  assert.equal(v.dut.file, "lights_sys.v");
  const at = (name) => v.dut.ports.findIndex((p) => p.name === name);
  const port = (name) => v.dut.ports[at(name)];
  assert.deepEqual(port("presses_valid"), { name: "presses_valid", dir: "in", width: 1 });
  assert.deepEqual(port("x_54"), { name: "x_54", dir: "out", width: 4, check: true });   // raw, read by the cell
  const [s] = v.scenarios;
  assert.equal(s.sim.status, "pass");
  const ch = (name) => s.changes.filter((c) => c[1] === at(name));
  // btn:2 pressed at cycle 1; the cell's held output follows 10 ms (10,000 cycles at 1 MHz) later
  assert.deepEqual(ch("pin_btn_0_btn_1_btn_2_btn_3")[0], [1, at("pin_btn_0_btn_1_btn_2_btn_3"), "4"]);
  assert.deepEqual(ch("buttons_held")[0], [10002, at("buttons_held"), "4"]);
  // the release yields { id: 2, long: 0 } = 0b100, and the LEDs follow
  const ev = ch("presses_valid")[0][0];
  assert.deepEqual(ch("presses_data")[0], [ev, at("presses_data"), "4"]);
  assert.ok(ch("o_pin_led_0_led_1_led_2_led_3_led_4_led_5_led_6_led_7").some(([c, , x]) => c > ev && x === "4"));
});

test("F-16 is cut at its uart cells: rx bytes in, tx bytes out, the uart.tx pin not at all", async () => {
  const v = await vec("F-16");
  assert.equal(v.dut.module, "shout_sys");
  assert.ok(!v.dut.ports.some((p) => /uart_tx/.test(p.name)), "a cell-owned pin is not a domain-module port");
  const at = (name) => v.dut.ports.findIndex((p) => p.name === name);
  const [s] = v.scenarios;
  const first = (name, hex) => s.changes.find((c) => c[1] === at(name) && c[2] === hex)?.[0];
  const rx = first("rx_bytes_data", "68"), tx = first("x_7", "48");   // "h" in, "H" out
  assert.ok(rx > 0 && tx > rx && tx - rx <= 4, `h at ${rx}, H at ${tx}`);
  assert.deepEqual(s.changes.find((c) => c[1] === at("tx_bytes_out_ready")), [1, at("tx_bytes_out_ready"), "1"], "the tx cell is ready from the start");
});
