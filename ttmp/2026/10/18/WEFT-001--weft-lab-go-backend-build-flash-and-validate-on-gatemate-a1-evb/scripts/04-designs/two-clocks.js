/** T-01 Two clocks
 *  group  WEFT-001 hardware checks
 *  about  The board LED blinks from the 10 MHz system clock; PMOD led:1 blinks from a 25.175 MHz PLL
 *         domain. Builds the wrapper's CC_PLL path and the PLL frequency check.
 */
const slow = module("slow")
  .out("led", bit)
  .every("250ms", $ => { $.led = !$.led; })
  .bind({ led: "led:0" });

const fast = module("fast")
  .domain("pix")
  .out("led", bit)
  .every("100ms", $ => { $.led = !$.led; })
  .bind({ led: "led:1" });

return design("twoclocks")
  .board("gatemate-a1-evb")
  .clocks(c => c.pin("sys", "clk").pll("pix", { from: "sys", hz: "25.175 MHz" }))
  .use(slow, fast);
