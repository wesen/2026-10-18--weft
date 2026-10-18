// Simulator tests (owner C): generated code vs evalOp for every opcode, then hand-built graphs.
import { Graph } from "../src/core/ir.js";
import { u, s, bit, vec, struct, binType, unType, shiftType, join, evalOp, isBig, wrapTo, typeName } from "../src/core/types.js";
import { genDomain, Sim, encode, decode } from "../src/core/sim.js";

let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log("FAIL", msg); } };
const eq = (a, b) => (typeof a === "bigint" || typeof b === "bigint" ? BigInt(a) === BigInt(b) : a === b);

// ---------------------------------------------------------------- differential: every opcode vs evalOp
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
const WIDTHS = [1, 2, 3, 5, 7, 8, 12, 15, 16, 17, 24, 30, 31, 32, 33, 40, 47, 52, 53, 54, 63, 64, 65, 96, 128];
const rw = (max = 128) => { let w; do w = WIDTHS[Math.floor(rnd() * WIDTHS.length)]; while (w > max); return w; };
const rt = (max) => (rnd() < 0.5 ? u(rw(max)) : s(Math.max(2, rw(max))));
function rv(T) {
  const lo = T.signed ? -(2n ** BigInt(T.w - 1)) : 0n, hi = T.signed ? 2n ** BigInt(T.w - 1) - 1n : 2n ** BigInt(T.w) - 1n;
  const r = rnd();
  let v;
  if (r < 0.08) v = lo; else if (r < 0.16) v = hi; else if (r < 0.22) v = 0n; else if (r < 0.28 && T.signed) v = -1n; else if (r < 0.34) v = 1n > hi ? hi : 1n;
  else { let b = 0n; for (let i = 0; i < T.w; i += 30) b = (b << 30n) | BigInt(Math.floor(rnd() * 2 ** 30)); v = lo + (b % (hi - lo + 1n)); }
  return isBig(T) ? v : Number(v);
}
function check(op, argTypes, R, attrs = {}, constArg = {}, ref = null) {
  const g = new Graph("t");
  const vals = argTypes.map(rv);
  const ids = argTypes.map((T, i) => (i in constArg ? g.const(constArg[i], T) : g.input("a" + i, T)));
  const actualVals = argTypes.map((T, i) => (i in constArg ? (isBig(T) ? BigInt(constArg[i]) : constArg[i]) : vals[i]));
  const id = g.add(op, ids, R, attrs);
  g.output("y", id);
  const code = genDomain(g, {});
  const F = new Float64Array(g.nodes.length), B = new Array(g.nodes.length).fill(0n);
  ids.forEach((nid, i) => { if (g.nodes[nid].op === "in") { if (isBig(argTypes[i])) B[nid] = actualVals[i]; else F[nid] = actualVals[i]; } });
  code.comb(F, B, []);
  const got = isBig(R) ? B[id] : F[id];
  const want = ref ? ref(actualVals) : evalOp(op, R, actualVals, attrs);
  if (!eq(got, want) || typeof got !== typeof want) {
    ok(false, `${op}(${argTypes.map(typeName).join(", ")}) → ${typeName(R)}: args ${actualVals.join(", ")} got ${got} (${typeof got}) want ${want} (${typeof want})`);
    return false;
  }
  return true;
}
const N = 400;
let checks = 0;
for (let i = 0; i < N; i++) {
  for (const op of ["add", "sub", "mul", "and", "or", "xor", "eq", "ne", "lt", "le", "gt", "ge", "land", "lor"]) {
    const a = rt(op === "mul" ? 64 : 128), b = rt(op === "mul" ? 64 : 128);
    check(op, [a, b], binType(op, a, b)); checks++;
  }
  for (const op of ["neg", "not", "lnot"]) { const a = rt(); check(op, [a], unType(op, a)); checks++; }
  { const a = rt(), k = Math.floor(rnd() * 70); check("shl", [a, u(7)], shiftType("shl", a, k), {}, { 1: k }); checks++; }
  { const a = rt(), k = Math.floor(rnd() * 70); check("shr", [a, u(7)], shiftType("shr", a, k), {}, { 1: k }); checks++; }
  { const a = rt(60), kT = u(1 + Math.floor(rnd() * 3)); check("shl", [a, kT], shiftType("shl", a, null, kT)); checks++; }
  { const a = rt(), kT = u(1 + Math.floor(rnd() * 7)); check("shr", [a, kT], a); checks++; }
  { const a = rt(), b = rt(); check("mux", [bit, a, b], join(a, b)); checks++; }
  { const a = rt(), R = rt(); check("wrap", [a], R); checks++; check("sat", [a], R); checks++; }
  { const a = rt(), lo = Math.floor(rnd() * a.w), hi = lo + Math.floor(rnd() * (a.w - lo)); check("slice", [a], u(hi - lo + 1), { lo, hi }); checks++;
    if (hi > lo) { check("slice", [a], s(hi - lo + 1), { lo, hi }); checks++; } }
  { const a = rt(100); check(a.signed ? "sext" : "zext", [a], a.signed ? s(a.w + rw(28)) : u(a.w + rw(28))); checks++; }
  // ops with no evalOp case: compare with a BigInt reference
  { const ts = [rt(40), rt(40), rt(40)].slice(0, 1 + Math.floor(rnd() * 3)), W = ts.reduce((x, t) => x + t.w, 0);
    check("concat", ts, u(W), {}, {}, (vs) => { let r = 0n; ts.forEach((t, j) => { r = (r << BigInt(t.w)) | BigInt.asUintN(t.w, BigInt(vs[j])); }); return W > 53 ? r : Number(r); }); checks++; }
  { const T = rnd() < 0.5 ? u(rw(70)) : s(Math.max(2, rw(70))), len = 1 + Math.floor(rnd() * 20), table = Array.from({ length: len }, () => rv(T));
    check("rom", [u(5)], T, { table }, {}, ([i]) => (i < len ? table[i] : isBig(T) ? 0n : 0)); checks++; }
  { const ST = struct({ a: rt(30), b: rt(30), c: rt(30) }), which = ["a", "b", "c"][Math.floor(rnd() * 3)];
    const FT = ST.fields.find(([n]) => n === which)[1];
    check("field", [ST], FT, { name: which }, {}, ([v]) => decode(v, ST)[which]); checks++;
    const parts = ST.fields.map(([, t]) => t);
    check("pack", parts, ST, {}, {}, (vs) => encode({ a: vs[0], b: vs[1], c: vs[2] }, ST)); checks++; }
  { const E = rnd() < 0.5 ? u(rw(16)) : s(Math.max(2, rw(16))), n = 1 + Math.floor(rnd() * 6), V = vec(E, n);
    check("index", [V, u(3)], E, {}, {}, ([v, i]) => (i < n ? decode(v, V)[i] : 0)); checks++;
    check("pack", Array(n).fill(E), V, {}, {}, (vs) => encode(vs, V)); checks++; }
}
console.log(`differential: ${checks} random checks against evalOp${fails ? `, ${fails} failures` : ", all agree"}`);

