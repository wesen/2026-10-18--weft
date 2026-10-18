/** F-15 Retiming and exploration
 *  group  Compiler
 *  about  A 31-tap FIR filter written as one combinational sum. .pipelined() hands the latency of its stream path to
 *         the compiler, so pipeline.cut slices the adder tree to meet the clock and retime moves registers across
 *         it. .explore() runs the pipeline over a grid of build-time knobs and keeps the Pareto front; the IR cache
 *         makes every point after the first a partial rebuild. Build-time knobs pick parameters; runtime knobs
 *         (F-12) are registers.
 *  shows  taps from build-time JS · .hint() · .pipelined() · pipeline.cut · retime · explore() · a JS reference model
 *  watch  Report (explore) · DAG
 *  try    Add a "fold symmetric taps" knob | Keep only points with latency ≤ 6 and see which survive
 */
function lowpass(n, cutoff) {                       // windowed sinc, normalized to unity gain in Q15: plain JS
  const m = (n - 1) / 2;
  const h = Array.from({ length: n }, (_, i) => {
    const t = i - m;
    const sinc = t === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t);
    return sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1)));   // Hamming window
  });
  const sum = h.reduce((a, b) => a + b, 0);
  return h.map(v => Math.round((v / sum) * 2 ** 15));
}

const fir = module("fir")
  .params({ TAPS: 31, CUTOFF: 0.1, MULT: "dsp" })
  .needs("in").provides("out")
  .lib(({ TAPS, CUTOFF }) => ({ H: lowpass(TAPS, CUTOFF) }))
  .regs(({ TAPS }) => ({ z: vec(s(16), TAPS) }))   // the delay line
  .hint(({ MULT }) => ({ multiply: MULT }))         // "dsp" | "lut" | "shift-add": steers dsp.pack and techmap
  .pipelined({ path: ["in", "out"] })               // latency on this stream path is the compiler's to choose
  .on("in", ($, x) => {
    for (let i = TAPS - 1; i > 0; i--) $.z[i] = $.z[i - 1];
    $.z[0] = x;
    let acc = x * H[0];
    for (let i = 1; i < TAPS; i++) acc = acc + $.z[i - 1] * H[i];   // grows as it must; nothing truncates
    $.push("out", sat(acc >> 15, s(16)));
  });

return design("fir")
  .board("dev")
  .use(stream("in").of(s(16)), stream("out").of(s(16)), fir)
  .compile(c => c
    .use(std.pipeline.default)                      // F-13's stages, then one edit to them
    .replace("retime", std.passes.retime.with({ moves: "both" }))   // registers may move backward too
    .explore(x => x
      .knob("fir.TAPS", [15, 31, 63])
      .knob("fir.MULT", ["dsp", "lut", "shift-add"])
      .knob("clock.sys", ["100 MHz", "150 MHz", "200 MHz"])
      .measure(r => ({
        luts: r.resources.luts,
        dsps: r.resources.dsps,
        latency: r.latency("fir"),
        met: r.timing.slack("sys") >= 0,
      }))
      .keep(m => m.met)
      .pareto(["luts", "dsps", "latency"])
      .parallel(8)
      .report("build/fir-explore.html")))
  .scenario("matches the JS model", async tb => {
    const H = lowpass(31, 0.1);                     // runtime lambdas may call build-time JS freely
    const xs = Array.from({ length: 200 }, () => tb.random.int(-20_000, 20_000));
    await tb.push("in", xs);
    const ys = await tb.pull("out", xs.length);
    xs.forEach((_, n) => {
      const acc = H.reduce((a, h, i) => a + h * (xs[n - i] ?? 0), 0);
      tb.expectEqual(ys[n], Math.max(-32_768, Math.min(32_767, Math.floor(acc / 2 ** 15))), `y[${n}]`);
    });
  });
