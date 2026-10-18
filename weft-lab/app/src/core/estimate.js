// Technology and timing estimate (owner B). The Lab does not run vendor synthesis or place-and-route:
// it maps each DAG node to an estimated cost in the target family's cells and estimates path delays
// with a per-family delay model (ARCH §7). Every number this module produces is an estimate, and the
// report says so.
import { clog2, isBig, typeName } from "./types.js";

// ---------- parts and families ----------
export const PARTS = {
  ice40up5k: { name: "ice40up5k", family: "ice40", luts: 5280, ffs: 5280, brams: 30, bramKb: 4, sprams: 4, dsps: 8, ios: 39 },
  ice40hx8k: { name: "ice40hx8k", family: "ice40", luts: 7680, ffs: 7680, brams: 32, bramKb: 4, sprams: 0, dsps: 0, ios: 206 },
  xc7a35t: { name: "xc7a35t", family: "xc7", luts: 20800, ffs: 41600, brams: 50, bramKb: 36, sprams: 0, dsps: 90, ios: 210 },
  xc7a50t: { name: "xc7a50t", family: "xc7", luts: 32600, ffs: 65200, brams: 75, bramKb: 36, sprams: 0, dsps: 120, ios: 250 },
  xc7a100t: { name: "xc7a100t", family: "xc7", luts: 63400, ffs: 126800, brams: 135, bramKb: 36, sprams: 0, dsps: 240, ios: 300 },
  "lfe5u-25f": { name: "lfe5u-25f", family: "ecp5", luts: 24288, ffs: 24288, brams: 56, bramKb: 18, sprams: 0, dsps: 28, ios: 197 },
  "lfe5u-45f": { name: "lfe5u-45f", family: "ecp5", luts: 43848, ffs: 43848, brams: 108, bramKb: 18, sprams: 0, dsps: 72, ios: 245 },
  "lfe5u-85f": { name: "lfe5u-85f", family: "ecp5", luts: 83640, ffs: 83640, brams: 208, bramKb: 18, sprams: 0, dsps: 156, ios: 365 },
  ccgm1a1: { name: "ccgm1a1", family: "gatemate", luts: 40960, ffs: 40960, brams: 64, bramKb: 20, sprams: 0, dsps: 0, ios: 162 },
  generic: { name: "generic", family: "generic", luts: 1e6, ffs: 1e6, brams: 1000, bramKb: 36, sprams: 0, dsps: 1000, ios: 1000 },
};
export function partInfo(part) {
  if (part && typeof part === "object") {
    if (part.luts && part.family) return { ...PARTS.generic, ...part };
    part = part.name || part.part;
  }
  const p = String(part || "").toLowerCase();
  for (const key of Object.keys(PARTS)) if (key !== "generic" && p.startsWith(key)) return PARTS[key];
  if (p.startsWith("ice40")) return { ...PARTS.ice40up5k, name: p };
  if (p.startsWith("xc7")) return { ...PARTS.xc7a35t, name: p };
  if (p.startsWith("lfe5")) return { ...PARTS["lfe5u-85f"], name: p };
  if (p.startsWith("ccgm1a")) return { ...PARTS.ccgm1a1, name: p };
  return PARTS.generic;
}
// families: LUT inputs, delay model (ns), cell names, memory primitives
export const FAMILY = {
  ice40: {
    name: "iCE40", k: 4, lut: 0.6, route: 0.9, carryPerBit: 0.12, overhead: 1.0, bramDelay: 2.0,
    dsp: { a: 16, b: 16, delay: 6.5 }, lutram: false, ffRam: 16,
    bram: { kb: 4, configs: [[256, 16], [512, 8], [1024, 4], [2048, 2]] },
    spram: { kb: 256, words: 16384, width: 16 },
    cells: { lut: "SB_LUT4", carry: "SB_CARRY", carryBits: 1, ff: "SB_DFF", dsp: "SB_MAC16", bram: "SB_RAM40_4K", spram: "SB_SPRAM256KA", io: "SB_IO", lutram: null },
  },
  xc7: {
    name: "7-series", k: 6, lut: 0.12, route: 0.45, carryPerBit: 0.015, overhead: 0.5, bramDelay: 2.45,
    dsp: { a: 25, b: 18, delay: 2.9, post: 1.1 }, lutram: true,
    bram: { kb: 36, configs: [[32768, 1], [16384, 2], [8192, 4], [4096, 9], [2048, 18], [1024, 36], [512, 72]],
      half: [[16384, 1], [8192, 2], [4096, 4], [2048, 9], [1024, 18], [512, 36]] },
    cells: { lut: "LUT6", carry: "CARRY4", carryBits: 4, ff: "FDRE", dsp: "DSP48E1", bram: "RAMB36E1", bram18: "RAMB18E1", io: "IOBUF", lutram: "RAM64X1D", srl: "SRLC32E" },
  },
  ecp5: {
    name: "ECP5", k: 4, lut: 0.25, route: 0.6, carryPerBit: 0.03, overhead: 0.6, bramDelay: 2.2,
    dsp: { a: 18, b: 18, delay: 4.0 }, lutram: true,
    bram: { kb: 18, configs: [[16384, 1], [8192, 2], [4096, 4], [2048, 9], [1024, 18], [512, 36]] },
    cells: { lut: "LUT4", carry: "CCU2C", carryBits: 2, ff: "TRELLIS_FF", dsp: "MULT18X18D", bram: "DP16KD", io: "TRELLIS_IO", lutram: "TRELLIS_DPR16X4" },
  },
  // GateMate: delays are a first guess fitted to one nextpnr run (a 25-bit counter closes at ~91 MHz);
  // calibrate against `weft build` reports as they come in. No hard multipliers: CC_MULT is built from CPEs.
  gatemate: {
    name: "GateMate", k: 4, lut: 0.9, route: 1.2, carryPerBit: 0.28, overhead: 1.5, bramDelay: 3.0,
    dsp: { a: 16, b: 16, delay: 8.0 }, lutram: false, ffRam: 16,
    bram: { kb: 20, configs: [[16384, 1], [8192, 2], [4096, 5], [2048, 10], [1024, 20], [512, 40]] },
    cells: { lut: "CC_LUT4", carry: "CC_ADDF", carryBits: 1, ff: "CC_DFF", dsp: "CC_MULT", bram: "CC_BRAM_20K", io: "CC_IBUF/CC_OBUF", lutram: null },
  },
};
FAMILY.generic = { ...FAMILY.xc7, name: "generic" };
export function familyOf(x) {
  if (!x) return "generic";
  if (typeof x === "string") return FAMILY[x] ? x : partInfo(x).family;
  if (x.family && FAMILY[x.family]) return x.family;
  if (x.partData?.family && FAMILY[x.partData.family]) return x.partData.family;
  return partInfo(x.part || x.partData || x.name).family;
}

