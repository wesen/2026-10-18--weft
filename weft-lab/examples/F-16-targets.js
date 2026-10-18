/** F-16 Many parts, many backends
 *  group  Compiler
 *  about  The DAG knows nothing about the part until techmap, so boards with the same clock share every pass before
 *         it: dev and big (100 MHz) share one DAG, and pico (12 MHz) gets its own, because the UART dividers are
 *         computed from the clock. It emits Verilog and VHDL per part, a cycle-accurate WebAssembly model per DAG,
 *         and a cell census from a backend of your own. One scenario runs behaviorally and gate-level on every part.
 *  shows  .boards() · board().part() · c.when() per target · emit() · backend() · scenarios across IR levels
 *  watch  Report (per target) · Passes
 *  try    Emit FIRRTL as well | Give the pico build a 32 KB line buffer in SPRAM
 */
const upcase = module("upcase")
  .needs("rx.bytes").provides("tx.bytes")
  .on("rx.bytes", ($, c) => {
    $.push("tx.bytes", c >= 97 && c <= 122 ? c ^ 0x20 : c);   // flip bit 5: a → A
  });

const census = backend("cell-census")
  .on("net")                                        // after techmap, once per target
  .emit((net, out) => {
    const counts = {};
    for (const cell of net.cells()) counts[cell.type] = (counts[cell.type] ?? 0) + 1;
    out.file("cells.json", JSON.stringify(counts, null, 2));
  });

return design("shout")
  .boards({
    pico: board("pico"),                            // ice40up5k
    dev: board("dev"),                              // xc7a35t
    big: board("dev").part("xc7a100t-1csg324"),     // a board profile is a copy you can change
  })
  .use(
    std.uart.rx("rx").baud(115_200).bind({ rx: "uart.rx" }).provides("rx.bytes"),
    upcase,
    std.uart.tx("tx").baud(115_200).bind({ tx: "uart.tx" }).needs("tx.bytes"))
  .compile(c => c
    .when(t => t.family === "xc7", w => w.after("map", s => s.pass(std.passes.srl.infer)))   // LUTs as shift registers
    .emit("verilog", { to: t => `build/${t.name}/rtl` })   // a builder lambda, once per target
    .emit("vhdl", { to: t => `build/${t.name}/vhdl` })
    .emit("sim:wasm", { to: t => `build/${t.name}/shout.wasm`, level: "dag" })   // one model per distinct DAG
    .emit(census, { to: t => `build/${t.name}` })
    .check("small everywhere", (r, t) => r.resources.luts < 0.2 * t.part.luts))
  .scenario("shouts back", sc => sc
    .uart("uart", "hello, fabric\n")
    .expectUart("uart", "HELLO, FABRIC\n", { within: "3ms" }),
    { levels: ["dag", "net"], targets: "all" });    // two DAG runs (pico; dev and big), three net runs
