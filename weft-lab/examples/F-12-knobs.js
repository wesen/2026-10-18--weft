/** F-12 Knobs
 *  group  Runtime
 *  about  Modules declare what may be turned while the design runs. csr.collect gathers every knob, status and irq
 *         into one register map behind a bus bridge, and the backends emit a C header, a typed JS driver and the
 *         register docs. The host panel is a runtime lambda that turns knobs over UART; the bitstream never changes.
 *  shows  .knob() with bounds enforced in hardware · .status() · .irq() · a bus bridge · host() · emitted drivers
 *  watch  Board (audio) · Registers
 *  try    Give the panel a vibrato-depth knob | Raise the volume ceiling and hear the clip counter climb
 */
const sine = rom("sine")
  .of(s(12))
  .from(1024, i => Math.round(2047 * Math.sin((2 * Math.PI * i) / 1024)));

const synth = module("synth")
  .provides("samples")
  .knob("hz", u(14), { reset: 440, min: 20, max: 8000 })   // a write outside the bounds saturates, in hardware
  .knob("volume", u(4), { reset: 8 })
  .status("clipped", u(16))                         // hardware writes it, the host reads it
  .irq("clip")                                      // a pulse here arrives at the host as an event
  .lib({ SINE: sine, K: Math.round(2 ** 32 / 48_000) })
  .regs({ phase: u(32) })
  .every("48 kHz", $ => {
    $.phase += $.hz * K;
    const y = (SINE[$.phase.bits(31, 22)] * $.volume) >> 3;
    if (y > 2047 || y < -2048) { $.clipped += 1; $.clip = 1; }
    $.push("samples", sat(y, s(12)));
  });

const panel = host("panel")
  .over("bridge")                                   // the bridge's other end: a serial port, or the simulator
  .onStart(async dev => dev.log(await dev.registers()))   // the map the compiler built
  .every("20ms", async dev => {                     // runtime lambda: ordinary JS on your machine
    const t = dev.clock.seconds();
    await dev.knob("synth.hz").set(Math.round(660 + 220 * Math.sin(Math.PI * t)));   // a siren, no rebuild
  })
  .on("synth.clip", async dev => {
    await dev.knob("synth.volume").update(v => Math.max(v - 1, 0));
    dev.log("clipped", await dev.status("synth.clipped").read(), "times; volume down");
  });

return design("siren")
  .board("dev")
  .use(synth, panel)
  .use(
    std.sigmaDelta("dac").needs("samples").bind({ out: "audio" }),
    std.bridge.uart("bridge").baud(1_000_000).bind({ uart: "uart" }))   // how the host reaches the map
  .compile(c => c
    .emit("c-header", { to: "fw/siren_regs.h" })
    .emit("host-js", { to: "host/siren.js" })      // dev.knob("synth.hz"), typed, with bounds and docs
    .emit("register-doc", { to: "docs/registers.md" }))
  .scenario("bounds hold in hardware", sc => sc
    .write("synth.hz", 50_000).expectKnob("synth.hz", 8000)
    .write("synth.hz", 3).expectKnob("synth.hz", 20))
  .scenario("the panel turns the volume down on clipping", sc => sc
    .write("synth.volume", 15)
    .run("panel").wait("100ms")
    .expectKnob("synth.volume", v => v < 15));
