/** WEFT-001 P8 check: btn:user through the HIL override
 *  about  led:0 follows the board's one button. On the board the scenario takes the button over through the
 *         HIL bridge's mux (the physical button is ignored meanwhile), then hands it back.
 */
const follow = module("follow")
  .in("btn", bit)
  .out("led", bit)
  .seq($ => { $.led = $.btn; })
  .bind({ btn: "btn:user", led: "led:0" });

return design("follow")
  .board("gatemate-a1-evb")
  .use(follow)
  .scenario("btn:user lights led:0", sc => sc
    .expectPins("led:0", 0)
    .press("btn:user", { hold: true }).wait("1ms").expectPins("led:0", 1)
    .release("btn:user").wait("1ms").expectPins("led:0", 0)
    .press("btn:user", { for: "100ms" }).wait("1ms").expectPins("led:0", 0)
    .expectToggles("led:0", 4));
