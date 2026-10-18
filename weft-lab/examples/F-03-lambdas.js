/** F-03 Three kinds of lambda
 *  group  Basics
 *  about  Builder lambdas run once, now, in JS, and shape the graph. Hardware lambdas are parsed into the IR and
 *         never called, so they cannot see JS variables: whatever they need is shipped with .lib(). Runtime lambdas
 *         run later, beside the simulator or the board, and are ordinary JS. This example ships with the classic
 *         mistake.
 *  shows  the compiler's capture check · .lib() · arrays become ROMs, functions are re-parsed and inlined
 *  watch  Code (diagnostics)
 *  try    Fix the capture error | Explain why gamma needs GAMMA shipped too
 */
const GAMMA = Array.from({ length: 256 }, (_, i) => Math.round(255 * (i / 255) ** 2.2));   // build-time JS
const gamma = v => GAMMA[v];

const dimmer = module("dimmer")
  .in("level", u(8))
  .out("pwm", bit)
  .regs({ phase: u(8) })
  .budget(b => b.luts(120).brams(0))                // builder lambda: runs now, while the graph is built
  .seq($ => {                                       // hardware lambda: parsed into IR nodes, never called
    $.phase += 1;
    $.pwm = $.phase < gamma($.level);              // ✕ captures the JS binding `gamma`
  });
  // the fix: .lib({ GAMMA, gamma }). GAMMA becomes a 256 × 8 ROM; gamma is re-parsed and inlined at the call

return design("lambdas")
  .board("dev")
  .use(dimmer)
  .pins({ "dimmer.level": "sw:0..7", "dimmer.pwm": "led:0" })
  .scenario("half the switches, a fifth of the light", async tb => {   // runtime lambda: plain async JS
    await tb.set("sw:0..7", 128);
    const duty = await tb.measure("led:0", { over: "1ms" });          // the fraction of time it was high
    tb.expect(Math.abs(duty - GAMMA[128] / 256) < 0.01);              // runtime lambdas may use JS values freely
  });