// ---------- helpers ----------
const W = (n) => Math.max(1, Math.min(n.type?.w ?? 1, n.attrs?.liveBits ?? Infinity));
const isConstNode = (g, id) => g.node(id)?.op === "const";
const constVal = (g, id) => { const v = g.node(id)?.attrs?.value; return typeof v === "bigint" ? Number(v) : v; };
const isPow2 = (v) => v > 0 && Number.isInteger(Math.log2(v)) && 2 ** Math.round(Math.log2(v)) === v;
// nonzero digits of the canonical signed-digit form of |v|
export function csdDigits(v) {
  let n = BigInt(Math.abs(Math.round(Number(v)))), c = 0;
  while (n !== 0n) {
    if (n & 1n) { const d = (n & 3n) === 3n ? -1n : 1n; n -= d; c++; }
    n >>= 1n;
  }
  return c;
}
const ROUTING = new Set(["wrap", "zext", "sext", "slice", "field", "pack", "concat", "mux", "not"]);
const FREE = new Set(["const", "in", "out", "probe", "slice", "wrap", "zext", "sext", "concat", "pack", "field", "mem"]);

// which nodes the estimate counts: those reaching an output, a memory write, a register, a stream endpoint, a
// cell input or a pin. Registers count as written (the Lab can observe every one of them; real synthesis would
// drop a register nothing outside reads); logic that only feeds probes and assertions does not.
export function synthLive(g, roots = []) {
  const live = new Set(), work = [];
  const push = (id) => { if (id != null && g.node(id) && !live.has(id)) { live.add(id); work.push(id); } };
  for (const n of g.live()) if (n.op === "out" || n.op === "memwr" || n.op === "reg" || n.attrs?.keep) push(n.id);
  for (const id of roots) push(id);
  while (work.length) {
    const n = g.node(work.pop());
    for (const a of n.args) push(a);
    if (n.op === "reg") push(n.attrs.next);
    if (n.op === "memrd") push(n.args[0]);
  }
  return live;
}

