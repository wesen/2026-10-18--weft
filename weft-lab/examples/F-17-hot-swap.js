/** F-17 Hot swap, with rollback
 *  group  Live change
 *  about  The filter lives in a reconfigurable region. A change is linted, replayed against recorded traffic, built
 *         as a partial bitstream for that region alone (the rest of the design is locked), and loaded for a canary
 *         window while its asserts run as hardware monitors. A knob-only change is a register write and skips all
 *         of that. A good swap commits; a bad one trips an assert during canary and the previous partial comes back.
 *  shows  .regions() · .place() · change() · .knob() · .replace() · .patch() · .verify() · .deploy() · .migrate()
 *  watch  Changes · Board (audio) · Waves
 *  try    Shorten the canary to 50 ms and watch the bad change commit | Patch the filter and a knob in one change
 */
function lowpass2(fc, fs) {                         // an RBJ biquad low-pass in Q14, plain JS at build time
  const w = (2 * Math.PI * fc) / fs, alpha = Math.sin(w) / Math.SQRT2, c = Math.cos(w), a0 = 1 + alpha;
  const q14 = v => Math.round((v / a0) * 2 ** 14);
  return { B: [q14((1 - c) / 2), q14(1 - c), q14((1 - c) / 2)], A: [q14(-2 * c), q14(1 - alpha)] };
}

const tone = module("tone")
  .provides("dry")
  .knob("volume", u(4), { reset: 2 })
  .lib({ STEP: Math.round((330 * 2 ** 16) / 48_000) })
  .regs({ phase: u(16) })
  .every("48 kHz", $ => {
    $.phase += STEP;
    $.push("dry", sat(($.phase.as(s(16)) * $.volume) >> 4, s(16)));   // .as() reinterprets: a sawtooth
  });

const onePole = module("filter")
  .needs("dry").provides("wet")
  .knob("alpha", u(8), { reset: 32 })               // 0 holds still, 255 passes everything
  .regs({ y: s(16) })
  .on("dry", ($, x) => {
    $.y += ((x - $.y) * $.alpha) >> 8;
    $.push("wet", $.y);
  })
  .assert("never pinned at a rail", $ => $.y !== 32767 && $.y !== -32768);   // sim, proofs, and a hardware monitor

const biquad = module("filter")                     // same name and ports: a drop-in replacement
  .needs("dry").provides("wet")
  .lib({ ...lowpass2(2000, 48_000), GAIN: 1 })
  .regs({ x1: s(16), x2: s(16), y1: s(16), y2: s(16), out: s(16) })
  .on("dry", ($, x) => {
    const acc = B[0] * x + B[1] * $.x1 + B[2] * $.x2 - A[0] * $.y1 - A[1] * $.y2;
    const y = sat(acc >> 14, s(16));
    $.x2 = $.x1; $.x1 = x;
    $.y2 = $.y1; $.y1 = y;
    const out = sat(y * GAIN, s(16));               // gain after the feedback loop, never inside it
    $.out = out;
    $.push("wet", out);
  })
  .assert("never pinned at a rail", $ => $.out !== 32767 && $.out !== -32768)
  .migrate(old => ({ y1: old.y, y2: old.y, out: old.y }));   // runtime lambda: the old region's registers, read back

const softer = change("softer")
  .knob("filter.alpha", 12);                        // a register write: no bitstream, commits at once

const swap = change("biquad instead of one-pole")
  .replace("filter", biquad)
  .verify(v => v.lint().ports("same").replay("last 1s").timing())
  .deploy(d => d.partial("dsp").canary("300ms", { watch: ["asserts", "wet.rate"] }))
  .rollbackOn("assert", "stall");

const louder = change("gain × 4")
  .patch("filter", { lib: { GAIN: 4 } })            // re-elaborates one module; only its region is rebuilt
  .verify(v => v.lint().replay("last 1s"))          // the recorded second was quiet, so replay passes
  .deploy(d => d.partial("dsp").canary("500ms"))
  .rollbackOn("assert");

return design("hot-swap")
  .board("dev")
  .regions(r => r.partition("dsp", { luts: 1500, dsps: 6 }))   // a floorplanned slot; everything else is static
  .place({ filter: "dsp" })
  .record({ streams: ["dry"], keep: "2s" })         // what .replay() feeds a candidate
  .use(tone, onePole, std.sigmaDelta("dac").needs("wet").bind({ out: "audio" }))
  .scenario("good commits, bad rolls back", sc => sc
    .wait("1s")
    .apply(softer).expectChange("softer", "committed", { within: "1ms" })
    .apply(swap).expectChange(/biquad/, "committed", { within: "2s" })
    .expectState("filter", s => s.y1 !== 0)         // migrate() carried the state across
    .apply(louder).wait("100ms")
    .write("tone.volume", 12)                       // the live signal gets loud mid-canary
    .expectChange("gain × 4", "rolled-back", { within: "1s" })
    .expectStream("wet", ys => ys.every(y => Math.abs(y) < 32_767), { last: 480 }));
