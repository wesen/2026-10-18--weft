/** F-18 Timing closer
 *  group  Agents
 *  about  An agent takes part in the build. When timing fails, the compiler hands the closer a dossier: the
 *         critical path as DAG nodes, each carrying the lambda and source text it came from. The closer proposes a
 *         change; the change is linted, checked for equivalence and timed again before it waits for your approval.
 *  shows  agent() · .scope() · the timing dossier · provenance through passes · equivalence up to stream latency
 *  watch  Agent · Changes · Report (timing)
 *  try    Let it commit knob changes without approval | Limit it to one proposal per build
 */
const closer = agent("closer")
  .model("claude")
  .guidelines(`You close timing on FPGA designs. Read the dossier's critical path and the source it came from.
Prefer, in order: a knob within its bounds, latency on a stream path (.pipelined), a rewrite of the lambda.
Never change ports, pins, clocks or stream types. Behavior must stay equivalent up to stream latency.`)
  .scope(s => s.read("*").propose("modules/*", "knobs/*").never("pins", "clocks", "boot", "streams"))
  .budget({ proposals: 3, per: "build" })
  .on("timing.failed", async (ctx, d) => {          // d: { domain, target, slack, path: [{ op, width, origin }], resources }
    const proposal = await ctx.llm.propose({
      goal: `Meet ${d.target} in ${d.domain}; the worst slack is ${d.slack} ns`,
      evidence: { path: d.path, resources: d.resources },
    });
    return ctx.changes.submit(proposal, {
      verify: v => v.lint().equiv({ upTo: "stream latency" }).timing(),
      approve: "you",                               // waits in the Changes tab
    });
  });

const blend = module("blend")
  .needs("layers").provides("out")
  .lib({ GAMMA: Array.from({ length: 256 }, (_, i) => Math.round(255 * (i / 255) ** (1 / 2.2))) })
  .on("layers", ($, l) => {
    const mix = (l.fg * l.alpha + l.bg * (255 - l.alpha) + 128) >> 8;   // two multiplies, two adds…
    $.push("out", GAMMA[sat(mix, u(8))]);                                 // …and a table, all in one cycle
  });

return design("blend")
  .board("dev")
  .clocks(c => c.pin("sys", "clk").pll("fast", { from: "sys", hz: "300 MHz" }))
  .use(stream("layers").of(struct({ fg: u(8), bg: u(8), alpha: u(8) })), stream("out").of(u(8)))
  .use(blend.domain("fast"), closer)                // .domain() returns a new value, like every builder call
  .scenario("closes timing", sc => sc
    .build()
    .expectBuild("timing", "failed")                // the dossier goes to the closer
    .expectProposal("closer", { within: "2m" })
    .approve()
    .expectChange(/blend/, "committed")
    .expectBuild("timing", "met"))
  .scenario("still blends", sc => sc
    .feed("layers", [{ fg: 255, bg: 0, alpha: 255 }, { fg: 0, bg: 255, alpha: 0 }])
    .expectStream("out", ys => ys.every(y => y >= 254)));
