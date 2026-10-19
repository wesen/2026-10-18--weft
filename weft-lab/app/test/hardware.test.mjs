// GateMate profile, PLL solver and hardware bundles (P3 of WEFT-001).
// node --test app/test/hardware.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { compile, solvePll } from "../src/core/compile.js";
import { gatematePll } from "../src/core/gatemate-pll.js";
import { buildBundle, HwError, HW_BUNDLE_SCHEMA } from "../src/core/hardware.js";

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, "../../examples");
const example = (prefix) => {
  const f = readdirSync(examples).find((x) => x.startsWith(prefix));
  return { file: f, src: readFileSync(join(examples, f), "utf8") };
};
const forBoard = (prefix) => { const { file, src } = example(prefix); return compile(src, { board: "gatemate-a1-evb", file }); };
const refusal = (fn) => { try { fn(); } catch (e) { if (e instanceof HwError) return e; throw e; } assert.fail("expected an HwError"); };

// "PLL fout=" values nextpnr-himbaechel (0.11.1-9) printed for REF_CLK 10.0 (scripts/03-pll-probe/run.sh)
const NEXTPNR_SPEED = { 1.0: 1.0, 7.3728: 7.3718, 12.0: 12.0, 24.0: 24.0, 25.175: 25.2083, 33.333: 33.3333, 37.5: 37.5, 48.0: 48.0, 50.0: 50.0, 66.0: 65.8333, 100.0: 100.0, 125.0: 125.0, 133.0: 132.5 };

test("gatematePll reproduces nextpnr's PLL fout", () => {
  for (const [want, got] of Object.entries(NEXTPNR_SPEED)) assert.equal(gatematePll(10, +want).fcore.toFixed(4), got.toFixed(4), `${want} MHz`);
  assert.equal(gatematePll(10, 25.175, { mode: 2 }).fcore.toFixed(4), "25.2778"); // ECONOMY
  assert.equal(gatematePll(10, 500), null);                                       // above SPEED's 416.75 MHz
});

test("solvePll uses the GateMate solver for the gatemate family", () => {
  const s = solvePll(10e6, 25.175e6, "gatemate");
  assert.equal(Math.round(s.hz), 25208333);
  assert.deepEqual([s.n1, s.n2, s.m1, s.m2, s.pdiv1], [11, 11, 2, 12, 2]);
});

test("examples compile against gatemate-a1-evb on its 10 MHz clock", () => {
  const c = forBoard("F-01");
  assert.deepEqual(c.diags.filter((d) => d.level === "error"), []);
  assert.equal(c.board.profile, "gatemate-a1-evb");
  assert.equal(c.board.part, "ccgm1a1");
  assert.equal(c.domains.sys.hz, 10e6);
  assert.equal(c.report.family, "gatemate");
});

test("a missing resource is a compile error naming the board", () => {
  const c = forBoard("F-10");
  assert.ok(c.diags.some((d) => d.level === "error" && /gatemate-a1-evb board has no hdmi/.test(d.message)));
  assert.equal(Math.round(c.domains.pix.hz), 25208333, "the pix PLL gets the frequency the board will run at");
});

test("the unknown-board message lists every profile", () => {
  const c = compile(`return design("x").board("nope").use(module("m").out("o", bit).bind({ o: "led:0" }));`);
  const msg = c.diags.find((d) => d.code === "board")?.message || "";
  assert.match(msg, /gatemate-a1-evb/);
});