// ---------- multipliers and memories ----------
function classifyMul(g, n, F, fam, hints, noDsp = false) {
  const [a, b] = n.args;
  const ca = isConstNode(g, a), cb = isConstNode(g, b);
  if (ca && cb) return { kind: "const" };
  if (ca || cb) {
    const v = constVal(g, ca ? a : b);
    if (v === 0 || isPow2(Math.abs(v))) return { kind: "shift" };
    const other = g.node(ca ? b : a);
    if (hints?.multiply === "dsp" && fam !== "generic" && !noDsp) return dspFit(other.type.w, bitsFor(v), F, "dsp");
    if (hints?.multiply === "lut") return { kind: "lut", wa: other.type.w, wb: bitsFor(v) };
    const digits = csdDigits(v);
    // without a hint, synthesis tools put a constant multiply with a wide result in a DSP (as Yosys and
    // Vivado do); narrow ones and explicit "shift-add" become adders of shifted copies
    if (!hints?.multiply && !noDsp && fam !== "generic" && F.dsp.a && n.type.w >= 11 && digits >= 2) return dspFit(other.type.w, bitsFor(v), F, "dsp");
    return { kind: "shift-add", digits, w: other.type.w };
  }
  const wa = g.node(a).type.w, wb = g.node(b).type.w;
  if (noDsp || F.dsp.a === 0 || hints?.multiply === "lut" || hints?.multiply === "shift-add") return { kind: "lut", wa, wb };
  return dspFit(wa, wb, F, "dsp");
}
const bitsFor = (v) => Math.max(1, Math.ceil(Math.log2(Math.abs(v) + 1)) + (v < 0 ? 1 : 0));
function dspFit(wa, wb, F, kind) {
  const { a, b } = F.dsp;
  // operands are signed in the DSP; an unsigned operand needs one more bit, which `type.w` of the
  // promoted value already accounts for when signed; be generous and allow w ≤ a for either order
  const fits = (x, y) => x <= a && y <= b;
  if (fits(wa, wb) || fits(wb, wa)) return { kind, count: 1 };
  const t1 = Math.ceil(wa / a) * Math.ceil(wb / b), t2 = Math.ceil(wb / a) * Math.ceil(wa / b);
  return { kind, count: Math.min(t1, t2), tiled: true };
}
// fewest primitives for a words × width memory, trying every aspect ratio
export function bramCount(words, width, F) {
  let best = { count: Infinity, cfg: null, half: false };
  for (const [d, w] of F.bram.configs) {
    const c = Math.ceil(width / w) * Math.ceil(words / d);
    if (c < best.count) best = { count: c, cfg: [d, w], half: false };
  }
  if (F.bram.half) for (const [d, w] of F.bram.half) {
    const c = Math.ceil(width / w) * Math.ceil(words / d) * 0.5;
    if (c < best.count) best = { count: c, cfg: [d, w], half: true };
  }
  return best;
}
// classify every mem and rom node (Appendix A "Memory placement", D8)
export function classifyMemories(g, F, fam, budgets = {}, noInfer = false) {
  const out = [];
  for (const n of g.live()) {
    if (n.op !== "mem" && n.op !== "rom") continue;
    const module = n.attrs.module || pathModule(n.attrs.path);
    const noBram = budgets[module]?.brams === 0;
    if (n.op === "rom") {
      const words = n.attrs.table?.length ?? 2 ** (g.node(n.args[0])?.type.w ?? 1);
      const width = n.type.w;
      const registered = romRegistered(g, n.id);
      let kind = "lut";
      if (!noBram && !noInfer && words > 64 && registered) kind = "bram";
      const rec = { id: n.id, path: n.attrs.path || (n.attrs.name ? `${module ? module + "." : ""}${n.attrs.name}` : `${module || "rom"}.rom%${n.id}`), module, kind: "rom", place: kind, words, width, registered };
      if (kind === "bram") Object.assign(rec, bramRec(words, width, F, fam));
      out.push(rec);
      continue;
    }
    const words = n.attrs.words, width = n.attrs.elem?.w ?? n.type.w;
    const bits = words * width;
    const ports = g.live().filter((m) => (m.op === "memrd" || m.op === "memwr") && m.args[0] === n.id);
    const rds = ports.filter((m) => m.op === "memrd"), wrs = ports.filter((m) => m.op === "memwr");
    // one address for reads and writes (or only one kind of access): a single-port RAM, which SPRAM can hold
    const singlePort = n.attrs.singlePort || (rds.length <= 1 && wrs.length <= 1 && (!rds.length || !wrs.length || rds[0].args[1] === wrs[0].args[1]));
    let place;
    if (noInfer) place = "ff";
    else if (fam === "ice40") {
      if (words <= F.ffRam) place = "ff";
      else if (singlePort && bits >= 32 * 1024) place = "spram";
      else place = noBram ? "ff" : "bram";
    } else if (words < 64 && F.lutram) place = "lutram";
    else place = noBram ? "lutram" : "bram";
    const rec = { id: n.id, path: n.attrs.path, module, kind: "ram", place, words, width, bits };
    if (place === "bram") Object.assign(rec, bramRec(words, width, F, fam));
    if (place === "spram") rec.sprams = Math.ceil(bits / (256 * 1024));
    out.push(rec);
  }
  return out;
}
function bramRec(words, width, F, fam) {
  const b = bramCount(words, width, F);
  return { brams: b.count, cfg: `${b.cfg[0]}×${b.cfg[1]}`, prim: b.half ? F.cells.bram18 : F.cells.bram, unit: fam === "xc7" ? "RAMB36" : F.cells.bram };
}
function romRegistered(g, id) {
  // the read result reaches a register through routing nodes only (≤ 3 hops)
  const seen = new Set();
  const walk = (x, depth) => {
    for (const u of g.users(x)) {
      if (seen.has(u)) continue;
      seen.add(u);
      const n = g.node(u);
      if (!n) continue;
      if (n.op === "reg") return true;
      if (depth < 3 && ROUTING.has(n.op) && walk(u, depth + 1)) return true;
    }
    return false;
  };
  return walk(id, 0);
}
export const pathModule = (p) => (p ? String(p).split(".")[0] : "");

