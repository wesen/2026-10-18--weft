/** F-01 Blinky
 *  group  Basics
 *  about  One module on the pico board. A timer flips the LED every 250 ms. A signal written in a timed or clocked
 *         block is a register; the compiler sizes the prescaler from the board's 12 MHz clock.
 *  shows  design · module · .out() · .every() · .bind() · a scenario on the simulated board
 *  watch  Board · Waves
 *  try    Blink at 5 Hz | Drive all three LEDs as a counter
 */
const blink = module("blink")
  .out("led", bit)
  .every("250ms", $ => { $.led = !$.led; })         // 12 MHz × 250 ms: a 22-bit prescaler, generated for you
  .bind({ led: "led:0" });

return design("blinky")
  .board("pico")
  .use(blink)
  .scenario("blinks at 2 Hz", sc => sc
    .wait("1.1s")
    .expectToggles("led:0", n => n === 4));
