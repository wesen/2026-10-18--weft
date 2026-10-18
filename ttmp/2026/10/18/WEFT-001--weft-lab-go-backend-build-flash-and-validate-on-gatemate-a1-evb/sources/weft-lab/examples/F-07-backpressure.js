/** F-07 Backpressure
 *  group  Components
 *  about  Four fast producers, four slow consumers, four buffered streams with four overflow policies. "block"
 *         holds ready low and its producer waits; the lossy ones keep going and count what they drop, in hardware,
 *         where the host can read it. stream.lower picks each buffer's implementation from its depth.
 *  shows  stream().buffer() overflow policies · $.push() / $.has() / $.take() · generator loops · drop counters
 *  watch  DAG (queues) · Waves
 *  try    Make one consumer twice as fast | Give q.block a depth of 512 and watch it move to block RAM
 */
const policies = {
  "q.block":  { depth: 16, overflow: "block" },
  "q.oldest": { depth: 16, overflow: "drop-oldest" },
  "q.newest": { depth: 16, overflow: "drop-newest" },
  "q.latest": { depth: 1,  overflow: "latest" },      // a register: the consumer always sees the freshest value
};
const names = Object.keys(policies);

const queues = names.map(n => stream(n)             // depth 1 → a register, 16 → LUT RAM, ≥ 64 → block RAM
  .of(u(16))
  .buffer(policies[n].depth, { overflow: policies[n].overflow }));

const producers = names.map(n => module(`fast-${n.slice(2)}`)
  .provides(n)
  .lib({ Q: n })                                    // a constant string names the stream inside the lambda
  .regs({ seq: u(16) })
  .seq($ => { if ($.push(Q, $.seq)) $.seq += 1; })); // a lossy stream always accepts; "block" may not

const consumers = names.map(n => module(`slow-${n.slice(2)}`)
  .needs(n)
  .lib({ Q: n })
  .regs({ last: u(16).init(0xffff), gaps: u(16), busy: u(2) })
  .seq($ => {
    $.busy += 1;                                    // ready on one cycle in four
    if ($.busy === 0 && $.has(Q)) {
      const v = $.take(Q);
      if (v !== wrap($.last + 1)) $.gaps += 1;
      $.last = v;
    }
  }));

return design("backpressure")
  .board("dev")
  .use(...queues, ...producers, ...consumers)
  .scenario("only block is lossless", sc => sc
    .step(4000)
    .expectState("slow-block", s => s.gaps === 0)
    .expectState("slow-oldest", s => s.gaps > 0)
    .expectState("slow-latest", s => s.gaps > 0)
    .expectDropped("q.block", 0)
    .expectDropped("q.newest", n => n > 2000));