// ---------- per-node cost ----------
export function nodeCost(g, n, F, fam, ctx) {
  const k = F.k, w = W(n), wide = k >= 6;
  const c = { luts: 0, carry: 0, ffs: 0, dsps: 0 };
  switch (n.op) {
    case "add": case "sub": case "neg":
      if (ctx.absorbed.has(n.id)) return c;
      c.luts = w; c.carry = Math.ceil(w / F.cells.carryBits); return c;
    case "lt": case "le": case "gt": case "ge": {
      const aw = Math.max(...n.args.map((a) => g.node(a).type.w));
      c.luts = wide ? Math.ceil(aw / 2) : aw; c.carry = Math.ceil(aw / F.cells.carryBits); return c;
    }
    case "eq": case "ne": {
      const aw = Math.max(...n.args.map((a) => g.node(a).type.w));
      const first = Math.ceil((2 * aw) / k);
      let tot = first, lvl = first;
      while (lvl > 1) { lvl = Math.ceil(lvl / k); tot += lvl; }
      c.luts = tot; return c;
    }
    case "and": case "or": case "xor":
      if (n.args.some((a) => isConstNode(g, a))) return c;   // a constant operand folds into the next LUT
      c.luts = wide ? Math.ceil(w / 2) : w; return c;
    case "land": case "lor": c.luts = 0.5; return c;
    case "not": case "lnot": return c;
    case "mux": if (ctx.absorbed.has(n.id) || ctx.ce?.has(n.id)) return c; c.luts = wide ? Math.ceil(w / 2) : w; return c;
    case "sat": c.luts = (wide ? Math.ceil(w / 2) : w) * 3; c.carry = 2 * Math.ceil(w / F.cells.carryBits); return c;
    case "shl": case "shr": {
      if (isConstNode(g, n.args[1])) return c;
      const sw = g.node(n.args[1]).type.w;
      c.luts = w * Math.ceil(sw / (wide ? 2 : 1)); return c;
    }
    case "index": {
      if (isConstNode(g, n.args[1])) return c;
      const vec = g.node(n.args[0]), elems = Math.max(1, Math.round(vec.type.w / Math.max(1, n.type.w)));
      c.luts = n.type.w * Math.ceil((elems - 1) / (wide ? 3 : 1)); return c;
    }
    case "mul": {
      const m = ctx.muls.get(n.id);
      if (!m) return c;
      if (m.kind === "dsp") { c.dsps = m.count; return c; }
      if (m.kind === "shift" || m.kind === "const") return c;
      if (m.kind === "shift-add") { c.luts = Math.max(0, m.digits - 1) * w; c.carry = Math.max(0, m.digits - 1) * Math.ceil(w / F.cells.carryBits); return c; }
      c.luts = Math.ceil((m.wa * m.wb) / (wide ? 2 : 1.5)); return c;
    }
    case "rom": {
      const mem = ctx.mems.get(n.id);
      if (mem?.place === "bram") return c;
      const words = n.attrs.table?.length ?? 2;
      if (words <= 1) return c;
      const per = wide ? Math.ceil(words / 64) + Math.max(0, Math.ceil(words / 256) - 1) : Math.ceil(words / 16) + Math.ceil((Math.ceil(words / 16) - 1) / 3);
      c.luts = per * w; return c;
    }
    case "memrd": case "memwr": {
      const mem = ctx.mems.get(n.args[0]);
      if (!mem || n.op === "memwr") return c;
      if (mem.place === "lutram") c.luts = Math.ceil(mem.words / (wide ? 64 : 16)) * mem.width * (wide ? 2 : 0.5);
      if (mem.place === "ff") { c.ffs = mem.words * mem.width; c.luts = Math.ceil((mem.words - 1) * mem.width / (wide ? 3 : 1)); }
      return c;
    }
    case "reg": {
      if (ctx.absorbed.has(n.id) || n.attrs.prescalerOf || ctx.dupRegs?.has(n.id)) return c;
      c.ffs = Math.max(0, n.type.w - (ctx.tz?.get(n.id) || 0));   // bits that are always 0 need no flip-flop
      return c;
    }
    default: return c;
  }
}

