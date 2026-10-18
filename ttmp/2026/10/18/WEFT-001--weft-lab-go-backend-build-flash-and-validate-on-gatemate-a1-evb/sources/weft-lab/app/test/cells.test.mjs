// Native cells and the scenario runner on hand-built designs (owner C)
import { Graph } from "../src/core/ir.js";
import { u, s, bit, struct } from "../src/core/types.js";
import { Sim } from "../src/core/sim.js";
import { runScenario, recorder } from "../src/core/scenario.js";

let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log("FAIL", msg); } };
const base = (domains, extra = {}) => ({ ok: true, diags: [], name: "t", board: { profile: "dev", mainHz: 100e6, resources: {} }, domains, instances: [], streams: [], pins: [], knobs: [], cells: [], asserts: [], scenarios: [], hosts: [], groups: [], ...extra });
const steps = (fn) => { const r = recorder(); fn(r); return r.steps; };
const inc = (g, r, T) => g.add("wrap", [g.add("add", [r, g.const(1, bit)], u(T.w + 1))], T);

// ---------- F-05: debounce cell → lights module, an inverted switch, four LEDs of eight
{
  const g = new Graph("sys", 100e6);
  const P = struct({ id: u(2), long: bit });
  const pv = g.input("presses.valid", bit, { src: "cell" }), pd = g.input("presses.data", P, { src: "cell" });
  const held = g.input("buttons.held", u(4), { src: "cell" });
  const pr = g.const(1, bit);
  const leds = g.reg("lights.leds", u(8), { module: "lights", name: "leds" });
  const sw = g.input("lights.invert.pin", bit, { src: "pin" });
  const s1 = g.reg("lights.__sync0", bit), s2 = g.reg("lights.__sync1", bit), s3 = g.reg("lights.__prev", bit);
  g.setNext(s1, sw); g.setNext(s2, s1); g.setNext(s3, s2);
  const rise = g.add("land", [s2, g.add("lnot", [s3], bit)], bit);
  const fire = g.add("land", [pv, pr], bit);
  const id = g.add("field", [pd], u(2), { name: "id" }), long = g.add("field", [pd], bit, { name: "long" });
  const mask = g.add("wrap", [g.add("shl", [g.const(1, u(8)), id], u(11))], u(8));
  const toggled = g.add("xor", [leds, mask], u(8));
  const onPress = g.add("mux", [long, g.const(0, u(8)), toggled], u(8));
  const onRise = g.add("not", [leds], u(8));
  g.setNext(leds, g.add("mux", [rise, onRise, g.add("mux", [fire, onPress, leds], u(8))], u(8)));
  const o = g.output("lights.leds", leds);
  const c = base({ sys: { hz: 100e6, graph: g } }, {
    pins: [...Array.from({ length: 8 }, (_, i) => ({ resource: `led:${i}`, dir: "out", domain: "sys", node: o, bit: i })), { resource: "sw:0", dir: "in", domain: "sys", node: sw, bit: 0 }],
    cells: [{ path: "buttons", kind: "debounce", domain: "sys", params: { settleMs: 10, longMs: 500, n: 4 }, pins: { raw: "btn:0..3" },
      io: { "presses.valid": { dir: "drive", node: pv, domain: "sys" }, "presses.data": { dir: "drive", node: pd, domain: "sys" }, "presses.ready": { dir: "read", node: pr, domain: "sys" }, held: { dir: "drive", node: held, domain: "sys" } } }],
    streams: [{ name: "presses", type: P, domain: "sys", signals: { valid: pv, data: pd, ready: pr }, dropped: null }],
    scenarios: [{ name: "toggle, invert, clear", kind: "steps", steps: steps((sc) => sc
      .press("btn:2").wait("20ms").expectPins("led:0..7", 0b0000_0100)
      .press("btn:0", { bounce: "3ms" }).wait("20ms").expectPins("led:0..7", 0b0000_0101)
      .toggle("sw:0").wait("1ms").expectPins("led:0..7", 0b1111_1010)
      .press("btn:1", { for: "600ms" }).wait("20ms").expectPins("led:0..7", 0)) }],
  });
  const t0 = performance.now();
  const r = await runScenario(c, "toggle, invert, clear");
  ok(r.status === "pass", "F-05 flow: " + r.message + " " + r.steps.map((x) => `${x.label}:${x.ok}:${x.note}`).join(" | "));
  console.log(`debounce scenario: ${r.status}, ${r.simTime.toFixed(0)} ms simulated in ${(performance.now() - t0).toFixed(0)} ms`);
}

