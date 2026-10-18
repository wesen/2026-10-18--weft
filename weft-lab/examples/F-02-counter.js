/** F-02 Counter
 *  group  Basics
 *  about  A ticker and an up/down counter, wired by name and shown on eight LEDs. Arithmetic grows: an 8-bit value
 *         plus one is nine bits, and putting it back into eight bits takes a word, wrap() or sat(). Compound
 *         assignments (+=, -=) wrap by definition.
 *  shows  ports · .seq() and .comb() · pulse · .wire() and .pins() · width rules · board- and signal-level scenarios
 *  watch  Board · Waves
 *  try    Replace wrap() with sat() and stop at 255 | Write $.value = $.value + 1 and read the error
 */
const ticker = module("ticker")
  .out("tick", pulse)                               // a pulse is a bit that falls back to 0 on its own
  .every("100ms", $ => { $.tick = 1; });

const counter = module("counter")
  .in({ en: bit, down: bit })
  .out({ value: u(8), zero: bit })
  .seq($ => {                                       // written here, value is a register: reset to 0, synchronous
    if ($.en) $.value = wrap($.down ? $.value - 1 : $.value + 1);
  })
  .comb($ => { $.zero = $.value === 0; });         // written here, zero is a wire

return design("counter")
  .board("dev")
  .use(ticker, counter)
  .wire("ticker.tick", "counter.en")
  .pins({ "counter.down": "sw:0", "counter.value": "led:0..7" })
  .scenario("counts up, then down", sc => sc
    .wait("350ms").expectPins("led:0..7", 3)
    .toggle("sw:0").wait("300ms").expectPins("led:0..7", 0))
  .scenario("wraps below zero", sc => sc
    .poke("counter.down", 1).poke("counter.en", 1).step()
    .expectSignal("counter.value", 255)
    .expectSignal("counter.zero", 0));