// ---------- timing ----------
export function nodeDelay(g, n, F, ctx) {
  const lvl = F.lut + F.route, w = W(n);
  switch (n.op) {
    case "add": case "sub": case "neg":
      if (ctx?.postAdds?.has(n.id)) return F.dsp.post ?? 1.0;   // through the DSP's post-adder / cascade
      return ctx?.absorbed?.has(n.id) ? 0 : lvl + w * F.carryPerBit;
    case "lt": case "le": case "gt": case "ge": { const aw = Math.max(...n.args.map((a) => g.node(a).type.w)); return lvl + aw * F.carryPerBit; }
    case "eq": case "ne": { const aw = Math.max(...n.args.map((a) => g.node(a).type.w)); return lvl * Math.max(1, Math.ceil(Math.log(2 * aw) / Math.log(F.k))); }
    case "and": case "or": case "xor": return n.args.some((a) => isConstNode(g, a)) ? 0 : lvl;
    case "land": case "lor": return lvl * 0.5;
    case "mux": return ctx?.absorbed?.has(n.id) || ctx?.ce?.has(n.id) ? 0 : lvl;
    case "sat": return 2 * lvl + w * F.carryPerBit;
    case "shl": case "shr": return isConstNode(g, n.args[1]) ? 0 : lvl * Math.ceil(g.node(n.args[1]).type.w / 2);
    case "index": return isConstNode(g, n.args[1]) ? 0 : lvl * Math.ceil(Math.log2(Math.max(2, g.node(n.args[0]).type.w / Math.max(1, n.type.w))) / 2);
    case "mul": {
      const m = ctx?.muls?.get(n.id);
      if (!m || m.kind === "shift" || m.kind === "const") return 0;
      if (m.kind === "dsp") return F.dsp.delay + F.route;
      if (m.kind === "shift-add") return Math.ceil(Math.log2(Math.max(2, m.digits))) * (lvl + w * F.carryPerBit);
      return (Math.ceil(Math.log2(Math.max(m.wa, m.wb))) + 1) * (lvl + w * F.carryPerBit);
    }
    case "rom": {
      const mem = ctx?.mems?.get(n.id);
      if (mem?.place === "bram") return F.bramDelay;
      const words = n.attrs.table?.length ?? 2;
      const levels = Math.max(1, Math.ceil(Math.log2(Math.max(2, words)) / Math.log2(2 ** F.k)));
      return levels * lvl + (F.k >= 6 && words > 64 ? 0.3 : 0);
    }
    case "memrd": return F.bramDelay;
    default: return 0;
  }
}
const SOURCE = new Set(["in", "reg", "const", "mem", "memrd"]);
// arrival times on one domain graph; returns an analysis object
export function timingOf(g, F, ctx, { hz = g.hz, pipelined = {}, endpoints = [] } = {}) {
  const arrival = new Map(), from = new Map();
  let order;
  try { order = g.topo(); } catch { order = g.live().map((n) => n.id); }
  for (const id of order) {
    const n = g.node(id);
    if (SOURCE.has(n.op)) { arrival.set(id, n.op === "memrd" ? F.bramDelay : 0); continue; }
    let best = 0, arg = null;
    for (const a of n.args) { const t = arrival.get(a) ?? 0; if (t >= best) { best = t; arg = a; } }
    const mod = n.attrs?.module;
    let d = nodeDelay(g, n, F, ctx);
    if (mod && pipelined[mod]?.stages > 1) d /= pipelined[mod].stages;
    arrival.set(id, best + d);
    from.set(id, arg);
  }
  // endpoints: register next values, outputs, memory writes
  let worst = 0, end = null, endKind = null;
  const consider = (id, kind, owner) => { const t = (arrival.get(id) ?? 0) + F.overhead; if (t > worst) { worst = t; end = id; endKind = { kind, owner }; } };
  for (const n of g.live()) {
    if (n.op === "reg" && n.attrs.next != null) consider(n.attrs.next, "reg", n.id);
    else if (n.op === "memwr") for (const a of n.args.slice(1)) consider(a, "memwr", n.id);
    // a port or stream endpoint is timed as if a register waited on the other side (an IP block's ports,
    // a stream's consumer outside this domain)
    else if (n.op === "out" && !n.attrs.async) consider(n.args[0], "out", n.id);
  }
  // stream signals, cell inputs and pins the compiler lists: the other side samples them on this clock
  const ends = [...new Set(endpoints)].map((id) => g.node(id)).filter(Boolean).map((n) => (n.op === "probe" || n.op === "out" ? n.args[0] : n.id));
  for (const id of ends) consider(id, "port", id);
  if (end == null) worst = F.overhead;
  const path = [];
  for (let id = end, guard = 0; id != null && guard < 400; id = from.get(id), guard++) {
    const n = g.node(id);
    path.unshift({ id, op: n.op, type: typeName(n.type), arrival: +(arrival.get(id) ?? 0).toFixed(3), delay: +nodeDelay(g, n, F, ctx).toFixed(3), origin: n.origin?.[0] || null, path: n.attrs?.path || null });
    if (SOURCE.has(n.op)) break;
  }
  const levels = path.filter((p) => p.delay > 0).length;
  const periodNs = hz ? 1e9 / hz : null;
  // required times (latest arrival that still meets the clock), for slack through a node
  const required = new Map();
  if (periodNs != null) {
    const req0 = periodNs - F.overhead;
    for (const n of g.live()) {
      if (n.op === "reg" && n.attrs.next != null) required.set(n.attrs.next, Math.min(required.get(n.attrs.next) ?? Infinity, req0));
      if (n.op === "memwr") for (const a of n.args.slice(1)) required.set(a, Math.min(required.get(a) ?? Infinity, req0));
      if (n.op === "out" && !n.attrs.async) required.set(n.args[0], Math.min(required.get(n.args[0]) ?? Infinity, req0));
    }
    for (const id of ends) required.set(id, Math.min(required.get(id) ?? Infinity, req0));
    for (let i = order.length - 1; i >= 0; i--) {
      const n = g.node(order[i]);
      const r = required.get(n.id);
      if (r == null || SOURCE.has(n.op)) continue;
      const mod = n.attrs?.module;
      let d = nodeDelay(g, n, F, ctx);
      if (mod && pipelined[mod]?.stages > 1) d /= pipelined[mod].stages;
      for (const a of n.args) required.set(a, Math.min(required.get(a) ?? Infinity, r - d));
    }
  }
  const slack = periodNs != null ? periodNs - worst : null;
  return {
    domain: g.domain, hz, periodNs: periodNs != null ? +periodNs.toFixed(3) : null, worstNs: +worst.toFixed(3),
    slack: slack != null ? +slack.toFixed(3) : null, fmax: worst > 0 ? +(1000 / worst).toFixed(1) : null, levels, path,
    endpoint: endKind ? { ...endKind, path: g.node(endKind.owner)?.attrs?.path || null } : null,
    arrival: (id) => arrival.get(typeof id === "object" ? id.id : id) ?? 0,
    // slack of the worst path through a node (Infinity when no constrained path passes through it)
    slackOf: (id) => {
      const k = typeof id === "object" ? id.id : id;
      const r = required.get(k);
      return r == null ? Infinity : +(r - (arrival.get(k) ?? 0)).toFixed(3);
    },
  };
}

