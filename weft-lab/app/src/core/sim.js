// The Weft simulator (owner C): every domain Graph is compiled to a JavaScript edge function with
// `new Function`; domains interleave on a picosecond event queue (D15). Values are Numbers up to 53 bits
// and BigInts above (types.js); the generated code agrees with `evalOp` (test/sim.test.mjs checks every
// opcode against it). Quiescent cycles are skipped: when an edge changes nothing but prescaler counters,
// the domain jumps to the next counter value any logic can tell apart (ARCH §5).
import { isBig, wrapTo, typeName, durMs, range } from "./types.js";
import { CELLS, encode, decode, expand, psOf, mulberry32, termId, randomOf } from "./cells.js";

export { encode, decode, expand };
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const EPS = 1e-7;
const toPs = (d) => (typeof d === "number" ? d : psOf(d));

// ---------------------------------------------------------------- code generation
const H = {
  wrapN(v, w, signed) { const m = 2 ** w; let r = v - Math.floor(v / m) * m; if (signed && r >= m / 2) r -= m; return r; },
  bw(op, a, b) {
    const P = 4294967296, al = a >>> 0, bl = b >>> 0, ah = Math.floor(a / P) | 0, bh = Math.floor(b / P) | 0;
    let lo, hi;
    if (op === 0) { lo = (al & bl) >>> 0; hi = ah & bh; } else if (op === 1) { lo = (al | bl) >>> 0; hi = ah | bh; } else { lo = (al ^ bl) >>> 0; hi = ah ^ bh; }
    return hi * P + lo;
  },
};
const fitsI32 = (T) => (T.signed ? T.w <= 32 : T.w <= 31);
const numLit = (v) => { const n = Number(v); return n < 0 || Object.is(n, -0) ? `(${n === 0 ? 0 : n})` : String(n); };
const bigLit = (v) => `${BigInt(v)}n`;
function wrNum(x, T) {
  const w = T.w;
  if (w <= 31) return T.signed ? `((${x}) << ${32 - w} >> ${32 - w})` : `((${x}) & ${2 ** w - 1})`;
  if (w === 32) return T.signed ? `((${x}) | 0)` : `((${x}) >>> 0)`;
  return `wrapN(${x}, ${w}, ${!!T.signed})`;
}
const wrBig = (x, T) => `BigInt.as${T.signed ? "Int" : "Uint"}N(${T.w}, ${x})`;
const CMP = { eq: "===", ne: "!==", lt: "<", le: "<=", gt: ">", ge: ">=" };

