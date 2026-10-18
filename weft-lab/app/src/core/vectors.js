// Co-simulation vectors (guide §6.10, §8.3): run a scenario on the simulator and record every change of the
// design's top-level ports, so a Verilog testbench can replay the inputs and check the outputs of the emitted
// RTL (L1) and of its synthesized netlist (L2).
//
//   vectors(script, { file, board, cosimHz, scenario }) → {
//     schema, cosimHz, bundle,                 // the hardware bundle of the co-simulation variant
//     scenarios: [{ name, cycles, changes: [[cycle, port, hex]], sim: { status, message } } | { name, skip }],
//     skip?                                    // the whole design cannot be co-simulated, and why
//   }
//
// The variant is compiled with { "clock.<main>": cosimHz }, so every prescaler shrinks by the same factor and
// a whole scenario fits in a short co-simulation. Cycle k means the k-th rising edge of the main clock:
//   - an input change at cycle k is first seen by edge k (apply it before that edge);
//   - an output value at cycle k is what the design drives just before edge k (the simulator computes it
//     during edge k from the registers of cycle k-1 and the inputs of edge k).
// Pins are recorded through the simulator's board hooks (setInput, _pin), not its waves: waves record a
// change when it is noticed, which can be the time of an input change rather than the edge that sees it.
import { compile } from "./compile.js";
import { buildBundle, HwError } from "./hardware.js";
import { pinParts } from "./verilog.js";
import { runScenario } from "./scenario.js";

export const VECTORS_SCHEMA = "weft.vectors/v1";
export const DEFAULT_COSIM_HZ = 1e6;

// scenario steps that change the design or its internals rather than its pins: the RTL cannot follow them
const INTERNAL = new Set(["poke", "force", "release", "knob", "apply", "patch", "change", "reload", "restore", "irq"]);

export async function vectors(script, { file = "design.js", board = "gatemate-a1-evb", cosimHz = DEFAULT_COSIM_HZ, scenario = null } = {}) {
  const base = compile(script, { board, file });
  const main = base.main || "sys";
  const compiled = compile(script, { board, file, overrides: { [`clock.${main}`]: cosimHz } });
  const bundle = buildBundle(compiled);          // throws HwError: what cannot go to hardware cannot be co-simulated
  const out = { schema: VECTORS_SCHEMA, cosimHz, bundle, scenarios: [] };
  if (Object.keys(compiled.domains).length > 1) {
    out.skip = `${Object.keys(compiled.domains).length} clock domains: co-simulation counts cycles of one clock`;
    return out;
  }
  const list = (compiled.scenarios || []).filter((s) => !scenario || s.name === scenario);
  if (scenario && !list.length) throw new HwError("scenario", `no scenario named "${scenario}" (there are: ${(compiled.scenarios || []).map((s) => s.name).join(", ") || "none"})`);
  for (const sc of list) out.scenarios.push(await record(compiled, bundle, sc));
  return out;
}

async function record(compiled, bundle, sc) {
  const internal = (sc.steps || []).find((s) => INTERNAL.has(s.op));
  if (internal) return { name: sc.name, skip: `step ${internal.op}(${JSON.stringify(internal.args?.[0] ?? "")}) changes the design's internals, which the RTL's ports cannot reproduce` };
  const ports = new Map(bundle.ports.map((p, i) => [p.name, { i, dir: p.dir, value: 0n }]));
  const changes = [];
  const put = (cycle, res, level) => {
    const { base, idx } = pinParts(res);
    const p = ports.get(base);
    if (!p) return;
    const bit = 1n << BigInt(idx);
    const v = level ? p.value | bit : p.value & ~bit;
    if (v === p.value) return;
    p.value = v;
    const last = changes.at(-1);
    if (last && last[0] === cycle && last[1] === p.i) last[2] = v;
    else changes.push([cycle, p.i, v]);
  };
  let sim = null, taint = null;
  const r = await runScenario(compiled, sc.name, {
    onSim(s) {
      sim = s;
      const board = s.board, D = s.main;
      const setInput = board.setInput.bind(board);
      board.setInput = (res, level) => { setInput(res, level); put(D.cycle + 1, res, level ? 1 : 0); };
      const pin = board._pin.bind(board);
      board._pin = (PD, k, v) => {
        pin(PD, k, v);
        for (const { res, bit } of PD.pinWatch[k].res) put(PD.cycle + 1, res, bitOf(v, bit));
      };
      for (const m of ["poke", "release", "reload"]) {
        const f = s[m].bind(s);
        s[m] = (...a) => { taint ||= `${m}(${JSON.stringify(a[0])})`; return f(...a); };
      }
    },
  });
  if (!sim) return { name: sc.name, skip: r.message || "the scenario did not start a simulation" };
  if (taint) return { name: sc.name, skip: `the scenario called ${taint}, which changes the design's internals` };
  return {
    name: sc.name, cycles: sim.cycle(sim.main.name),
    changes: changes.map(([c, i, v]) => [c, i, v.toString(16)]),
    sim: { status: r.status, message: r.message },
  };
}

function bitOf(v, bit) {
  if (typeof v === "bigint") return Number((v >> BigInt(bit)) & 1n);
  return bit < 31 ? (v >> bit) & 1 : Math.floor(v / 2 ** bit) & 1;
}