// ---------------------------------------------------------------- hand-built designs
function design(domains, extra = {}) {
  return { ok: true, diags: [], name: "t", board: { profile: "dev", mainHz: Object.values(domains)[0].hz, resources: {} }, domains, instances: [], streams: [], pins: [], knobs: [], cells: [], asserts: [], scenarios: [], hosts: [], groups: [], ...extra };
}

// F-02 counter
{
  const g = new Graph("sys", 100e6);
  const en = g.input("counter.en", bit, { src: "free" }), down = g.input("counter.down", bit, { src: "free" });
  const v = g.reg("counter.value", u(8), { module: "counter", name: "value" });
  const one = g.const(1, bit);
  const dec = g.add("sub", [v, one], s(9)), inc = g.add("add", [v, one], u(9));
  const sel = g.add("mux", [down, dec, inc], s(10)), w = g.add("wrap", [sel], u(8));
  g.setNext(v, g.add("mux", [en, w, v], u(8)));
  g.output("counter.zero", g.add("eq", [v, g.const(0, bit)], bit));
  g.output("counter.value", v);
  const sim = new Sim(design({ sys: { hz: 100e6, graph: g } }, { instances: [{ path: "counter", kind: "module" }] }));
  sim.poke("counter.down", 1).poke("counter.en", 1).step();
  ok(sim.peek("counter.value") === 255, "counter wraps below zero: " + sim.peek("counter.value"));
  ok(sim.peek("counter.zero") === 0, "zero is a wire of the new value");
  sim.poke("counter.down", 0).step(3);
  ok(sim.peek("counter.value") === 2, "counts up after wrapping: " + sim.peek("counter.value"));
  ok(sim.state("counter").value === 2, "state(instance)");
  const snap = sim.snapshot();
  sim.step(10);
  ok(sim.peek("counter.value") === 12, "12 after 10 more");
  sim.restore(snap);
  ok(sim.peek("counter.value") === 2 && sim.cycle() === 4, "restore");
  ok(sim.waves.series("counter.value").length >= 3, "waves recorded");
}

