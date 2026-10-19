// Verilog-2005 from the DAG (owner B): one module per clock domain, a top module that wires domains, pins and
// native cells together (adapters to the hand-written cores in hdl/cells, or black boxes). Deterministic: names come from paths and node ids, order from ids.
//
// Conventions (matching types.js evalOp): every wire is declared unsigned; signedness is applied explicitly —
// operands are extended to the result width by their own signedness before the operator, comparisons of mixed
// signedness go through $signed() at a common width, `shr` of a signed value is `>>>`. Because D1 sizes every
// result so nothing overflows, these widths reproduce the simulator's values bit for bit. Layout (as lower.js
// and sim.js): concat and struct pack list operands most significant first (the first struct field is the top
// bits); a vec packs element 0 into the low bits; index and ROM reads out of range give 0.
import { typeName } from "./types.js";
import { groupIO } from "./cells.js";

const KEYWORDS = new Set("always and assign automatic begin buf case casex casez cell config deassign default defparam design disable edge else end endcase endconfig endfunction endgenerate endmodule endprimitive endspecify endtable endtask event for force forever fork function generate genvar highz0 highz1 if ifnone incdir include initial inout input instance integer join large liblist library localparam macromodule medium module nand negedge nmos nor noshowcancelled not notif0 notif1 or output parameter pmos posedge primitive pull0 pull1 pulldown pullup pulsestyle_onevent pulsestyle_ondetect rcmos real realtime reg release repeat rnmos rpmos rtran rtranif0 rtranif1 scalared showcancelled signed small specify specparam strong0 strong1 supply0 supply1 table task time tran tranif0 tranif1 tri tri0 tri1 triand trior trireg unsigned use uwire vectored wait wand weak0 weak1 while wire wor xnor xor clk rst".split(" "));
export function sanitize(s) {
  let x = String(s ?? "").replace(/\[(\d+)\]/g, "_$1").replace(/[^A-Za-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  if (!x) x = "n";
  if (/^[0-9]/.test(x)) x = "n_" + x;
  if (KEYWORDS.has(x)) x = x + "_";
  return x;
}
const big = (v) => (typeof v === "bigint" ? v : typeof v === "boolean" ? BigInt(+v) : BigInt(Math.trunc(Number(v ?? 0))));
// the bit pattern (unsigned BigInt) of a value of type T; struct values are objects, vec values arrays
export function encodeValue(v, T) {
  if (v != null && typeof v === "object" && T?.k === "struct") {
    let acc = 0n;
    for (const [name, F] of T.fields) acc = (acc << BigInt(F.w)) | encodeValue(v[name] ?? 0, F);
    return acc;
  }
  if (v != null && typeof v === "object" && T?.k === "vec") {
    let acc = 0n;
    for (let i = T.n - 1; i >= 0; i--) acc = (acc << BigInt(T.elem.w)) | encodeValue(v[i] ?? 0, T.elem);
    return acc;
  }
  return BigInt.asUintN(T?.w ?? 64, big(v));
}
// a W-bit literal holding the two's complement pattern of v
export function lit(v, W) {
  const p = BigInt.asUintN(W, big(v));
  return `${W}'h${p.toString(16).toUpperCase()}`;
}
const rng = (w) => `[${Math.max(1, w) - 1}:0]`;

class Names {
  constructor() { this.used = new Set(); }
  take(base) {
    let n = sanitize(base), k = 1;
    while (this.used.has(n)) n = `${sanitize(base)}_${k++}`;
    this.used.add(n);
    return n;
  }
}

// ---------- one domain ----------
function emitDomain(modName, g, opts) {
  const names = new Names();
  names.used.add("clk"); names.used.add("rst");
  const nm = new Map();
  const nodes = g.live().slice().sort((a, b) => a.id - b.id);
  for (const n of nodes) {
    let base;
    if (n.op === "in") base = n.attrs.path || `in_${n.id}`;
    else if (n.op === "out") base = n.attrs.path ? `o_${n.attrs.path}` : `out_${n.id}`;
    else if (n.op === "reg" || n.op === "mem" || n.op === "probe") base = n.attrs.path || `${n.op}_${n.id}`;
    else base = `n${n.id}`;
    nm.set(n.id, names.take(base));
  }
  const N = (id) => nm.get(id);
  const T = (id) => g.node(id).type;
  const ext = (id, W) => {
    const t = T(id), w = t.w, x = N(id);
    if (w === W) return x;
    if (w > W) return `${x}[${W - 1}:0]`;
    return t.signed ? `{{${W - w}{${x}[${w - 1}]}}, ${x}}` : `{{${W - w}{1'b0}}, ${x}}`;
  };
  const cmpWidth = (a, b) => {
    const A = T(a), B = T(b);
    const signed = A.signed || B.signed;
    const wa = signed && !A.signed ? A.w + 1 : A.w, wb = signed && !B.signed ? B.w + 1 : B.w;
    return { W: Math.max(wa, wb), signed };
  };
  const ports = [], decls = [], assigns = [], seq = [], inits = [];
  const exportIds = new Set(opts.exports || []);
  for (const n of nodes) {
    const W = n.type.w, x = N(n.id), a = n.args;
    const comment = n.origin?.[0]?.src ? `  // ${String(n.origin[0].src).replace(/\s+/g, " ").slice(0, 70)}${n.origin[0].line ? ` (line ${n.origin[0].line})` : ""}` : "";
    const wire = (expr) => { decls.push(`  wire ${rng(W)} ${x};`); assigns.push(`  assign ${x} = ${expr};${comment}`); };
    // every declaration comes before every assign, so a wire may be read above the line that drives it
    const tmp = (name, w, expr) => { decls.push(`  wire ${rng(w)} ${name};`); assigns.push(`  assign ${name} = ${expr};`); };
    switch (n.op) {
      case "in": ports.push({ dir: "input", w: W, name: x, id: n.id, src: n.attrs.src || "free", path: n.attrs.path }); break;
      case "out": ports.push({ dir: "output", w: W, name: x, id: n.id, path: n.attrs.path }); assigns.push(`  assign ${x} = ${ext(a[0], W)};`); break;
      case "const": decls.push(`  wire ${rng(W)} ${x} = ${lit(n.attrs.value, W)};`); break;
      case "add": wire(`${ext(a[0], W)} + ${ext(a[1], W)}`); break;
      case "sub": wire(`${ext(a[0], W)} - ${ext(a[1], W)}`); break;
      case "mul": wire(`${ext(a[0], W)} * ${ext(a[1], W)}`); break;
      case "neg": wire(`-${ext(a[0], W)}`); break;
      case "and": wire(`${ext(a[0], W)} & ${ext(a[1], W)}`); break;
      case "or": wire(`${ext(a[0], W)} | ${ext(a[1], W)}`); break;
      case "xor": wire(`${ext(a[0], W)} ^ ${ext(a[1], W)}`); break;
      case "not": wire(`~${ext(a[0], W)}`); break;
      case "shl": {
        const k = g.node(a[1]);
        wire(k.op === "const" ? `${ext(a[0], W)} << ${Number(k.attrs.value)}` : `${ext(a[0], W)} << ${N(a[1])}`);
        break;
      }
      case "shr": {
        const k = g.node(a[1]);
        const amt = k.op === "const" ? String(Number(k.attrs.value)) : N(a[1]);
        const A = T(a[0]);
        const e = A.signed ? `$unsigned($signed(${N(a[0])}) >>> ${amt})` : `${N(a[0])} >> ${amt}`;
        if (A.w === W) wire(e);
        else { tmp(`${x}_r`, A.w, e); wire(`${x}_r[${W - 1}:0]`); }
        break;
      }
      case "eq": case "ne": case "lt": case "le": case "gt": case "ge": {
        const { W: cw, signed } = cmpWidth(a[0], a[1]);
        const op = { eq: "==", ne: "!=", lt: "<", le: "<=", gt: ">", ge: ">=" }[n.op];
        const l = ext(a[0], cw), r = ext(a[1], cw);
        wire(signed && op !== "==" && op !== "!=" ? `$signed(${l}) ${op} $signed(${r})` : `${l} ${op} ${r}`);
        break;
      }
      case "land": wire(`(|${N(a[0])}) && (|${N(a[1])})`); break;
      case "lor": wire(`(|${N(a[0])}) || (|${N(a[1])})`); break;
      case "lnot": wire(`!(|${N(a[0])})`); break;
      case "mux": wire(`(|${N(a[0])}) ? ${ext(a[1], W)} : ${ext(a[2], W)}`); break;
      case "wrap": case "zext": case "sext": wire(ext(a[0], W)); break;
      case "sat": {
        const A = T(a[0]), cw = Math.max(A.signed ? A.w : A.w + 1, n.type.signed ? W : W + 1) + 1;
        const hi = n.type.signed ? (1n << BigInt(W - 1)) - 1n : (1n << BigInt(W)) - 1n;
        const lo = n.type.signed ? -(1n << BigInt(W - 1)) : 0n;
        tmp(`${x}_s`, cw, ext(a[0], cw));
        wire(`($signed(${x}_s) > $signed(${lit(hi, cw)})) ? ${lit(hi, W)} : (($signed(${x}_s) < $signed(${lit(lo, cw)})) ? ${lit(lo, W)} : ${x}_s[${W - 1}:0])`);
        break;
      }
      case "slice": {
        const lo = n.attrs.lo ?? 0, A = T(a[0]);
        if (lo + W <= A.w) wire(`${N(a[0])}[${lo + W - 1}:${lo}]`);
        else { tmp(`${x}_e`, lo + W, ext(a[0], lo + W)); wire(`${x}_e[${lo + W - 1}:${lo}]`); }
        break;
      }
      case "concat": wire(`{${a.map((id) => N(id)).join(", ")}}`); break;
      case "pack": {
        if (n.type.k === "vec") { const ew = n.type.elem.w; wire(`{${a.slice().reverse().map((id) => ext(id, ew)).join(", ")}}`); }
        else if (n.type.k === "struct") wire(`{${a.map((id, i) => ext(id, n.type.fields[i]?.[1].w ?? T(id).w)).join(", ")}}`);
        else wire(`{${a.map((id) => N(id)).join(", ")}}`);
        break;
      }
      case "field": {
        const A = T(a[0]);
        let lo = n.attrs.lo;
        if (lo == null && A.fields) { lo = A.w; for (const [fname, F] of A.fields) { lo -= F.w; if (fname === n.attrs.name) break; } }
        lo = lo || 0;
        wire(`${N(a[0])}[${lo + W - 1}:${lo}]`);
        break;
      }
      case "index": {
        const k = g.node(a[1]);
        const V = T(a[0]), cnt = V.n ?? Math.floor(V.w / W);
        if (k.op === "const") { const i = Number(k.attrs.value), lo = i * W; wire(i < cnt ? `${N(a[0])}[${lo + W - 1}:${lo}]` : lit(0, W)); }
        else {
          const ow = Math.max(1, Math.ceil(Math.log2(Math.max(2, cnt * W))));
          tmp(`${x}_o`, ow, `${ext(a[1], ow)} * ${lit(W, ow)}`);
          wire(2 ** T(a[1]).w > cnt ? `(${N(a[1])} < ${cnt}) ? ${N(a[0])}[${x}_o +: ${W}] : ${lit(0, W)}` : `${N(a[0])}[${x}_o +: ${W}]`);
        }
        break;
      }
      case "rom": {
        const table = n.attrs.table || [];
        // pad to every index the address can take (reads past the table give 0) unless that is much larger
        const span = 2 ** T(a[0]).w, pad = span > table.length && span <= Math.max(4096, 2 * table.length);
        const depth = pad ? span : Math.max(1, table.length);
        decls.push(`  reg ${rng(W)} ${x}_t [0:${depth - 1}];`);
        const body = table.map((v, i) => `    ${x}_t[${i}] = ${lit(encodeValue(v, n.type), W)};`);
        if (pad) body.push(`    for (${x}_i = ${table.length}; ${x}_i < ${depth}; ${x}_i = ${x}_i + 1) ${x}_t[${x}_i] = ${lit(0, W)};`);
        if (pad) decls.push(`  integer ${x}_i;`);
        inits.push(`  initial begin  // ${table.length}-entry table${pad ? `, padded to ${depth}` : ""}\n${body.join("\n")}\n  end`);
        wire(!pad && span > table.length ? `(${N(a[0])} < ${table.length}) ? ${x}_t[${N(a[0])}] : ${lit(0, W)}` : `${x}_t[${N(a[0])}]`);
        break;
      }
      case "mem": {
        const words = n.attrs.words || 1, ew = n.attrs.elem?.w ?? W;
        decls.push(`  reg ${rng(ew)} ${x} [0:${words - 1}];${n.attrs.path ? `  // ${n.attrs.path}: ${words} × ${ew}` : ""}`);
        if (Array.isArray(n.attrs.init) && n.attrs.init.length) {
          inits.push(`  initial begin\n${n.attrs.init.map((v, i) => `    ${x}[${i}] = ${lit(encodeValue(v, n.attrs.elem || n.type), ew)};`).join("\n")}\n  end`);
        }
        break;
      }
      case "memrd": {
        const m = g.node(a[0]);
        decls.push(`  reg ${rng(W)} ${x} = ${lit(0, W)};  // registered read of ${m?.attrs?.path || N(a[0])}`);
        const en = a[2] != null ? `|${N(a[2])}` : "1'b1";
        seq.push(`    if (${en}) ${x} <= ${N(a[0])}[${N(a[1])}];`);
        break;
      }
      case "memwr": {
        const m = g.node(a[0]), ew = m?.attrs?.elem?.w ?? T(a[2]).w;
        seq.push(`    if (|${N(a[3])}) ${N(a[0])}[${N(a[1])}] <= ${ext(a[2], ew)};`);
        break;
      }
      case "reg": {
        const init = lit(encodeValue(n.attrs.init ?? 0, n.type), W);
        decls.push(`  reg ${rng(W)} ${x} = ${init};${n.attrs.physEncoding ? `  // fsm.encode would map this state register as ${n.attrs.physEncoding}; the RTL keeps the index (synthesis re-encodes FSMs)` : ""}`);
        if (n.attrs.next != null) seq.push(`    ${x} <= rst ? ${init} : ${ext(n.attrs.next, W)};`);
        break;
      }
      case "probe": decls.push(`  wire ${rng(W)} ${x};  // probe`); assigns.push(`  assign ${x} = ${ext(a[0], W)};`); break;
      case "cell": break;
      default: decls.push(`  // unsupported op ${n.op} at %${n.id}`); break;
    }
  }
  // values other domains or cells read: exported as extra outputs
  for (const id of [...exportIds].sort((p, q) => p - q)) {
    const n = g.node(id);
    if (!n || n.op === "out") continue;
    const pn = names.take(`x_${id}`);
    ports.push({ dir: "output", w: n.type.w, name: pn, id, export: true });
    assigns.push(`  assign ${pn} = ${N(id)};`);
  }
  const header = [`  input  wire clk`, `  input  wire rst`, ...ports.map((p) => `  ${p.dir === "input" ? "input " : "output"} wire ${rng(p.w)} ${p.name}`)];
  const text = [
    `// ${modName}: clock domain ${g.domain}${g.hz ? ` @ ${g.hz} Hz` : ""}, generated by Weft from the DAG (${nodes.length} nodes)`,
    `module ${modName} (`,
    header.join(",\n"),
    `);`,
    ...decls,
    ...inits,
    ...assigns,
    seq.length ? `  always @(posedge clk) begin\n${seq.join("\n")}\n  end` : "",
    `endmodule`,
    "",
  ].filter((l) => l !== "").join("\n") + "\n";
  return { text, ports, nameOf: N };
}

// ---------- the design ----------
export function emitVerilog(compiled) {
  const out = [];
  try {
    const design = sanitize(compiled.name || compiled.header?.id || "design");
    const domains = compiled.domains || {};
    // which nodes each domain must export: crossing sources and values cells read
    const exportsOf = Object.fromEntries(Object.keys(domains).map((d) => [d, new Set()]));
    for (const [, d] of Object.entries(domains)) for (const n of d.graph.live()) if (n.op === "in" && n.attrs.src === "cross" && n.attrs.from && exportsOf[n.attrs.from.domain]) exportsOf[n.attrs.from.domain].add(n.attrs.from.node);
    for (const c of compiled.cells || []) for (const io of Object.values(c.io || {})) if (io.dir === "read" && exportsOf[io.domain || c.domain]) exportsOf[io.domain || c.domain].add(io.node);
    const mods = {};
    for (const [d, { graph }] of Object.entries(domains)) {
      const modName = `${design}_${sanitize(d)}`;
      const m = emitDomain(modName, graph, { exports: [...exportsOf[d]] });
      mods[d] = { ...m, modName };
      out.push({ path: `${modName}.v`, text: m.text, module: modName, domain: d, ports: m.ports.map(({ dir, w, name, id, export: ex }) => ({ dir, w, name, id, export: !!ex })) });
    }
    const cellsFile = emitCellStubs(compiled);
    if (cellsFile) out.push(cellsFile);
    out.push({ ...emitTop(design, compiled, mods), top: true });
  } catch (e) {
    out.push({ path: "ERROR.txt", text: `Verilog emission failed: ${e.message}\n` });
  }
  return out;
}
export function pinParts(resource) {
  const m = String(resource).match(/^(.*?)[:\[](\d+)\]?$/);
  return m ? { base: sanitize(m[1]), idx: +m[2], indexed: true } : { base: sanitize(resource), idx: 0, indexed: false };
}
function emitTop(design, compiled, mods) {
  const lines = [], wires = [], assigns = [], insts = [];
  const domainNames = Object.keys(mods);
  const topPorts = new Map();   // name → { dir, w, indexed }
  const addPort = (name, dir, w, indexed) => {
    const p = topPorts.get(name);
    if (p) { p.w = Math.max(p.w, w); return; }
    topPorts.set(name, { dir, w, indexed });
  };
  for (const d of domainNames) addPort(`clk_${sanitize(d)}`, "input", 1, false);
  addPort("rst", "input", 1, false);
  const pins = compiled.pins || [];
  const resDir = (id) => compiled.board?.resources?.[id]?.dir;
  for (const p of pins) {
    const { base, idx, indexed } = pinParts(p.resource);
    addPort(base, p.dir === "in" ? "input" : "output", idx + 1, indexed);
  }
  const noBoard = !pins.length && !(compiled.cells || []).length;
  // domain instances
  for (const d of domainNames) {
    const m = mods[d], sd = sanitize(d);
    const conns = [`.clk(clk_${sd})`, `.rst(rst)`];
    for (const p of m.ports) {
      const w = `${sd}__${p.name}`;
      wires.push(`  wire ${rng(p.w)} ${w};`);
      conns.push(`.${p.name}(${w})`);
      if (p.dir === "input") {
        const n = compiled.domains[d].graph.node(p.id);
        const src = n?.attrs?.src || "free";
        if (src === "cross" && n.attrs.from && mods[n.attrs.from.domain]) {
          const sm = mods[n.attrs.from.domain];
          const ep = sm.ports.find((q) => q.id === n.attrs.from.node && q.dir === "output");
          if (ep) assigns.push(`  assign ${w} = ${sanitize(n.attrs.from.domain)}__${ep.name};  // ${n.attrs.from.domain} → ${d} (${n.attrs.stages ?? 2}-stage synchronizer registers are in the destination domain)`);
          continue;
        }
        if (src === "pin") {
          const ps = pins.filter((q) => q.node === p.id && (q.domain == null || q.domain === d));
          for (const q of ps) { const { base, idx, indexed } = pinParts(q.resource); assigns.push(`  assign ${w}[${q.bit ?? 0}] = ${base}${indexed || topPorts.get(base)?.w > 1 ? `[${idx}]` : ""};`); }
          if (ps.length) continue;
        }
        if (src === "knob") {
          const k = (compiled.knobs || []).find((x) => x.node === p.id && (x.domain == null || x.domain === d));
          assigns.push(`  assign ${w} = ${lit(k?.reset ?? 0, p.w)};  // knob ${n.attrs.path}: written by the host bridge, not modelled in this RTL`);
          continue;
        }
        if (src === "cell") continue;   // driven by a cell instance below
        if (src === "port" || noBoard) { const tp = sanitize(n?.attrs?.path || p.name); addPort(tp, "input", p.w, false); assigns.push(`  assign ${w} = ${tp};`); continue; }
        assigns.push(`  assign ${w} = ${lit(0, p.w)};  // unconnected input ${n?.attrs?.path || p.name}`);
      } else {
        if (p.export) continue;
        const ps = pins.filter((q) => q.node === p.id && (q.domain == null || q.domain === d));
        for (const q of ps) { const { base, idx, indexed } = pinParts(q.resource); assigns.push(`  assign ${base}${indexed || topPorts.get(base)?.w > 1 ? `[${idx}]` : ""} = ${w}[${q.bit ?? 0}];`); }
        if (!ps.length && noBoard) { const n = compiled.domains[d].graph.node(p.id); const tp = sanitize(n?.attrs?.path || p.name); addPort(tp, "output", p.w, false); assigns.push(`  assign ${tp} = ${w};`); }
      }
    }
    insts.push(`  ${m.modName} u_${sd} (\n    ${conns.join(",\n    ")}\n  );`);
  }
  // native cells: adapters to hand-written cores, or black boxes
  const stubs = cellStubs(compiled);
  for (const c of compiled.cells || []) {
    const ci = stubs.byCell.get(c);
    const conns = [...ci.clocks.map((d) => `.${ci.clocks.length > 1 ? `clk_${sanitize(d)}` : "clk"}(clk_${sanitize(d)})`), `.rst(rst)`];
    for (const p of ci.ports) {
      if (p.io) {
        const dm = mods[p.io.domain];
        const q = dm?.ports.find((x) => x.id === p.io.node && x.dir === (p.dir === "output" ? "input" : "output"));
        if (q) conns.push(`.${p.name}(${sanitize(p.io.domain)}__${q.name})`);
      } else {
        const { base, idx, indexed } = pinParts(p.resource);
        addPort(base, p.dir, idx + 1, indexed);
        conns.push(`.${p.name}(${base}${indexed ? `[${idx}]` : ""})`);
      }
    }
    const params = Object.entries(ci.inst).map(([k, v]) => `.${k}(${typeof v === "number" ? Math.round(v) : `"${String(v).replace(/"/g, "")}"`})`);
    insts.push(`  ${ci.module} ${params.length ? `#(${params.join(", ")}) ` : ""}u_${sanitize(c.path)} (\n    ${conns.join(",\n    ")}\n  );  // native cell ${c.path} (${c.kind}): ${ci.adapter ? `adapter to ${ci.adapter.core} (hdl/cells)` : "a black box in this RTL"}`);
  }
  const portList = [...topPorts.entries()].map(([name, p]) => `  ${p.dir === "input" ? "input " : "output"} wire ${rng(p.w)} ${name}`);
  lines.push(`// ${design}: top level generated by Weft — ${domainNames.length} clock domain${domainNames.length === 1 ? "" : "s"}, ${(compiled.cells || []).length} native cell${(compiled.cells || []).length === 1 ? "" : "s"}`);
  lines.push(`// Clocks are top-level inputs (PLL primitives are not emitted); rst is synchronous and active high.`);
  lines.push(`module ${design} (`, portList.join(",\n"), `);`);
  return { path: `${design}.v`, text: [...lines, ...wires, ...assigns, ...insts, `endmodule`, ""].join("\n") };
}
// Native cells with a hand-written core (hdl/cells/weft_core_<kind>.v). Instead of a black box, such a cell's
// module is an adapter: the same interface (port names follow the design's stream names), with the core inside.
// `params` are the per-instance parameters the top passes (from the cell's params and its domain clock);
// `wire` maps the cell's roles to core ports, or returns { reason } when the interface does not fit the core.
const cyclesOf = (ms, hz) => Math.max(0, Math.ceil((ms * hz) / 1000 - 1e-9));   // the model: t - since >= settle
export const CELL_CORES = {
  debounce: {
    core: "weft_core_debounce",
    params: (c, hz) => ({ SETTLE_CYC: cyclesOf(c.params?.settleMs ?? 10, hz), LONG_CYC: c.params?.longMs != null ? cyclesOf(c.params.longMs, hz) : 0 }),
    wire({ produce, role }) {
      const S = produce[0], raw = role("raw"), held = role("held");
      if (!S?.valid || !S.data || !raw) return { reason: "a debounce cell needs its raw pins and a stream of presses" };
      if (S.data.w < 2) return { reason: `presses carry ${S.data.w} bit(s); the core sends { id, long }` };
      return {
        params: { N: raw.w, ID_W: S.data.w - 1 },
        conns: { raw: raw.name, held: held?.name ?? "", ev_valid: S.valid.name, ev_id: `${S.data.name}[${S.data.w - 1}:1]`, ev_long: `${S.data.name}[0]`, ev_ready: S.ready?.name ?? "1'b1" },
      };
    },
  },
  "uart-rx": {
    core: "weft_core_uart_rx",
    params: (c, hz) => ({ CLK_HZ: Math.round(hz), BAUD: Math.round(c.params?.baud ?? 115200) }),
    wire({ produce, role }) {
      const S = produce[0], rx = role("rx") || role("uart");
      if (!S?.valid || !S.data || !rx) return { reason: "a uart-rx cell needs its rx pin and a stream of bytes" };
      return { params: {}, conns: { rx: rx.name, m_valid: S.valid.name, m_data: S.data.w >= 8 ? `${S.data.name}[7:0]` : S.data.name, m_ready: S.ready?.name ?? "1'b1" } };
    },
  },
  "uart-tx": {
    core: "weft_core_uart_tx",
    params: (c, hz) => ({ CLK_HZ: Math.round(hz), BAUD: Math.round(c.params?.baud ?? 115200) }),
    wire({ consume, role }) {
      const S = consume[0], tx = role("tx") || role("uart");
      if (!S?.valid || !S.data || !tx) return { reason: "a uart-tx cell needs its tx pin and a stream of bytes" };
      const data = S.data.w >= 8 ? `${S.data.name}[7:0]` : `{${8 - S.data.w}'d0, ${S.data.name}}`;
      return { params: {}, conns: { s_valid: S.valid.name, s_data: data, s_ready: S.ready?.name ?? "", tx: tx.name } };
    },
  },
};

// the interface each cell instance presents: clocks, io signals (to domain module ports) and pins the graph
// does not already carry; instances of a kind with the same interface share one module (an adapter when the
// kind has a core, a black box otherwise)
export function cellStubs(compiled) {
  const graphPins = new Set((compiled.pins || []).filter((p) => p.node != null).map((p) => p.resource));
  const resDir = (r) => compiled.board?.resources?.[r]?.dir ?? (/(^|[.:])rx$|raw|btn|button|sw/.test(String(r)) ? "in" : "out");
  const byCell = new Map(), sigs = new Map();
  for (const c of compiled.cells || []) {
    const clocks = [...new Set([c.domain, ...Object.values(c.io || {}).map((io) => io.domain || c.domain)].filter(Boolean))];
    const ports = [];
    const used = new Set(["clk", "rst", ...clocks.map((d) => `clk_${sanitize(d)}`)]);
    for (const [sig, io] of Object.entries(c.io || {}).sort(([x], [y]) => (x < y ? -1 : 1))) {
      const dom = io.domain || c.domain;
      const w = compiled.domains[dom]?.graph?.node(io.node)?.type?.w ?? 1;
      const name = sanitize(sig);
      used.add(name);
      ports.push({ name, dir: io.dir === "drive" ? "output" : "input", w, io: { ...io, domain: dom }, key: sig });
    }
    for (const [port, val] of Object.entries(c.pins || {})) {
      const rest = [val].flat().filter((r) => !graphPins.has(r));
      for (const r of rest) {
        let name = rest.length === 1 && !used.has(sanitize(port)) ? sanitize(port) : sanitize(`${port}_${r}`);
        while (used.has(name)) name += "_";
        used.add(name);
        ports.push({ name, dir: resDir(r) === "in" ? "input" : "output", w: 1, resource: r, pin: rest.length === 1 ? port : null });
      }
    }
    const spec = CELL_CORES[c.kind];
    let adapter = null, reason = null, inst;
    if (spec) {
      const hz = compiled.domains[c.domain]?.hz ?? 0;
      const g = groupIO(c.io);
      const byKey = new Map(ports.filter((p) => p.key).map((p) => [p.key, p]));
      const streams = (list) => list.map((x) => ({ name: x.name, valid: byKey.get(x.valid), data: byKey.get(x.data), ready: byKey.get(x.ready) }));
      const role = (r) => byKey.get(r) || ports.find((p) => p.pin === r) || null;
      const wired = clocks.length > 1 ? { reason: "the core has one clock" } : !hz ? { reason: "its clock domain has no frequency" } : spec.wire({ produce: streams(g.produce), consume: streams(g.consume), role });
      if (wired.reason) reason = wired.reason; else adapter = { core: spec.core, ...wired };
      inst = adapter ? spec.params(c, hz) : {};
    } else {
      inst = Object.fromEntries(Object.entries(c.params || {}).filter(([, v]) => typeof v === "number" || typeof v === "string").map(([k, v]) => [sanitize(k).toUpperCase(), v]));
    }
    const params = Object.keys(inst).sort();
    inst = Object.fromEntries(params.map((k) => [k, inst[k]]));
    const sig = JSON.stringify([c.kind, clocks.length, ports.map((p) => [p.name, p.dir, p.w]), params, adapter && [adapter.params, adapter.conns]]);
    if (!sigs.has(sig)) {
      const k = [...sigs.values()].filter((x) => x.kind === c.kind).length;
      sigs.set(sig, { kind: c.kind, module: `weft_${sanitize(c.kind)}${k ? `_${k + 1}` : ""}`, clocks, ports, params, adapter });
    }
    byCell.set(c, { ...sigs.get(sig), clocks, ports, inst, reason });
  }
  return { byCell, modules: [...sigs.values()] };
}
function emitCellStubs(compiled) {
  const { modules } = cellStubs(compiled);
  if (!modules.length) return null;
  const text = [`// Native cells used by this design. In the Lab their behaviour is JavaScript. A cell with a hand-written core`, `// (hdl/cells, added by weft build) gets an adapter from the design's stream signals to the core's ports; any`, `// other cell is a black box with the interface the design uses.`, ""];
  for (const m of modules.sort((x, y) => (x.module < y.module ? -1 : 1))) {
    const ps = [...m.clocks.map((d) => `  input  wire ${m.clocks.length > 1 ? `clk_${sanitize(d)}` : "clk"}`), `  input  wire rst`, ...m.ports.map((p) => `  ${p.dir === "input" ? "input " : "output"} wire ${rng(p.w)} ${p.name}`)];
    const head = `module ${m.module} ${m.params.length ? `#(${m.params.map((p) => `parameter ${p} = 0`).join(", ")}) ` : ""}(`;
    if (!m.adapter) { text.push(`(* blackbox *)`, head, ps.join(",\n"), `);`, `endmodule`, ""); continue; }
    const a = m.adapter;
    const cp = [...Object.entries(a.params).map(([k, v]) => `.${k}(${v})`), ...m.params.map((p) => `.${p}(${p})`)];
    const conns = [`.clk(clk)`, `.rst(rst)`, ...Object.entries(a.conns).map(([k, v]) => `.${k}(${v})`)];
    text.push(`// ${m.kind} cell → ${a.core}`, head, ps.join(",\n"), `);`, `  ${a.core} #(${cp.join(", ")}) core (\n    ${conns.join(",\n    ")}\n  );`, `endmodule`, "");
  }
  return { path: "weft_cells.v", text: text.join("\n") };
}
export { typeName as _typeName };
