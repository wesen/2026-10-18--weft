// Fork B tests: the pass pipeline, the estimate, rewrites and Verilog on hand-built DAGs.
import assert from "node:assert/strict";
import { Graph } from "../src/core/ir.js";
import { u, s, bit, binType, shiftType, join, clog2 } from "../src/core/types.js";
import { runPipeline, STD_PASSES as P, STD_ANALYSES, STD_PIPELINE, pass, analysis, rewrite, backend, checkRule, traceGraph, runExplore } from "../src/core/passes.js";
import { emitVerilog } from "../src/core/verilog.js";
import { bramCount, FAMILY, csdDigits } from "../src/core/estimate.js";

import { mkdirSync, writeFileSync } from "node:fs";
// WEFT_RTL_DIR=… writes every design's Verilog for an external checker (slang, iverilog)
function dump(name, files) {
  const dir = process.env.WEFT_RTL_DIR;
  if (!dir) return;
  mkdirSync(`${dir}/${name}`, { recursive: true });
  for (const f of files) writeFileSync(`${dir}/${name}/${f.path.split("/").pop()}`, f.text);
}
let failures = 0, count = 0;
function test(name, fn) {
  count++;
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.stack.split("\n").slice(0, 4).join("\n       ")}`); }
}
import { O, counter, mac, fir, scaler, echo, blend } from "./fixtures-b.mjs";

// ── F-02: an up/down counter ───────────────────────────────────────────────────────────────────────────────
test("F-02 counter: default pipeline, estimate, timing and Verilog on iCE40", () => {
  const { g, pins } = counter();
  const ctx = { name: "counter", domains: { sys: { hz: 12e6, graph: g } }, instances: [{ path: "counter", kind: "module" }], pins, cells: [], knobs: [], asserts: [], target: { name: "pico", family: "ice40", part: "ice40up5k-sg48" }, timings: { front: 2, lower: 3 }, diags: [] };
  const before = traceGraph(g.clone(), { cycles: 64, seed: 3 });
  const { stages, report, emits } = runPipeline(ctx);
  assert.deepEqual(stages.map((x) => x.name), ["front", "lower", "optimize", "time", "map", "back"]);
  const opt = stages.find((x) => x.name === "optimize");
  assert.ok(opt.iterations >= 2 && opt.iterations <= 8, "optimize runs to a fixpoint");
  assert.equal(g.count("mul"), 0, "the dead constant multiply is gone");
  assert.ok(!g.live().some((n) => n.op === "add" && g.node(n.args[1])?.op === "const" && g.node(n.args[1]).attrs.value === 0), "x + 0 folded");
  const after = traceGraph(g, { cycles: 64, seed: 3 });
  assert.deepEqual(after.map((c) => c["counter.value"]), before.map((c) => c["counter.value"]), "same register values before and after optimization");
  assert.equal(report.resources.ffs, 8);
  assert.ok(report.resources.luts >= 8 && report.resources.luts < 40, `luts ${report.resources.luts}`);
  assert.equal(report.resources.ios, 10);
  assert.equal(report.resources.of("counter").ffs, 8);
  assert.equal(report.family, "ice40");
  assert.ok(report.timing.sys.met && report.timing.slack("sys") > 50, "12 MHz is easy");
  assert.equal(typeof report.timing.worst("sys").explain(), "string");
  assert.equal(report.ir("dag").count("reg"), 1);
  assert.equal(report.part.luts, 5280);
  assert.equal(emits.length, 0);
  assert.ok(report.netlist.cells().some((c) => c.type === "SB_LUT4"));
  const v = emitVerilog(ctx);
  dump("counter", v);
  assert.ok(v.some((f) => f.path === "counter_sys.v") && v.some((f) => f.top));
  const top = v.find((f) => f.top).text;
  assert.match(top, /output wire \[7:0\] led/);
  assert.match(top, /assign led\[3\] = sys__o_counter_leds\[3\];/);
});

// ── F-13: the multiply-accumulate, one DSP on 7-series ─────────────────────────────────────────────────────
const F13 = (std, opts = {}) => (c) => c
  .cache(".weft/cache")
  .stage("front", (st) => st.pass(std.parse).pass(std.elaborate).pass(std.link))
  .stage("lower", (st) => st
    .pass(std.fsm.extract, std.pipeline.registers, std.stream.lower, std.csr.collect)
    .pass(std.flatten).pass(std.widths)
    .pass(std.checks.loops, std.checks.latches, std.checks.cdc))
  .stage("optimize", (st) => st.pass(std.constFold, std.cse, std.muxTree, std.dce).fixpoint({ max: 8 }))
  .stage("time", (st) => st.pass(std.pipeline.cut, std.retime))
  .stage("map", (st) => st.pass(...(opts.noDsp ? [std.mem.infer, std.fsm.encode] : [std.mem.infer, std.dsp.pack, std.fsm.encode])).pass(std.techmap))
  .stage("back", (st) => st.pass(std.place.with({ effort: "high" }), std.route, std.timing))
  .verifyEach()
  .snapshot("dag", { after: "optimize", as: "dot", to: "build/mac.dag.dot" })
  .inspect("net", (net) => console.log(net.stats()), { after: "map" })
  .check("one DSP", (r) => r.resources.dsps === 1 || `used ${r.resources.dsps} DSPs`)
  .check("meets 250 MHz", (r) => r.timing.slack("sys") >= 0 || r.timing.worst("sys").explain())
  .emit("verilog", { to: "build/rtl" })
  .emit("report", { to: "build/mac.report.json" });
const macCtx = (g, cfg) => ({ name: "mac", domains: { sys: { hz: g.hz, graph: g } }, instances: [{ path: "mac", kind: "module" }], pins: [], cells: [], knobs: [], target: { name: "mac", family: "xc7", part: "xc7a35t-1" }, compileCfg: cfg, timings: { front: 1.5, lower: 2.5 }, diags: [] });
test("F-13 mac: written-out pipeline, 1 DSP48E1, meets 250 MHz, snapshot, inspect, checks, emits", () => {
  const g = mac();
  const { stages, report, emits } = runPipeline(macCtx(g, F13(P)));
  assert.equal(report.resources.dsps, 1);
  assert.equal(report.dsps[0].mac, "mac.acc", "the adder and the accumulator register are absorbed");
  assert.equal(report.resources.luts, 0, "nothing left for LUTs");
  assert.ok(report.timing.sys.met, report.timing.worst("sys").explain());
  assert.ok(report.checks.filter((c) => c.kind === "check").every((c) => c.ok), JSON.stringify(report.checks));
  const opt = stages.find((x) => x.name === "optimize");
  assert.match(opt.snapshot.text, /^digraph weft/);
  assert.equal(opt.snapshot.to, "build/mac.dag.dot");
  const map = stages.find((x) => x.name === "map");
  assert.ok(map.inspect.output[0].includes("DSP48E1"), map.inspect.output.join("\n"));
  assert.ok(stages[0].passes.every((p) => p.external && p.note.includes("front.js")));
  assert.deepEqual(emits.map((e) => e.backend), ["snapshot", "verilog", "report"]);
  assert.ok(emits[1].files.every((f) => f.path.startsWith("build/rtl/")));
  assert.equal(emits[2].files[0].path, "build/mac.report.json");
  dump("mac", emits[1].files);
  const rtl = emits[1].files.find((f) => f.path.endsWith("mac_sys.v")).text;
  assert.match(rtl, /\* \{\{18\{mac_b\[17\]\}\}, mac_b\}/, "operands sign-extended to 36 bits before the multiply");
  assert.match(rtl, /mac_acc <= rst \? 48'h0 :/);
  const top = emits[1].files.find((f) => f.path.endsWith("/mac.v")).text;
  assert.match(top, /input  wire \[17:0\] mac_a/);
  assert.match(top, /output wire \[47:0\] mac_acc/);
  console.log("       " + map.passes.map((p) => `${p.name}: ${p.note}`).join("\n       "));
});
test("F-13 try: drop dsp.pack → LUT multiplier; 400 MHz → explain() names the source", () => {
  const g = mac();
  const { report } = runPipeline(macCtx(g, F13(P, { noDsp: true })));
  assert.equal(report.resources.dsps, 0);
  assert.ok(report.resources.luts > 100, `luts ${report.resources.luts}`);
  assert.ok(report.checks.some((c) => c.name === "one DSP" && !c.ok && c.message === "used 0 DSPs"));
  const g2 = mac(400e6);
  const r2 = runPipeline(macCtx(g2, F13(P))).report;
  assert.ok(!r2.timing.sys.met);
  const why = r2.checks.find((c) => c.name === "meets 250 MHz");
  assert.ok(!why.ok && why.message.includes("$.a * $.b") && why.message.includes("line 17"), why.message);
  assert.equal(r2.failures[0].event, "timing.failed");
  console.log("       " + why.message.split("\n").join("\n       "));
});
test("F-13 cache: the second build reuses the optimize stage", () => {
  const r1 = runPipeline(macCtx(mac(), F13(P)));
  const r2 = runPipeline(macCtx(mac(), F13(P)));
  void r1;
  const opt = r2.stages.find((x) => x.name === "optimize");
  assert.ok(opt.passes.every((p) => p.reused), "optimize reused from the stage cache");
});

// ── a small FIR: const taps, a delay line, .pipelined(), .hint() ────────────────────────────────────────────
test("FIR: shift-add constants, pipeline.cut for .pipelined(), srl.infer on xc7, latency()", () => {
  const g = fir([3, -5, 7, 9, 7, -5, 3, 11, 13, 17, 19, 23, 29, 31, 37, 41], 250e6);
  const ctx = { name: "fir", domains: { sys: { hz: 250e6, graph: g } }, instances: [{ path: "fir", kind: "module", pipelined: { path: ["in", "out"] }, hints: { multiply: "shift-add" } }], target: { name: "dev", family: "xc7", part: "xc7a35t" }, diags: [] };
  const { report, stages } = runPipeline(ctx);
  const cut = stages.find((x) => x.name === "time").passes.find((p) => p.name === "pipeline.cut");
  assert.ok(report.pipelines.fir.stages >= 2, cut.note);
  assert.equal(report.latency("fir"), report.pipelines.fir.stages);
  assert.ok(report.timing.sys.met, report.timing.worst("sys").explain());
  assert.equal(report.resources.dsps, 0, "constant multipliers become shift-add with the hint");
  const srl = stages.find((x) => x.name === "map").passes.find((p) => p.name === "srl.infer");
  assert.ok(srl && /chain/.test(srl.note), "srl.infer runs on xc7 by default: " + srl?.note);
  console.log(`       ${cut.note}\n       ${srl.note}`);
  dump("fir", emitVerilog({ name: "fir", domains: { sys: { hz: 250e6, graph: g } } }));
  // the same FIR with DSPs
  const g2 = fir([3, -5, 7, 9, 7, -5, 3], 100e6);
  const r2 = runPipeline({ name: "fir", domains: { sys: { hz: 100e6, graph: g2 } }, instances: [{ path: "fir", kind: "module", hints: { multiply: "dsp" } }], target: { name: "dev", family: "xc7", part: "xc7a35t" } }).report;
  assert.equal(r2.resources.dsps, 7);
  assert.equal(csdDigits(7), 2);
  assert.equal(csdDigits(23), 3);
});

test("pipeline.cut balances an add/sub chain on a near-critical path (F-17's biquad shape), same values", () => {
  const g = fir([3, -5, 7, 9, 7, -5, 3], 100e6);
  const before = traceGraph(g.clone(), { cycles: 64, seed: 4 });
  const { report, stages } = runPipeline({ name: "fir", domains: { sys: { hz: 100e6, graph: g } }, instances: [{ path: "fir", kind: "module", hints: { multiply: "dsp" } }], target: { family: "xc7", part: "xc7a35t" } });
  const note = stages.find((x) => x.name === "time").passes[0].note;
  assert.match(note, /balanced 1 add\/sub chain/);
  assert.ok(report.timing.sys.met && report.timing.sys.levels <= 6, report.timing.worst("sys").explain());
  const after = traceGraph(g, { cycles: 64, seed: 4 });
  for (let c = 0; c < 64; c++) assert.equal(after[c]["fir.out.data"], before[c]["fir.out.data"]);
});

// ── F-14: rewrites, analyses, a lint, saturation, explainPlan ───────────────────────────────────────────────
const isPow2 = (k) => k > 0 && (k & (k - 1)) === 0;
const peephole = [
  rewrite("multiply by a power of two")
    .from((x, k) => x * k)
    .where(({ k }) => k.isConst && isPow2(k.value))
    .to((x, k) => x << clog2(k))
    .examples([[(x) => x * 8, (x) => x << 3], [(x) => x * 6, null]]),
  rewrite("same value on both arms").from((c, a) => (c ? a : a)).to((c, a) => a),
  rewrite("double inversion").from((x) => ~~x).to((x) => x),
];
test("F-14: rule checks, examples, saturation removes every mul, the 48-bit lint, analyses and explainPlan", () => {
  const chk = checkRule(peephole[0]);
  assert.equal(chk.status, "sound");
  assert.equal(chk.exhaustiveUpTo, 8);
  assert.deepEqual(chk.examples, { ok: 2, total: 2, fails: [] });
  for (const r of peephole.slice(1)) assert.equal(checkRule(r).status, "sound", r.name);
  const fanout = analysis("fanout").on("dag").run((g) => new Map(g.nodes().map((n) => [n.id, n.users.length])));
  let visitedRegs = 0, sawSlack = null;
  const splitFanout = pass("split-fanout").on("dag").requires(fanout, STD_ANALYSES.timing).preserves("widths", "domains").params({ limit: 32 })
    .visit("reg", (n, g, { fanout, timing, limit }) => {
      visitedRegs++;
      const users = fanout.get(n.id);
      if (n.path === "scaler.go") sawSlack = timing.slack(n);
      if (users > limit && timing.slack(n) < 0.5) g.duplicate(n, { copies: Math.ceil(users / limit), split: "users" });
    });
  const wideCompares = pass("lint: wide comparisons").on("dag").readonly()
    .visit(["lt", "le", "gt", "ge"], (n, g) => {
      const w = Math.max(...n.args.map((a) => a.width));
      if (w > 32) g.warn(n, `${w}-bit comparison in one cycle`);
    });
  const g = scaler(8);
  const before = traceGraph(g.clone(), { cycles: 24, seed: 9 });
  const cfg = (c) => c
    .use(STD_PIPELINE)
    .after("lower", (st) => st.pass(wideCompares))
    .after("optimize", (st) => st.pass(P.saturate(peephole, { iters: 6, cost: "luts" })))
    .before("techmap", (st) => st.pass(splitFanout.with({ limit: 16 })))
    .validate({ cycles: 24 })
    .explainPlan()
    .check("no multipliers left", (r) => r.ir("dag").count("mul") === 0);
  const ctx = { name: "passes", domains: { sys: { hz: 48e6, graph: g } }, instances: [{ path: "scaler", kind: "module" }], target: { name: "pico", family: "ice40", part: "ice40up5k-sg48" }, compileCfg: cfg, diags: [] };
  const { report, stages, diags } = runPipeline(ctx);
  assert.deepEqual(stages.map((x) => x.name), ["front", "lower", "after lower", "optimize", "after optimize", "time", "map", "back"]);
  assert.equal(report.ir("lower").count("mul"), 8);
  assert.equal(report.ir("dag").count("mul"), 0);
  assert.ok(report.checks.find((c) => c.name === "no multipliers left").ok);
  const lint = diags.filter((d) => d.code === "lint");
  assert.equal(lint.length, 1);
  assert.equal(lint[0].line, 51);
  assert.match(lint[0].message, /48-bit comparison/);
  const rules = Object.fromEntries(report.rules.map((r) => [r.name, r]));
  assert.equal(rules["multiply by a power of two"].applied, 8);
  assert.equal(rules["double inversion"].applied, 8);
  assert.ok(!diags.some((d) => d.code === "validate"), diags.filter((d) => d.code === "validate").map((d) => d.message).join("; "));
  assert.equal(visitedRegs, 9);
  assert.ok(sawSlack > 10, `slack through go ${sawSlack}`);
  assert.match(report.plan, /fanout@sys computed/);
  assert.match(report.plan, /timing@sys/);
  dump("scaler", emitVerilog({ name: "scaler", domains: { sys: { hz: 48e6, graph: g } } }));
  const after = traceGraph(g, { cycles: 24, seed: 9 });
  for (let c = 0; c < 24; c++) for (let i = 0; i < 8; i++) assert.equal(after[c][`scaler.y[${i}]`], before[c][`scaler.y[${i}]`]);
  console.log("       " + report.plan.split("\n").join("\n       "));
});
test("rules: an unsound rule is refused with a counterexample; a failing example is reported", () => {
  const bad = rewrite("wrong shift").from((x, k) => x * k).where(({ k }) => k.isConst && k.value > 1).to((x, k) => x << (k - 1));
  const c = checkRule(bad);
  assert.equal(c.status, "unsound");
  assert.ok(c.counterexample && c.counterexample.width >= 1);
  const ex = rewrite("pow2 with a wrong example").from((x, k) => x * k).where(({ k }) => k.isConst && isPow2(k.value)).to((x, k) => x << clog2(k)).examples([[(x) => x * 6, (x) => x << 3]]);
  assert.equal(checkRule(ex).status, "examples-fail");
  const g = scaler(2);
  const { diags } = runPipeline({ name: "bad", domains: { sys: { hz: 48e6, graph: g } }, target: { family: "ice40", part: "ice40up5k" }, compileCfg: (cc) => cc.after("optimize", (st) => st.pass(P.saturate([bad]))) });
  const d = diags.find((x) => x.code === "rule-unsound");
  assert.ok(d, "rule-unsound diagnostic");
  assert.equal(g.count("mul"), 2, "the unsound rule changed nothing");
  console.log("       " + d.message);
});
test("validate() catches a pass that changes behaviour", () => {
  const breaker = pass("breaker").on("dag").run((g) => {
    const add = g.nodes("add")[0];
    g.replace(add, g.const(0, add.type));
  });
  const { g } = counter();
  const { diags } = runPipeline({ name: "c", domains: { sys: { hz: 12e6, graph: g } }, target: { family: "ice40", part: "ice40up5k" }, compileCfg: (c) => c.after("lower", (st) => st.pass(breaker)).validate({ cycles: 32 }) });
  const v = diags.find((d) => d.code === "validate");
  assert.ok(v && /breaker changed behaviour/.test(v.message), JSON.stringify(diags));
});

// ── memories: F-08's echo and sine table ─────────────────────────────────────────────────────────────────────
test("F-08: the 8192×12 echo is block RAM (3 RAMB36 on xc7), the registered 1024-entry sine table 1 RAMB18", () => {
  const g = echo();
  const cfg = (c) => c.check("the delay line is block RAM", (r) => r.resources.of("echo").brams >= 1);
  const { report } = runPipeline({ name: "echo", domains: { sys: { hz: 100e6, graph: g } }, target: { family: "xc7", part: "xc7a35t" }, compileCfg: cfg });
  const m = Object.fromEntries(report.memories.map((x) => [x.path, x]));
  assert.equal(m["echo.delay"].place, "bram");
  assert.equal(m["echo.delay"].brams, 3);
  assert.equal(m["osc.SINE"].place, "bram");
  assert.equal(m["osc.SINE"].brams, 0.5);
  assert.equal(m["osc.SINE"].primitive, "RAMB18E1");
  assert.equal(report.resources.of("echo").brams, 3);
  assert.ok(report.checks.find((c) => c.kind === "check").ok);
  assert.equal(bramCount(8192, 12, FAMILY.ice40).count, 24);
  const r2 = runPipeline({ name: "echo", domains: { sys: { hz: 48e6, graph: echo() } }, target: { family: "ice40", part: "ice40up5k" } }).report;
  assert.equal(r2.memories.find((x) => x.path === "echo.delay").place, "bram");
  assert.equal(r2.resources.brams, 24 + 3);
  // a single-port 16K×16 RAM on iCE40 goes to SPRAM
  const gs = new Graph("sys", 24e6);
  const ad = gs.input("buf.addr", u(14), { src: "port" }), dd = gs.input("buf.d", u(16), { src: "port" }), we = gs.input("buf.we", bit, { src: "port" });
  const mm = gs.add("mem", [], u(16), { path: "buf.line", words: 16384, elem: u(16), module: "buf" });
  gs.add("memwr", [mm, ad, dd, we], u(16), { module: "buf" });
  const q = gs.reg("buf.q", u(16), { module: "buf" });
  gs.setNext(q, gs.add("memrd", [mm, ad, gs.const(1)], u(16), { module: "buf" }));
  const rs = runPipeline({ name: "sp", domains: { sys: { hz: 24e6, graph: gs } }, target: { family: "ice40", part: "ice40up5k" } }).report;
  assert.equal(rs.memories[0].place, "spram");
  assert.equal(rs.resources.sprams, 1);
  const v = emitVerilog({ name: "echo", domains: { sys: { hz: 100e6, graph: echo() } } });
  dump("echo", v);
  const t = v[0].text;
  assert.match(t, /reg \[11:0\] echo_delay \[0:8191\];/);
  assert.match(t, /if \(\|dry_valid\) n\d+ <= echo_delay\[n\d+\];/);
});

// ── F-18: the blend misses 300 MHz ───────────────────────────────────────────────────────────────────────────
test("F-18: the 300 MHz blend fails timing; the dossier carries the path with origins", () => {
  const g = blend(300e6);
  const { report, diags } = runPipeline({ name: "blend", domains: { fast: { hz: 300e6, graph: g } }, target: { name: "dev", family: "xc7", part: "xc7a35t" } });
  const t = report.timing.fast;
  assert.ok(!t.met && t.slack < 0, `slack ${t.slack}`);
  assert.ok(diags.some((d) => d.code === "timing"));
  const f = report.failures[0];
  assert.equal(f.domain, "fast");
  assert.equal(f.target, "300 MHz");
  assert.ok(f.path.some((p) => p.origin?.src === "l.bg * (255 - l.alpha)" || p.origin?.src === "l.fg * l.alpha"));
  assert.ok(f.path.some((p) => p.origin?.line === 29));
  console.log("       " + t.worstNs + " ns, fmax " + t.fmax + " MHz");
  dump("blend", emitVerilog({ name: "blend", domains: { fast: { hz: 300e6, graph: g } } }));
});

// ── explore, custom backends, emitters ─────────────────────────────────────────────────────────────────────
test("explore: grid, keep, Pareto front through a recompile callback; a custom backend; c-header", () => {
  const cfg = (c) => c.explore((x) => x
    .knob("fir.TAPS", [7, 15]).knob("fir.MULT", ["dsp", "shift-add"])
    .measure((r) => ({ luts: r.resources.luts, dsps: r.resources.dsps, met: r.timing.slack("sys") >= 0 }))
    .keep((m) => m.met).pareto(["luts", "dsps"]));
  const base = runPipeline({ name: "fir", domains: { sys: { hz: 100e6, graph: fir() } }, target: { family: "xc7", part: "xc7a35t" }, compileCfg: cfg });
  assert.equal(base.report.explore.pending, true);
  const recompile = (o) => {
    const taps = Array.from({ length: o["fir.TAPS"] }, (_, i) => 3 + 2 * i);
    return runPipeline({ name: "fir", domains: { sys: { hz: 50e6, graph: fir(taps, 50e6) } }, instances: [{ path: "fir", hints: { multiply: o["fir.MULT"] } }], target: { family: "xc7", part: "xc7a35t" } });
  };
  const ex = runExplore(base.report.explore, recompile);
  assert.equal(ex.points.length, 4);
  assert.ok(ex.points.some((p) => p.pareto));
  assert.ok(ex.front.length >= 2, "LUTs trade against DSPs");
  const census = backend("cell-census").on("net").emit((net, out) => {
    const counts = {};
    for (const cell of net.cells()) counts[cell.type] = (counts[cell.type] ?? 0) + 1;
    out.file("cells.json", JSON.stringify(counts, null, 2));
  });
  const g = counter().g;
  const knobs = [{ path: "synth.hz", module: "synth", name: "hz", kind: "knob", type: u(16), reset: 440, min: 20, max: 20000, addr: 4, domain: "sys", node: 0 }];
  const r = runPipeline({ name: "siren", domains: { sys: { hz: 12e6, graph: g } }, knobs, target: { name: "pico", family: "ice40", part: "ice40up5k" },
    compileCfg: (c) => c.when((t) => t.family === "ice40", (w) => w.emit(census, { to: (t) => `build/${t.name}` })).emit("c-header", { to: "fw/siren_regs.h" }).emit("host-js", { to: "host/siren.js" }).emit("register-doc", { to: "docs/registers.md" }).emit("vhdl", { to: "build/vhdl" }).emit("sim:wasm", { to: "x.wasm" }) });
  const cells = JSON.parse(r.emits.find((e) => e.backend === "cell-census").files[0].text);
  assert.equal(r.emits.find((e) => e.backend === "cell-census").files[0].path, "build/pico/cells.json");
  assert.equal(cells.SB_DFF, 8);
  const h = r.emits.find((e) => e.backend === "c-header").files[0];
  assert.equal(h.path, "fw/siren_regs.h");
  assert.match(h.text, /#define SIREN_SYNTH_HZ_ADDR 0x04/);
  assert.match(r.emits.find((e) => e.backend === "vhdl").files[0].text, /entity siren_vhd is/);
  assert.equal(r.emits.find((e) => e.backend === "sim:wasm").files.length, 0);
  assert.ok(r.report.registers[0].addr === 4);
});
test("config errors become diagnostics, never exceptions", () => {
  const { diags } = runPipeline({ name: "x", domains: { sys: { hz: 1e6, graph: counter().g } }, compileCfg: (c) => c.after("nonsense", (s2) => s2.pass(P.dce)).replace("nope", P.dce).stage("weird", (s2) => s2.pass(42)) });
  assert.ok(diags.filter((d) => d.code === "compile-config").length >= 3, JSON.stringify(diags));
  const r = runPipeline({ name: "y", domains: {} });
  assert.ok(r.report && r.stages.length === 6);
});

// ── the real examples through fork A's compile() (skipped until app/test/STATUS-A.md says they compile) ──────
import { existsSync, readFileSync, readdirSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname;
const ex = (id) => { const dir = `${here}../../examples`; const f = readdirSync(dir).find((x) => x.startsWith(id)); return { f, src: readFileSync(`${dir}/${f}`, "utf8") }; };
if (existsSync(`${here}STATUS-A.md`)) {
  const { compile } = await import("../src/core/compile.js");
  const build = (id) => { const { f, src } = ex(id); return compile(src, { file: f }); };
  test("examples · F-13: one DSP48E1 on xc7a35t, meets 250 MHz, the DAG snapshot after optimize", () => {
    const c = build("F-13");
    assert.equal(c.report.resources.dsps, 1);
    assert.equal(c.report.part.family, "xc7");
    assert.ok(c.report.checks.filter((x) => x.kind === "check").every((x) => x.ok), JSON.stringify(c.report.checks));
    const snap = c.stages.find((x) => x.name === "optimize").snapshot;
    assert.equal(snap.to, "build/mac.dag.dot");
    assert.match(snap.text, /mul/);
    assert.ok(c.emits.some((e) => e.backend === "verilog" && e.files.some((x) => x.path.startsWith("build/rtl/"))));
    assert.ok(c.stages.find((x) => x.name === "map").inspect.output.length >= 1);
  });
  test("examples · F-14: every mul rewritten away, the 48-bit comparison linted at its line, explainPlan", () => {
    const c = build("F-14");
    assert.equal(c.report.ir("dag").count("mul"), 0);
    assert.ok(c.report.ir("lower").count("mul") > 0);
    const lint = c.diags.filter((d) => d.code === "lint");
    assert.equal(lint.length, 1);
    assert.match(lint[0].message, /48-bit comparison/);
    assert.ok(lint[0].line > 40);
    assert.match(c.report.plan, /saturate/);
    assert.ok(c.report.rules.find((r) => r.name === "multiply by a power of two").applied >= 64);
  });
  test("examples · F-08: the echo delay line is block RAM", () => {
    const c = build("F-08");
    const m = c.report.memories.find((x) => x.path.startsWith("echo"));
    assert.equal(m.place, "bram");
    assert.ok(c.report.resources.of("echo").brams >= 1);
    assert.ok(c.report.checks.find((x) => x.kind === "check").ok);
  });
  test("examples · F-18: the 300 MHz blend fails timing, with a dossier", () => {
    const c = build("F-18");
    assert.ok(!c.report.timing.fast.met);
    assert.equal(c.report.failures[0].domain, "fast");
    assert.ok(c.report.failures[0].path.some((p) => p.origin?.src?.includes("l.alpha")));
    assert.ok(c.report.timing.sys.met);
  });
  test("examples · every example: Verilog for every domain and no pass failures", () => {
    for (const f of readdirSync(`${here}../../examples`).filter((x) => /^F-\d+/.test(x))) {
      const c = compile(readFileSync(`${here}../../examples/${f}`, "utf8"), { file: f });
      assert.ok(!c.diags.some((d) => ["pass-failed", "ir-invariant", "compile-config", "internal", "validate"].includes(d.code)), `${f}: ${JSON.stringify(c.diags.filter((d) => d.level === "error"))}`);
      const v = emitVerilog(c);
      assert.ok(v.length >= 2 && !v.some((x) => x.path === "ERROR.txt"), f);
      for (const d of Object.keys(c.domains)) assert.ok(v.some((x) => x.text.includes(`clock domain ${d}`)), `${f} ${d}`);
    }
  });
}

console.log(`\n${count - failures}/${count} passed`);
if (failures) process.exit(1);