test("F-01 bundle", () => {
  const b = buildBundle(forBoard("F-01"));
  assert.equal(b.schema, HW_BUNDLE_SCHEMA);
  assert.equal(b.top, "blinky");
  assert.equal(b.board, "gatemate-a1-evb");
  assert.deepEqual(b.files.map((f) => [f.path, !!f.top]), [["blinky_sys.v", false], ["blinky.v", true]]);
  assert.deepEqual(b.clocks, [{ domain: "sys", port: "clk_sys", hz: 10e6, kind: "board", main: true }]);
  assert.deepEqual(b.ports, [{ name: "led", dir: "out", width: 1, indexed: true, bits: [{ bit: 0, resource: "led:0", kind: "led", domain: "sys" }] }]);
  assert.deepEqual(b.scenarios.map((s) => [s.name, s.portable]), [["blinks at 2 Hz", true]]);
  assert.match(b.files[1].text, /module blinky \(/);
});

test("port bits follow pinParts, not the DAG bit, and width is the highest index + 1", () => {
  const src = `
    const m = module("m").out("a", u(2)).out("b", bit)
      .seq($ => { $.a = wrap($.a + 1); $.b = !$.b; })
      .bind({ a: "led:7..6", b: "led:3" });
    return design("pins").board("gatemate-a1-evb").use(m);`;
  const b = buildBundle(compile(src, { board: "gatemate-a1-evb" }));
  const led = b.ports.find((p) => p.name === "led");
  assert.equal(led.width, 8);
  assert.deepEqual(led.bits.map((x) => [x.bit, x.resource]), [[3, "led:3"], [6, "led:6"], [7, "led:7"]]);
});

const SIGMA_DELTA = `
const tone = module("tone").provides("pcm").regs({ x: s(16) }).every("1ms", $ => { $.x = wrap(-$.x); $.push("pcm", $.x); });
return design("beep").board("pico").use(tone, std.sigmaDelta("dac").bind({ out: "led:1" }).needs("pcm"));`;

test("cells with a core get an adapter; the bundle names the core", () => {
  const f05 = buildBundle(forBoard("F-05"));
  const cells05 = f05.files.find((f) => f.path === "weft_cells.v").text;
  assert.deepEqual(f05.cells.map((c) => [c.kind, c.module]), [["debounce", "weft_core_debounce"]]);
  assert.ok(!cells05.includes("(* blackbox *)"));
  assert.match(cells05, /weft_core_debounce #\(\.N\(4\), \.ID_W\(2\), \.LONG_CYC\(LONG_CYC\), \.SETTLE_CYC\(SETTLE_CYC\)\) core/);
  assert.match(cells05, /\.ev_id\(presses_data\[2:1\]\),\s+\.ev_long\(presses_data\[0\]\)/);
  const top05 = f05.files.find((f) => f.top).text;
  assert.match(top05, /weft_debounce #\(\.LONG_CYC\(5000000\), \.SETTLE_CYC\(100000\)\) u_buttons/, "10 ms and 500 ms at 10 MHz");

  const f16 = buildBundle(forBoard("F-16"));
  const cells16 = f16.files.find((f) => f.path === "weft_cells.v").text;
  assert.deepEqual(f16.cells.map((c) => c.module), ["weft_core_uart_rx", "weft_core_uart_tx"]);
  assert.match(cells16, /weft_core_uart_rx #\(\.BAUD\(BAUD\), \.CLK_HZ\(CLK_HZ\)\) core/);
  assert.match(cells16, /\.m_valid\(rx_bytes_valid\)/);
  assert.match(cells16, /\.s_ready\(tx_bytes_ready\),\s+\.tx\(tx\)/);
  assert.match(f16.files.find((f) => f.top).text, /weft_uart_tx #\(\.BAUD\(115200\), \.CLK_HZ\(10000000\)\) u_tx \([\s\S]*?\.tx\(uart_tx\)\n  \);/);
  assert.deepEqual(f16.ports.find((p) => p.name === "uart_tx").bits[0], { bit: 0, resource: "uart.tx", kind: "uart", domain: "sys", cell: "tx" });
});

test("designs that cannot go to hardware are refused with a named reason", () => {
  assert.equal(refusal(() => buildBundle(forBoard("F-13"))).code, "bare-part");
  assert.equal(refusal(() => buildBundle(forBoard("F-14"))).code, "bare-part");
  assert.equal(refusal(() => buildBundle(forBoard("F-11"))).code, "bare-part");
  assert.equal(refusal(() => buildBundle(compile(SIGMA_DELTA, { board: "gatemate-a1-evb", file: "beep.js" }))).code, "cells", "sigma-delta has no core");
  assert.equal(refusal(() => buildBundle(forBoard("F-10"))).code, "compile");
  const { src } = example("F-11");
  assert.equal(refusal(() => buildBundle(compile(src))).code, "board", "a simulation-only compile has no board");
});

test("every example bundles or fails with a named reason", () => {
  const ok = [];
  for (const f of readdirSync(examples).filter((x) => /^F-\d+.*\.js$/.test(x)).sort()) {
    const c = compile(readFileSync(join(examples, f), "utf8"), { board: "gatemate-a1-evb", file: f });
    try { buildBundle(c); ok.push(f.slice(0, 4)); }
    catch (e) { assert.ok(e instanceof HwError && e.code && e.message, `${f}: ${e.stack}`); }
  }
  for (const id of ["F-01", "F-02", "F-05", "F-06", "F-16"]) assert.ok(ok.includes(id), `${id} should bundle (bundled: ${ok.join(", ")})`);
});