// ---------- DSP absorption: multiply-accumulate folded into one DSP block ----------
function absorbMacs(g, muls, absorbed, fam, postAdds = new Set()) {
  const postAdd = [];
  for (const [id, m] of muls) {
    if (m.kind !== "dsp" || m.count !== 1) continue;
    let x = id, guard = 0;
    let users = g.users(x);
    while (users.length === 1 && ["sext", "zext", "wrap"].includes(g.node(users[0]).op) && guard++ < 4) { x = users[0]; users = g.users(x); }
    if (users.length !== 1) continue;
    const add = g.node(users[0]);
    if (!add || (add.op !== "add" && add.op !== "sub")) continue;
    const other = add.args.find((a) => a !== x);
    const strip = (y) => { let z = y; for (let i = 0; i < 4 && ["sext", "zext", "wrap"].includes(g.node(z)?.op); i++) z = g.node(z).args[0]; return z; };
    const acc = g.node(strip(other));
    if (!acc || acc.op !== "reg") { if (fam === "xc7" && add.type.w <= 48) postAdd.push([m, add.id]); continue; }
    // the register's next reaches the add through muxes and casts only
    const chain = [];
    let y = acc.attrs.next, ok = false;
    for (let i = 0; i < 6 && y != null; i++) {
      const n = g.node(y);
      if (y === add.id) { ok = true; break; }
      if (!n || !["mux", "wrap", "sext", "zext"].includes(n.op)) break;
      chain.push(y);
      y = n.op === "mux" ? n.args.slice(1).find((a) => reaches(g, a, add.id)) ?? n.args[2] : n.args[0];
    }
    if (!ok) continue;
    absorbed.add(add.id); absorbed.add(acc.id);
    for (const c of chain) absorbed.add(c);
    m.mac = acc.attrs.path;
  }
  // DSP48E1's post-adder: P = A×B + C (or + PCIN down a cascade); one add per DSP
  for (const [m, addId] of postAdd) if (!absorbed.has(addId)) { absorbed.add(addId); postAdds.add(addId); m.postAdd = true; }
}
function reaches(g, from, to, depth = 6) {
  if (from === to) return true;
  if (depth === 0) return false;
  const n = g.node(from);
  return !!n && n.args.some((a) => reaches(g, a, to, depth - 1));
}