// Generate { edge, comb, wave } for one domain graph. `plan` names the observers (see Sim._buildDomain).
export function genDomain(g, plan = {}) {
  const nodes = g.nodes;
  const order = g.topo();
  const isB = (id) => isBig(nodes[id].type);
  const S = (id) => (isB(id) ? "B" : "F");
  const E = (id, big) => (isB(id) === big ? `n${id}` : big ? `BigInt(n${id})` : `Number(n${id})`);
  const T = (id) => (isB(id) ? `(n${id} !== 0n)` : `(n${id} !== 0)`);
  const res = (x, R) => (isBig(R) ? x : `Number(${x})`);
  const tables = [];
  const memIdx = new Map();
  for (const n of nodes) if (n && n.op === "mem") memIdx.set(n.id, memIdx.size);
  const body = [];
  const loads = (id) => `const n${id} = ${S(id)}[${id}];`;

  function expr(n) {
    const R = n.type, A = n.args, Rb = isBig(R), op = n.op;
    const anyB = A.some(isB), big = Rb || anyB;
    switch (op) {
      case "add": case "sub": case "mul": case "neg": {
        if (big) {
          const a = E(A[0], true), b = A[1] != null ? E(A[1], true) : null;
          return res(op === "add" ? `(${a} + ${b})` : op === "sub" ? `(${a} - ${b})` : op === "mul" ? `(${a} * ${b})` : `(-${a})`, R);
        }
        const a = `n${A[0]}`, b = `n${A[1]}`;
        return op === "add" ? `(${a} + ${b})` : op === "sub" ? `(${a} - ${b})` : op === "mul" ? `(${a} * ${b} + 0)` : `(0 - ${a})`;
      }
      case "and": case "or": case "xor": case "not": {
        const W = R.w, sym = { and: "&", or: "|", xor: "^" }[op];
        if (big || W > 53) {
          const P = (id) => `BigInt.asUintN(${W}, ${E(id, true)})`;
          const r = op === "not" ? `(~${E(A[0], true)})` : `(${P(A[0])} ${sym} ${P(A[1])})`;
          return res(wrBig(r, R), R);
        }
        if (W <= 32) return wrNum(op === "not" ? `~n${A[0]}` : `n${A[0]} ${sym} n${A[1]}`, R);
        return wrNum(op === "not" ? `(-n${A[0]} - 1)` : `bw(${{ and: 0, or: 1, xor: 2 }[op]}, n${A[0]}, n${A[1]})`, R);
      }
      case "shl": {
        const kn = nodes[A[1]];
        if (kn.op === "const") {
          const k = Number(kn.attrs.value);
          if (k >= R.w) return Rb ? "0n" : "0";
          if (big) return res(wrBig(`(${E(A[0], true)} << ${k}n)`, R), R);
          return wrNum(`n${A[0]} * ${2 ** k}`, R);
        }
        if (big) return res(`(${E(A[1], true)} >= ${R.w}n ? 0n : ${wrBig(`(${E(A[0], true)} << ${E(A[1], true)})`, R)})`, R);
        return `(n${A[1]} >= ${R.w} ? 0 : ${wrNum(`n${A[0]} * Math.pow(2, n${A[1]})`, R)})`;
      }
      case "shr": {
        const kn = nodes[A[1]];
        if (big) return res(`(${E(A[0], true)} >> ${kn.op === "const" ? bigLit(kn.attrs.value) : E(A[1], true)})`, R);
        if (kn.op === "const") {
          const k = Number(kn.attrs.value);
          if (k === 0) return `n${A[0]}`;
          if (fitsI32(nodes[A[0]].type) && k < 32) return `(n${A[0]} >> ${k})`;
          if (k >= 64) return `(n${A[0]} < 0 ? -1 : 0)`;
          return `Math.floor(n${A[0]} / ${2 ** k})`;
        }
        return `(n${A[1]} >= 64 ? (n${A[0]} < 0 ? -1 : 0) : Math.floor(n${A[0]} / Math.pow(2, n${A[1]})))`;
      }
      case "eq": case "ne": case "lt": case "le": case "gt": case "ge":
        if (isB(A[0]) !== isB(A[1])) return `(${E(A[0], true)} ${CMP[op]} ${E(A[1], true)} ? 1 : 0)`;
        return `(n${A[0]} ${CMP[op]} n${A[1]} ? 1 : 0)`;
      case "land": return `(${T(A[0])} && ${T(A[1])} ? 1 : 0)`;
      case "lor": return `(${T(A[0])} || ${T(A[1])} ? 1 : 0)`;
      case "lnot": return `(${T(A[0])} ? 0 : 1)`;
      case "mux": return `(${T(A[0])} ? ${E(A[1], Rb)} : ${E(A[2], Rb)})`;
      case "wrap":
        if (Rb) return wrBig(E(A[0], true), R);
        if (isB(A[0])) return `Number(${wrBig(`n${A[0]}`, R)})`;
        return wrNum(`n${A[0]}`, R);
      case "sat": {
        const lo = R.signed ? -(2n ** BigInt(R.w - 1)) : 0n, hi = R.signed ? 2n ** BigInt(R.w - 1) - 1n : 2n ** BigInt(R.w) - 1n;
        if (big) { const x = E(A[0], true); return res(`(${x} < ${lo}n ? ${lo}n : ${x} > ${hi}n ? ${hi}n : ${x})`, R); }
        const x = `n${A[0]}`, L = numLit(lo), Hh = numLit(hi);
        return `(${x} < ${L} ? ${L} : ${x} > ${Hh} ? ${Hh} : ${x})`;
      }
      case "slice": case "field": {
        let lo = n.attrs.lo;
        if (lo == null && op === "field") lo = fieldLo(nodes[A[0]].type, n.attrs.name);
        lo = lo || 0;
        if (big) return res(wrBig(`(${E(A[0], true)} >> ${lo}n)`, R), R);
        if (fitsI32(nodes[A[0]].type) && lo < 32) return wrNum(lo ? `n${A[0]} >> ${lo}` : `n${A[0]}`, R);
        return wrNum(lo ? `Math.floor(n${A[0]} / ${2 ** lo})` : `n${A[0]}`, R);
      }
      case "zext": case "sext": return E(A[0], Rb);
      case "concat": case "pack": {
        const parts = catParts(n, nodes);
        const allNum = !big && R.w <= 53;
        if (allNum) {
          const terms = parts.map(({ id, off, w }) => {
            const AT = nodes[id].type;
            const p = !AT.signed && AT.w <= w ? `n${id}` : wrNum(`n${id}`, { w, signed: false });
            return off ? `${p} * ${2 ** off}` : p;
          });
          const sum = `(${terms.join(" + ") || "0"})`;
          return R.signed ? wrNum(sum, R) : sum;
        }
        const terms = parts.map(({ id, off, w }) => `(BigInt.asUintN(${w}, ${E(id, true)}) << ${off}n)`);
        const x = `(${terms.join(" | ") || "0n"})`;
        return res(R.signed ? wrBig(x, R) : x, R);
      }
      case "rom": {
        const tb = (n.attrs.table || []).map((v) => { const x = typeof v === "object" && v !== null ? encode(v, R) : v; return Rb ? BigInt(wrapTo(x, R)) : Number(wrapTo(x, R)); });
        const k = tables.push(Rb ? tb : Float64Array.from(tb)) - 1;
        const i = E(A[0], false);
        return `(${i} >= 0 && ${i} < ${tb.length} ? TBL[${k}][${i}] : ${Rb ? "0n" : "0"})`;
      }
      case "index": {
        const V = nodes[A[0]].type, ew = V.elem ? V.elem.w : R.w, cnt = V.n ?? Math.floor(V.w / ew);
        const i = E(A[1], false);
        if (isB(A[0]) || Rb) return `(${i} < ${cnt} ? ${res(wrBig(`(${E(A[0], true)} >> (BigInt(${i}) * ${ew}n))`, R), R)} : ${Rb ? "0n" : "0"})`;
        return `(${i} < ${cnt} ? ${wrNum(`Math.floor(n${A[0]} / Math.pow(2, ${i} * ${ew}))`, R)} : 0)`;
      }
      default: throw new Error(`the simulator has no rule for ${op} (%${n.id})`);
    }
  }

  // one statement per node: [compute, store]; only probes/outs a poke forced carry the force check
  const forceable = plan.forced || new Set();
  const stmt = new Map();
  for (const id of order) {
    const n = nodes[id];
    switch (n.op) {
      case "in": case "reg": case "memrd": case "cell": stmt.set(id, [loads(id), ""]); break;
      case "const": stmt.set(id, [`const n${id} = ${isB(id) ? bigLit(n.attrs.value) : numLit(n.attrs.value)};`, ""]); break;
      case "mem": case "memwr": break;
      case "out": case "probe": stmt.set(id, [forceable.has(id) ? `const n${id} = FM[${id}] ? ${isB(id) ? "BV" : "FV"}[${id}] : ${E(n.args[0], isB(id))};` : `const n${id} = ${E(n.args[0], isB(id))};`, `${S(id)}[${id}] = n${id};`]); break;
      default: stmt.set(id, [`const n${id} = ${expr(n)};`, `${S(id)}[${id}] = n${id};`]);
    }
  }
  for (const id of order) { const st = stmt.get(id); if (st) body.push(st[1] ? `${st[0]} ${st[1]}` : st[0]); }
  // the lean edge computes only the cone that state, observers, cells and crossings need, and stores only
  // what is read from outside between edges (settle() recomputes everything for peeks)
  const need = new Set(), stack = [...(plan.roots || [])];
  for (const n of nodes) if (n) {
    if (n.op === "reg" && n.attrs.next != null) stack.push(n.attrs.next);
    if (n.op === "memrd" || n.op === "memwr") stack.push(...n.args.slice(1));
  }
  for (const a of plan.asserts || []) stack.push(a.node);
  for (const q of plan.irqs || []) stack.push(q.node);
  for (const f of plan.fires || []) stack.push(f.v, f.r, f.d);
  for (const d of plan.drops || []) stack.push(d.node);
  for (const p of plan.pins || []) stack.push(p.node);
  while (stack.length) { const id = stack.pop(); if (id == null || need.has(id) || !nodes[id]) continue; need.add(id); for (const a of nodes[id].args) stack.push(a); }
  const store = new Set(plan.store || []);
  for (const f of plan.fires || []) { store.add(f.v); store.add(f.r); store.add(f.d); }
  const lean = [];
  for (const id of order) { if (!need.has(id)) continue; const st = stmt.get(id); if (st) lean.push(store.has(id) && st[1] ? `${st[0]} ${st[1]}` : st[0]); }
  const live = (id) => id != null && nodes[id] && nodes[id].op !== "mem" && nodes[id].op !== "memwr";
  // observers
  const obs = [];
  for (const a of plan.asserts || []) if (live(a.node)) obs.push(a.kind === "cover" ? `if (${T(a.node)}) X.cv(${a.k});` : `if (!${T(a.node)}) X.af(${a.k});`);
  for (const q of plan.irqs || []) if (live(q.node)) obs.push(`if (${T(q.node)}) X.irq(${q.k});`);
  for (const f of plan.fires || []) if (live(f.v) && live(f.r)) obs.push(`if (${T(f.v)} && ${T(f.r)}) X.fire(${f.k}, ${live(f.d) ? `n${f.d}` : 0});`);
  for (const d of plan.drops || []) if (live(d.node)) obs.push(`if (${T(d.node)}) X.drop(${d.k});`);
  for (const p of plan.pins || []) if (live(p.node)) obs.push(`if (n${p.node} !== PV[${p.k}]) { PV[${p.k}] = n${p.node}; X.pin(${p.k}, n${p.node}); }`);
  // commit: registers, then memories (read-first unless the memory says write-first)
  const commit = ["let ch = 0, nv;"];
  const presc = plan.presc || new Set();
  for (const n of nodes) {
    if (!n || n.op !== "reg" || n.attrs.next == null || !nodes[n.attrs.next]) continue;
    const nx = n.attrs.next, R = n.type, NT = nodes[nx].type;
    let x = E(nx, isBig(R));
    if (NT.w !== R.w || !!NT.signed !== !!R.signed) x = isBig(R) ? wrBig(E(nx, true), R) : isB(nx) ? `Number(${wrBig(`n${nx}`, R)})` : wrNum(`n${nx}`, R);
    if (presc.has(n.id)) commit.push(`${S(n.id)}[${n.id}] = ${x};`);
    else commit.push(`nv = ${x}; if (${S(n.id)}[${n.id}] !== nv) { ${S(n.id)}[${n.id}] = nv; ch = 1; }`);
  }
  for (const [memId, k] of memIdx) {
    const m = nodes[memId], ET = m.attrs.elem || m.type, EB = isBig(ET), words = m.attrs.words ?? 0;
    const rds = nodes.filter((x) => x && x.op === "memrd" && x.args[0] === memId);
    const wrs = nodes.filter((x) => x && x.op === "memwr" && x.args[0] === memId);
    const rd = rds.map((r) => { const [, a, en] = r.args; const ad = en != null ? E(a, false) : "0";
      return `if (${en != null ? T(en) : "true"}) { const a = ${ad}; nv = a >= 0 && a < ${words} ? M${k}[a] : ${isB(r.id) ? "0n" : "0"}; ${isB(r.id) !== EB ? `nv = ${isB(r.id) ? "BigInt(nv)" : "Number(nv)"};` : ""} if (${S(r.id)}[${r.id}] !== nv) { ${S(r.id)}[${r.id}] = nv; ch = 1; } }`; });
    const wr = wrs.map((w) => { const [, a, d, en] = w.args;
      let dv = E(d, EB); const DT = nodes[d].type; if (DT.w !== ET.w || !!DT.signed !== !!ET.signed) dv = EB ? wrBig(E(d, true), ET) : wrNum(E(d, false), ET);
      return `if (${en != null ? T(en) : "true"}) { const a = ${E(a, false)}; if (a >= 0 && a < ${words}) { nv = ${dv}; if (M${k}[a] !== nv) { M${k}[a] = nv; ch = 1; } } }`; });
    commit.push(...(m.attrs.rdw === "write-first" ? [...wr, ...rd] : [...rd, ...wr]));
  }
  const memDecl = [...memIdx.values()].map((k) => `const M${k} = M[${k}];`).join(" ");
  const waveLines = (plan.waves || []).filter((w) => live(w.node)).map((w) => `v = ${S(w.node)}[${w.node}]; if (v !== W[${w.k}]) { W[${w.k}] = v; X.rec(${w.k}, v); }`);
  const src = `"use strict";
const { wrapN, bw } = H;
const NOX = { fm: new Uint8Array(${nodes.length}), fv: null, bv: null };
function edge(F, B, M, X) {
  const PV = X.pv, FM = X.fm, FV = X.fv, BV = X.bv; ${memDecl}
  ${body.join("\n  ")}
  ${obs.join("\n  ")}
  if (X.on) X.tick();
  ${commit.join("\n  ")}
  return ch;
}
function edgeLean(F, B, M, X) {
  const PV = X.pv, FM = X.fm, FV = X.fv, BV = X.bv; ${memDecl}
  ${lean.join("\n  ")}
  ${obs.join("\n  ")}
  if (X.on) X.tick();
  ${commit.join("\n  ")}
  return ch;
}
function comb(F, B, M, X = NOX) {
  const FM = X.fm, FV = X.fv, BV = X.bv; ${memDecl}
  ${body.join("\n  ")}
}
function wave(F, B, W, X) { let v;
  ${waveLines.join("\n  ")}
}
return { edge, edgeLean, comb, wave };`;
  let fns;
  try { fns = new Function("H", "TBL", src)(H, tables); } catch (e) { throw new Error(`domain ${g.domain}: generated code does not compile: ${e.message}`); }
  return { ...fns, src, memIdx, order, lean: need.size };
}
function fieldLo(T, name) {
  if (!T || T.k !== "struct") return 0;
  let off = T.w;
  for (const [n, FT] of T.fields) { off -= FT.w; if (n === name) return off; }
  return 0;
}
// operand placement of concat/pack: concat and struct pack are most significant first; vec pack is element 0 first
function catParts(n, nodes) {
  const R = n.type, A = n.args;
  if (n.op === "pack" && R.k === "vec") { const ew = R.elem.w; return A.map((id, i) => ({ id, off: i * ew, w: ew })); }
  const ws = A.map((id, i) => (n.op === "pack" && R.k === "struct" && R.fields[i] ? R.fields[i][1].w : nodes[id].type.w));
  let off = ws.reduce((a, b) => a + b, 0);
  return A.map((id, i) => { off -= ws[i]; return { id, off, w: ws[i] }; });
}

