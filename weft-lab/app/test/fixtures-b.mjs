// Hand-built DAGs shaped like the examples' (fork B tests and the Verilog co-simulation harness).
import { Graph } from "../src/core/ir.js";
import { u, s, bit, binType, shiftType, join } from "../src/core/types.js";
export const O = (line, src) => ({ file: "design.js", line, col: 1, src });
export function counter() {
  const g = new Graph("sys", 12e6);
  const en = g.input("counter.en", bit, { src: "pin", module: "counter" });
  const dn = g.input("counter.down", bit, { src: "pin", module: "counter" });
  const v = g.reg("counter.value", u(8), { module: "counter", name: "value" }, O(14, ".regs({ value: u(8) })"));
  const one = g.const(1);
  const zero = g.const(0);
  const dec = g.add("sub", [v, one], binType("sub", u(8), u(1)), { module: "counter" }, O(18, "$.value - 1"));
  const inc = g.add("add", [v, one], binType("add", u(8), u(1)), { module: "counter" }, O(18, "$.value + 1"));
  const incz = g.add("add", [inc, zero], binType("add", binType("add", u(8), u(1)), u(1)), { module: "counter" }, O(19, "+ 0"));   // constFold removes
  const sel = g.add("mux", [dn, dec, incz], join(g.node(dec).type, g.node(incz).type), { module: "counter" }, O(18, "$.down ? … : …"));
  const w = g.add("wrap", [sel], u(8), { module: "counter" }, O(18, "+="));
  const nx = g.add("mux", [en, w, v], u(8), { module: "counter" }, O(17, "if ($.en)"));
  g.setNext(v, nx);
  const folded = g.add("mul", [g.const(3), g.const(4)], u(5), {}, O(20, "3 * 4"));   // dead, and foldable
  void folded;
  const leds = g.output("counter.leds", v, { module: "counter" });
  const pins = [...Array(8).keys()].map((i) => ({ resource: `led:${i}`, dir: "out", domain: "sys", node: leds, bit: i, instance: "counter", port: "leds" }));
  pins.push({ resource: "btn:0", dir: "in", domain: "sys", node: en, bit: 0 }, { resource: "btn:1", dir: "in", domain: "sys", node: dn, bit: 0 });
  return { g, ids: { v, en, dn, nx, leds }, pins };
}

export function mac(hz = 250e6) {
  const g = new Graph("sys", hz);
  const a = g.input("mac.a", s(18), { src: "port", module: "mac" }, O(13, ".in({ a: s(18) })"));
  const b = g.input("mac.b", s(18), { src: "port", module: "mac" }, O(13, ".in({ b: s(18) })"));
  const clear = g.input("mac.clear", bit, { src: "port", module: "mac" });
  const acc = g.reg("mac.acc", s(48), { module: "mac", name: "acc" }, O(14, '.out("acc", s(48))'));
  const m = g.add("mul", [a, b], binType("mul", s(18), s(18)), { module: "mac" }, O(17, "$.a * $.b"));
  const se = g.add("sext", [m], s(48), { module: "mac" }, O(17, "$.a * $.b"));
  const add = g.add("add", [acc, se], binType("add", s(48), s(48)), { module: "mac" }, O(17, "$.acc += $.a * $.b"));
  const wr = g.add("wrap", [add], s(48), { module: "mac" }, O(17, "+="));
  const nx = g.add("mux", [clear, g.const(0, s(48)), wr], s(48), { module: "mac" }, O(16, "if ($.clear)"));
  g.setNext(acc, nx);
  g.output("mac.acc", acc, { module: "mac" });
  return g;
}

export function fir(taps = [3, -5, 7, 9, 7, -5, 3], hz = 100e6) {
  const g = new Graph("sys", hz);
  const x = g.input("fir.in.data", s(16), { src: "port", module: "fir" });
  const z = taps.slice(1).map((_, i) => g.reg(`fir.z[${i}]`, s(16), { module: "fir", name: `z${i}` }));
  z.forEach((r, i) => g.setNext(r, i === 0 ? x : z[i - 1]));
  let acc = g.add("mul", [x, g.const(taps[0])], binType("mul", s(16), g.node(g.const(taps[0])).type), { module: "fir" }, O(36, "x * H[0]"));
  for (let i = 1; i < taps.length; i++) {
    const k = g.const(taps[i]);
    const m = g.add("mul", [z[i - 1], k], binType("mul", s(16), g.node(k).type), { module: "fir" }, O(37, "$.z[i - 1] * H[i]"));
    acc = g.add("add", [acc, m], binType("add", g.node(acc).type, g.node(m).type), { module: "fir" }, O(37, "acc + …"));
  }
  const sh = g.add("shr", [acc, g.const(4)], shiftType("shr", g.node(acc).type, 4), { module: "fir" }, O(38, "acc >> 15"));
  const y = g.add("sat", [sh], s(16), { module: "fir" }, O(38, "sat(acc >> 15, s(16))"));
  const out = g.reg("fir.out.data", s(16), { module: "fir" });
  g.setNext(out, y);
  g.output("fir.out", out, { module: "fir" });
  return g;
}

