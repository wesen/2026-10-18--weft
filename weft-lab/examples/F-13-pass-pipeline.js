/** F-13 The pass pipeline
 *  group  Compiler
 *  about  Under every design is an IR DAG compiler. Hardware lambdas are parsed into HIR, flattened into one
 *         dataflow DAG per clock domain (registers are where the cycles are cut), optimized to a fixpoint, mapped
 *         onto the part's cells, then placed and routed. Every node keeps the lambda and the source text it came
 *         from, through every pass. This is what .compile() runs when you pass nothing, written out, with a
 *         snapshot, an inspection and checks between stages.
 *  shows  hir → dag → net → phys · stages and passes · fixpoint · verifyEach · snapshot · inspect · checks
 *  watch  Passes · DAG · Report
 *  try    Drop dsp.pack and compare LUTs | Ask for 400 MHz and follow explain() back to the source
 */
const mac = module("mac")
  .in({ a: s(18), b: s(18), clear: bit })
  .out("acc", s(48))
  .seq($ => {
    if ($.clear) $.acc = 0;
    else $.acc += $.a * $.b;                        // 18 × 18 → 36 bits; dsp.pack folds the multiply-add into one DSP
  });

// What .inspect("dag", g => g.print(), { after: "optimize" }) shows: one line per node, each with its origin:
//   %1 = in a : s18
//   %2 = in b : s18
//   %3 = in clear : bit
//   %4 = reg acc : s48                       ← .out("acc", s(48)), written in .seq
//   %5 = mul %1, %2 : s36                    ← $.a * $.b
//   %6 = add %4, sext(%5) : s48 wrap         ← +=
//   %7 = mux %3, 0, %6 : s48                 ← if ($.clear)
//   %4.next = %7

return design("mac")
  .part("xc7a35t-1")                                // no board: an IP block, and its ports are the top
  .clocks(c => c.port("sys", { hz: "250 MHz" }))
  .use(mac)
  .compile(c => c
    .cache(".weft/cache")                           // nodes are content-hashed: an edit rebuilds only what it reaches
    .stage("front", s => s                          // source → hir
      .pass(std.passes.parse)                       // hardware lambdas → HIR, with the capture check
      .pass(std.passes.elaborate)                   // params, .with(), generator loops → one instance tree
      .pass(std.passes.link))                       // provides/needs and .wire() → edges; unmet needs fail here
    .stage("lower", s => s                          // hir → dag
      .pass(std.passes.fsm.extract, std.passes.pipeline.registers, std.passes.stream.lower, std.passes.csr.collect)
      .pass(std.passes.flatten)                     // one DAG per clock domain; registers are its sources and sinks
      .pass(std.passes.widths)                      // infer, then enforce: nothing truncates silently
      .pass(std.passes.checks.loops, std.passes.checks.latches, std.passes.checks.cdc))
    .stage("optimize", s => s
      .pass(std.passes.constFold, std.passes.cse, std.passes.muxTree, std.passes.dce)
      .fixpoint({ max: 8 }))                        // repeat until the graph's hash stops changing
    .stage("time", s => s                           // moves latency only where .pipelined() allows it
      .pass(std.passes.pipeline.cut, std.passes.retime))
    .stage("map", s => s                            // dag → net
      .pass(std.passes.mem.infer, std.passes.dsp.pack, std.passes.fsm.encode)
      .pass(std.passes.techmap))                    // the part decides the cells: LUT6, CARRY4, DSP48E1 …
    .stage("back", s => s                           // net → phys
      .pass(std.passes.place.with({ effort: "high" }), std.passes.route, std.passes.timing))
    .verifyEach()                                   // re-check IR invariants after every pass: slower, catches pass bugs
    .snapshot("dag", { after: "optimize", as: "dot", to: "build/mac.dag.dot" })
    .inspect("net", net => console.log(net.stats()), { after: "map" })   // a builder lambda over the IR, mid-build
    .check("one DSP", r => r.resources.dsps === 1 || `used ${r.resources.dsps} DSPs`)
    .check("meets 250 MHz", r => r.timing.slack("sys") >= 0 || r.timing.worst("sys").explain())   // path → source
    .emit("verilog", { to: "build/rtl" })
    .emit("report", { to: "build/mac.report.json" }))
  .scenario("accumulates", sc => sc
    .poke("mac.a", 3).poke("mac.b", -4).step(5)
    .expectSignal("mac.acc", -60));