// ---------------------------------------------------------------- prescaler analysis
// The values of a counter that any logic can tell apart: constants it is compared against (and both sides of
// a threshold), 0 and its maximum. Between two of them every cycle behaves alike, so they can be skipped.
function analyzePrescaler(g, reg) {
  const nodes = g.nodes, P = reg.id, T = reg.type;
  if (T.signed || T.w > 52) return null;
  const special = new Set([0, 2 ** T.w - 1]);
  const memo = new Map();
  const selfOnly = (id, depth = 0) => {
    if (id === reg.attrs.next) return true;
    if (memo.has(id)) return memo.get(id);
    memo.set(id, false);
    const us = g.users(id);
    const ok = depth < 12 && us.length > 0 && us.every((u) => (u === P ? nodes[P].attrs.next === id : nodes[u].op !== "reg" && nodes[u].op !== "out" && selfOnly(u, depth + 1)));
    memo.set(id, ok);
    return ok;
  };
  const constOf = (id) => (nodes[id]?.op === "const" ? Number(nodes[id].attrs.value) : null);
  const visit = (id, depth) => {
    for (const uid of g.users(id)) {
      if (uid === P) continue;
      const u = nodes[uid];
      if (u.op in CMP) {
        const left = u.args[0] === id, other = left ? u.args[1] : u.args[0], c = constOf(other);
        if (c == null) return false;
        const op = left ? u.op : { lt: "gt", le: "ge", gt: "lt", ge: "le", eq: "eq", ne: "ne" }[u.op];
        if (op === "eq" || op === "ne") special.add(c);
        else { const b = op === "lt" || op === "ge" ? c : c + 1; special.add(b); special.add(b - 1); }
        continue;
      }
      if (u.op === "probe" || u.op === "out") continue;
      if ((u.op === "zext" || u.op === "sext") && depth < 3) { if (!visit(uid, depth + 1)) return false; continue; }
      if (selfOnly(uid)) continue;
      return false;
    }
    return true;
  };
  if (!visit(P, 0)) return null;
  const S = Float64Array.from([...special].filter((v) => v >= 0 && v <= 2 ** T.w - 1).sort((a, b) => a - b));
  return {
    id: P, S,
    special(v) { let lo = 0, hi = S.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (S[m] === v) return true; if (S[m] < v) lo = m + 1; else hi = m - 1; } return false; },
    // cycles from value v (moving by d = ±1) until the counter reaches a special value
    dist(v, d) {
      let lo = 0, hi = S.length - 1;
      if (d > 0) { let r = Infinity; while (lo <= hi) { const m = (lo + hi) >> 1; if (S[m] >= v) { r = S[m]; hi = m - 1; } else lo = m + 1; } return r - v; }
      let r = -Infinity; while (lo <= hi) { const m = (lo + hi) >> 1; if (S[m] <= v) { r = S[m]; lo = m + 1; } else hi = m - 1; } return v - r;
    },
  };
}

// ---------------------------------------------------------------- waves
export class Waves {
  constructor(limit = 200_000) { this.limit = limit; this.signals = []; this.byPath = new Map(); this.total = 0; this.version = 0; this.watched = null; this.onWatch = null; }
  // record only these paths (null: every signal up to 53 bits wide); the simulator regenerates its code
  watch(paths) { this.watched = paths ? new Set(paths) : null; this.onWatch?.(); return this; }
  // default: every signal up to 53 bits, except in pixel-clock domains (they change every cycle and would
  // fill the buffer within a frame); watch() them by path to record them
  watching(path, type, video = false) { return this.watched ? this.watched.has(path) : type.w <= 53 && !video; }
  add(path, domain, node, type) {
    const k = this.signals.length;
    this.signals.push({ path, domain, node, type, width: type.w, t: [], v: [] });
    if (!this.byPath.has(path)) this.byPath.set(path, k);
    return k;
  }
  rec(k, t, v) {
    const s = this.signals[k];
    if (s.t.length && s.t[s.t.length - 1] === t) { s.v[s.v.length - 1] = v; return; }
    s.t.push(t); s.v.push(v);
    if (++this.total > this.limit) this.trim();
    this.version++;
  }
  trim() {
    let total = 0;
    for (const s of this.signals) {
      if (s.t.length > 16) { const cut = s.t.length >> 1; s.t.splice(0, cut); s.v.splice(0, cut); }
      total += s.t.length;
    }
    this.total = total;
  }
  clear() { for (const s of this.signals) { const lt = s.t.at(-1), lv = s.v.at(-1); s.t = lt != null ? [lt] : []; s.v = lv != null ? [lv] : []; } this.total = this.signals.length; }
  paths() { return this.signals.map((s) => s.path); }
  signal(path) { const k = typeof path === "number" ? path : this.byPath.get(path); return k == null ? null : this.signals[k]; }
  // [[t, v], …] in ps, starting with the value in force at `from`
  series(path, from = 0, to = Infinity) {
    const s = this.signal(path);
    if (!s) return [];
    const out = [];
    let i = 0;
    while (i < s.t.length && s.t[i] <= from) i++;
    if (i > 0) out.push([from, s.v[i - 1]]);
    for (; i < s.t.length && s.t[i] <= to; i++) out.push([s.t[i], s.v[i]]);
    return out;
  }
  valueAt(path, t) { const s = this.signal(path); if (!s) return undefined; let v; for (let i = 0; i < s.t.length && s.t[i] <= t; i++) v = s.v[i]; return v; }
  span() { let a = Infinity, b = 0; for (const s of this.signals) if (s.t.length) { a = Math.min(a, s.t[0]); b = Math.max(b, s.t.at(-1)); } return { from: a === Infinity ? 0 : a, to: b }; }
}

// ---------------------------------------------------------------- the board
class Terminal {
  constructor(board, id) { this.board = board; this.id = id; this.trans = []; this.cellText = ""; this.rx = []; this.rxBusy = 0; this.decoders = new Map(); this.baud = null; this.sent = ""; }
  attachRx(ctx) { this.rx.push(ctx); }
  cellOut(s) { this.cellText += s; }
  send(text, opts = {}) {
    const sim = this.board.sim;
    const bytes = [...String(text)].map((c) => c.charCodeAt(0) & 255);
    this.sent += text;
    if (this.rx.length) { const ctx = this.rx[0]; CELLS["uart-rx"].enqueue(ctx, bytes); sim._wake(sim.dom[ctx.domain]); return; }
    const res = [`${this.id}.rx`, `${this.id}:rx`].find((r) => this.board.inPins.has(r));
    if (!res) { sim.warn(`uart ${this.id}: nothing receives`); return; }
    const T = 1e12 / (opts.baud ?? this.baud ?? 115_200);
    let t = Math.max(sim.time, this.rxBusy) + T;
    for (const b of bytes) {
      const bits = [0, ...Array.from({ length: 8 }, (_, i) => (b >> i) & 1), 1];
      bits.forEach((lv, i) => sim.at(t + i * T, () => this.board.setInput(res, lv)));
      t += 10 * T;
    }
    this.rxBusy = t;
  }
  line(t, level) { if (!this.trans.length || this.trans.at(-1)[1] !== level) this.trans.push([t, level]); }
  textAt(baud) {
    baud = baud ?? this.baud ?? 115_200;
    let d = this.decoders.get(baud);
    if (!d) this.decoders.set(baud, (d = { pos: 0, t0: null, text: "" }));
    const tr = this.trans, T = 1e12 / baud, nowT = this.board.sim.time;
    const levelAt = (t, from) => { let lv = 1; for (let i = Math.max(0, from - 1); i < tr.length && tr[i][0] <= t; i++) lv = tr[i][1]; return lv; };
    for (;;) {
      if (d.t0 == null) {
        let f = -1;
        for (let i = d.pos; i < tr.length; i++) if (tr[i][1] === 0) { f = i; break; }
        if (f < 0) { d.pos = tr.length; break; }
        d.t0 = tr[f][0]; d.pos = f;
      }
      const end = d.t0 + 9.5 * T;
      if (nowT < end) break;
      let byte = 0;
      for (let b = 0; b < 8; b++) if (levelAt(d.t0 + (1.5 + b) * T, d.pos)) byte |= 1 << b;
      d.text += String.fromCharCode(byte);
      while (d.pos < tr.length && tr[d.pos][0] <= end) d.pos++;
      d.t0 = null;
    }
    return this.cellText + d.text;
  }
  get text() { return this.textAt(); }
}

