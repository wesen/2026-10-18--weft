/** F-09 Pipelines
 *  group  Components
 *  about  RGB to luma in three stages. What a stage writes is visible to the stages after it, and
 *         pipeline.registers carries only what is still live: $.r, $.g and $.b cross one register, px crosses none.
 *         When the output is not ready the pipe stalls; .stall("skid") spends a few registers to keep that stall
 *         off the critical path.
 *  shows  pipeline() · .stage() · inferred pipeline registers · fixed-point weights from build-time JS · a JS model
 *  watch  DAG (stages) · Waves
 *  try    Add a contrast stage between sum and round | Switch to .stall("global") and compare fmax
 */
const rgb = struct({ r: u(8), g: u(8), b: u(8) });
const W = [0.299, 0.587, 0.114].map(w => Math.round(w * 256));   // [77, 150, 29] in Q0.8, computed now

const luma = pipeline("luma")
  .needs("rgb").provides("gray")
  .lib({ W })
  .stall("skid")
  .stage("weigh", ($, px) => {                      // the first stage receives the beat
    $.r = px.r * W[0];
    $.g = px.g * W[1];
    $.b = px.b * W[2];
  })
  .stage("sum", $ => { $.y = $.r + $.g + $.b; })    // as wide as it needs to be
  .stage("round", $ => sat(($.y + 128) >> 8, u(8)));   // the last stage's return value is the output beat

return design("luma")
  .board("dev")
  .use(stream("rgb").of(rgb), stream("gray").of(u(8)), luma)
  .scenario("matches the JS model", async tb => {   // runtime lambda: async JS beside the simulator
    const px = Array.from({ length: 64 }, () =>
      ({ r: tb.random.int(0, 255), g: tb.random.int(0, 255), b: tb.random.int(0, 255) }));
    await tb.push("rgb", px);
    const ys = await tb.pull("gray", px.length);
    px.forEach((p, i) =>
      tb.expectEqual(ys[i], Math.min(255, (p.r * W[0] + p.g * W[1] + p.b * W[2] + 128) >> 8), `pixel ${i}`));
  })
  .scenario("survives backpressure", sc => sc
    .feed("rgb", "random", { beats: 500 })
    .throttle("gray", { ready: 0.3 })               // the sink is ready on 30 % of cycles
    .expectStream("gray", ys => ys.length === 500, { within: "100us" }));