// ---------- a UART line from a pin (F-06's fsm transmitter, as a shift register at 115200 on 12 MHz)
{
  const g = new Graph("sys", 12e6), DIV = 104;
  const cnt = g.reg("tx.wait", u(16)), sh = g.reg("tx.shift", u(10), { init: 0x3ff }), n = g.reg("tx.n", u(4));
  const msg = [..."hi\n"].map((ch) => ch.charCodeAt(0));
  const idx = g.reg("tx.i", u(3));
  const tick = g.add("eq", [cnt, g.const(DIV - 1)], bit);
  g.setNext(cnt, g.add("mux", [tick, g.const(0, u(16)), inc(g, cnt, u(16))], u(16)));
  const idle = g.add("eq", [n, g.const(0, bit)], bit);
  const more = g.add("lt", [idx, g.const(msg.length)], bit);
  const load = g.add("land", [g.add("land", [tick, idle], bit), more], bit);
  const ch = g.add("rom", [idx], u(8), { table: msg });
  const frame = g.add("concat", [g.const(1, bit), ch, g.const(0, bit)], u(10));
  const shifted = g.add("concat", [g.const(1, bit), g.add("slice", [sh], u(9), { lo: 1, hi: 9 })], u(10));
  g.setNext(sh, g.add("mux", [load, frame, g.add("mux", [g.add("land", [tick, g.add("lnot", [idle], bit)], bit), shifted, sh], u(10))], u(10)));
  g.setNext(n, g.add("mux", [load, g.const(10, u(4)), g.add("mux", [g.add("land", [tick, g.add("lnot", [idle], bit)], bit), g.add("wrap", [g.add("sub", [n, g.const(1, bit)], s(5))], u(4)), n], u(4))], u(4)));
  g.setNext(idx, g.add("mux", [load, inc(g, idx, u(3)), idx], u(3)));
  const line = g.output("tx.line", g.add("mux", [idle, g.const(1, bit), g.add("slice", [sh], bit, { lo: 0, hi: 0 })], bit));
  const c = base({ sys: { hz: 12e6, graph: g } }, { pins: [{ resource: "uart.tx", dir: "out", domain: "sys", node: line, bit: 0 }],
    scenarios: [{ name: "says hi", kind: "steps", steps: steps((sc) => sc.expectUart("uart", "hi\n", { within: "2ms", baud: 115_200 })) }] });
  const r = await runScenario(c, "says hi");
  ok(r.status === "pass", "uart pin decode: " + r.message);
}