// ---------- what the flip-flops absorb ----------
// muxes between a register's next value and the register itself are its clock enable; a mux to a constant is
// its synchronous set/reset (FDRE/FDSE, SB_DFFESR, TRELLIS_FF all have both pins)
export function flopControls(g) {
  const free = new Set();
  for (const r of g.live()) {
    if (r.op !== "reg" || r.attrs.next == null) continue;
    let x = r.attrs.next, ce = false, sr = false;
    for (let i = 0; i < 4; i++) {
      const m = g.node(x);
      if (!m || m.op !== "mux" || g.users(x).length !== 1) break;
      const [, a, b] = m.args;
      if (!ce && (a === r.id || b === r.id)) { free.add(x); ce = true; x = a === r.id ? b : a; continue; }
      if (!sr && (isConstNode(g, a) || isConstNode(g, b))) { free.add(x); sr = true; x = isConstNode(g, a) ? b : a; continue; }
      break;
    }
  }
  return free;
}
// low bits known to be zero (constant shifts and multiplies by powers of two leave them), to a fixpoint
// through registers
export function knownZeros(g) {
  const tz = new Map();
  const tzConst = (v, w) => { let b = BigInt.asUintN(w, typeof v === "bigint" ? v : BigInt(v)); if (b === 0n) return w; let k = 0; while (!(b & 1n)) { b >>= 1n; k++; } return k; };
  let order;
  try { order = g.topo(); } catch { return tz; }
  const regs = g.live().filter((n) => n.op === "reg");
  for (const n of regs) tz.set(n.id, tzConst(n.attrs.init ?? 0, n.type.w));
  // optimistic start, monotone decrease: iterate to the fixpoint (a register chain moves one step per round);
  // if the bound is reached, give up soundly (no known zeros in any register)
  const bound = regs.reduce((a, n) => a + n.type.w, 0) + 2;
  let converged = false;
  for (let it = 0; it < bound; it++) {
    for (const id of order) {
      const n = g.node(id), T = (k) => Math.min(tz.get(k) ?? 0, g.node(k).type.w);
      let z = 0;
      switch (n.op) {
        case "const": z = tzConst(n.attrs.value, n.type.w); break;
        case "shl": z = isConstNode(g, n.args[1]) ? T(n.args[0]) + Number(constVal(g, n.args[1])) : T(n.args[0]); break;
        case "mul": z = T(n.args[0]) + T(n.args[1]); break;
        case "add": case "sub": case "or": case "xor": case "mux": z = Math.min(...n.args.slice(n.op === "mux" ? 1 : 0).map(T)); break;
        case "and": z = Math.max(...n.args.map(T)); break;
        case "neg": case "not": z = n.op === "neg" ? T(n.args[0]) : 0; break;
        case "wrap": case "zext": case "sext": case "sat": z = n.op === "sat" ? 0 : T(n.args[0]); break;
        case "reg": continue;
        default: z = 0;
      }
      tz.set(id, Math.min(z, n.type.w));
    }
    let changed = false;
    for (const n of regs) if (n.attrs.next != null) {
      const z = Math.min(tz.get(n.id), tz.get(n.attrs.next) ?? 0);
      if (z !== tz.get(n.id)) { tz.set(n.id, z); changed = true; }
    }
    if (!changed) { converged = true; break; }
  }
  if (!converged) for (const n of regs) tz.set(n.id, 0);
  return tz;
}
// registers with the same next value and initial value are one flip-flop after synthesis merges them
export function duplicateRegs(g) {
  const seen = new Map(), dup = new Set();
  for (const n of g.live()) {
    if (n.op !== "reg" || n.attrs.next == null || n.attrs.keep) continue;
    const k = `${n.attrs.next}|${String(n.attrs.init ?? 0)}|${n.type.w}|${n.type.signed}`;
    if (seen.has(k)) dup.add(n.id); else seen.set(k, n.id);
  }
  return dup;
}

