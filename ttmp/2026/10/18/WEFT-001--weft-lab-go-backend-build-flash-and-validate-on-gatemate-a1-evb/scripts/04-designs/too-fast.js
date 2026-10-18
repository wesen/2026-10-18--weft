/** T-02 Too fast
 *  group  WEFT-001 hardware checks
 *  about  Like T-01, but the PLL domain runs at 400 MHz, where a 26-bit prescaler cannot meet timing:
 *         exercises timing-failed builds (a bitstream exists; loading needs --force).
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

return design("toofast")
  .board("gatemate-a1-evb")
  .clocks(c => c.pin("sys", "clk").pll("pix", { from: "sys", hz: "400 MHz" }))
  .use(slow, fast);
