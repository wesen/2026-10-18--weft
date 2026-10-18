/** F-04 Parameters and generators
 *  group  Basics
 *  about  Builders are values: every call returns a new one, so a module can be shared, specialized with .with()
 *         and stamped out in a plain JS loop. Any builder argument may be a lambda of the parameters; it runs once
 *         per specialization. Parameters reach hardware lambdas as constants, so loops over them unroll.
 *  shows  .params() · .with() · .as() · builder lambdas of params · unrolled loops · "generate" is just JS
 *  watch  DAG (instances)
 *  try    Make channel 7 a 12-bit PWM | Put the eight phases 45° apart
 */
const pwm = module("pwm")
  .params({ BITS: 8 })
  .in("duty", ({ BITS }) => u(BITS))                // a builder lambda of params: runs per specialization
  .out("out", bit)
  .regs(({ BITS }) => ({ phase: u(BITS) }))
  .seq($ => {
    $.phase += 1;
    $.out = $.phase < $.duty;
  });

const breathe = module("breathe")
  .params({ N: 4 })
  .out("duty", ({ N }) => vec(u(8), N))
  .regs({ level: u(8), up: bit.init(1) })
  .every("4ms", $ => {
    const up = $.level === 0 ? 1 : $.level === 255 ? 0 : $.up;   // locals are wires
    $.up = up;
    if (up) $.level += 1;
    else $.level -= 1;
  })
  .comb($ => {
    for (let i = 0; i < N; i++) $.duty[i] = wrap($.level + i * 32);   // N is a constant here, so the loop unrolls
  });

const bank = Array.from({ length: 8 }, (_, i) => pwm.as(`pwm-${i}`));   // eight instances of one value

return design("breathing")
  .board("dev")
  .use(breathe.with({ N: bank.length }), ...bank)
  .wire(bank.map((p, i) => [`breathe.duty[${i}]`, `${p.name}.duty`]))
  .pins(Object.fromEntries(bank.map((p, i) => [`${p.name}.out`, `led:${i}`])))
  .scenario("eight different phases", sc => sc
    .wait("300ms")
    .expectSignal("breathe.duty", d => new Set(d).size === 8));
