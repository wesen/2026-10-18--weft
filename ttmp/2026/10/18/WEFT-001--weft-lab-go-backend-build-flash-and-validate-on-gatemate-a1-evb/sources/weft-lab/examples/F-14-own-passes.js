/** F-14 Your own passes
 *  group  Compiler
 *  about  Passes are values, like modules. An analysis computes a fact about the IR; a pass changes it; a rewrite
 *         is a pattern and its replacement, both written as hardware lambdas and matched against the DAG.
 *         requires/preserves turn the pass list into a DAG of its own, so an analysis reruns only after something
 *         invalidated it. The same scenario runs at three IR levels; a mismatch names the pass that caused it.
 *  shows  analysis() · pass().visit() · rewrite().from().where().to() · rule examples · e-graph saturation · lint
 *  watch  Passes · DAG
 *  try    Add a rule for x * 2^k - x | Lower the fanout limit to 8 and watch the register count
 */
const isPow2 = k => k > 0 && (k & (k - 1)) === 0;

const peephole = [
  rewrite("multiply by a power of two")
    .from((x, k) => x * k)                          // a pattern: x and k match any node…
    .where(({ k }) => k.isConst && isPow2(k.value)) // …and this builder lambda narrows the match
    .to((x, k) => x << clog2(k))
    .examples([[x => x * 8, x => x << 3], [x => x * 6, null]]),   // null: must not match
  rewrite("same value on both arms").from((c, a) => (c ? a : a)).to((c, a) => a),
  rewrite("double inversion").from(x => ~~x).to(x => x),
];   // SAT screens each rule at widths 1–16 when loaded, then proves it again at the exact width of each match

const fanout = analysis("fanout")
  .on("dag")
  .run(g => new Map(g.nodes().map(n => [n.id, n.users.length])));

const splitFanout = pass("split-fanout")
  .on("dag")
  .requires(fanout, std.analyses.timing)            // estimated on the DAG, long before placement
  .preserves("widths", "domains")                   // everything else is invalidated when this pass edits the graph
  .params({ limit: 32 })
  .visit("reg", (n, g, { fanout, timing, limit }) => {
    const users = fanout.get(n.id);
    if (users > limit && timing.slack(n) < 0.5) g.duplicate(n, { copies: Math.ceil(users / limit), split: "users" });
  });

const wideCompares = pass("lint: wide comparisons")
  .on("dag")
  .readonly()                                       // preserves every analysis
  .visit(["lt", "le", "gt", "ge"], (n, g) => {
    const w = Math.max(...n.args.map(a => a.width));   // the result is one bit; the operands carry the width
    if (w > 32) g.warn(n, `${w}-bit comparison in one cycle`);   // reported at the lambda's source line
  });

const scaler = module("scaler")
  .in({ x: u(16), en: bit, now: u(48), deadline: u(48) })
  .out({ y: vec(u(20), 64), late: bit })
  .regs({ go: bit })                                // en, registered once: one flip-flop that drives 1280 enables
  .seq($ => {
    $.go = $.en;
    for (let i = 0; i < 64; i++) if ($.go) $.y[i] = ($.x ^ i) * 8;   // 64 multiplies by 8
  })
  .comb($ => { $.late = $.now > $.deadline; });    // 48 bits: the lint will say so

return design("passes")
  .part("ice40up5k-sg48")
  .clocks(c => c.port("sys", { hz: "48 MHz" }))
  .use(scaler)
  .compile(c => c
    .use(std.pipeline.default)                      // F-13's stages, then edits to them
    .after("lower", s => s.pass(wideCompares))
    .after("optimize", s => s.pass(std.passes.saturate(peephole, { iters: 6, cost: "luts" })))   // e-graph, cheapest wins
    .before("techmap", s => s.pass(splitFanout.with({ limit: 16 })))
    .explainPlan()                                  // prints the pass DAG: what ran, what was reused, what was invalidated
    .check("no multipliers left", r => r.ir("dag").count("mul") === 0))
  .scenario("same answers after the rewrites", sc => sc
    .poke("scaler.x", 1000).poke("scaler.en", 1).step(2)   // one edge to register en, one to load y
    .expectSignal("scaler.y[5]", (1000 ^ 5) * 8),
    { levels: ["hir", "dag", "net"] });             // run at three IR levels; a mismatch is bisected to one pass
