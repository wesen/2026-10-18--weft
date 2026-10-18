/** F-05 Buttons and events
 *  group  Components
 *  about  std.debounce cleans four raw buttons and provides a stream of presses. The lights module needs that
 *         stream; the link pass connects producer to consumer by name, with no wiring written. Handlers fire on
 *         stream beats and on edges of input ports.
 *  shows  std components · .provides() / .needs() · .on(stream) · .on("port.rise") · exclusive pin binding
 *  watch  Board · DAG (links)
 *  try    Bind a second module to led:0..7 and read the error | Clear on a double press instead of a long one
 */
const buttons = std.debounce("buttons")
  .bind({ raw: "btn:0..3" })
  .settle("10ms")                                   // an edge must hold for 10 ms to count
  .longPress("500ms")                               // presses carry { id: u(2), long: bit }
  .provides("presses");

const lights = module("lights")
  .needs("presses")
  .in("invert", bit)
  .out("leds", u(8))
  .on("presses", ($, p) => {                        // runs on the cycle a beat arrives; ready is handled for you
    $.leds = p.long ? 0 : $.leds ^ (1 << p.id);
  })
  .on("invert.rise", $ => { $.leds = ~$.leds; })    // an edge of an input port is an event too
  .bind({ invert: "sw:0", leds: "led:0..7" });      // led:0..7 now belongs to lights; a second binder is an error

return design("lights")
  .board("dev")
  .use(buttons, lights)                             // no .wire(): "presses" links by name
  .scenario("toggle, invert, clear", sc => sc
    .press("btn:2").wait("20ms").expectPins("led:0..7", 0b0000_0100)
    .press("btn:0", { bounce: "3ms" }).wait("20ms").expectPins("led:0..7", 0b0000_0101)   // chatter counts once
    .toggle("sw:0").wait("1ms").expectPins("led:0..7", 0b1111_1010)
    .press("btn:1", { for: "600ms" }).wait("20ms").expectPins("led:0..7", 0));