// ---------- the estimate for a whole design ----------
// ctx: { domains: {name: {hz, graph}}, instances, pins, cells, knobs, board|part|target, budgets }
// opts: { dsp: false } maps every multiplier to LUTs (dsp.pack not run); { mem: false } leaves memories in
// flip-flops and ROMs in LUTs (mem.infer not run).
export function estimate(ctx, opts = {}) {
  const part = partInfo(ctx.target?.part || ctx.board?.partData || ctx.board?.part || "generic");
  const fam = familyOf(ctx.target?.family || part.family);
  const F = FAMILY[fam];
  const instances = ctx.instances || [];
  const hintsOf = new Map(instances.map((i) => [i.path, i.hints || null]));
  const budgets = Object.fromEntries(instances.filter((i) => i.budget).map((i) => [i.path, i.budget]));
  const res = { luts: 0, ffs: 0, brams: 0, dsps: 0, carry: 0, ios: (ctx.pins || []).length, lutram: 0, sprams: 0 };
  const perModule = {};
  const add = (mod, k, v) => {
    if (!v) return;
    const m = (perModule[mod || "(top)"] ??= { luts: 0, ffs: 0, brams: 0, dsps: 0, carry: 0, lutram: 0, sprams: 0 });
    m[k] += v;
  };
  const memories = [], dspList = [], cells = [];
  const domainCtx = {};
  for (const [dname, d] of Object.entries(ctx.domains || {})) {
    const g = d.graph;
    const live = synthLive(g, ctx.rootsOf?.(dname) || []);
    const muls = new Map();
    for (const n of g.live()) if (n.op === "mul" && live.has(n.id)) {
      const mod = n.attrs.module || pathModule(n.attrs.path);
      const m = classifyMul(g, n, F, fam, hintsOf.get(mod), opts.dsp === false || part.dsps === 0);
      muls.set(n.id, m);
      if (m.kind === "dsp") dspList.push({ domain: dname, id: n.id, module: mod, count: m.count, widths: n.args.map((a) => g.node(a).type.w), origin: n.origin?.[0] || null });
    }
    const absorbed = new Set(), postAdds = new Set();
    absorbMacs(g, muls, absorbed, fam, postAdds);
    for (const dl of dspList) if (dl.domain === dname) { const m = muls.get(dl.id); if (m?.mac) dl.mac = m.mac; }
    const mems = new Map();
    for (const m of classifyMemories(g, F, fam, budgets, opts.mem === false)) { mems.set(m.id, { ...m, domain: dname }); memories.push({ ...m, domain: dname }); }
    const cx = { muls, absorbed, postAdds, mems, ce: flopControls(g), tz: knownZeros(g), dupRegs: duplicateRegs(g) };
    domainCtx[dname] = cx;
    for (const n of g.live()) {
      if (!live.has(n.id) && n.op !== "mem") continue;
      const mod = n.attrs.module || pathModule(n.attrs.path) || "(top)";
      const c = nodeCost(g, n, F, fam, cx);
      add(mod, "luts", c.luts); add(mod, "ffs", c.ffs); add(mod, "dsps", c.dsps); add(mod, "carry", c.carry);
      if ((n.op === "memrd") && mems.get(n.args[0])?.place === "lutram") add(mod, "lutram", c.luts);
    }
    for (const m of mems.values()) {
      const mod = m.module || "(top)";
      if (m.brams) add(mod, "brams", m.brams);
      if (m.sprams) add(mod, "sprams", m.sprams);
    }
  }
  // native cells: a small fixed cost each (behavioural models; real IP would differ)
  const CELL_COST = { "uart-rx": { luts: 40, ffs: 30 }, "uart-tx": { luts: 30, ffs: 25 }, debounce: { luts: 30, ffs: 40 }, "sigma-delta": { luts: 20, ffs: 18 }, "video-timing": { luts: 45, ffs: 22 }, hdmi: { luts: 120, ffs: 90 }, "bridge-uart": { luts: 160, ffs: 140 }, xfifo: { luts: 30, ffs: 40 } };
  for (const c of ctx.cells || []) {
    const cc = CELL_COST[c.kind] || { luts: 20, ffs: 20 };
    add(c.path, "luts", cc.luts); add(c.path, "ffs", cc.ffs);
  }
  for (const m of Object.values(perModule)) for (const k of Object.keys(m)) m[k] = Math.ceil(m[k] * 100) / 100;
  for (const m of Object.values(perModule)) { m.luts = Math.ceil(m.luts); m.ffs = Math.ceil(m.ffs); m.carry = Math.ceil(m.carry); }
  for (const m of Object.values(perModule)) for (const k of ["luts", "ffs", "brams", "dsps", "carry", "lutram", "sprams"]) res[k] += m[k] || 0;
  res.brams = Math.round(res.brams * 2) / 2;
  // technology cells (for the census backend and the netlist view)
  for (const [mod, m] of Object.entries(perModule)) {
    const push = (type, n) => { for (let i = 0; i < n; i++) cells.push({ type, module: mod }); };
    push(F.cells.lut, m.luts); push(F.cells.ff, m.ffs); push(F.cells.carry, m.carry); push(F.cells.dsp, m.dsps);
  }
  for (const m of memories) {
    if (m.place === "bram") for (let i = 0; i < Math.ceil(m.brams); i++) cells.push({ type: m.prim || F.cells.bram, module: m.module });
    if (m.place === "spram") for (let i = 0; i < m.sprams; i++) cells.push({ type: F.cells.spram, module: m.module });
    if (m.place === "lutram" && F.cells.lutram) cells.push({ type: F.cells.lutram, module: m.module });
  }
  for (let i = 0; i < res.ios; i++) cells.push({ type: F.cells.io, module: "(io)" });
  return { part, family: fam, F, resources: res, perModule, memories, dsps: dspList, cells, domainCtx };
}