export function scaler(n = 8) {
  const g = new Graph("sys", 48e6);
  const x = g.input("scaler.x", u(16), { src: "port", module: "scaler" });
  const en = g.input("scaler.en", bit, { src: "port", module: "scaler" });
  const nowv = g.input("scaler.now", u(48), { src: "port", module: "scaler" });
  const dl = g.input("scaler.deadline", u(48), { src: "port", module: "scaler" });
  const go = g.reg("scaler.go", bit, { module: "scaler", name: "go" });
  g.setNext(go, en);
  for (let i = 0; i < n; i++) {
    const y = g.reg(`scaler.y[${i}]`, u(20), { module: "scaler" });
    const xi = g.add("xor", [x, g.const(i)], u(16), { module: "scaler" }, O(49, "$.x ^ i"));
    const m = g.add("mul", [xi, g.const(8)], binType("mul", u(16), u(4)), { module: "scaler" }, O(49, "($.x ^ i) * 8"));
    const nn = g.add("not", [g.add("not", [m], u(20), { module: "scaler" })], u(20), { module: "scaler" }, O(49, "~~"));
    g.setNext(y, g.add("mux", [go, nn, y], u(20), { module: "scaler" }, O(49, "if ($.go)")));
    g.output(`scaler.y${i}`, y, { module: "scaler" });
  }
  const late = g.add("gt", [nowv, dl], bit, { module: "scaler" }, O(51, "$.now > $.deadline"));
  g.output("scaler.late", late, { module: "scaler" });
  return g;
}

export function echo() {
  const g = new Graph("sys", 100e6);
  const dry = g.input("dry.data", s(12), { src: "port" });
  const valid = g.input("dry.valid", bit, { src: "port" });
  const at = g.reg("echo.at", u(13), { module: "echo" });
  const mem = g.add("mem", [], s(12), { path: "echo.delay", words: 8192, elem: s(12), module: "echo" });
  const atn = g.add("wrap", [g.add("add", [at, g.const(1)], u(14))], u(13), { module: "echo" });
  const rd = g.add("memrd", [mem, atn, valid], s(12), { module: "echo" });
  const y = g.add("sat", [g.add("add", [dry, g.add("shr", [rd, g.const(1)], s(11))], s(13))], s(12), { module: "echo" });
  g.add("memwr", [mem, at, y, valid], s(12), { module: "echo" });
  g.setNext(at, g.add("mux", [valid, atn, at], u(13)));
  const wet = g.reg("echo.wet", s(12), { module: "echo" });
  g.setNext(wet, y);
  g.output("wet", wet);
  const phase = g.reg("osc.phase", u(10), { module: "osc" });
  g.setNext(phase, g.add("wrap", [g.add("add", [phase, g.const(1)], u(11))], u(10)));
  const table = Array.from({ length: 1024 }, (_, i) => Math.round(2047 * Math.sin((2 * Math.PI * i) / 1024)));
  const sine = g.add("rom", [phase], s(12), { table, module: "osc", path: "osc.SINE" });
  const sample = g.reg("osc.sample", s(12), { module: "osc" });
  g.setNext(sample, sine);
  g.output("dry", sample);
  return g;
}

export function blend(hz = 300e6) {
  const g = new Graph("fast", hz);
  const fg = g.input("layers.fg", u(8), { src: "port", module: "blend" }), bg = g.input("layers.bg", u(8), { src: "port", module: "blend" }), al = g.input("layers.alpha", u(8), { src: "port", module: "blend" });
  const L = (src) => O(28, src);
  const m1 = g.add("mul", [fg, al], u(16), { module: "blend" }, L("l.fg * l.alpha"));
  const inv = g.add("sub", [g.const(255), al], s(9), { module: "blend" }, L("255 - l.alpha"));
  const m2 = g.add("mul", [bg, inv], s(17), { module: "blend" }, L("l.bg * (255 - l.alpha)"));
  const s1 = g.add("add", [m1, m2], s(18), { module: "blend" }, L("+"));
  const s2 = g.add("add", [s1, g.const(128)], s(19), { module: "blend" }, L("+ 128"));
  const sh = g.add("shr", [s2, g.const(8)], s(11), { module: "blend" }, L(">> 8"));
  const st = g.add("sat", [sh], u(8), { module: "blend" }, O(29, "sat(mix, u(8))"));
  const table = Array.from({ length: 256 }, (_, i) => Math.round(255 * (i / 255) ** (1 / 2.2)));
  const gm = g.add("rom", [st], u(8), { table, module: "blend" }, O(29, "GAMMA[…]"));
  const out = g.reg("blend.out.data", u(8), { module: "blend" });
  g.setNext(out, gm);
  g.output("out.data", out);
  return g;
}

// struct and vec layout: pack, field, index (out of range → 0), concat, a ROM of struct values
import { vec, struct } from "../src/core/types.js";
export function packer() {
  const g = new Graph("sys", 50e6);
  const T = struct({ fg: u(8), bg: u(8), alpha: u(8) });
  const a = g.input("p.a", u(8), { src: "port" }), b = g.input("p.b", s(6), { src: "port" }), i = g.input("p.i", u(3), { src: "port" });
  const pk = g.add("pack", [a, b, g.const(3)], T);
  const r = g.reg("p.r", T);
  g.setNext(r, pk);
  const f = g.add("field", [r], u(8), { name: "bg", lo: 8, hi: 15 });
  const V = vec(u(4), 5);
  const els = [0, 1, 2, 3, 4].map((k) => g.add("slice", [g.add("add", [a, g.const(k)], u(9))], u(4), { lo: k, hi: k + 3 }));
  const vr = g.reg("p.v", V);
  g.setNext(vr, g.add("pack", els, V));
  const el = g.add("index", [vr, i], u(4));
  const o = g.reg("p.o", u(12));
  g.setNext(o, g.add("concat", [el, f], u(12)));
  const table = [{ fg: 1, bg: 2, alpha: 3 }, { fg: 250, bg: 7, alpha: 128 }, { fg: 9, bg: 255, alpha: 0 }];
  const q = g.reg("p.q", T);
  g.setNext(q, g.add("rom", [i], T, { table, name: "LUT" }));
  const qa = g.reg("p.qa", u(8));
  g.setNext(qa, g.add("field", [q], u(8), { name: "fg", lo: 16, hi: 23 }));
  return g;
}
