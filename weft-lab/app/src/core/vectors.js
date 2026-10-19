// Co-simulation vectors (guide §6.10, §8.3): run a scenario on the simulator and record every change of the
// design's top-level ports, so a Verilog testbench can replay the inputs and check the outputs of the emitted
// RTL (L1) and of its synthesized netlist (L2).
//
//   vectors(script, { file, board, cosimHz, scenario }) → {
//     schema, cosimHz, bundle,                 // the hardware bundle of the co-simulation variant
//     dut?,                                    // designs with native cells: the domain module under test
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
//
// A design with native cells is cut at the cell boundary (guide §6.10): the cells' JavaScript models work at
// the transaction level, so their cores are checked by their own testbenches (hdl/cells/tb) instead. The
// device under test is then the domain module, and `dut.ports` replaces the bundle's ports: pin inputs, the
// values cells drive into the graph (inputs), the graph's outputs, and the values cells read (outputs x_<id>).
// A cell ticks inside edge k after the graph is evaluated, so what it reads belongs to cycle k and what it
// drives is first seen by edge k + 1.
import { compile } from "./compile.js";
import { buildBundle, HwError } from "./hardware.js";
import { pinParts, emitVerilog } from "./verilog.js";
import { runScenario } from "./scenario.js";
import { expandResources } from "./boards.js";

export const VECTORS_SCHEMA = "weft.vectors/v1";
export const DEFAULT_COSIM_HZ = 1e6;

// scenario steps that change the design or its internals rather than its pins: the RTL cannot follow them
const INTERNAL = new Set(["poke", "force", "release", "knob", "apply", "patch", "change", "reload", "restore", "irq"]);
// release() of board resources lets go of a button; of a signal path, it ends a poke
const isInternal = (compiled, s) => INTERNAL.has(s.op) &&
  !(s.op === "release" && expandResources(s.args?.[0] ?? "", compiled.board).every((r) => r in (compiled.board?.resources || {})));

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
  let cut = null;
  if ((compiled.cells || []).length) {
    const dm = emitVerilog(compiled).find((f) => f.domain === compiled.main);
    if (!dm) throw new HwError("emit", `no module for the main domain ${compiled.main}`);
    const watched = new Set((compiled.pins || []).filter((p) => p.node != null).map((p) => p.node));
    cut = dm.ports.map((p) => ({ name: p.name, dir: p.dir === "input" ? "in" : "out", width: p.w, node: p.id, check: p.dir === "input" ? false : p.export || watched.has(p.id) }));
    out.dut = { module: dm.module, file: dm.path, ports: cut.map(({ name, dir, width, check }) => ({ name, dir, width, ...(dir === "out" ? { check } : {}) })) };
  }
  for (const sc of list) out.scenarios.push(await (cut ? recordCut(compiled, cut, sc) : record(compiled, bundle, sc)));
  return out;
}

async function record(compiled, bundle, sc) {
  const internal = (sc.steps || []).find((s) => isInternal(compiled, s));
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

// the same recording for a design cut at its cells: every change of a domain-module port, as node values
async function recordCut(compiled, cut, sc) {
  const internal = (sc.steps || []).find((s) => isInternal(compiled, s));
  if (internal) return { name: sc.name, skip: `step ${internal.op}(${JSON.stringify(internal.args?.[0] ?? "")}) changes the design's internals, which the RTL's ports cannot reproduce` };
  const ports = cut.map((p, i) => ({ ...p, i, value: 0n }));
  const byNode = new Map(ports.map((p) => [p.node, p]));
  const inputs = ports.filter((p) => p.dir === "in");
  const reads = new Set((compiled.cells || []).flatMap((c) => Object.values(c.io || {}).filter((e) => e.dir === "read").map((e) => e.node)));
  const changes = [];
  const put = (cycle, p, v) => {
    const x = BigInt.asUintN(p.width, typeof v === "bigint" ? v : BigInt(Math.trunc(Number(v) || 0)));
    if (x === p.value) return;
    p.value = x;
    const last = changes.at(-1);
    if (last && last[0] === cycle && last[1] === p.i) last[2] = x;
    else changes.push([cycle, p.i, x]);
  };
  const val = (D, id) => (D.big[id] ? D.B[id] : D.F[id]);
  let sim = null, taint = null;
  const r = await runScenario(compiled, sc.name, {
    onSim(s) {
      sim = s;
      const board = s.board, D = s.main;
      const snap = (cycle) => { for (const p of inputs) put(cycle, p, val(D, p.node)); };
      snap(1);                                   // initial drives (a uart-tx cell is ready from the start)
      const setInput = board.setInput.bind(board);
      board.setInput = (res, level) => { setInput(res, level); snap(D.cycle + 1); };
      const pin = board._pin.bind(board);
      board._pin = (PD, k, v) => { pin(PD, k, v); const p = PD === D && byNode.get(PD.pinWatch[k].node); if (p && p.dir === "out") put(PD.cycle + 1, p, v); };
      const tick = s._tick.bind(s);
      s._tick = (TD) => {
        if (TD === D) for (const id of reads) { const p = byNode.get(id); if (p && p.dir === "out") put(D.cycle + 1, p, val(D, id)); }
        tick(TD);
        if (TD === D) snap(D.cycle + 2);
      };
      for (const m of ["poke", "release", "reload"]) {
        const f = s[m].bind(s);
        s[m] = (...a) => { taint ||= `${m}(${JSON.stringify(a[0])})`; return f(...a); };
      }
    },
  });
  if (!sim) return { name: sc.name, skip: r.message || "the scenario did not start a simulation" };
  if (taint) return { name: sc.name, skip: `the scenario called ${taint}, which changes the design's internals` };
  const cycles = sim.cycle(sim.main.name);
  return {
    name: sc.name, cycles,
    changes: changes.filter(([c]) => c <= cycles).map(([c, i, v]) => [c, i, v.toString(16)]),
    sim: { status: r.status, message: r.message },
  };
}

function bitOf(v, bit) {
  if (typeof v === "bigint") return Number((v >> BigInt(bit)) & 1n);
  return bit < 31 ? (v >> bit) & 1 : Math.floor(v / 2 ** bit) & 1;
}