// F-01 blinky on the pico (12 MHz): a 22-bit prescaler marked for skipping
function blinky(prescaler = true) {
  const g = new Graph("sys", 12e6), P = 3_000_000;
  const cnt = g.reg("blink.__every0", u(22), prescaler ? { prescaler: { period: P } } : {});
  const top = g.add("eq", [cnt, g.const(P - 1)], bit);
  g.setNext(cnt, g.add("mux", [top, g.const(0, u(22)), g.add("wrap", [g.add("add", [cnt, g.const(1, bit)], u(23))], u(22))], u(22)));
  const led = g.reg("blink.led", bit, { module: "blink", name: "led" });
  g.setNext(led, g.add("mux", [top, g.add("lnot", [led], bit), led], bit));
  const o = g.output("blink.led", led);
  return design({ sys: { hz: 12e6, graph: g } }, { pins: [{ resource: "led:0", dir: "out", domain: "sys", node: o, bit: 0 }] });
}
{
  const sim = new Sim(blinky(), { waves: true });
  const t0 = performance.now();
  sim.runFor("1.1s");
  const ms = performance.now() - t0;
  ok(sim.board.toggles["led:0"] === 4, "blinky toggles 4 times in 1.1 s: " + sim.board.toggles["led:0"]);
  ok(sim.cycle() === 13_200_000, "13.2 M cycles: " + sim.cycle());
  ok(ms < 300, `blinky 1.1 s in ${ms.toFixed(1)} ms`);
  console.log(`F-01 blinky: 1.1 s of 12 MHz (13.2 M cycles) in ${ms.toFixed(1)} ms, ${sim.edges} real edges, ${(sim.stats.cyclesPerSecond / 1e6).toFixed(0)} M cycles/s effective`);
  // the same design without the prescaler mark: real edges only, same answer
  const ref = new Sim(blinky(false), { waves: false });
  const t1 = performance.now();
  ref.runFor("300ms");
  const ms2 = performance.now() - t1;
  const sk = new Sim(blinky(), { waves: false });
  sk.runFor("300ms");
  ok(ref.peek("blink.__every0") === sk.peek("blink.__every0") && ref.peek("blink.led") === sk.peek("blink.led"), "skipping matches stepping: " + ref.peek("blink.__every0") + " vs " + sk.peek("blink.__every0"));
  console.log(`  without skipping: 3.6 M cycles in ${ms2.toFixed(0)} ms = ${(3.6e6 / ms2 / 1e3).toFixed(1)} M cycles/s (real edges)`);
  // wake from a skip: a poke in the middle lands at the right cycle
  const a = new Sim(blinky(), { waves: false }), b = new Sim(blinky(false), { waves: false });
  for (const x of [a, b]) { x.runFor("100ms"); x.poke("blink.__every0", 2_999_990); x.runFor("10us"); }
  ok(a.peek("blink.led") === b.peek("blink.led") && a.peek("blink.__every0") === b.peek("blink.__every0"), "poke during a skip");
}

