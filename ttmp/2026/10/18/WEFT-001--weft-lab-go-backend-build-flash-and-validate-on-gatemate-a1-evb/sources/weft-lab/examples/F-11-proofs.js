/** F-11 Proofs and testbenches
 *  group  Verification
 *  about  A round-robin arbiter with its properties beside it. The same .assert() lambdas are checked on every
 *         cycle in simulation, proved by the formal engine, and can be built into hardware as monitors. A seeded,
 *         scoreboarded random test runs as an async runtime lambda.
 *  shows  .require() on params · .assert() / .assume() / .cover() · past() and within() · .prove() · coverage
 *  watch  Proofs · Waves
 *  try    Break the rotation and read the counterexample trace | Prove it for N = 8
 */
const arbiter = module("arbiter")
  .params({ N: 4 })
  .require(({ N }) => (N & (N - 1)) === 0 || "N must be a power of two")   // checked per specialization
  .in("req", ({ N }) => u(N))
  .out("grant", ({ N }) => u(N))
  .regs(({ N }) => ({ last: u(clog2(N)) }))
  .comb($ => {
    $.grant = 0;
    for (let k = N; k >= 1; k--) {                  // unrolled; the last match wins, so walk from the far end
      const i = wrap($.last + k, u(clog2(N)));      // wrapping to clog2(N) bits is modulo N for free
      if ($.req[i]) $.grant = 1 << i;
    }
  })
  .seq($ => { for (let i = 0; i < N; i++) if ($.grant[i]) $.last = i; })
  .assume("a request waits for its grant", $ => !(past($.req[0]) && !past($.grant[0])) || $.req[0])
  .assert("at most one grant", $ => ($.grant & ($.grant - 1)) === 0)
  .assert("grants go to requesters", $ => ($.grant & ~$.req) === 0)
  .assert("served within N cycles", $ => !$.req[0] || within(N, $.grant[0]))
  .cover("every port served in turn", $ => sequence($.grant === 1, $.grant === 2, $.grant === 4, $.grant === 8));

return design("arbiter")
  .use(arbiter)                                     // no board and no part: simulation and proofs only
  .prove(p => p
    .module("arbiter")
    .bmc(24)                                        // no counterexample in 24 cycles…
    .induction()                                    // …then k-induction for every depth
    .engine("smt"))
  .scenario("fair under random load", async tb => {
    const served = [0, 0, 0, 0];
    let req = 0, grant = 0;
    for (let t = 0; t < 10_000; t++) {
      req = (req & ~grant) | tb.random.int(0, 15);  // pending requests stay up, as the assume demands
      await tb.poke("arbiter.req", req);
      await tb.step();
      grant = await tb.peek("arbiter.grant");
      if (grant) served[Math.log2(grant)]++;
    }
    tb.expect(Math.min(...served) > 2000, `shares: ${served}`);   // seeded: a failure replays exactly
    tb.expectCoverage("all");                       // every .cover() was hit at least once
  });