// ---------- video: timing + hdmi cells, a 16 × 16 sprite drawn combinationally and through a register
for (const registered of [false, true]) {
  const g = new Graph("pix", 25.175e6);
  const BEAM = struct({ x: u(10), y: u(10), visible: bit }), PIX = struct({ r: u(8), g: u(8), b: u(8) });
  const bv = g.input("beam.valid", bit, { src: "cell" }), bd = g.input("beam.data", BEAM, { src: "cell" }), br = g.const(1, bit);
  const x = g.add("field", [bd], u(10), { name: "x" }), y = g.add("field", [bd], u(10), { name: "y" });
  const dx = g.add("sub", [x, g.const(40)], s(11)), dy = g.add("sub", [y, g.const(30)], s(11));
  const inside = g.add("land", [g.add("land", [g.add("ge", [dx, g.const(0, bit)], bit), g.add("lt", [dx, g.const(16)], bit)], bit), g.add("land", [g.add("ge", [dy, g.const(0, bit)], bit), g.add("lt", [dy, g.const(16)], bit)], bit)], bit);
  const blue = g.add("pack", [g.const(0, u(8)), g.const(0, u(8)), g.add("zext", [g.add("slice", [y], u(8), { lo: 1, hi: 8 })], u(8))], PIX);
  let px = g.add("mux", [inside, g.const(0xffc800, u(24)), blue], PIX), pvld = bv;
  if (registered) { const r1 = g.reg("raster.px", PIX), r2 = g.reg("raster.v", bit); g.setNext(r1, px); g.setNext(r2, bv); px = r1; pvld = r2; }
  const pr = g.input("pixels.ready", bit, { src: "cell" });
  const c = base({ pix: { hz: 25.175e6, graph: g } }, {
    cells: [
      { path: "beam", kind: "video-timing", domain: "pix", params: { mode: "640x480@60" }, io: { "beam.valid": { dir: "drive", node: bv, domain: "pix" }, "beam.data": { dir: "drive", node: bd, domain: "pix" }, "beam.ready": { dir: "read", node: br, domain: "pix" } } },
      { path: "hdmi", kind: "hdmi", domain: "pix", params: {}, pins: { tmds: "hdmi" }, io: { "pixels.valid": { dir: "read", node: pvld, domain: "pix" }, "pixels.data": { dir: "read", node: px, domain: "pix" }, "pixels.ready": { dir: "drive", node: pr, domain: "pix" } } },
    ],
    scenarios: [{ name: "sprite", kind: "steps", steps: steps((sc) => sc.wait("40ms").expectFrame("hdmi", (f) => f.count({ r: 255, g: 200, b: 0 }) === 256 && f.at(40, 30).r === 255 && f.at(39, 30).r === 0 && f.at(0, 479).b === 239)) }],
  });
  const t0 = performance.now();
  const r = await runScenario(c, "sprite");
  const ms = performance.now() - t0;
  ok(r.status === "pass", `video (${registered ? "registered" : "combinational"} pixel): ${r.message}`);
  console.log(`video ${registered ? "registered" : "combinational"}: ${r.status}, 40 ms of 25.175 MHz (1.0 M pixel clocks) in ${ms.toFixed(0)} ms = ${(1.007e6 / ms / 1e3).toFixed(1)} M cycles/s`);
}

// ---------- an async FIFO crossing sys → pix carrying a counter
{
  const sys = new Graph("sys", 100e6), pix = new Graph("pix", 25e6);
  const seq = sys.reg("p.seq", u(16));
  const iv = sys.const(1, bit), ir = sys.input("q.in.ready", bit, { src: "cell" });
  sys.setNext(seq, sys.add("mux", [ir, inc(sys, seq, u(16)), seq], u(16)));
  const ov = pix.input("q.out.valid", bit, { src: "cell" }), od = pix.input("q.out.data", u(16), { src: "cell" }), orr = pix.const(1, bit);
  const last = pix.reg("c.last", u(16), { init: 0xffff }), gaps = pix.reg("c.gaps", u(16));
  const fire = pix.add("land", [ov, orr], bit);
  pix.setNext(last, pix.add("mux", [fire, od, last], u(16)));
  pix.setNext(gaps, pix.add("mux", [pix.add("land", [fire, pix.add("ne", [od, inc(pix, last, u(16))], bit)], bit), inc(pix, gaps, u(16)), gaps], u(16)));
  const c = base({ sys: { hz: 100e6, graph: sys }, pix: { hz: 25e6, graph: pix } }, {
    cells: [{ path: "q", kind: "xfifo", domain: "sys", params: { depth: 16, policy: "block", from: "sys", to: "pix" },
      io: { "in.valid": { dir: "read", node: iv, domain: "sys" }, "in.data": { dir: "read", node: seq, domain: "sys" }, "in.ready": { dir: "drive", node: ir, domain: "sys" },
        "out.valid": { dir: "drive", node: ov, domain: "pix" }, "out.data": { dir: "drive", node: od, domain: "pix" }, "out.ready": { dir: "read", node: orr, domain: "pix" } } }],
  });
  const sim = new Sim(c, { waves: false });
  sim.runFor("10us");
  const st = sim.state("c");
  ok(st.gaps === 0 && st.last > 200, "block FIFO crossing is lossless: " + JSON.stringify(st));
}
console.log(fails ? `cells: ${fails} FAILED` : "cells ok");
process.exit(fails ? 1 : 0);
