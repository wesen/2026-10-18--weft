// Hardware bundles: the contract between the compiler (JavaScript) and the board flow (Go, `weft build`).
// A bundle is plain JSON (schema "weft.hw-bundle/v1"): the emitted Verilog plus every fact Go needs to
// wrap it for a board — clocks, reset, which top-level port bit carries which board resource, native
// cells, knobs, the estimate and which scenarios can run on hardware. Go never runs JavaScript and never
// parses Verilog; it reads this. DOM-free: the page and tools/weft-hw.mjs both call buildBundle.
import { emitVerilog, pinParts, sanitize } from "./verilog.js";

export const HW_BUNDLE_SCHEMA = "weft.hw-bundle/v1";

// Native cells with a hand-written core in hdl/cells (kind → core module). The adapters that connect a
// cell's stream-derived ports to its core come with the cores (P7); until then designs with cells are refused.
export const CELL_CORES = {};

// Scenario steps the board runner (hwscenario.js) can perform through the HIL bridge or the design's UART.
export const PORTABLE_STEPS = new Set(["wait", "press", "release", "toggle", "set", "uart", "expectToggles", "expectPins", "expectUart"]);

export class HwError extends Error {
  constructor(code, message, details = []) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// compiled design → bundle. Throws HwError with a named reason when the design cannot go to hardware.
export function buildBundle(compiled, { source = null } = {}) {
  if (!compiled) throw new HwError("compile", "the design did not compile");
  const board = compiled.board;
  if (!board?.profile) throw new HwError("board", "compile the design for a board first (compile(script, { board: \"gatemate-a1-evb\" }))");
  const d = compiled.design?._ || {};
  if (compiled.design && !d.board && !d.targets) {
    // retargeting keeps only what a board binds: a bare-part design would lose every port. Checked before
    // compile errors, because errors after retargeting (checks against the new part) follow from this one.
    throw new HwError("bare-part", `the design names no board (it targets ${d.part ? `the bare part ${d.part}` : "simulation only"}), so retargeting it to ${board.profile} drops every port. Add .board("${board.profile}") and bind resources first.`);
  }
  const errors = (compiled.diags || []).filter((x) => x.level === "error");
  if (errors.length) {
    throw new HwError("compile", `the design has ${errors.length} compile error${errors.length === 1 ? "" : "s"}: ${errors[0].message}`, errors.map((x) => ({ line: x.line, message: x.message })));
  }
  if (!compiled.ok) throw new HwError("compile", "the design did not compile");
  const pins = compiled.pins || [];
  if (!pins.length) throw new HwError("no-pins", `the design binds no ${board.profile} resources: nothing on the board could observe or drive it`);
  const unsupported = (compiled.cells || []).filter((c) => !CELL_CORES[c.kind]);
  if (unsupported.length) {
    throw new HwError("cells", `native cells without a hardware core yet: ${unsupported.map((c) => `${c.path} (${c.kind})`).join(", ")}`, unsupported.map((c) => ({ path: c.path, kind: c.kind })));
  }

  const files = emitVerilog(compiled);
  const failed = files.find((f) => f.path === "ERROR.txt");
  if (failed) throw new HwError("emit", failed.text.trim());
  const topFile = files.find((f) => f.top);
  const top = topFile.path.replace(/\.v$/, "");

  return {
    schema: HW_BUNDLE_SCHEMA,
    design: compiled.name,
    board: board.profile,
    part: board.part,
    source: source || (compiled.file ? { file: compiled.file } : null),
    header: compiled.header ? { id: compiled.header.id, title: compiled.header.title } : null,
    top,
    files: files.map((f) => (f.top ? { path: f.path, text: f.text, top: true } : { path: f.path, text: f.text })),
    clocks: clocksOf(compiled),
    reset: { port: "rst", activeHigh: true, synchronous: true },
    ports: portsOf(pins, board),
    cells: (compiled.cells || []).map((c) => ({ path: c.path, kind: c.kind, domain: c.domain, module: CELL_CORES[c.kind], params: c.params || {} })),
    knobs: (compiled.knobs || []).map((k) => ({ path: k.path, kind: k.kind, type: k.typeName, width: k.type?.w ?? null, reset: k.reset ?? 0, min: k.min ?? null, max: k.max ?? null, addr: k.addr ?? null, domain: k.domain })),
    estimate: estimateOf(compiled.report),
    scenarios: (compiled.scenarios || []).map(scenarioSummary),
  };
}

function clocksOf(compiled) {
  const clocks = compiled.clocks || {};
  return Object.keys(compiled.domains || {}).map((domain) => {
    const c = clocks[domain] || {};
    const out = { domain, port: `clk_${sanitize(domain)}`, hz: compiled.domains[domain].hz, kind: c.kind || "board", main: domain === compiled.main };
    if (c.kind === "pll") Object.assign(out, { wantHz: c.want, from: c.from, pll: c.pll });
    if (c.pin) out.pin = c.pin;
    return out;
  });
}

// one entry per top-level port, exactly as emitTop declares it: name = pinParts base, bit = pinParts index,
// width = highest index + 1. Cell-owned pins (node: null) are included.
function portsOf(pins, board) {
  const ports = new Map();
  for (const p of pins) {
    const { base, idx, indexed } = pinParts(p.resource);
    let port = ports.get(base);
    if (!port) ports.set(base, (port = { name: base, dir: p.dir === "in" ? "in" : "out", width: 0, indexed, bits: [] }));
    if (port.bits.some((b) => b.resource === p.resource)) continue;
    port.width = Math.max(port.width, idx + 1);
    const res = board.resources?.[p.resource];
    port.bits.push({ bit: idx, resource: p.resource, kind: res?.kind ?? null, domain: p.domain ?? null, ...(p.cell ? { cell: p.instance } : {}) });
  }
  for (const port of ports.values()) port.bits.sort((a, b) => a.bit - b.bit);
  return [...ports.values()];
}

function estimateOf(report) {
  if (!report) return null;
  const fmax = {};
  for (const [d, t] of Object.entries(report.timing || {})) if (t && typeof t === "object" && "fmax" in t) fmax[d] = t.fmax;
  return { part: report.part?.name ?? report.part ?? null, family: report.family, resources: report.resources || null, fmaxMHz: fmax };
}

function scenarioSummary(s) {
  const ops = (s.steps || []).map((x) => x.op);
  const other = ops.find((op) => !PORTABLE_STEPS.has(op));
  const portable = s.kind === "steps" && ops.length > 0 && !other;
  const out = { name: s.name, kind: s.kind, portable, steps: ops };
  if (!portable) out.skip = s.kind !== "steps" ? `a ${s.kind} scenario runs in the simulator only` : other ? `step ${other}() has no board equivalent` : "no steps";
  return out;
}