export class Board {
  constructor(sim) {
    this.sim = sim;
    this.inputs = {}; this.toggles = {}; this.levels = {}; this.terms = {}; this.frames = [];
    this.inPins = new Map(); this.outPins = new Map(); this.holds = {};
    this.audio = { rate: 48_000, data: new Float32Array(1 << 16), at: 0, total: 0, last: 0,
      recent(n = 1024) { const out = new Float32Array(Math.min(n, this.total, this.data.length)); for (let i = 0; i < out.length; i++) out[i] = this.data[(this.at - out.length + i + this.data.length) % this.data.length]; return out; } };
  }
  get profile() { return this.sim.c.board?.profile; }
  get resources() { return this.sim.c.board?.resources || {}; }
  expand(id) { return expand(id); }
  _bind() {
    this.inPins = new Map(); this.outPins = new Map();
    for (const p of this.sim.c.pins || []) {
      const D = this.sim.dom[p.domain] || this.sim._domainOfNode(p.node, p.resource);
      if (!D) continue;
      const m = p.dir === "in" ? this.inPins : this.outPins;
      if (!m.has(p.resource)) m.set(p.resource, []);
      m.get(p.resource).push({ D, id: p.node, bit: p.bit ?? 0 });
    }
    for (const [res, list] of this.inPins) this._applyInput(res, list);
  }
  _applyInput(res, list = this.inPins.get(res) || []) {
    const lv = this.inputs[res] ? 1 : 0;
    for (const { D, id, bit } of list) {
      if (D.forced.has(id)) continue;
      const cur = D.F[id], m = 2 ** bit;
      const has = Math.floor(cur / m) % 2 === 1;
      if (has !== !!lv) D.F[id] = cur + (lv ? m : -m);
    }
  }
  setInput(res, level) {
    level = level ? 1 : 0;
    if ((this.inputs[res] ?? 0) === level) return;
    this.inputs[res] = level;
    this._applyInput(res);
    this.sim._inputChanged();
  }
  input(res) { return this.inputs[res] ?? 0; }
  read(res) {
    if (this.outPins.has(res)) {
      this.sim.settle();
      const { D, id, bit } = this.outPins.get(res)[0];
      return bitOf(D.big[id] ? D.B[id] : D.F[id], bit);
    }
    return this.inputs[res] ?? 0;
  }
  value(id) { return this.expand(id).reduce((acc, r, i) => acc + (this.read(r) ? 2 ** i : 0), 0); }
  get pins() { const o = {}; for (const r of new Set([...Object.keys(this.resources), ...this.inPins.keys(), ...this.outPins.keys()])) o[r] = this.read(r); return o; }
  leds() { return Object.keys(this.pins).filter((r) => /^led/.test(r)).sort((a, b) => (+a.split(":")[1] || 0) - (+b.split(":")[1] || 0)).map((r) => this.read(r)); }
  set(id, v) {
    const rs = this.expand(id);
    if (rs.length === 1) { this.setInput(rs[0], typeof v === "boolean" ? +v : v ? 1 : 0); return; }
    rs.forEach((r, i) => this.setInput(r, Math.floor(Number(v) / 2 ** i) % 2));
  }
  toggle(id) { for (const r of this.expand(id)) this.setInput(r, this.input(r) ? 0 : 1); }
  // a press: level 1 now (with chatter for `bounce`), released after `for` (default 50 ms; `hold: true` keeps it down)
  press(id, opts = {}) {
    const sim = this.sim, bounce = opts.bounce ? toPs(opts.bounce) : 0;
    const hold = opts.hold || opts.for === Infinity ? null : toPs(opts.for ?? "50ms");
    for (const r of this.expand(id)) {
      this._chatter(r, 1, sim.time, bounce);
      if (hold != null) { const t = sim.time + hold; sim.at(t, () => this._chatter(r, 0, t, bounce)); }
    }
    return hold == null ? 0 : hold;
  }
  release(id, opts = {}) { const b = opts.bounce ? toPs(opts.bounce) : 0; for (const r of this.expand(id)) this._chatter(r, 0, this.sim.time, b); }
  _chatter(res, level, t, bounce) {
    const sim = this.sim;
    if (!bounce) { if (t <= sim.time) this.setInput(res, level); else sim.at(t, () => this.setInput(res, level)); return; }
    const n = 3 + Math.floor(sim.rng() * 4);
    const times = Array.from({ length: n }, () => t + sim.rng() * bounce).sort((a, b) => a - b);
    this.setInput(res, level);
    times.forEach((tt, i) => sim.at(tt, () => this.setInput(res, i % 2 === 0 ? 1 - level : level)));
    sim.at(t + bounce, () => this.setInput(res, level));
  }
  uart(id = "uart") { id = termId(id); return (this.terms[id] ||= new Terminal(this, id)); }
  pushFrame(f) { this.frames.push(f); if (this.frames.length > 2) this.frames.shift(); }
  lastFrame() { return this.frames.at(-1) || null; }
  audioPush(v, t) { const a = this.audio; a.data[a.at] = v; a.at = (a.at + 1) % a.data.length; a.total++; a.last = t; }
  _pin(D, k, v) {
    const w = D.pinWatch[k], t = this.sim.time;
    for (const { res, bit } of w.res) {
      const lv = bitOf(v, bit), prev = this.levels[res];
      if (prev === undefined) this.levels[res] = lv;
      else if (lv !== prev) { this.levels[res] = lv; this.toggles[res] = (this.toggles[res] || 0) + 1; }
      if (/[.:]tx$/.test(res)) this.uart(termId(res)).line(t, lv);
    }
  }
  save() { return { inputs: { ...this.inputs }, toggles: { ...this.toggles }, levels: { ...this.levels } }; }
  restore(s) { this.inputs = { ...s.inputs }; this.toggles = { ...s.toggles }; this.levels = { ...s.levels }; for (const r of this.inPins.keys()) this._applyInput(r); }
}
function bitOf(v, bit) {
  if (typeof v === "bigint") return Number((v >> BigInt(bit)) & 1n);
  return bit < 31 ? (v >> bit) & 1 : Math.floor(v / 2 ** bit) & 1;
}

// ---------------------------------------------------------------- the simulator
export class Sim {
  constructor(compiled, opts = {}) {
    this.opts = { seed: 1, waves: true, ...opts };
    this.seed = this.opts.seed;
    this.rng = mulberry32(this.seed * 2654435761);
    this.time = 0;
    this.listeners = new Map();
    this.logLines = [];
    this.warnings = [];
    this.waves = new Waves(this.opts.waveLimit ?? 200_000);
    this.wavesOn = this.opts.waves !== false;
    this.waves.onWatch = () => { for (const D of this.doms || []) this._regen(D); };
    this.board = new Board(this);
    this._events = [];
    this._deferred = []; this._inEdge = false;
    this._wakeKeys = new Set();
    this._wall = 0; this.edges = 0; this.skipped = 0;
    this.resets = {}; this.escalations = []; this.hung = new Map(); this.irqLog = [];
    this._groupLog = {};
    this._load(compiled);
  }