// a valid/ready pair: producer counts on every fire, consumer is ready one cycle in four; a stream tap sees it
{
  const g = new Graph("sys", 100e6);
  const seq = g.reg("fast.seq", u(16), { module: "fast" });
  const busy = g.reg("slow.busy", u(2), { module: "slow" });
  const got = g.reg("slow.last", u(16), { module: "slow", init: 0xffff });
  const gaps = g.reg("slow.gaps", u(16), { module: "slow" });
  const valid = g.const(1, bit);
  const ready = g.add("eq", [busy, g.const(0, bit)], bit);
  const fire = g.add("land", [valid, ready], bit);
  g.setNext(seq, g.add("mux", [fire, g.add("wrap", [g.add("add", [seq, g.const(1, bit)], u(17))], u(16)), seq], u(16)));
  g.setNext(busy, g.add("wrap", [g.add("add", [busy, g.const(1, bit)], u(3))], u(2)));
  const exp = g.add("wrap", [g.add("add", [got, g.const(1, bit)], u(17))], u(16));
  const gap = g.add("land", [fire, g.add("ne", [seq, exp], bit)], bit);
  g.setNext(gaps, g.add("mux", [gap, g.add("wrap", [g.add("add", [gaps, g.const(1, bit)], u(17))], u(16)), gaps], u(16)));
  g.setNext(got, g.add("mux", [fire, seq, got], u(16)));
  const sim = new Sim(design({ sys: { hz: 100e6, graph: g } }, { streams: [{ name: "q", type: u(16), domain: "sys", signals: { valid, data: seq, ready }, dropped: null }] }), { waves: false });
  sim.step(4000);
  const st = sim.stream("q");
  ok(st.fired === 1000, "1000 beats in 4000 cycles: " + st.fired);
  ok(sim.state("slow").gaps === 0 && sim.state("slow").last === 999, "no gaps, last 999: " + JSON.stringify(sim.state("slow")));
  ok(st.last.length === 1000 && st.last[10] === 10, "stream log");
}

// a memory with a registered read (D8): data appears the cycle after the address
{
  const g = new Graph("sys", 100e6);
  const T = s(12);
  const mem = g.add("mem", [], T, { path: "echo.delay", words: 16, elem: T, rdw: "read-first", init: null });
  const at = g.reg("echo.at", u(4));
  const one = g.const(1, bit);
  g.setNext(at, g.add("wrap", [g.add("add", [at, one], u(5))], u(4)));
  const data = g.add("sub", [g.const(0, bit), g.add("zext", [at], u(12))], s(13));
  const d12 = g.add("wrap", [data], T);
  g.add("memwr", [mem, at, d12, one], T, { path: "echo.delay.w" });
  const rd = g.add("memrd", [mem, at, one], T, { path: "echo.delay.q" });
  g.output("echo.q", rd);
  const sim = new Sim(design({ sys: { hz: 100e6, graph: g } }), { waves: false });
  sim.step(16); // fill: word i = -i
  ok(sim.peek("echo.at") === 0, "address wrapped");
  sim.step(1);  // edge reads word 0 (read-first: before this edge's write of word 0)
  ok(sim.peek("echo.q") === 0, "read word 0: " + sim.peek("echo.q"));
  sim.step(1);  // reads word 1 = -1
  ok(sim.peek("echo.q") === -1, "registered read returns -1 one edge later: " + sim.peek("echo.q"));
  sim.step(5);
  ok(sim.peek("echo.q") === -6, "and -6 after five more: " + sim.peek("echo.q"));
}

