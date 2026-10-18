/** F-08 Tables and memories
 *  group  Components
 *  about  A direct digital synthesizer feeding an echo. A builder lambda fills the sine table; the delay line is a
 *         RAM that mem.infer puts in block RAM. RAM reads take a cycle, and the grammar makes you say so.
 *  shows  rom().from() · .ram() · .every("48 kHz") · sat() · std.sigmaDelta · a check on the build report
 *  watch  Board (audio) · Report (memories)
 *  try    Store a quarter wave and mirror it | Make the echo half a second long and read the BRAM count
 */
const sine = rom("sine")
  .of(s(12))
  .from(1024, i => Math.round(2047 * Math.sin((2 * Math.PI * i) / 1024)));   // builder lambda, called 1024 times now

const osc = module("osc")
  .params({ HZ: 440 })
  .provides("dry")
  .lib({ SINE: sine })                              // a rom shipped by .lib() is instanced in this module
  .lib(({ HZ }) => ({ STEP: Math.round((HZ * 2 ** 32) / 48_000) }))   // the tuning word, computed at build time
  .regs({ phase: u(32) })
  .every("48 kHz", $ => {
    $.phase += STEP;
    $.push("dry", SINE[$.phase.bits(31, 22)]);      // the top ten bits index the table
  });

const echo = module("echo")
  .needs("dry").provides("wet")
  .ram("delay", { of: s(12), words: 8192 })         // 8192 × 12 bits
  .regs({ at: u(13) })
  .on("dry", ($, x) => {
    const back = $.delay.q;                         // what the last read() returned: reads take a cycle
    const y = sat(x + (back >> 1), s(12));          // 13 bits back into 12 by saturating, never by accident
    $.delay.write($.at, y);
    $.delay.read(wrap($.at + 1));                   // the oldest sample, ready by the next beat
    $.at += 1;
    $.push("wet", y);
  });

return design("echo")
  .board("dev")
  .use(stream("dry").of(s(12)), stream("wet").of(s(12)), osc, echo)
  .use(std.sigmaDelta("dac").needs("wet").bind({ out: "audio" }))
  .compile(c => c                                   // the default pipeline, plus one check (more in F-13)
    .check("the delay line is block RAM", r => r.resources.of("echo").brams >= 1))
  .scenario("stays in range", sc => sc
    .wait("200ms")
    .expectStream("wet", ys => ys.every(y => y >= -2048 && y <= 2047), { last: 4800 }));