  // ---------- building
  _load(c, carry = null) {
    this.c = this.compiled = c;
    this.doms = []; this.dom = {}; this._linked = false;
    for (const t of Object.values(this.board.terms)) t.rx = [];
    this.paths = new Map();
    const entries = Object.entries(c.domains || {});
    if (!entries.length) throw new Error("this design has no clock domains to simulate");
    // compile domains first (observer plans need the stream/assert/pin lists)
    entries.forEach(([name, d], i) => {
      const D = { name, idx: i, hz: d.hz || c.board?.mainHz || 1e8, g: d.graph };
      D.period = 1e12 / D.hz;
      this.doms.push(D); this.dom[name] = D;
      for (const n of D.g.nodes) if (n && n.attrs?.path && n.op !== "const") {
        if (!this.paths.has(n.attrs.path)) this.paths.set(n.attrs.path, []);
        this.paths.get(n.attrs.path).push({ D, id: n.id, op: n.op });
      }
    });
    this.main = this.dom[c.board?.mainDomain] || this.dom.sys || this.doms.find((D) => Math.abs(D.hz - (c.board?.mainHz || 0)) < 1) || this.doms[0];
    // streams
    this.streams = new Map();
    for (const s of c.streams || []) {
      const sg = s.signals || {};
      const D = this.dom[s.domain] || this._domainOfNode(sg.valid, s.name);
      const st = { name: s.name, spec: s, D, fired: 0, dropped: 0, buf: null, type: D?.g.nodes[sg.data]?.type || s.type, k: this.streams.size };
      this.streams.set(s.name, st);
    }
    this.props = (c.asserts || []).map((a, k) => ({ ...a, k, fails: 0, hits: 0, first: null, firstHit: null }));
    this.knobMap = new Map();
    for (const k of c.knobs || []) this.knobMap.set(k.path, { k, D: this.dom[k.domain] || this._domainOfNode(k.node, k.path) });
    for (const D of this.doms) this._buildDomain(D);
    // a stream nobody consumes is drained by an always-ready sink until a testbench throttles it
    for (const st of this.streams.values()) {
      const r = st.spec.signals?.ready, n = st.D?.g.nodes[r];
      if (n && n.op === "in" && n.attrs.src !== "cell" && n.attrs.src !== "cross") st.D.F[r] = 1;
    }
    // cells
    this._cells = [];
    for (const cell of c.cells || []) this._addCell(cell);
    this.board._bind();
    for (const D of this.doms) { D.cycle = Math.floor(this.time / D.period + EPS); D.next = (D.cycle + 1) * D.period; }
    if (carry) carry();
    this._settled = false;
    this.settle();
  }
  _domainOfNode(id, hint = "") {
    const cand = this.doms.filter((D) => id != null && D.g.nodes[id]);
    if (cand.length <= 1) return cand[0] || null;
    return cand.find((D) => String(D.g.nodes[id].attrs?.path || "").startsWith(String(hint).split(".")[0])) || cand[0];
  }
  _buildDomain(D) {
    const g = D.g, N = g.nodes.length, nodes = g.nodes;
    D.F = new Float64Array(N); D.B = new Array(N); D.big = new Uint8Array(N);
    D.forced = new Map(); D.regForced = new Map(); D.dirty = true; D.act = false; D.skip = null;
    D.cells = []; D.drivers = []; D.fires = []; D.nf = 0;
    for (const n of nodes) if (n) {
      const b = isBig(n.type);
      D.big[n.id] = b ? 1 : 0;
      if (b) D.B[n.id] = 0n;
      if (n.op === "const") this._store(D, n.id, n.attrs.value);
      if (n.op === "reg") this._store(D, n.id, initOf(n));
    }
    // memories
    D.memNodes = nodes.filter((n) => n && n.op === "mem");
    D.M = D.memNodes.map((m) => {
      const ET = m.attrs.elem || m.type, words = m.attrs.words || 0, big = isBig(ET);
      const arr = big ? new Array(words).fill(0n) : new Float64Array(words);
      (m.attrs.init || []).forEach((v, i) => { if (i < words) arr[i] = big ? BigInt(encode(v, ET)) : Number(encode(v, ET)); });
      return arr;
    });
    // prescalers
    D.presc = [];
    for (const n of nodes) if (n && n.op === "reg" && n.attrs.prescaler) { const a = analyzePrescaler(g, n); D.presc.push(a ? { ...a, ok: true, v0: 0 } : { id: n.id, ok: false, v0: 0 }); }
    // crossings
    D.cross = nodes.filter((n) => n && n.op === "in" && n.attrs.src === "cross" && n.attrs.from).map((n) => ({ id: n.id, from: n.attrs.from, stages: n.attrs.stages || 2 + Math.floor(this.rng() * 2), pipe: [] }));
    // observers
    const plan = { asserts: [], irqs: [], fires: [], drops: [], pins: [], waves: [], presc: new Set(D.presc.filter((p) => p.ok).map((p) => p.id)) };
    for (const p of this.props) if ((p.domain ? p.domain === D.name : this._domainOfNode(p.node, p.path) === D)) plan.asserts.push({ k: p.k, node: p.node, kind: p.kind });
    D.irqs = [];
    for (const { k, D: KD } of this.knobMap.values()) if (k.kind === "irq" && KD === D) { plan.irqs.push({ k: D.irqs.length, node: k.node }); D.irqs.push(k.path); }
    D.streamList = [];
    for (const st of this.streams.values()) if (st.D === D) {
      const sg = st.spec.signals || {};
      const j = D.streamList.push(st) - 1;
      plan.fires.push({ k: j, v: sg.valid, r: sg.ready, d: sg.data });
      const dn = st.spec.dropped;
      if (dn != null && nodes[dn] && nodes[dn].type.w === 1) plan.drops.push({ k: j, node: dn });
    }
    D.pinWatch = [];
    const byNode = new Map();
    for (const p of this.c.pins || []) {
      if (p.dir !== "out" || !nodes[p.node]) continue;
      if (!((p.domain && p.domain === D.name) || (!p.domain && this._domainOfNode(p.node, p.resource) === D))) continue;
      if (!byNode.has(p.node)) { byNode.set(p.node, D.pinWatch.length); D.pinWatch.push({ node: p.node, res: [] }); plan.pins.push({ k: byNode.get(p.node), node: p.node }); }
      D.pinWatch[byNode.get(p.node)].res.push({ res: p.resource, bit: p.bit ?? 0 });
    }
    D.wk = []; D.wnodes = [];
    for (const n of nodes) if (n && (n.op === "reg" || n.op === "in" || n.op === "out" || n.op === "probe") && n.attrs.path) {
      D.wnodes.push(n.id);
      D.wk.push(this.waves.add(n.attrs.path, D.name, n.id, n.type));
    }
    D.W = new Array(D.wk.length).fill(NaN);
    // nodes read from outside the edge function: cell inputs, crossing sources, stream ends
    plan.store = []; plan.roots = [];
    for (const cell of this.c.cells || []) for (const e of Object.values(cell.io || {})) if ((this.dom[e.domain] || this.dom[cell.domain]) === D && nodes[e.node]) { plan.store.push(e.node); plan.roots.push(e.node); }
    for (const D2 of this.doms) for (const n of D2.g.nodes) if (n && n.op === "in" && n.attrs.src === "cross" && n.attrs.from?.domain === D.name && nodes[n.attrs.from.node]) { plan.store.push(n.attrs.from.node); plan.roots.push(n.attrs.from.node); }
    for (const st of D.streamList) for (const k of ["valid", "data", "ready"]) { const id = st.spec.push?.[k]; if (id != null && nodes[id]) { plan.store.push(id); plan.roots.push(id); } }
    D.plan = plan;
    this._regen(D);
    const sim = this;
    D.X = {
      on: false, pv: new Array(D.pinWatch.length).fill(NaN), fm: new Uint8Array(N), fv: new Float64Array(N), bv: new Array(N),
      af: (k) => sim._fail(D, k), cv: (k) => sim._hit(D, k),
      irq: (k) => { D.act = true; sim._irq(D.irqs[k]); },
      fire: (k, v) => { const st = D.streamList[k]; if (st.taps) D.act = true; D.fires[D.nf++] = st; D.fires[D.nf++] = v; sim._fire(st, v); },
      drop: (k) => { D.streamList[k].dropped++; sim.emit("drop", { stream: D.streamList[k].name, time: sim.time }); },
      pin: (k, v) => { D.act = true; sim.board._pin(D, k, v); },
      tick: () => sim._tick(D),
      rec: (k, v) => sim.waves.rec(D.wk[k], sim.time, v),
    };
    // crossing sources: who samples whom
    D.xsrc = [];
  }
  _linkCrossings() {
    for (const D of this.doms) D.xsrc = [];
    for (const D of this.doms) for (const x of D.cross) {
      const S = this.dom[x.from.domain];
      if (!S) continue;
      let e = S.xsrc.find((s) => s.id === x.from.node);
      if (!e) S.xsrc.push((e = { id: x.from.node, last: NaN, dests: [] }));
      if (!e.dests.includes(D)) e.dests.push(D);
    }
  }
  _store(D, id, v) {
    const T = D.g.nodes[id]?.type;
    if (D.big[id]) D.B[id] = typeof v === "bigint" ? v : BigInt(T && T.k !== "u" && T.k !== "s" ? encode(v, T) : v ?? 0);
    else D.F[id] = typeof v === "object" && v !== null ? Number(encode(v, T)) : Number(v ?? 0);
  }
  _get(D, id) { return D.big[id] ? D.B[id] : D.F[id]; }
  _addCell(cell) {
    const model = CELLS[cell.kind];
    if (!model) { this.warn(`no simulation model for the ${cell.kind} cell ${cell.path}`); return; }
    const sim = this, io = {};
    for (const [key, e] of Object.entries(cell.io || {})) {
      const D = this.dom[e.domain] || this.dom[cell.domain] || this._domainOfNode(e.node, cell.path) || this.main;
      if (!D || !D.g.nodes[e.node]) continue;
      io[key] = { ...e, D, id: e.node, big: D.big[e.node] === 1, T: D.g.nodes[e.node].type };
    }
    const domains = [...new Set([cell.domain, ...Object.values(io).map((e) => e.D.name)].filter((d) => this.dom[d]))];
    if (!domains.length) domains.push(this.main.name);
    const rec = { path: cell.path, kind: cell.kind, model, cell, domains, hung: false };
    const ctx = {
      sim, board: this.board, cell, kind: cell.kind, path: cell.path, params: cell.params || {}, io, state: {}, domain: domains[0],
      get time() { return sim.time; },
      cycle() { return (ctx.D || sim.dom[ctx.domain])?.cycle ?? 0; },
      rng: mulberry32(hashStr(cell.path) ^ (this.seed * 7919)),
      has: (k) => !!io[k],
      get: (k) => { const e = io[k]; return e ? (e.big ? e.D.B[e.id] : e.D.F[e.id]) : 0; },
      set: (k, v) => {
        const e = io[k];
        if (!e || e.D.forced.has(e.id)) return;
        if (e.T.k === "u" || e.T.k === "s") v = wrapTo(typeof v === "boolean" ? +v : v, e.T);
        if (e.big) { v = BigInt(v); if (e.D.B[e.id] === v) return; e.D.B[e.id] = v; }
        else { v = Number(v); if (e.D.F[e.id] === v) return; e.D.F[e.id] = v; }
        e.D.dirty = true; sim._settled = false;
        if (e.D.name !== ctx.domain) sim._wake(e.D);
      },
      typeOf: (k) => io[k]?.T || null,
      // fast paths for per-cycle cells: a reference to a node's slot, and a write that keeps quiescence honest
      ref: (k) => { const e = io[k]; return e ? { A: e.big ? e.D.B : e.D.F, i: e.id, D: e.D, big: e.big, T: e.T } : null; },
      put: (r, v) => { if (r.A[r.i] === v) return; r.A[r.i] = v; r.D.dirty = true; sim._settled = false; if (r.D !== ctx.D) sim._wake(r.D); },
      D: null,
      input: (res) => sim.board.inputs[res] ?? 0,
      wakeAt: (t, dn) => sim._wakeAt(t, sim.dom[dn || ctx.domain]),
      wake: (dn) => sim._wake(sim.dom[dn]),
      emit: (ev, data) => sim.emit(ev, { ...data, cell: cell.path, time: sim.time }),
    };
    rec.ctx = ctx;
    ctx.D = this.dom[domains[0]];
    try { model.init(ctx); } catch (e) { this.warn(`cell ${cell.path}: ${e.message}`); return; }
    this._cells.push(rec);
    for (const dn of domains) { this.dom[dn].cells.push(rec); this.dom[dn].X.on = true; }
  }
  warn(msg) { if (this.warnings.length < 200) this.warnings.push(msg); }