// a crossing: a sys counter sampled in a slower pix domain through 2 stages
{
  const sys = new Graph("sys", 100e6), pix = new Graph("pix", 25e6);
  const c = sys.reg("src.count", u(16));
  sys.setNext(c, sys.add("wrap", [sys.add("add", [c, sys.const(1, bit)], u(17))], u(16)));
  const x = pix.input("dst.count", u(16), { src: "cross", from: { domain: "sys", node: c }, stages: 2 });
  const hold = pix.reg("dst.seen", u(16));
  pix.setNext(hold, x);
  const sim = new Sim(design({ sys: { hz: 100e6, graph: sys }, pix: { hz: 25e6, graph: pix } }), { waves: false });
  sim.step(1, "pix"); // t = 40 ns
  const seen = [];
  for (let i = 0; i < 6; i++) { sim.step(1, "pix"); seen.push(sim.peek("dst.seen")); }
  const now = sim.peek("src.count");
  ok(seen.every((v, i) => i < 2 || v - seen[i - 1] === 4), "pix sees the counter advance 4 per pix cycle: " + seen);
  ok(now - seen.at(-1) >= 8 && now - seen.at(-1) <= 13, `seen lags by 2 pix stages (+ the reg): ${now} vs ${seen.at(-1)}`);
}

// assert monitoring and knobs with bounds
{
  const g = new Graph("sys", 1e6);
  const hz = g.reg("synth.hz", u(14), { knob: true, init: 440 });
  g.setNext(hz, hz);
  const big = g.add("gt", [hz, g.const(5000)], bit);
  const okNode = g.add("lnot", [big], bit);
  const sim = new Sim(design({ sys: { hz: 1e6, graph: g } }, {
    knobs: [{ path: "synth.hz", module: "synth", name: "hz", kind: "knob", type: u(14), reset: 440, min: 20, max: 8000, addr: 0, domain: "sys", node: hz }],
    asserts: [{ path: "synth", name: "hz below 5k", kind: "assert", module: "synth", domain: "sys", node: okNode, line: 1 }],
  }), { waves: false });
  const fails = [];
  sim.on("assert", (e) => fails.push(e));
  ok(sim.knob("synth.hz").set(50_000) === 8000, "knob clamps to max");
  ok(sim.knob("synth.hz").set(3) === 20 && sim.knob("synth.hz").get() === 20, "knob clamps to min");
  sim.step(3);
  ok(fails.length === 0, "assert holds");
  sim.knob("synth.hz").set(6000);
  sim.step(2);
  ok(fails.length === 2 && fails[0].name === "hz below 5k", "assert fails each edge: " + fails.length);
}

// a 64-bit accumulator: BigInt registers
{
  const g = new Graph("sys", 1e6);
  const acc = g.reg("m.acc", s(64));
  const k = g.input("m.k", s(40), { src: "free" });
  g.setNext(acc, g.add("wrap", [g.add("add", [acc, k], s(65))], s(64)));
  const sim = new Sim(design({ sys: { hz: 1e6, graph: g } }), { waves: false });
  sim.poke("m.k", -(2 ** 38));
  sim.step(1000);
  ok(sim.peek("m.acc") === BigInt(-(2 ** 38)) * 1000n, "64-bit accumulate: " + sim.peek("m.acc"));
}

// a struct register peeked by field and a vec by index
{
  const g = new Graph("sys", 1e6);
  const P = struct({ x: u(10), y: u(10) });
  const p = g.reg("phys.pos", P, { init: encode({ x: 40, y: 30 }, P) });
  g.setNext(p, p);
  const V = vec(u(8), 4);
  const d = g.add("pack", [g.const(1, u(8)), g.const(2, u(8)), g.const(3, u(8)), g.const(4, u(8))], V);
  g.output("b.duty", d);
  const sim = new Sim(design({ sys: { hz: 1e6, graph: g } }), { waves: false });
  ok(sim.peek("phys.pos.x") === 40 && sim.peek("phys.pos").y === 30, "struct fields");
  ok(sim.peek("b.duty[2]") === 3 && sim.peek("b.duty").join() === "1,2,3,4", "vec elements");
  sim.poke("phys.pos.y", 99);
  ok(sim.peek("phys.pos.y") === 99 && sim.peek("phys.pos.x") === 40, "poke a struct field");
}

console.log(fails ? `sim: ${fails} FAILED` : "sim ok");
process.exit(fails ? 1 : 0);
