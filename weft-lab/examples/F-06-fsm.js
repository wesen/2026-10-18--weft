/** F-06 State machines
 *  group  Components
 *  about  A UART transmitter written as an fsm. Each state is a hardware lambda: it drives outputs, writes
 *         registers and returns the next state; returning nothing stays put. fsm.extract reads the returns to
 *         build the transition graph, and fsm.encode picks an encoding for the part.
 *  shows  fsm() · states as lambdas · .lib() from params and the clock · a hardware helper · $.has() / $.take()
 *  watch  DAG (fsm) · Board (serial)
 *  try    Add an even-parity state | Force .encode("onehot") and compare LUTs in the report
 */
const greeter = module("greeter")
  .provides("bytes")
  .lib({ MSG: [..."hello\r\n"].map(ch => ch.charCodeAt(0)) })   // an array of numbers becomes a 7-entry ROM
  .regs({ i: u(3), go: bit })
  .every("1s", $ => { $.go = 1; })
  .seq($ => {
    if ($.go && $.push("bytes", MSG[$.i])) {        // push() is 1 on the cycle the beat is taken
      if ($.i === MSG.length - 1) { $.i = 0; $.go = 0; }
      else $.i += 1;
    }
  });

function baud($) {                                  // a hardware helper: shipped by .lib(), inlined where called
  if ($.wait !== 0) { $.wait -= 1; return 0; }
  $.wait = DIV;
  return 1;
}

const tx = fsm("uart-tx")
  .params({ BAUD: 115_200 })
  .needs("bytes")
  .out("line", bit.init(1))                         // a UART line idles high
  .regs({ shift: u(8), n: u(3), wait: u(16) })
  .lib(({ BAUD }, { clock }) => ({ DIV: Math.round(clock.hz / BAUD) - 1 }))   // builder lambda: params and clock
  .lib({ baud })
  .initial("idle")
  .state("idle", $ => {
    $.line = 1;
    if ($.has("bytes")) { $.shift = $.take("bytes"); $.wait = DIV; return "start"; }
  })
  .state("start", $ => { $.line = 0; if (baud($)) return "data"; })
  .state("data", $ => {
    $.line = $.shift[0];
    if (!baud($)) return;
    $.shift >>= 1;
    $.n += 1;                                       // wraps back to 0 after the eighth bit
    if ($.n === 7) return "stop";
  })
  .state("stop", $ => { $.line = 1; if (baud($)) return "idle"; });

return design("hello-uart")
  .board("pico")                                    // 12 MHz, so DIV = 103
  .use(stream("bytes").of(u(8)).buffer(8, { overflow: "block" }), greeter, tx)
  .pins({ "uart-tx.line": "uart.tx" })
  .scenario("says hello every second", sc => sc
    .expectUart("uart", "hello\r\n", { within: "1.1s", baud: 115_200 })
    .expectUart("uart", "hello\r\n", { within: "1.1s", baud: 115_200 }));