  // ---------- events and listeners
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event)?.delete(fn);
  }
  emit(event, data) {
    if (this._inEdge) { this._deferred.push([event, data]); return; }
    const ls = this.listeners.get(event); if (ls) for (const fn of [...ls]) { try { fn(data); } catch (e) { this.warn(`${event} listener: ${e.message}`); } } const all = this.listeners.get("*"); if (all) for (const fn of all) fn(event, data); }
  log(...args) { const line = { time: this.time, text: args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ") }; this.logLines.push(line); if (this.logLines.length > 2000) this.logLines.shift(); this.emit("log", line); }
  // schedule fn at time t (ps); events run before edges at the same time
  at(t, fn, key = null) {
    if (key) { if (this._wakeKeys.has(key)) return; this._wakeKeys.add(key); }
    const e = { t: Math.max(t, this.time), fn, key };
    const q = this._events;
    let i = q.length;
    while (i > 0 && q[i - 1].t > e.t) i--;
    q.splice(i, 0, e);
  }
  _wakeAt(t, D) { if (!D) return; if (t <= this.time) { this._wake(D); return; } this.at(t, () => this._wake(D), `w:${D.name}:${t}`); }
  _inputChanged() { this._settled = false; for (const D of this.doms) this._wake(D); }

  // ---------- running
  get mainDomain() { return this.main.name; }
  cycle(domain = this.main.name) {
    const D = this.dom[domain] || this.main;
    if (D.skip) return Math.min(D.skip.c0 + D.skip.k, Math.max(D.skip.c0, Math.floor(this.time / D.period + EPS)));
    return D.cycle;
  }
  runFor(dur) { return this.runTo(this.time + toPs(dur)); }
  runTo(tEnd, pred = null) {
    const t0 = now();
    if (!this._linked) { this._linkCrossings(); this._linked = true; }
    const doms = this.doms, ev = this._events;
    let hit = false;
    for (;;) {
      let D = doms[0];
      for (let i = 1; i < doms.length; i++) if (doms[i].next < D.next) D = doms[i];
      if (ev.length && ev[0].t <= D.next && ev[0].t <= tEnd) {
        const e = ev.shift();
        if (e.key) this._wakeKeys.delete(e.key);
        if (e.t > this.time) this.time = e.t;
        e.fn();
        if (pred && pred(this)) { hit = true; break; }
        continue;
      }
      if (D.next > tEnd) break;
      this.time = D.next;
      this._edge(D);
      if (pred && pred(this)) { hit = true; break; }
    }
    if (!hit) this.time = Math.max(this.time, tEnd);
    for (const D of doms) if (D.skip) this._materialize(D, this.time, true);
    this._settled = false;
    this._wall += now() - t0;
    return hit;
  }
  runUntil(pred, limit = "1s") { return this.runTo(this.time + toPs(limit), pred); }
  step(n = 1, domain = this.main.name) {
    const D = this.dom[domain] || this.main;
    const target = this.cycle(D.name) + n;
    this.runTo(target * D.period);
    return this;
  }
  // real-time driving for the UI: simulate wallMs × speed of sim time within roughly wallMs of compute
  advance(wallMs, speed = 1) {
    const t0 = now(), start = this.time, target = this.time + wallMs * speed * 1e9;
    let chunk = Math.max(this.main.period * 64, Math.min(target - this.time, (this._chunk ?? 1e8)));
    while (this.time < target) {
      const c0 = now();
      this.runTo(Math.min(target, this.time + chunk));
      const dt = now() - c0;
      if (dt < 2) chunk *= 2; else if (dt > 8) chunk = Math.max(this.main.period * 16, chunk / 2);
      if (now() - t0 > wallMs * 0.8) break;
    }
    this._chunk = chunk;
    const wall = now() - t0, simMs = (this.time - start) / 1e9;
    return { simMs, wallMs: wall, speed: simMs / Math.max(wallMs, 1e-3), done: this.time >= target };
  }
  _edge(D) {
    const F = D.F;
    D.skip = null;
    const XC = D.cross;
    for (let i = 0; i < XC.length; i++) {
      const x = XC[i], S = x.S || (x.S = this.dom[x.from.domain]);
      if (!S) continue;
      const v = S.big[x.from.node] ? S.B[x.from.node] : S.F[x.from.node], p = x.pipe;
      if (p.length < x.stages) { const cur = this._get(D, x.id); while (p.length < x.stages) p.push(cur); }
      const out = p[0], last = p.length - 1;
      let still = out === v;
      for (let j = 0; j < last; j++) { const y = p[j + 1]; p[j] = y; if (y !== out) still = false; }
      p[last] = v;
      if (!still || out !== (D.big[x.id] ? D.B[x.id] : F[x.id])) D.act = true;
      if (!D.forced.has(x.id)) { if (D.big[x.id]) D.B[x.id] = out; else F[x.id] = out; }
    }
    if (D.forced.size) for (const [id, v] of D.forced) { if (D.big[id]) D.B[id] = v; else F[id] = v; }
    D.act = D.act || D.dirty; D.dirty = false;
    D.nf = 0;
    const P = D.presc;
    for (let i = 0; i < P.length; i++) P[i].v0 = F[P[i].id];
    this._inEdge = true;
    const ch = D.edge(F, D.B, D.M, D.X);
    this._inEdge = false;
    D.cycle++;
    this.edges++;
    if (D.regForced.size) for (const [id, v] of D.regForced) { if (D.big[id]) D.B[id] = v; else F[id] = v; }
    if (this.wavesOn) D.wave(F, D.B, D.W, D.X);
    for (const s of D.xsrc) { const v = this._get(D, s.id); if (v !== s.last) { s.last = v; for (const d2 of s.dests) this._wake(d2); } }
    if (this._deferred.length) { const q = this._deferred; this._deferred = []; for (const [ev, data] of q) this.emit(ev, data); }
    const quiet = !ch && !D.act && !D.dirty;
    D.act = false;
    if (quiet) this._trySkip(D);
    if (!D.skip) D.next = (D.cycle + 1) * D.period;
  }
  _trySkip(D) {
    let k = Infinity;
    const moving = [];
    for (const p of D.presc) {
      const v1 = D.F[p.id], v0 = p.v0;
      if (v1 === v0) continue;
      if (!p.ok) return;
      const d = v1 - v0;
      if ((d !== 1 && d !== -1) || p.special(v0)) return;
      k = Math.min(k, p.dist(v1, d));
      moving.push({ id: p.id, v1, d });
    }
    if (k < 2) return;
    for (const x of D.cross) for (let j = 1; j < x.pipe.length; j++) if (x.pipe[j] !== x.pipe[0]) return;
    D.skip = { c0: D.cycle, k, moving, fires: D.fires.slice(0, D.nf) };
    if (k === Infinity) { D.next = Infinity; return; }
    for (const m of moving) D.F[m.id] = m.v1 + k * m.d;
    D.cycle += k;
    this.skipped += k;
    D.next = (D.cycle + 1) * D.period;
  }
  // end a skip at time t: edges strictly before t (or up to and including t) count as done
  _materialize(D, t, inclusive) {
    const s = D.skip;
    if (!s) return;
    const e = inclusive ? Math.floor(t / D.period + EPS) : Math.ceil(t / D.period - EPS) - 1;
    const done = Math.min(s.c0 + s.k, Math.max(s.c0, e));
    if (s.k !== Infinity) this.skipped -= s.c0 + s.k - done;
    else this.skipped += done - s.c0;
    D.cycle = done;
    for (const m of s.moving) D.F[m.id] = m.v1 + (done - s.c0) * m.d;
    // every skipped cycle repeated the quiet edge exactly, including the beats it delivered
    const n = done - s.c0;
    if (n > 0) for (let i = 0; i < s.fires.length; i += 2) {
      const st = s.fires[i], v = s.fires[i + 1];
      if (!st.buf) st.buf = ringOf(st.type);
      for (let j = 0, m = Math.min(n, RING); j < m; j++) st.buf[(st.fired + j) & (RING - 1)] = v;
      st.fired += n;
    }
    D.skip = null;
    D.next = (D.cycle + 1) * D.period;
    if (this.wavesOn) D.wave(D.F, D.B, D.W, D.X);
  }
  _wake(D) {
    if (!D) return;
    D.dirty = true;
    if (D.skip) this._materialize(D, this.time, false);
  }
  _tick(D) {
    for (const c of D.cells) {
      if (c.hung) continue;
      c.ctx.domain = D.name; c.ctx.D = D;
      if (c.model.tick(c.ctx)) D.act = true;
    }
    for (let i = 0; i < D.drivers.length; i++) {
      const d = D.drivers[i];
      if (d.tick()) D.act = true;
      if (d.done) { D.drivers.splice(i--, 1); d.finish?.(); }
    }
    D.X.on = D.cells.length > 0 || D.drivers.length > 0;
  }
  settle() {
    if (this._settled) return;
    for (const D of this.doms) {
      if (D.forced.size) for (const [id, v] of D.forced) { if (D.big[id]) D.B[id] = v; else D.F[id] = v; }
      D.comb(D.F, D.B, D.M, D.X);
    }
    this._settled = true;
  }

  // ---------- observation hooks
  _fail(D, k) {
    const p = this.props[k];
    p.fails++;
    if (!p.first) p.first = { time: this.time, cycle: D.cycle + 1 };
    if (p.fails <= 20) this.emit(p.kind === "assume" ? "assume" : "assert", { time: this.time, cycle: D.cycle + 1, path: p.path, name: p.name, kind: p.kind, domain: D.name, line: p.line });
  }
  _hit(D, k) { const p = this.props[k]; p.hits++; if (!p.firstHit) { p.firstHit = { time: this.time, cycle: D.cycle + 1 }; this.emit("cover", { time: this.time, path: p.path, name: p.name }); } }
  _irq(path) { const e = { path, time: this.time }; this.irqLog.push(e); if (this.irqLog.length > 5000) this.irqLog.splice(0, 1000); this.emit("irq", e); }
  _fire(st, v) {
    if (!st.buf) st.buf = ringOf(st.type);
    st.buf[st.fired & (RING - 1)] = v;
    st.fired++;
    if (st.taps) for (const f of st.taps) f(v);
  }

  // ---------- paths, peek, poke
  resolve(path, prefer = ["out", "reg", "probe", "in", "memrd", "cell"]) {
    let base = String(path);
    const sel = [];
    while (!this.paths.has(base)) {
      const m = base.match(/^(.*)(?:\[(\d+)\]|\.([A-Za-z_$][\w$]*))$/);
      if (!m) return null;
      sel.unshift(m[2] != null ? +m[2] : m[3]);
      base = m[1];
    }
    const list = this.paths.get(base);
    const hit = prefer.map((op) => list.find((e) => e.op === op)).find(Boolean) || list[0];
    return { ...hit, path: base, sel, node: hit.D.g.nodes[hit.id], type: hit.D.g.nodes[hit.id].type };
  }
  has(path) { return !!this.resolve(path); }
  peek(path) {
    const r = this.resolve(path);
    if (!r) { const st = this._instState(path); if (st) return st; throw new Error(`no signal named ${path}`); }
    this.settle();
    let v = decode(this._get(r.D, r.id), r.type);
    for (const s of r.sel) v = v == null ? v : v[s];
    return v;
  }
  value(domain, id) { this.settle(); const D = this.dom[domain]; return D ? this._get(D, id) : undefined; }
  poke(path, v, opts = {}) {
    const r = this.resolve(path, ["in", "reg", "memrd", "out", "probe"]);
    if (!r) throw new Error(`no signal named ${path}`);
    let raw = encode(v, r.type);
    if (r.sel.length) { const cur = decode(this._get(r.D, r.id), r.type); setIn(cur, r.sel, v); raw = encode(cur, r.type); }
    if (r.op === "in") r.D.forced.set(r.id, r.D.big[r.id] ? BigInt(raw) : Number(raw));
    if (r.op === "out" || r.op === "probe") { r.D.X.fm[r.id] = 1; if (r.D.big[r.id]) r.D.X.bv[r.id] = BigInt(raw); else r.D.X.fv[r.id] = Number(raw); this._forceNode(r.D, r.id, true); }
    if (r.op === "reg" && opts.force) r.D.regForced.set(r.id, r.D.big[r.id] ? BigInt(raw) : Number(raw));
    this._store(r.D, r.id, raw);
    this._settled = false;
    this._wake(r.D);
    return this;
  }
  // a probe or out node is forced through a check that exists only in code generated for it
  _forceNode(D, id, on) {
    D.forcedNodes ||= new Set();
    if (on === D.forcedNodes.has(id)) return;
    if (on) D.forcedNodes.add(id); else D.forcedNodes.delete(id);
    this._regen(D);
  }
  // (re)generate a domain's code: forced probes get a force check; watched signals join the lean cone
  _regen(D) {
    const plan = D.plan, nodes = D.g.nodes;
    plan.forced = D.forcedNodes || new Set();
    plan.waves = [];
    const video = (this.c.cells || []).some((c) => c.kind === "video-timing" && (c.domain === D.name || Object.values(c.io || {}).some((e) => e.domain === D.name)));
    if (this.wavesOn) D.wnodes.forEach((id, k) => { if (this.waves.watching(nodes[id].attrs.path, nodes[id].type, video)) plan.waves.push({ k, node: id }); });
    const w = plan.waves.map((x) => x.node);
    const code = genDomain(D.g, { ...plan, store: [...plan.store, ...w], roots: [...plan.roots, ...w] });
    D.code = code; D.edge = code.edgeLean; D.comb = code.comb; D.wave = code.wave; D.src = code.src;
  }
  release(path) {
    const r = this.resolve(path, ["in", "reg", "probe", "out"]);
    if (!r) return this;
    r.D.forced.delete(r.id); r.D.regForced.delete(r.id); r.D.X.fm[r.id] = 0; if (r.op === "out" || r.op === "probe") this._forceNode(r.D, r.id, false);
    for (const [res, list] of this.board.inPins) if (list.some((p) => p.D === r.D && p.id === r.id)) this.board._applyInput(res, list);
    this._wake(r.D);
    return this;
  }
  _instance(name) { return (this.c.instances || []).find((i) => i.path === name || i.def === name) || null; }
  _instState(name) {
    const inst = this._instance(name), cellRec = this._cells.find((c) => c.path === name);
    const prefix = name + ".";
    const out = {};
    let any = false;
    this.settle();
    for (const [p, list] of this.paths) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.includes(".") && !/^[\w$]+$/.test(rest)) continue;
      const e = ["reg", "out", "in", "probe"].map((op) => list.find((x) => x.op === op)).find(Boolean) || list[0];
      const n = e.D.g.nodes[e.id];
      let v = decode(this._get(e.D, e.id), n.type);
      const states = n.attrs.states || (rest === "state" || n.attrs.fsm ? inst?.states : null);
      if (states && typeof v === "number") v = states[n.attrs.encoding === "onehot" ? Math.log2(v) : v] ?? v;
      if (!(rest in out) || e.op === "reg") out[rest] = v;
      any = true;
    }
    if (cellRec?.model.view) { Object.assign(out, cellRec.model.view(cellRec.ctx.state)); any = true; }
    return any || inst ? out : null;
  }
  state(instance) { const s = this._instState(instance); if (!s) throw new Error(`no instance named ${instance}`); return s; }

  // ---------- streams, knobs
  stream(name) {
    const st = this.streams.get(name);
    if (!st) throw new Error(`no stream named ${name}`);
    const sim = this;
    const xf = this._cells.find((c) => c.kind === "xfifo" && (c.path === name || c.cell.params?.stream === name || c.path.startsWith(name + ".")));
    return {
      name, type: st.type, spec: st.spec,
      get fired() { return st.fired; },
      get dropped() { return sim._dropped(st, xf); },
      get last() { return sim.beats(st, 0, st.fired).map((v) => decode(v, st.type)); },
      tail(n) { return sim.beats(st, st.fired - n, st.fired).map((v) => decode(v, st.type)); },
    };
  }
  // raw beats [from, to) of a stream's log (the last 65 536 are kept)
  beats(st, from, to) {
    from = Math.max(from, st.fired - RING, 0); to = Math.min(to, st.fired);
    const out = [];
    for (let i = from; i < to; i++) out.push(st.buf[i & (RING - 1)]);
    return out;
  }
  _dropped(st, xf) {
    let n = st.dropped;
    const dn = st.spec.dropped;
    if (dn != null && st.D && st.D.g.nodes[dn] && st.D.g.nodes[dn].type.w > 1) { this.settle(); n += Number(this._get(st.D, dn)); }
    if (xf) n += xf.ctx.state.dropped;
    return n;
  }
  knob(path) {
    const e = this.knobMap.get(path);
    if (!e) throw new Error(`no knob named ${path}`);
    const sim = this;
    return { path, info: e.k, get: () => sim._knobGet(e), read: () => sim._knobGet(e), set: (v) => sim._knobSet(e, v) };
  }
  _knobGet(e) { this.settle(); return decode(this._get(e.D, e.k.node), e.D.g.nodes[e.k.node].type); }
  _knobSet(e, v) {
    const T = e.D.g.nodes[e.k.node].type, [lo, hi] = range(T);
    let x = Math.round(Number(v));
    const min = e.k.min ?? lo, max = e.k.max ?? hi;
    x = Math.max(min, Math.min(max, x));
    this._store(e.D, e.k.node, x);
    this._settled = false;
    this._wake(e.D);
    this.emit("knob", { path: e.k.path, value: x, time: this.time });
    return x;
  }
  status(path) { const e = this.knobMap.get(path); if (e) return this._knobGet(e); return this.peek(path); }
  registers() { return (this.c.knobs || []).map((k) => ({ path: k.path, kind: k.kind, addr: k.addr, type: typeName(k.type || this.knobMap.get(k.path)?.D.g.nodes[k.node]?.type), reset: k.reset, min: k.min, max: k.max })); }

  // ---------- supervision: hang, reset, escalate
  hang(instance) {
    const cell = this._cells.find((c) => c.path === instance);
    if (cell) {
      cell.hung = true;
      for (const [key, e] of Object.entries(cell.ctx.io)) if (e.dir === "drive" && /\.(ready|valid)$/.test(key)) { e.D.F[e.id] = 0; e.D.dirty = true; }
    } else {
      for (const D of this.doms) for (const n of D.g.nodes) if (n && n.op === "reg" && inInstance(n, instance)) D.regForced.set(n.id, this._get(D, n.id));
    }
    this.hung.set(instance, this.time);
    this.emit("hang", { instance, time: this.time });
    const grp = (this.c.groups || []).find((g) => (g.children || []).includes(instance));
    const wd = this._watchdogPs(instance, grp);
    this.at(this.time + wd, () => { if (this.hung.has(instance)) this._recover(instance, grp); });
  }
  _watchdogPs(instance, grp) {
    const names = grp ? grp.children : [instance];
    for (const n of names) { const i = this._instance(n); const w = i?.supervise?.watchdog ?? i?.watchdog; if (w) return toPs(w.ms != null ? w.ms : w.after ?? w); }
    return toPs("20ms");
  }
  _recover(instance, grp) {
    const strategy = grp?.strategy || "one-for-one";
    let targets = [instance];
    if (grp && strategy === "all-for-one") targets = grp.children.slice();
    else if (grp && strategy === "rest-for-one") targets = grp.children.slice(Math.max(0, grp.children.indexOf(instance)));
    for (const t of targets) this.reset(t, grp?.name);
    if (grp) {
      const log = (this._groupLog[grp.name] ||= []);
      log.push(this.time);
      const win = grp.window != null ? toPs(grp.window) : Infinity, max = grp.maxResets ?? Infinity;
      const recent = log.filter((t) => this.time - t <= win);
      if (recent.length > max && grp.escalate) {
        const esc = { group: grp.name, agent: grp.escalate, time: this.time, resets: recent.length, instance };
        this.escalations.push(esc);
        this.emit("escalation", esc);
      }
    }
  }
  reset(instance, group = null) {
    const cell = this._cells.find((c) => c.path === instance);
    if (cell) { cell.hung = false; cell.ctx.state = {}; try { cell.model.init(cell.ctx); } catch (e) { this.warn(e.message); } }
    for (const D of this.doms) {
      for (const n of D.g.nodes) if (n && n.op === "reg" && inInstance(n, instance)) { D.regForced.delete(n.id); this._store(D, n.id, initOf(n)); }
      this._wake(D);
    }
    this.hung.delete(instance);
    this.resets[instance] = (this.resets[instance] || 0) + 1;
    this._settled = false;
    this.emit("reset", { instance, group, time: this.time });
  }

  // ---------- testbench drivers (feed, throttle, tb.push / tb.pull)
  _streamEnds(name) {
    const st = this.streams.get(name);
    if (!st) throw new Error(`no stream named ${name}`);
    const sg = st.spec.signals || {}, D = st.D;
    const isIn = (id) => id != null && D && D.g.nodes[id]?.op === "in";
    const src = st.spec.push && isIn(st.spec.push.valid) ? st.spec.push : sg;
    return { st, D, sg, src, canSource: isIn(src.valid) && isIn(src.data), canSink: isIn(sg.ready) };
  }
  source(name, beats, opts = {}) {
    const { st, D, src: sg, canSource } = this._streamEnds(name);
    if (!canSource) throw new Error(`stream ${name} has a producer in the design; it cannot be fed`);
    const q = beats.map((b) => encode(b, st.type));
    const sim = this;
    const drv = {
      kind: "source", name, q, sent: 0, done: false, gap: opts.rate ?? 1,
      tick() {
        let act = false;
        if (D.F[sg.valid] && sim._get(D, sg.ready)) { q.shift(); drv.sent++; act = true; }
        if (!q.length) { D.F[sg.valid] = 0; drv.done = !opts.keep; return act; }
        const v = drv.gap >= 1 || sim.rng() < drv.gap ? 1 : 0;
        if (D.F[sg.valid] !== v) act = true;
        D.F[sg.valid] = v; sim._store(D, sg.data, q[0]);
        return true;
      },
    };
    if (q.length) { D.F[sg.valid] = 1; this._store(D, sg.data, q[0]); }
    D.drivers.push(drv); D.X.on = true; this._wake(D);
    return drv;
  }
  sink(name, opts = {}) {
    const { st, D, sg, canSink } = this._streamEnds(name);
    const sim = this, got = [];
    const p = opts.ready ?? 1, want = opts.count ?? Infinity;
    const drv = {
      kind: "sink", name, got, done: false,
      tick() {
        if (canSink && sim._get(D, sg.valid) && D.F[sg.ready]) got.push(decode(sim._get(D, sg.data), st.type));
        if (got.length >= want) { if (canSink) D.F[sg.ready] = 0; drv.done = true; return true; }
        if (canSink) D.F[sg.ready] = p >= 1 || sim.rng() < p ? 1 : 0;
        return true;
      },
    };
    if (!canSink) { st.taps = st.taps || []; const tap = (v) => { got.push(decode(v, st.type)); if (got.length >= want) { drv.done = true; st.taps = st.taps.filter((x) => x !== tap); if (!st.taps.length) st.taps = null; } }; st.taps.push(tap); return drv; }
    D.F[sg.ready] = p >= 1 ? 1 : 0;
    D.drivers.push(drv); D.X.on = true; this._wake(D);
    return drv;
  }
  random(name) { const st = this.streams.get(name); return randomOf(st.type, this.rng); }

  // ---------- snapshot / restore / reload
  snapshot(opts = {}) {
    return {
      time: this.time,
      doms: this.doms.map((D) => ({ name: D.name, F: D.F.slice(), B: D.B.slice(), M: D.M.map((m) => m.slice()), cycle: this.cycle(D.name), forced: new Map(D.forced), regForced: new Map(D.regForced), cross: D.cross.map((x) => x.pipe.slice()), pv: D.X.pv.slice(), W: D.W.slice(), fm: D.X.fm.slice(), fv: D.X.fv.slice(), bv: D.X.bv.slice() })),
      cells: this._cells.map((c) => ({ path: c.path, hung: c.hung, state: c.model.save ? c.model.save(c.ctx.state) : cloneState(c.ctx.state) })),
      board: this.board.save(),
      streams: [...this.streams.values()].map((s) => ({ name: s.name, fired: s.fired, dropped: s.dropped, buf: s.buf ? s.buf.slice() : null })),
      props: this.props.map((p) => ({ fails: p.fails, hits: p.hits, first: p.first, firstHit: p.firstHit })),
      events: opts.events === false ? null : this._events.slice(), resets: { ...this.resets },
    };
  }
  restore(s) {
    this.time = s.time;
    for (const d of s.doms) {
      const D = this.dom[d.name];
      if (!D || D.F.length !== d.F.length) continue;
      D.F.set(d.F); for (let i = 0; i < d.B.length; i++) D.B[i] = d.B[i]; d.M.forEach((m, i) => { if (D.M[i] && D.M[i].length === m.length) for (let j = 0; j < m.length; j++) D.M[i][j] = m[j]; });
      D.cycle = d.cycle; D.next = (D.cycle + 1) * D.period; D.skip = null; D.dirty = true;
      D.forced = new Map(d.forced); D.regForced = new Map(d.regForced);
      d.cross.forEach((p, i) => { if (D.cross[i]) D.cross[i].pipe = p.slice(); });
      D.X.pv = d.pv.slice(); D.W = d.W.slice(); D.X.fm.set(d.fm); D.X.fv.set(d.fv); D.X.bv = d.bv.slice();
      for (let i = 0; i < d.fm.length; i++) if (d.fm[i] !== (D.forcedNodes?.has(i) ? 1 : 0)) this._forceNode(D, i, d.fm[i] === 1);
    }
    for (const c of s.cells) { const rec = this._cells.find((x) => x.path === c.path); if (!rec) continue; rec.hung = c.hung; if (rec.model.restore) rec.model.restore(rec.ctx.state, c.state); else rec.ctx.state = cloneState(c.state); }
    this.board.restore(s.board);
    for (const x of s.streams) { const st = this.streams.get(x.name); if (st) { st.fired = x.fired; st.dropped = x.dropped; st.buf = x.buf ? x.buf.slice() : null; } }
    s.props.forEach((p, i) => { if (this.props[i]) Object.assign(this.props[i], p); });
    if (s.events) { this._events = s.events.slice(); this._wakeKeys = new Set(this._events.map((e) => e.key).filter(Boolean)); }
    this.resets = { ...s.resets };
    this._settled = false;
    this.emit("restore", { time: this.time });
  }
  // swap in a new compiled design at the current time, carrying registers and memories by path;
  // `migrate: { [module]: old => ({ reg: value }) }` maps a replaced module's old state onto its new registers
  reload(compiled, { migrate = {} } = {}) {
    const old = new Map();
    for (const [p, list] of this.paths) { const e = list.find((x) => x.op === "reg" || x.op === "mem" || x.op === "memrd"); if (e) old.set(p, { op: e.op, type: e.D.g.nodes[e.id].type, v: e.op === "mem" ? e.D.M[e.D.memNodes.findIndex((m) => m.id === e.id)] : this._get(e.D, e.id) }); }
    const oldStates = {};
    for (const m of Object.keys(migrate)) { try { oldStates[m] = this._instState(m); } catch { oldStates[m] = {}; } }
    const oldCells = new Map(this._cells.map((c) => [c.path + "|" + c.kind, c.ctx.state]));
    const streams = new Map([...this.streams].map(([k, s]) => [k, s]));
    const oldDoms = this.doms;
    this._linked = false;
    const watched = this.waves.watched;
    this.waves = new Waves(this.waves.limit);
    this.waves.watched = watched;
    this.waves.onWatch = () => { for (const D of this.doms || []) this._regen(D); };
    this._load(compiled, () => {
      for (const [p, list] of this.paths) {
        const o = old.get(p); if (!o) continue;
        const e = list.find((x) => x.op === o.op); if (!e) continue;
        const T = e.D.g.nodes[e.id].type;
        if (T.w !== o.type.w) continue;
        if (o.op === "mem") { const k = e.D.memNodes.findIndex((m) => m.id === e.id); if (k >= 0 && e.D.M[k].length === o.v.length) e.D.M[k] = o.v.slice(); }
        else this._store(e.D, e.id, o.v);
      }
      for (const [m, fn] of Object.entries(migrate)) {
        let vals = {};
        try { vals = fn(oldStates[m] || {}) || {}; } catch (e) { this.warn(`migrate ${m}: ${e.message}`); }
        for (const [name, v] of Object.entries(vals)) { const r = this.resolve(`${m}.${name}`, ["reg"]); if (r && r.op === "reg") this._store(r.D, r.id, encode(v, r.type)); }
      }
      for (const c of this._cells) { const s = oldCells.get(c.path + "|" + c.kind); if (s) c.ctx.state = Object.assign(c.ctx.state, s); }
      for (const [k, s] of streams) { const st = this.streams.get(k); if (st) { st.fired = s.fired; st.dropped = s.dropped; st.buf = s.buf && isBig(st.type) === Array.isArray(s.buf) ? s.buf : null; if (!st.buf) st.fired = 0; } }
    });
    void oldDoms;
    this.emit("reload", { time: this.time, name: compiled.name });
    return this;
  }

  // waves on: every node is computed and recorded each edge; off: only the cone that matters (faster)
  setWaves(on) { this.wavesOn = !!on; for (const D of this.doms) this._regen(D); }

  // ---------- stats
  get stats() {
    const wallS = this._wall / 1000, mc = this.cycle(this.main.name);
    return {
      cyclesPerSecond: wallS > 0 ? mc / wallS : 0, edgesPerSecond: wallS > 0 ? this.edges / wallS : 0,
      simSeconds: this.time / 1e12, wallSeconds: wallS, edges: this.edges, skipped: this.skipped, mainCycles: mc,
    };
  }
  get domains() { return this.doms.map((D) => ({ name: D.name, hz: D.hz, cycle: this.cycle(D.name), graph: D.g, skipping: !!D.skip })); }
  get props_() { return this.props; }
  coverage() { return this.props.filter((p) => p.kind === "cover").map((p) => ({ path: p.path, name: p.name, hits: p.hits, first: p.firstHit })); }
}

const RING = 65_536;
const ringOf = (T) => (T && isBig(T) ? new Array(RING).fill(0n) : new Float64Array(RING));
function initOf(n) {
  let v = n.attrs.init;
  if (v == null) v = n.type.initVal ?? 0;
  if (typeof v === "boolean") v = +v;
  return typeof v === "object" ? encode(v, n.type) : n.type.k === "u" || n.type.k === "s" ? wrapTo(v, n.type) : v;
}
function inInstance(n, instance) { return n.attrs.module === instance || String(n.attrs.path || "").startsWith(instance + "."); }
function setIn(obj, sel, v) { let o = obj; for (let i = 0; i < sel.length - 1; i++) o = o[sel[i]]; o[sel.at(-1)] = v; }
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function cloneState(s) { try { return structuredClone(s); } catch { return { ...s }; } }
function safeJson(a) { try { return JSON.stringify(a, (k, v) => (typeof v === "bigint" ? v.toString() : v)); } catch { return String(a); } }
export { toPs, durMs };
