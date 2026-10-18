// Lowering (owner A): elaborated instances + their parsed hardware lambdas → one hash-consed DAG per clock
// domain (D11 level "dag"). Hardware lambdas are executed symbolically: every statement runs under a path
// condition, every write becomes a guarded assignment, and at the end each register's next value and each
// wire's driver is the chain of muxes those guarded assignments describe (D5). Locals are SSA values;
// loops with constant bounds unroll; .lib() helpers are re-parsed and inlined. Streams (D7) become
// valid/ready/data nodes with producer-side buffers; memories (D8) become mem/memrd/memwr; events and
// .every() become prescalers (D6); asserts get their past/within/sequence monitors as registers.
import * as T from "./types.js";
import { Graph } from "./ir.js";
import { parseLambda, posOf, patternNames, HW_GLOBALS } from "./front.js";
import { expandResources } from "./boards.js";

const BIT = T.bit;
const ITER_LIMIT = 4096;
const HELPER_DEPTH = 24;

// ---------- values ----------
// { k: "c", v, T } constant · { k: "n", id, T } node · { k: "rec", fields: Map } record · { k: "vecsig", sig } ·
// { k: "str", v } · { k: "js", v } any other build-time JS value · { k: "type", T } · { k: "rom", rom } ·
// { k: "ram", sig } · { k: "self" } · { k: "builtin", name } · { k: "strmux", c, a, b } · { k: "undef" }
const C = (v, Ty) => {
  if (typeof v === "boolean") v = v ? 1 : 0;
  const TT = Ty || T.constType(v);
  return { k: "c", v: T.conv(v, TT), T: TT };
};
const ZERO = C(0, BIT), ONE = C(1, BIT);
const UNDEF = { k: "undef" };
const SELF = { k: "self" };
const isC = (v) => v && v.k === "c";
const isNum = (v) => v && (v.k === "c" || v.k === "n");
const isZero = (v) => isC(v) && (typeof v.v === "bigint" ? v.v === 0n : v.v === 0);
const isOne = (v) => isC(v) && !isZero(v);
const sameVal = (a, b) => a === b || (a.k === "n" && b.k === "n" && a.id === b.id) || (a.k === "c" && b.k === "c" && a.v === b.v && T.sameType(a.T, b.T));
const sameShape = (a, b) => a.k === b.k && a.w === b.w && a.signed === b.signed && T.sameType({ ...a, pulse: false }, { ...b, pulse: false });
const TYPE_FNS = new Set([T.u, T.s, T.vec, T.struct, T.clog2]);

class LowerError extends Error {}

// ---------- node construction with folding ----------
class Ops {
  constructor(g, module) { this.g = g; this.mod = module; this.origin = null; }
  add(op, args, Ty, attrs = {}) { return this.g.add(op, args, Ty, this.mod ? { ...attrs, module: this.mod } : attrs, this.origin); }
  kc(v, Ty) { const TT = Ty || T.constType(v); return this.add("const", [], TT, { value: T.conv(v, TT) }); }
  N(id) { return { k: "n", id, T: this.g.node(id).type }; }
  nid(v) {
    if (v.k === "n") return v.id;
    if (v.k === "c") return this.kc(v.v, v.T);
    if (v.k === "vecsig") return this.vecWhole(v).id;
    if (v.k === "rec") throw new LowerError("a record needs a struct type here (push it, or assign it to a struct signal)");
    if (v.k === "str") throw new LowerError(`the string "${v.v}" is not a hardware value`);
    if (v.k === "undef") throw new LowerError("this value is undefined");
    throw new LowerError(`a ${v.k === "js" ? typeof v.v : v.k} value cannot become hardware here`);
  }
  vecWhole(v) {
    const els = v.sig.elems.map((e) => e.node).reverse();   // element 0 least significant
    return this.N(this.add("concat", els, v.sig.T));
  }
  // logical helpers on bits
  truth(v) {
    if (v.k === "vecsig") v = this.vecWhole(v);
    if (!isNum(v)) {
      if (v.k === "str" || v.k === "js") return C(v.v ? 1 : 0, BIT);
      if (v.k === "undef") return ZERO;
      throw new LowerError("a condition must be a number");
    }
    if (isC(v)) return isZero(v) ? ZERO : ONE;
    if (v.T.k === "u" && v.T.w === 1) return v;
    if (!T.isScalar(v.T)) throw new LowerError(`a ${T.typeName(v.T)} is not a condition`);
    return this.N(this.add("ne", [v.id, this.kc(0)], BIT));
  }
  and(a, b) {
    a = this.truth(a); b = this.truth(b);
    if (isZero(a) || isZero(b)) return ZERO;
    if (isOne(a)) return b;
    if (isOne(b)) return a;
    if (sameVal(a, b)) return a;
    return this.N(this.add("land", [a.id, b.id], BIT));
  }
  or(a, b) {
    a = this.truth(a); b = this.truth(b);
    if (isOne(a) || isOne(b)) return ONE;
    if (isZero(a)) return b;
    if (isZero(b)) return a;
    if (sameVal(a, b)) return a;
    return this.N(this.add("lor", [a.id, b.id], BIT));
  }
  not(a) {
    a = this.truth(a);
    if (isC(a)) return isZero(a) ? ONE : ZERO;
    const n = this.g.node(a.id);
    if (n.op === "lnot") return this.N(n.args[0]);
    return this.N(this.add("lnot", [a.id], BIT));
  }
  bin(op, a, b) {
    if (a.k === "vecsig") a = this.vecWhole(a);
    if (b.k === "vecsig") b = this.vecWhole(b);
    if (!isNum(a) || !isNum(b)) throw new LowerError(`operator ${op} needs numbers`);
    if (!T.isScalar(a.T) || !T.isScalar(b.T)) throw new LowerError(`operator ${op} needs scalars, not ${T.typeName(T.isScalar(a.T) ? b.T : a.T)}`);
    if (op === "land") return this.and(a, b);
    if (op === "lor") return this.or(a, b);
    let R;
    if (op === "shl" || op === "shr") {
      if (isC(b)) {
        const k = Number(b.v);
        if (k < 0) throw new LowerError("a negative shift amount");
        R = T.shiftType(op, a.T, k);
      } else R = T.shiftType(op, a.T, null, b.T);
    } else R = T.binType(op, a.T, b.T);
    if (isC(a) && isC(b)) {
      const v = T.evalOp(op, R, [a.v, b.v]);
      return C(v);
    }
    // a few identities that keep path conditions and unrolled loops small
    if ((op === "add" || op === "or" || op === "xor") && isZero(b) && T.fits(a.T, R)) return a;
    if ((op === "shl" || op === "shr") && isZero(b)) return a;
    if (op === "mul" && (isZero(a) || isZero(b))) return C(0);
    if (op === "mul" && isC(b) && b.v == 1 && !b.T.signed) return a;            // y * GAIN with GAIN = 1 (F-17)
    if (op === "mul" && isC(a) && a.v == 1 && !a.T.signed) return b;
    return this.N(this.add(op, [this.nid(a), this.nid(b)], R));
  }
  un(op, a) {
    if (a.k === "vecsig") a = this.vecWhole(a);
    if (op === "lnot") return this.not(a);
    if (!isNum(a) || !T.isScalar(a.T)) throw new LowerError(`operator ${op} needs a number`);
    const R = T.unType(op, a.T);
    if (isC(a)) return C(T.evalOp(op, R, [a.v]));
    return this.N(this.add(op, [a.id], R));
  }
  mux(c, a, b) {
    c = this.truth(c);
    if (isC(c)) return isZero(c) ? b : a;
    if (sameVal(a, b)) return a;
    if (a.k === "str" || b.k === "str" || a.k === "strmux" || b.k === "strmux") return { k: "strmux", c, a, b };
    if (a.k === "vecsig") a = this.vecWhole(a);
    if (b.k === "vecsig") b = this.vecWhole(b);
    if (a.k === "rec" && b.k === "rec") {
      const fields = new Map();
      for (const [n, fa] of a.fields) {
        if (!b.fields.has(n)) throw new LowerError(`both sides of ?: need the field ${n}`);
        fields.set(n, this.mux(c, fa, b.fields.get(n)));
      }
      for (const n of b.fields.keys()) if (!a.fields.has(n)) throw new LowerError(`both sides of ?: need the field ${n}`);
      return { k: "rec", fields };
    }
    if (a.k === "rec") a = this.cast(a, b.T, "fit");
    if (b.k === "rec") b = this.cast(b, a.T, "fit");
    if (!isNum(a) || !isNum(b)) throw new LowerError("?: needs values on both sides");
    let R;
    if (T.isScalar(a.T) && T.isScalar(b.T)) R = T.join(a.T, b.T);
    else if (T.sameType(a.T, b.T)) R = a.T;
    else throw new LowerError(`?: mixes ${T.typeName(a.T)} and ${T.typeName(b.T)}`);
    return this.N(this.add("mux", [c.id, this.nid(a), this.nid(b)], R));
  }
  // exact-type conversion. mode: "fit" (must fit), "wrap", "sat", "as" (reinterpret the bits)
  cast(v, Tt, mode = "fit", onError = null) {
    if (v.k === "vecsig") v = this.vecWhole(v);
    const bad = (msg) => { if (onError) onError(msg); else throw new LowerError(msg); };
    if (Tt.k === "struct") {
      if (v.k === "rec") {
        const ids = [];
        for (const [n, FT] of Tt.fields) {
          if (!v.fields.has(n)) { bad(`the record has no field ${n} (the type is ${T.typeName(Tt)})`); ids.push(this.kc(0, FT)); continue; }
          ids.push(this.nid(this.cast(v.fields.get(n), FT, mode, onError)));
        }
        for (const n of v.fields.keys()) if (!Tt.fields.some(([m]) => m === n)) bad(`the type ${T.typeName(Tt)} has no field ${n}`);
        return this.N(this.add("pack", ids, Tt));
      }
      if (v.k === "n" && T.sameType(v.T, Tt)) return v;
      if (isC(v) && isZero(v)) return this.N(this.kc(T.isBig(Tt) ? 0n : 0, Tt));
      bad(`expected ${T.typeName(Tt)}, got ${v.T ? T.typeName(v.T) : v.k}`);
      return this.N(this.kc(T.isBig(Tt) ? 0n : 0, Tt));
    }
    if (Tt.k === "vec") {
      if (v.k === "n" && T.sameType(v.T, Tt)) return v;
      if (isC(v) && isZero(v)) return this.N(this.kc(T.isBig(Tt) ? 0n : 0, Tt));
      bad(`expected ${T.typeName(Tt)}, got ${v.T ? T.typeName(v.T) : v.k}`);
      return this.N(this.kc(T.isBig(Tt) ? 0n : 0, Tt));
    }
    if (v.k === "rec") { bad(`a record cannot become ${T.typeName(Tt)}`); return C(0, Tt); }
    if (!isNum(v)) { bad(`expected a number for ${T.typeName(Tt)}`); return C(0, Tt); }
    if (!T.isScalar(v.T)) {
      if (mode === "as" && v.T.w === Tt.w) return this.N(this.add("wrap", [v.id], Tt));
      bad(`a ${T.typeName(v.T)} cannot become ${T.typeName(Tt)}`);
      return C(0, Tt);
    }
    if (isC(v)) {
      let val = v.v;
      if (mode === "fit" && !T.fits(T.constType(val), Tt)) { bad(`${String(val)} does not fit in ${T.typeName(Tt)}: use wrap() or sat()`); val = T.wrapTo(val, Tt); }
      else if (mode === "wrap" || mode === "as") val = T.wrapTo(val, Tt);
      else if (mode === "sat") val = T.satTo(val, Tt);
      return { k: "c", v: T.conv(val, Tt), T: Tt };
    }
    if (sameShape(v.T, Tt)) return v.T === Tt ? v : { ...v, T: Tt };
    if (mode === "as") {
      if (v.T.w !== Tt.w) { bad(`.as(${T.typeName(Tt)}) reinterprets bits, so the widths must match (this is ${T.typeName(v.T)})`); }
      return this.N(this.add("wrap", [v.id], Tt));
    }
    if (T.fits(v.T, Tt)) return this.N(this.add(v.T.signed ? "sext" : "zext", [v.id], Tt));
    if (mode === "fit") {
      bad(`${T.typeName(v.T)} does not fit in ${T.typeName(Tt)}: say what happens to the extra bits with wrap() or sat()`);
      return this.N(this.add("wrap", [v.id], Tt));
    }
    return this.N(this.add(mode === "sat" ? "sat" : "wrap", [v.id], Tt));
  }
  slice(v, hi, lo) {
    if (v.k === "vecsig") v = this.vecWhole(v);
    if (!isNum(v)) throw new LowerError(".bits() needs a number");
    if (hi < lo || lo < 0 || hi >= v.T.w) throw new LowerError(`bits(${hi}, ${lo}) is outside a ${v.T.w}-bit value`);
    const R = T.u(hi - lo + 1);
    if (isC(v)) return C(T.evalOp("slice", R, [v.v], { hi, lo }));
    if (lo === 0 && hi === v.T.w - 1 && !v.T.signed && v.T.k === "u") return v;
    return this.N(this.add("slice", [v.id], R, { hi, lo }));
  }
  bitAt(v, idx) {
    if (isC(idx)) {
      const i = Number(idx.v);
      if (i < 0 || i >= v.T.w) throw new LowerError(`bit ${i} is outside a ${v.T.w}-bit value`);
      return this.slice(v, i, i);
    }
    const sh = this.bin("shr", isC(v) ? this.N(this.kc(v.v, v.T)) : v, idx);
    return this.slice(sh, 0, 0);
  }
  field(v, name) {
    const Ty = v.T;
    let lo = 0, hit = null;
    for (let i = Ty.fields.length - 1; i >= 0; i--) {
      const [n, FT] = Ty.fields[i];
      if (n === name) { hit = FT; break; }
      lo += FT.w;
    }
    if (!hit) throw new LowerError(`${T.typeName(Ty)} has no field ${name}`);
    return this.N(this.add("field", [this.nid(v)], hit, { name, lo, hi: lo + hit.w - 1 }));
  }
  // element i of a vec-typed node
  elemOf(v, idx) {
    const E = v.T.elem, n = v.T.n;
    const at = (i) => this.N(this.add("wrap", [this.nid(this.slice(v, i * E.w + E.w - 1, i * E.w))], E));
    if (isC(idx)) {
      const i = Number(idx.v);
      if (i < 0 || i >= n) throw new LowerError(`index ${i} is outside vec(${T.typeName(E)}, ${n})`);
      return at(i);
    }
    let r = at(0);
    for (let i = 1; i < n; i++) r = this.mux(this.bin("eq", idx, C(i)), at(i), r);
    return r;
  }
}

// ---------- the design-level lowering ----------
export function lower(E) { return new Lowering(E).run(); }

class Lowering {
  constructor(E) {
    this.E = E;
    this.file = E.file;
    this.diags = E.diags;
    this.graphs = {};
    for (const [name, d] of Object.entries(E.domains)) this.graphs[name] = new Graph(name, d.hz);
    this.main = E.main;
    this.instByPath = new Map();
    this.cellByPath = new Map();
    this.streams = new Map();
    this.placeholders = new Set();   // "graph:id" of probes still waiting for their driver
    this.pins = [];
    this.pinOwner = new Map();
    this.knobs = [];
    this.asserts = [];
    this.cellsOut = [];
    this.instancesOut = [];
  }
  err(message, at = {}, code = "lower", level = "error") {
    this.diags.push({ level, code, message, line: at?.line ?? null, col: at?.col ?? null, file: this.file });
  }
  graph(domain) {
    if (!this.graphs[domain]) {
      this.err(`unknown clock domain "${domain}"`, {}, "domain");
      this.graphs[domain] = new Graph(domain, this.E.domains[this.main]?.hz ?? null);
    }
    return this.graphs[domain];
  }
  ph(g, path, Ty, attrs = {}, module = null) {
    const dummy = g.add("const", [], Ty, { value: T.isBig(Ty) ? 0n : 0, placeholder: true });
    const id = g.add("probe", [dummy], Ty, { path, ...attrs, ...(module ? { module } : {}) });
    this.placeholders.add(`${g.domain}:${id}`);
    return id;
  }
  patch(g, phId, srcId, ops = null) {
    const n = g.node(phId);
    let src = srcId;
    const st = g.node(srcId).type;
    if (!sameShape(st, n.type)) {
      const o = ops || new Ops(g, n.attrs.module || null);
      src = o.nid(o.cast(o.N(srcId), n.type, "wrap"));
    }
    n.args[0] = src;
    g._users = null;
    this.placeholders.delete(`${g.domain}:${phId}`);
  }

  run() {
    const E = this.E;
    for (const I of E.instances) this.instByPath.set(I.path, I);
    for (const c of E.cells) this.cellByPath.set(c.path, c);
    this.setupStreams();
    for (const I of E.instances) this.lowerInstance(I);
    this.finalizeStreams();
    this.lowerCells();
    this.wire();
    this.outputs();
    this.assignAddresses();
    const hadErrors = this.diags.some((d) => d.level === "error");
    for (const key of hadErrors ? [] : this.placeholders) {
      const [dom, id] = key.split(":");
      const n = this.graphs[dom]?.node(+id);
      if (n) this.err(`${n.attrs.path} is never driven; it reads as 0`, {}, "undriven", "warn");
    }
    const domains = {};
    for (const [name, g] of Object.entries(this.graphs)) domains[name] = { hz: g.hz, graph: g };
    return {
      domains, instances: this.instancesOut, streams: [...this.streams.values()].map((S) => this.streamOut(S)),
      pins: this.pins, knobs: this.knobs, cells: this.cellsOut, asserts: this.asserts,
    };
  }

  // ================= streams: link providers and consumers =================
  setupStreams() {
    const E = this.E;
    const get = (name) => {
      if (!this.streams.has(name)) this.streams.set(name, { name, decl: null, T: null, producer: null, consumers: [], pushes: [], line: null });
      return this.streams.get(name);
    };
    for (const d of E.streamDecls) {
      const S = get(d.name);
      if (S.decl) this.err(`stream "${d.name}" is declared twice`, { line: d.line }, "link");
      S.decl = d; S.T = d.type || null; S.line = d.line;
    }
    for (const I of E.instances) {
      for (const n of I.provides) {
        const S = get(n);
        if (S.producer) this.err(`stream "${n}" has two producers: ${S.producer.path} and ${I.path}`, { line: I.line }, "link");
        else S.producer = { kind: "inst", path: I.path, domain: I.domain };
      }
      for (const n of I.needs) get(n).consumers.push({ kind: "inst", path: I.path, domain: I.domain });
    }
    for (const c of E.cells) {
      for (const p of c.iface.provides) {
        const S = get(p.stream);
        if (S.producer) this.err(`stream "${p.stream}" has two producers: ${S.producer.path} and ${c.path}`, { line: c.line }, "link");
        else S.producer = { kind: "cell", path: c.path, domain: c.domain };
        if (!S.T && p.type) S.T = p.type;
        else if (S.T && p.type && !T.sameType(S.T, p.type)) this.err(`${c.path} provides ${p.stream} as ${T.typeName(p.type)}, but the stream is declared ${T.typeName(S.T)}`, { line: c.line }, "type");
      }
      for (const p of c.iface.needs) {
        const S = get(p.stream);
        S.consumers.push({ kind: "cell", path: c.path, domain: c.domain });
        if (!S.T && p.type) S.T = p.type;
      }
    }
    for (const S of this.streams.values()) {
      const decl = S.decl;
      S.cross = decl?.cross || null;
      // R6.7: every stream between a producer and a consumer in the design has a buffer at its producer,
      // depth 2 (a skid buffer) unless .buffer() says otherwise. Streams at the design's edge (no producer, or
      // no consumer) are the testbench's to drive, so they stay plain handshakes.
      S.depth = decl?.depth || (S.producer && S.consumers.length && !S.cross ? 2 : 0);
      S.defaultBuffer = !decl?.depth && S.depth > 0;
      S.overflow = decl?.overflow || "block";
      if (S.overflow === "latest" && S.depth !== 1) this.err(`stream "${S.name}": "latest" keeps one beat, so its buffer has depth 1 (.buffer(1, { overflow: "latest" }))`, { line: S.line }, "stream");
      if (!S.producer && !decl) this.err(`nothing provides "${S.name}": ${S.consumers.map((c) => c.path).join(", ")} needs it (declare it with stream("${S.name}").of(…) to drive it from a testbench)`, { line: this.instByPath.get(S.consumers[0]?.path)?.line }, "link");
      if (!S.consumers.length && !decl) this.err(`nobody needs "${S.name}"; its ready is held low`, { line: this.instByPath.get(S.producer?.path)?.line }, "link", "warn");
      // domains
      let dP = S.producer?.domain ?? null, dC = S.consumers[0]?.domain ?? null;
      if (S.cross) {
        if (S.cross.from && dP && S.cross.from !== dP) this.err(`stream "${S.name}" crosses from ${S.cross.from}, but its producer ${S.producer.path} runs in ${dP}`, { line: S.line }, "cdc");
        if (S.cross.to && dC && S.cross.to !== dC) this.err(`stream "${S.name}" crosses to ${S.cross.to}, but ${S.consumers[0].path} runs in ${dC}`, { line: S.line }, "cdc");
        dP = dP || S.cross.from || this.main; dC = dC || S.cross.to || this.main;
      } else {
        dP = dP || dC || this.main; dC = dC || dP;
      }
      for (const c of S.consumers) if (c.domain !== dC && !S.cross) this.err(`stream "${S.name}" goes to ${c.path} in ${c.domain} and to ${S.consumers[0].path} in ${dC}: one stream, one consumer domain`, { line: S.line }, "cdc");
      S.dP = dP; S.dC = dC;
      S.mode = S.cross ? "cross" : dP !== dC ? "unsync" : S.depth > 0 ? "buffer" : "wire";
      if (S.mode === "unsync") this.err(`stream "${S.name}" goes from the ${dP} domain (${S.producer?.path ?? "testbench"}) to the ${dC} domain (${S.consumers.map((c) => c.path).join(", ")}) without .cross(): checks.cdc refuses to build a crossing nobody synchronized`, { line: S.line ?? this.instByPath.get(S.consumers[0]?.path)?.line }, "cdc");
      this.streamNodes(S);
    }
  }
  // the bit-wide signals of a stream; data nodes come once the type is known (dataNodes)
  streamNodes(S) {
    const gP = this.graph(S.dP), gC = this.graph(S.dC), name = S.name;
    const inNode = (g, path, Ty, src, extra = {}) => g.add("in", [], Ty, { path, src, stream: name, ...extra });
    const prodKind = S.producer?.kind ?? null;
    const modCons = S.consumers.filter((c) => c.kind === "inst");
    const cellCons = S.consumers.filter((c) => c.kind === "cell");
    S.pValid = prodKind === "inst" ? this.ph(gP, `${name}.valid`, BIT, { stream: name }) : inNode(gP, `${name}.valid`, BIT, prodKind === "cell" ? "cell" : "port");
    const sideC = S.mode === "wire" ? name : `${name}.out`;
    // the merged consumer-side ready
    if (S.consumers.length > 1 || modCons.length) S.cReady = this.ph(gC, `${sideC}.ready`, BIT, { stream: name });
    else if (cellCons.length) S.cReady = inNode(gC, `${sideC}.ready`, BIT, "cell");
    else if (!S.decl && S.producer) S.cReady = gC.add("probe", [gC.add("const", [], BIT, { value: 1 })], BIT, { path: `${sideC}.ready`, stream: name, sink: true });   // R6.5: an undeclared sink is always ready
    else S.cReady = inNode(gC, `${sideC}.ready`, BIT, "port");
    // per-consumer views (an eager fork when there are several)
    S.views = new Map();
    if (S.consumers.length > 1) {
      for (const c of S.consumers) {
        const r = c.kind === "inst" ? this.ph(gC, `${name}.out.${c.path}.ready`, BIT, { stream: name }) : inNode(gC, `${name}.out.${c.path}.ready`, BIT, "cell");
        S.views.set(c.path, { ready: r, valid: null, taken: null });
      }
    } else if (S.consumers.length === 1) S.views.set(S.consumers[0].path, { ready: S.cReady, valid: null });
    switch (S.mode) {
      case "wire": S.pReady = S.cReady; S.cValid = S.pValid; break;
      case "buffer": S.pReady = this.ph(gP, `${name}.ready`, BIT, { stream: name }); S.cValid = this.ph(gC, `${name}.out.valid`, BIT, { stream: name }); break;
      case "cross": S.pReady = inNode(gP, `${name}.ready`, BIT, "cell"); S.cValid = inNode(gC, `${name}.out.valid`, BIT, "cell"); break;
      case "unsync":
        S.pReady = gP.add("in", [], BIT, { path: `${name}.ready`, src: "cross", from: { domain: S.dC, node: S.cReady }, stages: 0, unsync: true, stream: name });
        S.cValid = gC.add("in", [], BIT, { path: `${name}.out.valid`, src: "cross", from: { domain: S.dP, node: S.pValid }, stages: 0, unsync: true, stream: name });
        break;
    }
    // fork: per-consumer valid = valid ∧ ¬taken
    if (S.consumers.length > 1) {
      const o = new Ops(gC, name);
      for (const [path, v] of S.views) {
        v.taken = gC.add("reg", [], BIT, { path: `${name}.out.${path}.taken`, init: 0, next: null, module: name });
        v.valid = o.and(o.N(S.cValid), o.not(o.N(v.taken))).id;
      }
    } else for (const v of S.views.values()) v.valid = S.cValid;
    if (S.T) this.dataNodes(S);
  }
  dataNodes(S) {
    if (S.pData != null) return;
    const gP = this.graph(S.dP), gC = this.graph(S.dC), name = S.name, Ty = S.T;
    const prodKind = S.producer?.kind ?? null;
    S.pData = prodKind === "inst" ? this.ph(gP, `${name}.data`, Ty, { stream: name }) : gP.add("in", [], Ty, { path: `${name}.data`, src: prodKind === "cell" ? "cell" : "port", stream: name });
    switch (S.mode) {
      case "wire": S.cData = S.pData; break;
      case "buffer": S.cData = this.ph(gC, `${name}.out.data`, Ty, { stream: name }); break;
      case "cross": S.cData = gC.add("in", [], Ty, { path: `${name}.out.data`, src: "cell", stream: name }); break;
      case "unsync": S.cData = gC.add("in", [], Ty, { path: `${name}.out.data`, src: "cross", from: { domain: S.dP, node: S.pData }, stages: 0, unsync: true, stream: name }); break;
    }
  }
  // the stream's type: declared, from a cell, or the join of what its producer pushes (lowering it first)
  streamType(S, at) {
    if (S.T) { this.dataNodes(S); return S.T; }
    const P = S.producer?.kind === "inst" ? this.instByPath.get(S.producer.path) : null;
    if (P && P.state !== "done") {
      if (P.state === "lowering") {
        this.err(`stream "${S.name}" feeds back into its producer, so its type cannot be inferred: declare it, stream("${S.name}").of(…)`, at, "type");
        S.T = T.u(1); this.dataNodes(S); return S.T;
      }
      this.lowerInstance(P);
    }
    if (!S.T) S.T = this.inferType(S, at);
    this.dataNodes(S);
    return S.T;
  }
  inferType(S, at) {
    if (!S.pushes.length) {
      this.err(`stream "${S.name}" has no type: nothing pushes to it and it is not declared`, at, "type", S.consumers.length ? "error" : "warn");
      return T.u(1);
    }
    const typeOfVal = (v) => {
      if (v.k === "rec") return T.struct(Object.fromEntries([...v.fields].map(([n, f]) => [n, typeOfVal(f)])));
      if (v.k === "c") return T.constType(v.v);
      if (v.k === "n") return v.T;
      return T.u(1);
    };
    const joinT = (a, b) => {
      if (!a) return b;
      if (a.k === "struct" && b.k === "struct") return T.struct(Object.fromEntries(a.fields.map(([n, F]) => [n, joinT(F, b.fields.find(([m]) => m === n)?.[1] || F)])));
      if (T.isScalar(a) && T.isScalar(b)) return T.join(a, b);
      return a;
    };
    let Ty = null;
    for (const p of S.pushes) Ty = joinT(Ty, typeOfVal(p.value));
    return Ty;
  }
  view(S, I, at) {
    const v = S.views.get(I.path);
    if (!v) { this.err(`${I.path} reads "${S.name}" but does not .needs() it`, at, "link"); return { valid: S.cValid, ready: null, data: () => this.consData(S, at) }; }
    return { valid: v.valid, ready: v.ready, data: () => this.consData(S, at) };
  }
  consData(S, at) { this.streamType(S, at); return S.cData; }

  finalizeStreams() {
    for (const S of this.streams.values()) {
      if (S.pData == null) { this.streamType(S, { line: S.line }); }
      const gP = this.graph(S.dP), gC = this.graph(S.dC);
      // producer module: valid = any push guard, data = the pushes as a priority mux (later pushes win)
      if (S.producer?.kind === "inst") {
        const I = this.instByPath.get(S.producer.path);
        const o = new Ops(gP, S.producer.path);
        let valid = ZERO, data = null;
        for (const p of S.pushes) {
          o.origin = p.origin;
          const val = o.cast(p.value, S.T, "fit", (m) => this.err(`${I.path} pushes to ${S.name}: ${m}`, p.at, "width"));
          valid = o.or(valid, p.guardv);
          data = data ? o.mux(p.guardv, val, data) : val;
        }
        if (!S.pushes.length) this.err(`${I.path} provides "${S.name}" but never pushes to it`, { line: I.line }, "link", "warn");
        o.origin = null;
        this.patch(gP, S.pValid, o.nid(valid));
        this.patch(gP, S.pData, data ? o.nid(o.cast(data, S.T, "wrap")) : o.kc(T.isBig(S.T) ? 0n : 0, S.T));
      }
      // fork: merged ready, taken flags
      if (S.consumers.length > 1) {
        const o = new Ops(gC, S.name);
        let all = ONE;
        for (const [, v] of S.views) all = o.and(all, o.or(o.N(v.ready), o.N(v.taken)));
        this.patch(gC, S.cReady, o.nid(all));
        const pop = o.and(o.N(S.cValid), all);
        for (const [, v] of S.views) {
          const fire = o.and(o.N(v.valid), o.N(v.ready));
          gC.setNext(v.taken, o.nid(o.mux(pop, ZERO, o.or(o.N(v.taken), fire))));
        }
      }
      if (S.mode === "buffer") this.lowerBuffer(S);
      if (S.mode === "cross") this.crossCell(S);
    }
  }
  // producer-side buffer (D7): depth 1 "latest" is a register, small depths are register files, ≥ 64 a memory
  lowerBuffer(S) {
    const g = this.graph(S.dP), o = new Ops(g, S.name), Ty = S.T, d = S.depth, name = S.name;
    const reg = (n, Tr, init = 0) => g.add("reg", [], Tr, { path: `${name}.${n}`, init: T.isBig(Tr) ? BigInt(init) : init, next: null, module: name, stream: name });
    const pv = o.N(S.pValid), pd = o.N(S.pData), cr = o.N(S.cReady);
    const lossy = S.overflow !== "block";
    let dropInc = null;
    S.dropped = null;
    if (lossy) S.dropped = reg("dropped", T.u(16));
    if (d === 2 && S.overflow === "block") {
      // the skid buffer (R6.12): ready is a register, so no combinational path runs from the consumer back
      S.impl = "skid";
      const mv = reg("main.valid", BIT), md = reg("main", Ty), sv = reg("skid.valid", BIT), sd = reg("skid", Ty);
      const MV = o.N(mv), MD = o.N(md), SV = o.N(sv), SD = o.N(sd);
      const inReady = o.not(SV);
      const inFire = o.and(pv, inReady), outFire = o.and(MV, cr);
      const free = o.or(outFire, o.not(MV));
      g.setNext(mv, o.nid(o.mux(free, o.or(SV, inFire), MV)));
      // the incoming data passes one multiplexer: the selects are control, computed beside it
      const loadIn = o.and(free, o.and(o.not(SV), inFire)), loadSkid = o.and(free, SV);
      g.setNext(md, o.nid(o.mux(loadIn, pd, o.mux(loadSkid, SD, MD))));
      g.setNext(sv, o.nid(o.mux(free, ZERO, o.or(SV, inFire))));
      g.setNext(sd, o.nid(o.mux(o.and(o.not(free), inFire), pd, SD)));
      this.patch(g, S.pReady, o.nid(inReady));
      this.patch(g, S.cValid, mv);
      this.patch(g, S.cData, md);
    } else if (d === 1 && (S.overflow === "latest" || S.overflow === "drop-oldest")) {
      S.impl = "register";
      const v = reg("full", BIT), r = reg("buf", Ty);
      const V = o.N(v), pop = o.and(V, cr);
      g.setNext(v, o.nid(o.mux(pv, ONE, o.mux(pop, ZERO, V))));
      g.setNext(r, o.nid(o.mux(pv, pd, o.N(r))));
      dropInc = o.and(pv, o.and(V, o.not(pop)));
      this.patch(g, S.pReady, o.nid(ONE));
      this.patch(g, S.cValid, v);
      this.patch(g, S.cData, r);
    } else if (d < 64) {
      S.impl = d === 1 ? "register" : d <= 4 || this.E.board.family === "ice40" ? "flip-flops" : "lut-ram";
      const aw = Math.max(1, T.clog2(d)), cw = T.bitlen(d) || 1;
      const head = reg("head", T.u(aw)), tail = reg("tail", T.u(aw)), count = reg("count", T.u(cw));
      const H = o.N(head), Tl = o.N(tail), Cn = o.N(count);
      const full = o.bin("eq", Cn, C(d)), empty = o.bin("eq", Cn, C(0));
      const cValid = o.not(empty);
      const pop = o.and(cValid, cr);
      let pReady, accept, dropOld = ZERO;
      if (S.overflow === "block") { pReady = o.not(full); accept = o.and(pv, pReady); }
      else if (S.overflow === "drop-newest") { pReady = ONE; accept = o.and(pv, o.not(full)); dropInc = o.and(pv, full); }
      else { pReady = ONE; accept = pv; dropOld = o.and(pv, o.and(full, o.not(pop))); dropInc = dropOld; }
      const inc = (P) => (d === 2 ** aw ? o.cast(o.bin("add", P, C(1)), T.u(aw), "wrap") : o.mux(o.bin("eq", P, C(d - 1)), C(0, T.u(aw)), o.cast(o.bin("add", P, C(1)), T.u(aw), "wrap")));
      const ents = [];
      for (let k = 0; k < d; k++) {
        const e = reg(`e${k}`, Ty);
        const we = d === 1 ? accept : o.and(accept, o.bin("eq", Tl, C(k)));
        g.setNext(e, o.nid(o.mux(we, pd, o.N(e))));
        ents.push(e);
      }
      let out = o.N(ents[0]);
      for (let k = 1; k < d; k++) out = o.mux(o.bin("eq", H, C(k)), o.N(ents[k]), out);
      const adv = o.or(pop, dropOld);
      g.setNext(tail, o.nid(o.mux(accept, inc(Tl), Tl)));
      g.setNext(head, o.nid(o.mux(adv, inc(H), H)));
      const c1 = o.mux(accept, o.bin("add", Cn, C(1)), Cn);
      g.setNext(count, o.nid(o.cast(o.mux(adv, o.bin("sub", c1, C(1)), c1), T.u(cw), "wrap")));
      this.patch(g, S.pReady, o.nid(pReady));
      this.patch(g, S.cValid, o.nid(cValid));
      this.patch(g, S.cData, o.nid(out));
    } else {
      // memory FIFO with a registered read: an output register in front, the memory behind it
      S.impl = "block-ram";
      const aw = T.clog2(d), cw = T.bitlen(d);
      const mem = g.add("mem", [], Ty, { path: `${name}.mem`, words: d, elem: Ty, rdw: "old", init: null, module: name });
      const wp = reg("wptr", T.u(aw)), rp = reg("rptr", T.u(aw)), cnt = reg("count", T.u(cw)), ov = reg("ovalid", BIT);
      const W = o.N(wp), R = o.N(rp), Cn = o.N(cnt), OV = o.N(ov);
      const full = o.bin("eq", Cn, C(d));
      const pop = o.and(OV, cr);
      let pReady, accept, dropOld = ZERO;
      if (S.overflow === "block") { pReady = o.not(full); accept = o.and(pv, pReady); }
      else if (S.overflow === "drop-newest") { pReady = ONE; accept = o.and(pv, o.not(full)); dropInc = o.and(pv, full); }
      else { pReady = ONE; accept = pv; dropOld = o.and(pv, full); dropInc = dropOld; }
      const issue = o.and(o.bin("ne", Cn, C(0)), o.or(o.not(OV), pop));
      const rd = g.add("memrd", [mem, o.nid(R), o.nid(issue)], Ty, { path: `${name}.q`, module: name });
      g.add("memwr", [mem, o.nid(W), o.nid(pd), o.nid(accept)], Ty, { path: `${name}.w`, module: name });
      const inc = (P) => o.cast(o.bin("add", P, C(1)), T.u(aw), "wrap");
      g.setNext(wp, o.nid(o.mux(accept, inc(W), W)));
      const radv = o.or(issue, dropOld);
      g.setNext(rp, o.nid(o.mux(radv, inc(R), R)));
      const c1 = o.mux(accept, o.bin("add", Cn, C(1)), Cn);
      g.setNext(cnt, o.nid(o.cast(o.mux(radv, o.bin("sub", c1, C(1)), c1), T.u(cw), "wrap")));
      g.setNext(ov, o.nid(o.mux(issue, ONE, o.mux(pop, ZERO, OV))));
      this.patch(g, S.pReady, o.nid(pReady));
      this.patch(g, S.cValid, ov);
      this.patch(g, S.cData, rd);
    }
    if (S.dropped != null) {
      // R6.9: a 16-bit saturating status register the host can read
      const D = o.N(S.dropped);
      g.setNext(S.dropped, o.nid(o.mux(o.and(dropInc || ZERO, o.bin("ne", D, C(0xffff))), o.cast(o.bin("add", D, C(1)), T.u(16), "wrap"), D)));
      g.node(S.dropped).attrs.status = { kind: "status", saturating: true, addr: null };
      this.knobs.push({ path: `${name}.dropped`, module: name, name: "dropped", kind: "status", type: T.u(16), typeName: "u16", reset: 0, min: null, max: null, addr: null, domain: S.dP, node: S.dropped, stream: name });
    }
  }
  crossCell(S) {
    S.impl = "xfifo";
    const depth = S.depth || 4, policy = S.depth ? S.overflow : "block";
    const io = {
      "in.valid": { dir: "read", node: S.pValid, domain: S.dP },
      "in.data": { dir: "read", node: S.pData, domain: S.dP },
      "in.ready": { dir: "drive", node: S.pReady, domain: S.dP },
      "out.valid": { dir: "drive", node: S.cValid, domain: S.dC },
      "out.data": { dir: "drive", node: S.cData, domain: S.dC },
      "out.ready": { dir: "read", node: S.cReady, domain: S.dC },
    };
    const gP = this.graph(S.dP);
    const cellNode = gP.add("cell", [S.pValid, S.pData], BIT, { path: `${S.name}.xfifo`, kind: "xfifo", module: S.name });
    this.cellsOut.push({ path: `${S.name}.xfifo`, kind: "xfifo", domain: S.dP, params: { depth, policy, from: S.dP, to: S.dC, type: T.typeName(S.T), stages: S.cross.stages || 2, stream: S.name }, io, pins: {}, node: cellNode, line: S.line });
    this.instancesOut.push({ path: `${S.name}.xfifo`, kind: "cell", cell: "xfifo", def: "xfifo", domain: S.dP, params: { depth, policy, from: S.dP, to: S.dC }, line: S.line, ports: [], regs: [], provides: [], needs: [], knobs: [] });
  }
  streamOut(S) {
    return {
      name: S.name, type: S.T, typeName: T.typeName(S.T), producer: S.producer?.path ?? null, consumers: S.consumers.map((c) => c.path),
      depth: S.depth, overflow: S.overflow, cross: S.cross ? { from: S.dP, to: S.dC } : null, mode: S.mode, impl: S.impl || (S.mode === "wire" ? "wire" : S.mode),
      // signals: the beats as the consumer sees them (fire there = a beat delivered), in `domain`.
      // push: the producer side, when a same-domain buffer separates the two (a crossing's sides are in its xfifo cell's io).
      domain: S.dC, pushDomain: S.dP, outDomain: S.dC,
      signals: { valid: S.cValid, data: S.cData, ready: S.cReady },
      ...(S.mode === "buffer" ? { push: { valid: S.pValid, data: S.pData, ready: S.pReady } } : {}),
      sides: { push: { valid: S.pValid, data: S.pData, ready: S.pReady, domain: S.dP }, pop: { valid: S.cValid, data: S.cData, ready: S.cReady, domain: S.dC } },
      views: Object.fromEntries([...S.views].map(([p, v]) => [p, { valid: v.valid, ready: v.ready }])),
      dropped: S.dropped ?? null, declared: !!S.decl, line: S.line,
    };
  }

  // ================= instances =================
  lowerInstance(I) {
    if (I.state === "done" || I.state === "lowering") return;
    I.state = "lowering";
    try { new InstanceLowering(this, I).run(); }
    catch (e) {
      if (e instanceof LowerError) { if (!e.silent) this.err(e.message, e.at || { line: I.line }, e.code || "lower"); }
      else this.err(`internal error while lowering ${I.path}: ${e.message}`, { line: I.line }, "internal");
      if (!(e instanceof LowerError) && this.E.debug) throw e;
    }
    I.state = "done";
  }

  // ================= cells =================
  lowerCells() {
    for (const c of this.E.cells) {
      const g = this.graph(c.domain);
      const io = {}, pinsMap = {};
      const reads = [];
      for (const [port, spec] of Object.entries(c.iface.pins)) {
        const bound = c.binds[port];
        if (bound == null) { this.err(`${c.path} needs .bind({ ${port}: … })`, { line: c.line }, "pins"); continue; }
        const res = expandResources(bound, this.E.board);
        pinsMap[port] = res;
        for (const r of res) this.claimPin(r, `${c.path}.${port}`, c.line);
        const dirOf = (r) => (spec.dir === "inout" ? this.E.board.resources[r]?.dir ?? "out" : spec.dir);
        const ins = res.filter((r) => dirOf(r) === "in");
        if (ins.length) {
          const id = g.add("in", [], T.u(ins.length), { path: `pin:${ins.join(",")}`, src: "pin", pins: ins, module: c.path });
          io[port] = { dir: "read", node: id, domain: c.domain, resources: ins };
          reads.push(id);
          ins.forEach((r, bit) => this.pins.push({ resource: r, dir: "in", domain: c.domain, node: id, bit, instance: c.path, port }));
        }
        for (const r of res) if (dirOf(r) !== "in") this.pins.push({ resource: r, dir: "out", domain: c.domain, node: null, bit: 0, instance: c.path, port, cell: true });
      }
      for (const p of c.iface.ports) {
        const id = g.add("in", [], p.type, { path: `${c.path}.${p.name}`, src: "cell", module: c.path });
        io[p.name] = { dir: "drive", node: id, domain: c.domain };
        c.portNodes[p.name] = id;
      }
      for (const p of c.iface.provides) {
        const S = this.streams.get(p.stream);
        io[`${p.stream}.valid`] = { dir: "drive", node: S.pValid, domain: S.dP };
        io[`${p.stream}.data`] = { dir: "drive", node: S.pData, domain: S.dP };
        io[`${p.stream}.ready`] = { dir: "read", node: S.pReady, domain: S.dP };
        if (S.dP === c.domain) reads.push(S.pReady);
      }
      for (const p of c.iface.needs) {
        const S = this.streams.get(p.stream);
        const v = S.views.get(c.path);
        io[`${p.stream}.valid`] = { dir: "read", node: v.valid, domain: S.dC };
        io[`${p.stream}.data`] = { dir: "read", node: S.cData, domain: S.dC };
        io[`${p.stream}.ready`] = { dir: "drive", node: v.ready, domain: S.dC };
        if (S.dC === c.domain) reads.push(v.valid, S.cData);
        if (p.signed && S.T && !S.T.signed) this.err(`${c.path} plays signed samples; "${p.stream}" is ${T.typeName(S.T)}`, { line: c.line }, "type", "warn");
      }
      const params = { ...c.iface.params };
      if (c.kind === "hdmi") {
        const tm = this.E.cells.find((x) => x.kind === "video-timing" && x.domain === c.domain);
        params.timing = tm?.path ?? null;
        if (!tm) this.err(`${c.path} needs a std.video.timing() in the ${c.domain} domain`, { line: c.line }, "link");
        params.serialHz = (this.E.domains[c.domain]?.hz || 0) * 5;
      }
      if (c.kind === "video-timing") {
        const hz = this.E.domains[c.domain]?.hz;
        if (hz && Math.abs(hz - params.hz) / params.hz > 0.01) this.err(`${c.path}: ${params.mode} wants a ${(params.hz / 1e6).toFixed(3)} MHz pixel clock; ${c.domain} runs at ${(hz / 1e6).toFixed(3)} MHz`, { line: c.line }, "clock", "warn");
      }
      const node = g.add("cell", [...new Set(reads)], BIT, { path: c.path, kind: c.kind, module: c.path });
      this.cellsOut.push({ path: c.path, kind: c.kind, domain: c.domain, params, io, pins: pinsMap, node, line: c.line });
      this.instancesOut.push({
        path: c.path, kind: "cell", cell: c.kind, def: c.kind, domain: c.domain, params, line: c.line,
        ports: c.iface.ports.map((p) => ({ name: p.name, dir: p.dir, type: p.type })), regs: [],
        provides: c.iface.provides.map((p) => p.stream), needs: c.iface.needs.map((p) => p.stream), knobs: [],
      });
    }
  }
  claimPin(r, owner, line) {
    const board = this.E.board;
    if (!board.resources[r]) {
      this.err(board.profile ? `the ${board.profile} board has no ${r}` : `${owner} binds ${r}, but the design has no board`, { line }, "pins");
      return false;
    }
    const prev = this.pinOwner.get(r);
    if (prev && prev !== owner) { this.err(`${r} is bound twice: by ${prev} and by ${owner}`, { line }, "pins"); return false; }
    this.pinOwner.set(r, owner);
    return true;
  }

  // ================= .wire() connections =================
  resolvePortRef(ref) {
    const paths = [...this.instByPath.keys(), ...this.cellByPath.keys()].sort((a, b) => b.length - a.length);
    for (const p of paths) if (ref.startsWith(p + ".")) {
      const rest = ref.slice(p.length + 1);
      const m = rest.match(/^([\w$]+)(?:\[(\d+)\])?$/);
      if (!m) return null;
      return { path: p, port: m[1], index: m[2] != null ? +m[2] : null, inst: this.instByPath.get(p), cell: this.cellByPath.get(p) };
    }
    return null;
  }
  wire() {
    for (const w of this.E.wires) {
      const src = this.resolvePortRef(w.from), dst = this.resolvePortRef(w.to);
      if (!src) { this.err(`.wire(): no port "${w.from}"`, { line: w.line }, "link"); continue; }
      if (!dst || !dst.inst) { this.err(`.wire(): no input port "${w.to}"`, { line: w.line }, "link"); continue; }
      const dsig = dst.inst.lowered?.sigs.get(dst.port);
      if (!dsig || dsig.role !== "in") { this.err(`.wire(): ${w.to} is not an input port`, { line: w.line }, "link"); continue; }
      let srcId, srcDomain;
      if (src.cell) {
        srcId = src.cell.portNodes[src.port];
        srcDomain = src.cell.domain;
        if (srcId == null) { this.err(`.wire(): ${src.path} has no port ${src.port}`, { line: w.line }, "link"); continue; }
      } else {
        const ss = src.inst.lowered?.sigs.get(src.port);
        if (!ss) { this.err(`.wire(): ${src.path} has no port ${src.port}`, { line: w.line }, "link"); continue; }
        const el = src.index != null ? ss.elems?.[src.index] : ss;
        if (!el) { this.err(`.wire(): ${w.from} is not an element of ${src.path}.${src.port}`, { line: w.line }, "link"); continue; }
        if (el.elems) { this.err(`.wire(): ${w.from} is a vector; wire its elements`, { line: w.line }, "link"); continue; }
        srcId = el.node; srcDomain = src.inst.domain;
      }
      const g = this.graph(dst.inst.domain);
      if (srcDomain !== dst.inst.domain) {
        const sg = this.graph(srcDomain);
        srcId = g.add("in", [], sg.node(srcId).type, { path: `${w.to}.cross`, src: "cross", from: { domain: srcDomain, node: srcId }, stages: 2, module: dst.inst.path });
      }
      const o = new Ops(g, dst.inst.path);
      const val = o.cast(o.N(srcId), dsig.T, "fit", (m) => this.err(`.wire(${w.from} → ${w.to}): ${m}`, { line: w.line }, "width"));
      if (!this.placeholders.has(`${g.domain}:${dsig.node}`)) this.err(`${w.to} is driven twice`, { line: w.line }, "link");
      this.patch(g, dsig.node, o.nid(val));
    }
  }

  // ================= top-level outputs and pins =================
  outputs() {
    for (const I of this.E.instances) {
      const L = I.lowered;
      if (!L) continue;
      for (const p of I.ports.filter((p) => p.dir === "out")) {
        const sig = L.sigs.get(p.name);
        if (!sig) continue;
        const key = `${I.path}.${p.name}`;
        const conn = this.E.conn.get(key);
        const g = L.g;
        if (conn?.kind === "pin") {
          const res = expandResources(conn.res, this.E.board);
          const width = sig.T.w;
          if (res.length !== width) this.err(`${key} is ${width} bit${width > 1 ? "s" : ""} wide but ${Array.isArray(conn.res) ? conn.res.join(", ") : conn.res} is ${res.length} pin${res.length > 1 ? "s" : ""}`, { line: conn.line }, "pins");
          const okAll = res.every((r) => this.claimPin(r, key, conn.line));
          if (!okAll && !res.length) continue;
          const src = sig.elems ? L.ops.vecWhole({ k: "vecsig", sig }).id : sig.node;
          const id = g.add("out", [src], g.node(src).type, { path: `pin:${res.join(",")}`, pins: res, module: I.path, port: p.name });
          res.forEach((r, bit) => { if (this.E.board.resources[r]) this.pins.push({ resource: r, dir: "out", domain: I.domain, node: id, bit, instance: I.path, port: p.name }); });
          if (this.E.board.resources[res[0]] && this.E.board.resources[res[0]].dir === "in") this.err(`${res[0]} is an input on this board; ${key} is an output`, { line: conn.line }, "pins");
        } else if (!this.E.board.profile && !this.E.consumed.has(key)) {
          // no board: the design's ports are the top (F-11, F-13, F-14)
          const src = sig.elems ? L.ops.vecWhole({ k: "vecsig", sig }).id : sig.node;
          g.add("out", [src], g.node(src).type, { path: `port:${key}`, port: p.name, module: I.path, top: true });
        }
      }
    }
  }
  assignAddresses() {
    let addr = 0;
    for (const k of this.knobs) {
      k.addr = addr; addr += 4;
      const n = this.graph(k.domain).node(k.node);
      const a = n?.attrs?.knob || n?.attrs?.status || n?.attrs?.irq;
      if (a) a.addr = k.addr;
    }
  }
}

// ================= one instance =================
class InstanceLowering {
  constructor(L, I) {
    this.L = L; this.I = I; this.path = I.path;
    this.g = L.graph(I.domain);
    this.hz = L.E.domains[I.domain]?.hz ?? L.E.domains[L.main]?.hz ?? 100e6;
    this.ops = new Ops(this.g, I.path);
    this.sigs = new Map();
    this.readyTerms = new Map();     // stream → [cond Values] (this consumer's ready)
    this.prescalers = new Map();
    this.mon = 0;
    this.edges = new Map();
    I.lowered = this;
  }
  err(msg, at, code = "lower", level = "error") { this.L.err(msg, at, code, level); }
  get file() { return this.L.file; }

  run() {
    const I = this.I;
    this.makeSignals();
    // blocks in the order they were written
    for (const b of I.blocks) this.block(b);
    if (I.kind === "fsm") this.fsm();
    if (I.kind === "pipeline") this.pipeline();
    for (const a of I.asserts) this.assertion(a);
    if (I.supervise) this.supervise();
    this.finalize();
    this.describe();
  }

  // ---------- signals ----------
  makeSignals() {
    const I = this.I, g = this.g, o = this.ops;
    const written = this.prescan();
    const mk = (name, role, Ty, store, extra = {}) => {
      const path = `${I.path}.${name}`;
      const sig = { name, role, T: Ty, store, path, writes: [], pulse: !!Ty.pulse || role === "irq", ...extra };
      if (Ty.k === "vec" && (store === "reg" || store === "wire")) {
        sig.elems = Array.from({ length: Ty.n }, (_, i) => {
          const e = { name: `${name}[${i}]`, role, T: Ty.elem, store, path: `${path}[${i}]`, writes: [], pulse: false, parent: sig, index: i };
          e.node = store === "reg" ? g.add("reg", [], Ty.elem, { path: e.path, init: initOf(Ty.elem, Ty.initVal, i), next: null, module: I.path, name: e.name }) : this.L.ph(g, e.path, Ty.elem, { name: e.name }, I.path);
          return e;
        });
        if (role === "out") sig.node = g.add("probe", [o.vecWhole({ k: "vecsig", sig }).id], Ty, { path, module: I.path, name });
      } else if (store === "reg") {
        sig.node = g.add("reg", [], Ty, { path, init: initOf(Ty, Ty.initVal), next: null, module: I.path, name, ...(sig.pulse ? { pulse: true } : {}), ...(extra.regAttrs || {}) });
      } else if (store === "wire") sig.node = this.L.ph(g, path, Ty, { name }, I.path);
      this.sigs.set(name, sig);
      return sig;
    };
    for (const p of I.ports) {
      if (this.sigs.has(p.name)) { this.err(`${I.path} declares ${p.name} twice`, { line: p.line }, "builder"); continue; }
      if (p.dir === "in") this.inputPort(p, mk);
      else {
        const w = written.get(p.name);
        let store = "wire";
        if (w?.clocked && w?.comb) this.err(`${I.path}.${p.name} is written in .comb() and in a clocked block; a signal is a register or a wire, not both`, { line: p.line }, "driver");
        if (w?.clocked) store = "reg";
        else if (!w && I.kind !== "pipeline") this.err(`${I.path}.${p.name} is never written`, { line: p.line }, "driver", "warn");
        mk(p.name, "out", p.type, store);
      }
    }
    for (const [name, Ty] of Object.entries(I.regs)) {
      if (this.sigs.has(name)) { this.err(`${I.path}.${name} is declared twice`, { line: I.line }, "builder"); continue; }
      if (written.get(name)?.comb) this.err(`${I.path}.${name} is a register; .comb() cannot write it`, { line: I.line }, "driver");
      mk(name, "reg", Ty, "reg");
    }
    for (const k of I.knobs) {
      const Ty = k.kind === "irq" ? T.pulse : k.type;
      const reset = k.opts.reset ?? 0;
      const sig = mk(k.name, k.kind, Ty, "reg", { regAttrs: { [k.kind === "knob" ? "knob" : k.kind]: { kind: k.kind, min: k.opts.min ?? null, max: k.opts.max ?? null, reset, addr: null } } });
      const n = g.node(sig.node);
      n.attrs.init = T.conv(reset, Ty);
      if (k.kind === "knob") n.attrs.knob = { kind: "knob", min: k.opts.min ?? null, max: k.opts.max ?? null, reset, addr: null };
      this.L.knobs.push({ path: sig.path, module: I.path, name: k.name, kind: k.kind, type: Ty, typeName: T.typeName(Ty), reset, min: k.opts.min ?? null, max: k.opts.max ?? null, addr: null, domain: I.domain, node: sig.node, line: k.line });
    }
    for (const r of I.rams) {
      const elem = r.opts.of, words = r.opts.words;
      if (!T.isType(elem) || !Number.isInteger(words)) { this.err(`.ram("${r.name}") needs { of: type, words: n }`, { line: r.line }, "builder"); continue; }
      const mem = g.add("mem", [], elem, { path: `${I.path}.${r.name}`, words, elem, rdw: r.opts.rdw || "old", init: r.opts.init || null, module: I.path, name: r.name });
      this.sigs.set(r.name, { name: r.name, role: "ram", store: "ram", T: elem, path: `${I.path}.${r.name}`, mem, words, aT: T.u(Math.max(1, T.clog2(words))), reads: [], writes: [], rd: null });
    }
  }
  inputPort(p, mk) {
    const I = this.I, g = this.g, key = `${I.path}.${p.name}`;
    const conn = this.L.E.conn.get(key);
    if (conn?.kind === "pin") {
      const res = expandResources(conn.res, this.L.E.board);
      if (res.length !== p.type.w) this.err(`${key} is ${p.type.w} bit${p.type.w > 1 ? "s" : ""} wide but ${Array.isArray(conn.res) ? conn.res.join(", ") : conn.res} is ${res.length} pin${res.length > 1 ? "s" : ""}`, { line: conn.line }, "pins");
      res.forEach((r) => this.L.claimPin(r, key, conn.line));
      const raw = g.add("in", [], p.type, { path: `pin:${res.join(",")}`, src: "pin", pins: res, module: I.path, port: p.name });
      res.forEach((r, bit) => this.L.pins.push({ resource: r, dir: "in", domain: I.domain, node: raw, bit, instance: I.path, port: p.name }));
      if (this.L.E.board.resources[res[0]]?.dir === "out") this.err(`${res[0]} is an output on this board; ${key} is an input`, { line: conn.line }, "pins");
      // two flip-flops between a pin and the logic: the first may go metastable, the second gives it a cycle to settle
      const s1 = g.add("reg", [], p.type, { path: `${key}.sync1`, init: 0, next: raw, module: I.path, sync: true });
      const s2 = g.add("reg", [], p.type, { path: `${key}.sync2`, init: 0, next: s1, module: I.path, sync: true });
      const sig = mk(p.name, "in", p.type, "input");
      sig.node = g.add("probe", [s2], p.type, { path: key, module: I.path, name: p.name, input: true });
      sig.pin = res;
    } else if (conn?.kind === "wire") {
      const sig = mk(p.name, "in", p.type, "input");
      sig.node = this.L.ph(g, key, p.type, { name: p.name, input: true }, I.path);
    } else {
      const sig = mk(p.name, "in", p.type, "input");
      sig.node = g.add("in", [], p.type, { path: key, src: this.L.E.board.profile ? "free" : "port", module: I.path, port: p.name });
    }
  }
  // the names a lambda writes through $ (following $ into .lib() helpers)
  writesOf(parsed) {
    const names = new Set();
    this.scanWrites(parsed.node, selfOf(parsed), (n) => names.add(n));
    return names;
  }
  // which names each kind of block writes: decides register vs wire for out ports (D5)
  prescan() {
    const I = this.I, out = new Map();
    const note = (name, clocked) => {
      const w = out.get(name) || { clocked: false, comb: false };
      if (clocked) w.clocked = true; else w.comb = true;
      out.set(name, w);
    };
    for (const b of I.blocks) if (b.lam.parsed) this.scanWrites(b.lam.parsed.node, selfOf(b.lam.parsed), (n) => note(n, b.kind !== "comb"));
    for (const s of I.states) if (s.lam.parsed) this.scanWrites(s.lam.parsed.node, selfOf(s.lam.parsed), (n) => note(n, true));
    return out;
  }
  scanWrites(fnNode0, selfName0, note) {
    const I = this.I;
    const scan = (fnNode, selfName, depth = 0) => {
      if (!selfName || depth > 8) return;
      const visit = (n) => {
        if (!n || typeof n.type !== "string") return;
        let target = null;
        if (n.type === "AssignmentExpression") target = n.left;
        else if (n.type === "UpdateExpression") target = n.argument;
        if (target) {
          let t = target;
          while (t.type === "MemberExpression" && !(t.object.type === "Identifier" && t.object.name === selfName)) t = t.object;
          if (t.type === "MemberExpression" && t.object.type === "Identifier" && t.object.name === selfName && !t.computed) note(t.property.name);
        }
        if (n.type === "CallExpression" && n.callee.type === "Identifier") {
          const f = I.lib[n.callee.name];
          if (typeof f === "function") {
            const k = n.arguments.findIndex((a) => a.type === "Identifier" && a.name === selfName);
            if (k >= 0) try { const p = parseLambda(f); scan(p.node, patternNames(p.params[k])[0], depth + 1); } catch { /* reported later */ }
          }
        }
        for (const key in n) {
          if (key === "loc") continue;
          const v = n[key];
          if (Array.isArray(v)) v.forEach(visit);
          else if (v && typeof v.type === "string") visit(v);
        }
      };
      visit(fnNode.body);
    };
    scan(fnNode0, selfName0);
  }

  // ---------- blocks ----------
  block(b) {
    const lam = b.lam;
    if (!lam.parsed) return;
    const fr = this.frame(lam, b.kind === "comb" ? "comb" : "clocked");
    if (b.kind === "seq") { this.runLambda(fr, []); return; }
    if (b.kind === "comb") {
      fr.combWrites = this.writesOf(lam.parsed);
      fr.wrote = new Set();
      this.runLambda(fr, []);
      // a wire assigned on every path through this block is complete (otherwise it would be a latch)
      for (const s of this.sigs.values()) for (const e of s.elems || [s]) if (e.store === "wire" && fr.assigned.has(e.path)) e.complete = true;
      return;
    }
    if (b.kind === "every") {
      const tick = this.prescaler(b.arg, lam);
      fr.pc = fr.pcv = tick;
      this.runLambda(fr, []);
      return;
    }
    if (b.kind === "on") {
      const ev = b.arg;
      const em = ev.match(/^(.+)\.(rise|fall|change)$/);
      if (em && this.sigs.has(em[1]) && !this.L.streams.has(ev)) {
        fr.pc = fr.pcv = this.edge(em[1], em[2], lam);
        this.runLambda(fr, []);
        return;
      }
      const S = this.L.streams.get(ev);
      if (!S) { this.err(`.on("${ev}"): no stream or port event of that name (events: a stream, or "port.rise" / "port.fall" / "port.change")`, { line: lam.line }, "link"); return; }
      const view = this.L.view(S, this.I, { line: lam.line });
      const o = this.ops;
      const readyOn = this.L.ph(this.g, `${this.path}.on.${ev}.ready`, BIT, { stream: ev }, this.path);
      const valid = o.N(view.valid);
      fr.pc = o.and(valid, o.N(readyOn));
      fr.pcv = valid;
      const data = o.N(view.data());
      this.runLambda(fr, [data]);
      let r = ONE;
      for (const s of fr.pushed) r = o.and(r, o.N(this.L.streams.get(s).pReady));
      this.L.patch(this.g, readyOn, o.nid(r));
      this.ready(ev, o.N(readyOn));
    }
  }
  ready(stream, cond) {
    if (!this.readyTerms.has(stream)) this.readyTerms.set(stream, []);
    this.readyTerms.get(stream).push(cond);
  }
  prescaler(period, lam) {
    let cycles;
    try { cycles = Math.max(1, Math.round(this.hz * T.periodS(period))); }
    catch (e) { this.err(e.message, { line: lam.line }, "builder"); cycles = 1; }
    if (this.prescalers.has(cycles)) return this.prescalers.get(cycles);
    if (cycles === 1) { this.prescalers.set(1, ONE); return ONE; }
    const o = this.ops, g = this.g;
    const w = Math.max(1, T.clog2(cycles));
    const k = this.prescalers.size;
    o.origin = { file: this.file, line: lam.line, col: lam.col, src: `.every(${JSON.stringify(period)})` };
    const r = g.add("reg", [], T.u(w), { path: `${this.path}.every${k || ""}`, init: 0, next: null, module: this.path, prescaler: { period: cycles, label: String(period) } }, o.origin);
    const R = o.N(r);
    const tick = o.bin("eq", R, C(cycles - 1));
    g.setNext(r, o.nid(o.mux(tick, C(0, T.u(w)), o.cast(o.bin("add", R, C(1)), T.u(w), "wrap"))));
    const tp = g.add("probe", [o.nid(tick)], BIT, { path: `${this.path}.every${k || ""}.tick`, module: this.path });
    o.origin = null;
    const t = o.N(tp);
    this.prescalers.set(cycles, t);
    return t;
  }
  edge(port, kind, lam) {
    const key = `${port}.${kind}`;
    if (this.edges.has(key)) return this.edges.get(key);
    const o = this.ops, g = this.g, sig = this.sigs.get(port);
    const cur = o.truth(o.N(sig.node));
    let prev = this.edges.get(`${port}.prev`);
    if (!prev) {
      const r = g.add("reg", [], BIT, { path: `${this.path}.${port}.prev`, init: 0, next: o.nid(cur), module: this.path });
      prev = o.N(r);
      this.edges.set(`${port}.prev`, prev);
    }
    const ev = kind === "rise" ? o.and(cur, o.not(prev)) : kind === "fall" ? o.and(o.not(cur), prev) : o.truth(o.bin("xor", cur, prev));
    this.edges.set(key, ev);
    return ev;
  }

  // ---------- fsm ----------
  fsm() {
    const I = this.I, o = this.ops, g = this.g;
    const names = I.states.map((s) => s.name);
    if (!names.length) { this.err(`fsm("${I.path}") has no states`, { line: I.line }, "fsm"); return; }
    const init = I.initial ? names.indexOf(I.initial) : 0;
    if (init < 0) this.err(`.initial("${I.initial}") is not a state of ${I.path} (${names.join(", ")})`, { line: I.line }, "fsm");
    const ST = T.u(Math.max(1, T.clog2(names.length)));
    const st = g.add("reg", [], ST, { path: `${this.path}.state`, init: Math.max(0, init), next: null, module: this.path, name: "state", states: names, fsm: { states: names, encoding: I.encode || "auto", initial: names[Math.max(0, init)] } });
    const sig = { name: "state", role: "state", T: ST, store: "reg", path: `${this.path}.state`, node: st, writes: [], pulse: false };
    this.sigs.set("state", sig);
    this.stateSig = sig;
    this.transitions = [];
    let stepFire = ONE, stepFireV = ONE, readyStep = null, pushedAll = new Set();
    if (I.step) {
      const S = this.L.streams.get(I.step);
      if (!S) this.err(`.step("${I.step}"): no stream of that name`, { line: I.line }, "link");
      else {
        const view = this.L.view(S, I, { line: I.line });
        readyStep = this.L.ph(g, `${this.path}.step.ready`, BIT, { stream: I.step }, this.path);
        stepFireV = o.N(view.valid);
        stepFire = o.and(stepFireV, o.N(readyStep));
        this.ready(I.step, o.N(readyStep));
      }
    }
    const S0 = o.N(st);
    names.forEach((name, k) => {
      const s = I.states[k];
      if (!s.lam.parsed) return;
      const fr = this.frame(s.lam, "clocked");
      const here = o.bin("eq", S0, C(k));
      fr.pc = o.and(stepFire, here);
      fr.pcv = o.and(stepFireV, here);
      fr.state = name;
      this.runLambda(fr, []);
      for (const s2 of fr.pushed) pushedAll.add(s2);
      for (const r of fr.returns) {
        if (r.val.k === "undef") continue;
        const idx = this.stateIndex(r.val, names, s.lam, r.node, fr);
        if (idx == null) continue;
        sig.writes.push({ guard: r.cond, value: idx, origin: r.origin });
        for (const t of this.targetsOf(r.val)) this.transitions.push({ from: name, to: t });
      }
    });
    if (readyStep != null) {
      let r = ONE;
      for (const s of pushedAll) r = o.and(r, o.N(this.L.streams.get(s).pReady));
      this.L.patch(g, readyStep, o.nid(r));
    }
  }
  stateIndex(v, names, lam, node, fr) {
    if (v.k === "str") {
      const k = names.indexOf(v.v);
      if (k < 0) { this.err(`"${v.v}" is not a state of ${this.path} (${names.join(", ")})`, this.pos(fr, node), "fsm"); return null; }
      return C(k, this.stateSig.T);
    }
    if (v.k === "strmux") {
      const a = this.stateIndex(v.a, names, lam, node, fr), b = this.stateIndex(v.b, names, lam, node, fr);
      if (!a || !b) return null;
      return this.ops.mux(v.c, a, b);
    }
    this.err(`a state returns the name of the next state (a string), or nothing to stay`, this.pos(fr, node), "fsm");
    return null;
  }
  targetsOf(v) { return v.k === "str" ? [v.v] : v.k === "strmux" ? [...this.targetsOf(v.a), ...this.targetsOf(v.b)] : []; }

  // ---------- pipeline ----------
  pipeline() {
    const I = this.I, o = this.ops, g = this.g;
    if (I.needs.length !== 1 || I.provides.length !== 1) { this.err(`pipeline("${I.path}") needs exactly one input stream and provides exactly one output stream`, { line: I.line }, "pipeline"); return; }
    if (!I.stages.length) { this.err(`pipeline("${I.path}") has no stages`, { line: I.line }, "pipeline"); return; }
    const Sin = this.L.streams.get(I.needs[0]), Sout = this.L.streams.get(I.provides[0]);
    const view = this.L.view(Sin, I, { line: I.line });
    const inValid = o.N(view.valid);
    const data = o.N(view.data());
    const n = I.stages.length;
    const skid = I.stall === "skid";
    // which stage values each later stage reads: only those cross a register (pipeline.registers)
    const mentions = I.stages.map((s) => (s.lam.parsed ? selfMembers(s.lam.parsed) : new Set()));
    // R6.13: "global" stalls every stage with one signal; "skid" puts a skid buffer at each boundary, so each
    // boundary's ready is a register and no stall path runs the length of the pipe
    const enPh = skid ? null : this.L.ph(g, `${this.path}.advance`, BIT, {}, this.path);
    const EN = enPh != null ? o.N(enPh) : null;
    let vals = new Map(), validPrev = inValid;
    let inReady = null;            // what the input stream sees (skid: the first boundary's registered ready)
    let readyBelow = null;         // skid: the placeholder for the ready of the boundary being built
    const live = [];
    let result = null;
    this.stageVals = vals;
    const reg = (path, Ty, k) => g.add("reg", [], Ty, { path, init: T.isBig(Ty) ? 0n : 0, next: null, module: this.path, stage: k });
    for (let k = 0; k < n; k++) {
      const s = I.stages[k];
      if (!s.lam.parsed) continue;
      const fr = this.frame(s.lam, "stage");
      fr.stage = k;
      this.stageVals = vals;
      const ret = this.runLambda(fr, k === 0 ? [data] : []);
      if (k === n - 1) {
        if (ret.k === "undef") this.err(`the last stage of ${this.path} returns the output beat`, { line: s.lam.line }, "pipeline");
        result = ret;
        break;
      }
      // boundary k: register what later stages still read
      o.origin = { file: this.file, line: s.lam.base?.line ?? s.lam.line, col: null, src: `.stage("${s.name}") → registers` };
      const later = new Set();
      for (let j = k + 1; j < n; j++) for (const m of mentions[j]) later.add(m);
      const next = new Map();
      const keep = [];
      const b = `${this.path}.s${k + 1}`;
      if (!skid) {
        for (const [name, v] of vals) {
          if (!later.has(name)) continue;
          if (v.k === "rec") { this.err(`stage value ${name} is a record; registers need a struct type`, { line: s.lam.line }, "pipeline"); continue; }
          const r = reg(`${b}.${name}`, v.T, k + 1);
          g.setNext(r, o.nid(o.mux(EN, v, o.N(r))));
          next.set(name, o.N(r));
          keep.push(name);
        }
        const vr = reg(`${b}.valid`, BIT, k + 1);
        g.setNext(vr, o.nid(o.mux(EN, validPrev, o.N(vr))));
        validPrev = o.N(vr);
      } else {
        const outReadyPh = this.L.ph(g, `${b}.ready`, BIT, {}, this.path);
        const mv = reg(`${b}.valid`, BIT, k + 1), sv = reg(`${b}.skid.valid`, BIT, k + 1);
        const MV = o.N(mv), SV = o.N(sv);
        const bReady = o.not(SV);
        const inFire = o.and(validPrev, bReady), outFire = o.and(MV, o.N(outReadyPh));
        const free = o.or(outFire, o.not(MV));
        const loadIn = o.and(free, o.and(o.not(SV), inFire)), loadSkid = o.and(free, SV), park = o.and(o.not(free), inFire);
        g.setNext(mv, o.nid(o.mux(free, o.or(SV, inFire), MV)));
        g.setNext(sv, o.nid(o.mux(free, ZERO, o.or(SV, inFire))));
        for (const [name, v] of vals) {
          if (!later.has(name)) continue;
          if (v.k === "rec") { this.err(`stage value ${name} is a record; registers need a struct type`, { line: s.lam.line }, "pipeline"); continue; }
          const m = reg(`${b}.${name}`, v.T, k + 1), sk = reg(`${b}.skid.${name}`, v.T, k + 1);
          g.setNext(m, o.nid(o.mux(loadIn, v, o.mux(loadSkid, o.N(sk), o.N(m)))));
          g.setNext(sk, o.nid(o.mux(park, v, o.N(sk))));
          next.set(name, o.N(m));
          keep.push(name);
        }
        if (readyBelow == null) inReady = bReady;
        else this.L.patch(g, readyBelow, o.nid(bReady));
        readyBelow = outReadyPh;
        validPrev = MV;
      }
      live.push({ after: s.name, registers: keep });
      vals = next;
    }
    this.stageInfo = { stages: I.stages.map((s) => s.name), live, latency: n - 1, stall: I.stall };
    // the output beat
    if (!Sout.T) {
      const tv = (v) => (v.k === "rec" ? T.struct(Object.fromEntries([...v.fields].map(([nm, f]) => [nm, tv(f)]))) : v.k === "c" ? T.constType(v.v) : v.T || T.u(1));
      Sout.T = result ? tv(result) : T.u(1);
    }
    this.L.dataNodes(Sout);
    const outV = validPrev, outD = result ? o.cast(result, Sout.T, "fit", (m) => this.err(`${this.path} output: ${m}`, { line: I.stages[n - 1].lam.line }, "width")) : C(0, Sout.T);
    const pReady = o.N(Sout.pReady);
    o.origin = { file: this.file, line: I.line, col: null, src: `.stall("${I.stall}")` };
    let readyIn;
    if (skid) {
      if (readyBelow == null) readyIn = pReady;           // one stage: the input meets the output directly
      else { this.L.patch(g, readyBelow, o.nid(pReady)); readyIn = inReady; }
    } else {
      this.L.patch(g, enPh, o.nid(o.or(pReady, o.not(outV))));
      readyIn = EN;
    }
    Sout.pushes.push({ guard: outV, guardv: outV, value: outD, at: { line: I.line }, origin: null });
    this.ready(Sin.name, readyIn);
  }

  // ---------- asserts and supervision ----------
  assertion(a) {
    if (!a.lam.parsed) return;
    const fr = this.frame(a.lam, "assert");
    const v = this.runLambda(fr, []);
    const o = this.ops;
    let bitv;
    try { bitv = o.truth(v); } catch (e) { this.err(`${a.kind} "${a.name}": ${e.message}`, { line: a.lam.line }, "assert"); bitv = ONE; }
    const id = this.g.add("probe", [o.nid(bitv)], BIT, { path: `${this.path}.${a.kind}.${a.name}`, module: this.path, assert: a.kind });
    this.L.asserts.push({ path: `${this.path}.${a.kind}.${a.name}`, name: a.name, kind: a.kind, module: this.path, domain: this.I.domain, node: id, line: a.lam.base?.line ?? a.lam.line });
  }
  supervise() {
    const I = this.I, o = this.ops, g = this.g;
    const info = { watchdog: null, reset: "local", calls: I.supervise.calls };
    for (const c of I.supervise.calls) {
      if (c.op === "reset") info.reset = c.args[0];
      if (c.op === "watchdog") {
        const lam = c.lam;
        let ms = 0;
        try { ms = T.durMs(c.args[0]); } catch (e) { this.err(e.message, { line: lam?.line }, "builder"); }
        const cycles = Math.max(1, Math.round((this.hz * ms) / 1000));
        let alive = ONE;
        if (lam?.parsed) {
          const fr = this.frame(lam, "assert");
          alive = o.truth(this.runLambda(fr, []));
        }
        const w = T.bitlen(cycles) || 1;
        const cnt = g.add("reg", [], T.u(w), { path: `${this.path}.watchdog`, init: 0, next: null, module: this.path, watchdog: { cycles } });
        const CN = o.N(cnt);
        const bark = o.bin("ge", CN, C(cycles));
        g.setNext(cnt, o.nid(o.mux(alive, C(0, T.u(w)), o.mux(bark, CN, o.cast(o.bin("add", CN, C(1)), T.u(w), "wrap")))));
        const id = g.add("probe", [o.nid(bark)], BIT, { path: `${this.path}.watchdog.bark`, module: this.path });
        info.watchdog = { ms, cycles, node: id, counter: cnt };
      }
    }
    this.superviseInfo = info;
  }

  // ---------- finalize: registers, wires, memories, readies ----------
  finalize() {
    const o = this.ops, g = this.g;
    const each = (sig) => (sig.elems ? sig.elems : [sig]);
    for (const top of this.sigs.values()) {
      if (top.store === "ram") { this.finalizeRam(top); continue; }
      for (const sig of each(top)) {
        if (sig.store === "reg") {
          let cur = sig.pulse ? C(0, sig.T) : o.N(sig.node);
          for (const w of sig.writes) {
            o.origin = w.origin || null;
            cur = o.mux(w.guard, o.cast(w.value, sig.T, "wrap"), cur);
          }
          o.origin = null;
          g.setNext(sig.node, o.nid(o.cast(cur, sig.T, "wrap")));
        } else if (sig.store === "wire") {
          if (!sig.writes.length) continue;
          let cur = C(0, T.isScalar(sig.T) ? sig.T : null) || ZERO;
          if (!T.isScalar(sig.T)) cur = o.N(o.kc(T.isBig(sig.T) ? 0n : 0, sig.T));
          for (const w of sig.writes) {
            o.origin = w.origin || null;
            cur = o.mux(w.guard, o.cast(w.value, sig.T, "wrap"), cur);
          }
          o.origin = null;
          if (!sig.complete) this.err(`${sig.path} is not assigned on every path through .comb(): that would be a latch. Give it a value first (a default), then override it`, { line: sig.writes[0].origin?.line }, "latch");
          this.L.patch(g, sig.node, o.nid(o.cast(cur, sig.T, "wrap")));
        }
      }
    }
    for (const [stream, terms] of this.readyTerms) {
      const S = this.L.streams.get(stream);
      const v = S?.views.get(this.path);
      if (!v || v.ready == null) continue;
      let r = ZERO;
      for (const t of terms) r = o.or(r, t);
      const rg = this.L.graph(S.dC);
      if (rg !== g) continue;
      if (this.L.placeholders.has(`${rg.domain}:${v.ready}`)) this.L.patch(rg, v.ready, o.nid(r));
    }
    for (const n of this.I.needs) {
      const S = this.L.streams.get(n);
      const v = S?.views.get(this.path);
      if (v && v.ready != null && !this.readyTerms.has(n) && this.L.placeholders.has(`${this.L.graph(S.dC).domain}:${v.ready}`)) {
        this.err(`${this.path} needs "${n}" but never takes from it; its ready is held low`, { line: this.I.line }, "link", "warn");
        this.L.patch(this.L.graph(S.dC), v.ready, o.nid(ZERO));
      }
    }
  }
  finalizeRam(sig) {
    const o = this.ops, g = this.g;
    if (sig.writes.length) {
      let en = ZERO, addr = null, data = null;
      for (const w of sig.writes) {
        o.origin = w.origin;
        en = o.or(en, w.guard);
        addr = addr ? o.mux(w.guard, w.addr, addr) : w.addr;
        data = data ? o.mux(w.guard, w.data, data) : w.data;
      }
      g.add("memwr", [sig.mem, o.nid(o.cast(addr, sig.aT, "wrap")), o.nid(o.cast(data, sig.T, "wrap")), o.nid(en)], sig.T, { path: `${sig.path}.w`, module: this.path });
    }
    if (sig.rd != null) {
      let en = ZERO, addr = null;
      for (const r of sig.reads) { o.origin = r.origin; en = o.or(en, r.guard); addr = addr ? o.mux(r.guard, r.addr, addr) : r.addr; }
      const n = g.node(sig.rd);
      n.args = [sig.mem, o.nid(addr ? o.cast(addr, sig.aT, "wrap") : C(0, sig.aT)), o.nid(en)];
      g._users = null;
      if (!sig.reads.length) this.err(`${sig.path}.q is read but nothing calls ${sig.name}.read(address)`, {}, "memory", "warn");
    }
    o.origin = null;
  }
  describe() {
    const I = this.I;
    const regs = [];
    for (const s of this.sigs.values()) {
      if (s.store !== "reg") continue;
      if (s.elems) s.elems.forEach((e) => regs.push({ name: e.name, type: e.T, path: e.path }));
      else regs.push({ name: s.name, type: s.T, path: s.path, role: s.role });
    }
    const out = {
      path: I.path, kind: I.kind, def: I.defName, defId: I.defId, memo: I.memoKey, domain: I.domain, params: I.params, line: I.line,
      ports: I.ports.map((p) => ({ name: p.name, dir: p.dir, type: p.type, store: this.sigs.get(p.name)?.store, node: this.sigs.get(p.name)?.node })),
      regs, provides: I.provides, needs: I.needs, knobs: I.knobs.map((k) => k.name),
      rams: I.rams.map((r) => ({ name: r.name, words: r.opts.words, type: r.opts.of, node: this.sigs.get(r.name)?.mem })),
      budget: I.budget, hints: I.hints, pipelined: I.pipelined, migrate: I.migrate || null,
      lib: Object.keys(I.lib), blocks: I.blocks.map((b) => ({ kind: b.kind, arg: b.arg ?? null, line: b.lam.base?.line ?? b.lam.line })),
    };
    if (I.kind === "fsm") {
      out.states = I.states.map((s) => s.name);
      out.initial = I.initial || out.states[0];
      out.encoding = I.encode || "auto";   // requested (D12); the DAG state register holds the state index
      out.stateNode = this.stateSig?.node ?? null;
      out.transitions = dedupe(this.transitions || []);
      out.step = I.step || null;
    }
    if (I.kind === "pipeline") out.pipeline = this.stageInfo || null;
    if (this.superviseInfo) out.supervise = this.superviseInfo;
    if (I.probe) out.probe = { ...I.probe, nodes: Object.fromEntries((I.probe.signals || []).map((n) => [n, this.sigs.get(n)?.node ?? null])) };
    this.L.instancesOut.push(out);
  }

  // ================= the symbolic executor =================
  frame(lam, mode) {
    return { lam, mode, pc: ONE, pcv: ONE, returns: [], assigned: new Set(), overlays: [], pushed: new Set(), depth: 0, retCount: 0 };
  }
  pos(fr, node) {
    if (!node) return { line: fr.lam.base?.line ?? fr.lam.line, col: null };
    return posOf(fr.lam.parsed, node, fr.lam.base);
  }
  origin(fr, node) {
    const p = this.pos(fr, node);
    const pr = fr.lam.parsed;
    let src = pr.src.slice(Math.max(0, node.start - pr.prefix), Math.max(0, node.end - pr.prefix)).replace(/\s+/g, " ");
    if (src.length > 72) src = src.slice(0, 69) + "…";
    return { file: this.file, line: p.line, col: p.col, src };
  }
  fail(fr, node, msg, code = "lower") {
    const at = this.pos(fr, node);
    throw Object.assign(new LowerError(msg), { at, code });
  }
  // run a lambda: binds params[0] to $, the rest to args; returns the value of an expression body or the returns
  runLambda(fr, args) {
    const p = fr.lam.parsed;
    const env = { vars: new Map(), parent: null };
    p.params.forEach((pat, i) => {
      if (i === 0) this.bindPattern(pat, SELF, env, fr);
      else this.bindPattern(pat, args[i - 1] ?? UNDEF, env, fr);
    });
    try {
      if (p.exprBody) return this.ev(p.body, fr, env);
      this.execList(p.body.body, fr, env);
      return this.returnValue(fr);
    } catch (e) {
      if (!(e instanceof LowerError)) throw e;
      if (!e.silent) this.err(e.message, e.at || this.pos(fr, null), e.code || "lower");
      return UNDEF;
    }
  }
  returnValue(fr) {
    const o = this.ops;
    let v = null;
    for (let i = fr.returns.length - 1; i >= 0; i--) {
      const r = fr.returns[i];
      if (r.val.k === "undef") continue;
      v = v ? o.mux(r.cond, r.val, v) : r.val;
    }
    return v || UNDEF;
  }
  bindPattern(pat, val, env, fr) {
    if (pat.type === "Identifier") { env.vars.set(pat.name, { v: val }); return; }
    if (pat.type === "AssignmentPattern") { this.bindPattern(pat.left, val.k === "undef" ? this.ev(pat.right, fr, env) : val, env, fr); return; }
    if (pat.type === "ObjectPattern") {
      for (const prop of pat.properties) {
        if (prop.type === "RestElement") this.fail(fr, prop, "rest patterns are not supported in hardware");
        const key = prop.computed ? this.constKey(this.ev(prop.key, fr, env)) : prop.key.name ?? prop.key.value;
        this.bindPattern(prop.value, this.member(val, key, false, fr, prop), env, fr);
      }
      return;
    }
    if (pat.type === "ArrayPattern") {
      pat.elements.forEach((el, i) => { if (el) this.bindPattern(el, this.member(val, C(i), true, fr, el), env, fr); });
      return;
    }
    this.fail(fr, pat, `${pat.type} is not supported here`);
  }
  constKey(v) { if (v.k === "c") return Number(v.v); if (v.k === "str") return v.v; throw new LowerError("a property name must be a constant"); }
  // variables, with branch overlays so that ifs can merge what each branch assigned
  lookupBinding(env, name) { for (let e = env; e; e = e.parent) if (e.vars.has(name)) return e.vars.get(name); return null; }
  readVar(fr, b) {
    for (let i = fr.overlays.length - 1; i >= 0; i--) if (fr.overlays[i].has(b)) return fr.overlays[i].get(b);
    return b.v;
  }
  writeVar(fr, b, v) {
    if (b.const) throw new LowerError("assignment to a const");
    if (fr.overlays.length) fr.overlays[fr.overlays.length - 1].set(b, v);
    else b.v = v;
  }
  dead(fr) { return isZero(fr.pc); }

  execList(list, fr, env) {
    // hoist function declarations? not in hardware
    for (const s of list) {
      if (this.dead(fr)) return;
      this.exec(s, fr, env);
    }
  }
  exec(s, fr, env) {
    if (this.dead(fr)) return;
    switch (s.type) {
      case "ExpressionStatement": this.ev(s.expression, fr, env); return;
      case "VariableDeclaration":
        for (const d of s.declarations) {
          const v = d.init ? this.ev(d.init, fr, env) : UNDEF;
          if (d.id.type === "Identifier") env.vars.set(d.id.name, { v, const: s.kind === "const" });
          else this.bindPattern(d.id, v, env, fr);
        }
        return;
      case "BlockStatement": this.execList(s.body, fr, { vars: new Map(), parent: env }); return;
      case "IfStatement": this.execIf(s, fr, env); return;
      case "ForStatement": this.execFor(s, fr, env); return;
      case "ForOfStatement": this.execForOf(s, fr, env); return;
      case "WhileStatement": this.execWhile(s, fr, env); return;
      case "ReturnStatement": {
        const v = s.argument ? this.ev(s.argument, fr, env) : UNDEF;
        fr.returns.push({ cond: fr.pc, condv: fr.pcv, val: v, node: s, origin: this.origin(fr, s) });
        fr.retCount++;
        fr.pc = ZERO; fr.pcv = ZERO;
        return;
      }
      case "BreakStatement": case "ContinueStatement":
        if (!fr.loop) this.fail(fr, s, `${s.type === "BreakStatement" ? "break" : "continue"} outside a loop`);
        if (fr.pc !== fr.loop.pc) this.fail(fr, s, `${s.type === "BreakStatement" ? "break" : "continue"} under a hardware condition: loops unroll at build time, so they can only stop on a constant`);
        throw { loopCtl: s.type === "BreakStatement" ? "break" : "continue" };
      case "EmptyStatement": return;
      case "FunctionDeclaration": this.fail(fr, s, "declare helpers outside and ship them with .lib()");
      // falls through
      default: this.fail(fr, s, `${s.type} is not supported in a hardware lambda`);
    }
  }
  branch(fr, cond, run) {
    const o = this.ops;
    const pc0 = fr.pc, pcv0 = fr.pcv, as0 = fr.assigned, r0 = fr.retCount;
    fr.pc = o.and(pc0, cond); fr.pcv = o.and(pcv0, cond);
    fr.assigned = new Set(as0);
    const ov = new Map();
    fr.overlays.push(ov);
    run();
    fr.overlays.pop();
    const res = { pc: fr.pc, pcv: fr.pcv, assigned: fr.assigned, dead: this.dead(fr), overlay: ov, returned: fr.retCount !== r0 };
    fr.pc = pc0; fr.pcv = pcv0; fr.assigned = as0;
    return res;
  }
  mergeBranches(fr, c, A, B) {
    const o = this.ops;
    // locals assigned in either branch become muxes
    const keys = new Set([...A.overlay.keys(), ...B.overlay.keys()]);
    for (const b of keys) {
      const cur = this.readVar(fr, b);
      const va = A.overlay.has(b) ? A.overlay.get(b) : cur;
      const vb = B.overlay.has(b) ? B.overlay.get(b) : cur;
      let v;
      if (A.dead && !B.dead) v = vb;
      else if (B.dead && !A.dead) v = va;
      else v = o.mux(c, va, vb);
      this.writeVar(fr, b, v);
    }
    // path condition after: the paths that reached the end of either branch
    if (A.returned || B.returned) { fr.pc = o.or(A.pc, B.pc); fr.pcv = o.or(A.pcv, B.pcv); }
    if (A.returned || B.returned) fr.retCount++;
    // definite assignment (latch check)
    if (A.dead && B.dead) fr.assigned = new Set([...A.assigned, ...B.assigned]);
    else if (A.dead) fr.assigned = B.assigned;
    else if (B.dead) fr.assigned = A.assigned;
    else fr.assigned = new Set([...A.assigned].filter((x) => B.assigned.has(x)));
  }
  execIf(s, fr, env) {
    const o = this.ops;
    const c = o.truth(this.ev(s.test, fr, env));
    if (isC(c)) {
      if (!isZero(c)) this.exec(s.consequent, fr, env);
      else if (s.alternate) this.exec(s.alternate, fr, env);
      return;
    }
    const at = this.origin(fr, s.test);
    o.origin = at;
    const A = this.branch(fr, c, () => this.exec(s.consequent, fr, env));
    o.origin = at;
    let B;
    if (s.alternate) B = this.branch(fr, o.not(c), () => this.exec(s.alternate, fr, env));
    else {
      // no else: the fall-through path only matters when the then-branch returned
      B = { pc: fr.pc, pcv: fr.pcv, assigned: fr.assigned, dead: false, overlay: new Map(), returned: false };
      if (A.returned) { const nc = o.not(c); B.pc = o.and(fr.pc, nc); B.pcv = o.and(fr.pcv, nc); }
    }
    o.origin = at;
    this.mergeBranches(fr, c, A, B);
  }
  loopBody(fr, body, env, pc0) {
    const saved = fr.loop;
    fr.loop = { pc: pc0 };
    try { this.exec(body, fr, env); return null; }
    catch (e) { if (e && e.loopCtl) return e.loopCtl; throw e; }
    finally { fr.loop = saved; }
  }
  execFor(s, fr, env) {
    const scope = { vars: new Map(), parent: env };
    if (s.init) {
      if (s.init.type === "VariableDeclaration") this.exec(s.init, fr, scope);
      else this.ev(s.init, fr, scope);
    }
    let n = 0;
    while (true) {
      if (this.dead(fr)) return;
      if (s.test) {
        const t = this.ev(s.test, fr, scope);
        if (!isC(t) && t.k !== "str") this.fail(fr, s.test, "a loop condition must be a constant: loops unroll at build time (use params, .lib() values and loop variables)");
        if (isC(t) ? isZero(t) : !t.v) break;
      }
      if (++n > ITER_LIMIT) this.fail(fr, s, `this loop ran ${ITER_LIMIT} times while unrolling; is its bound right?`);
      const body = { vars: new Map(), parent: scope };
      const ctl = this.loopBody(fr, s.body, body, fr.pc);
      if (ctl === "break") break;
      if (s.update) this.ev(s.update, fr, scope);
    }
  }
  execForOf(s, fr, env) {
    const it = this.ev(s.right, fr, env);
    let items;
    if (it.k === "js" && Array.isArray(it.v)) items = it.v.map((x) => this.toVal(x));
    else if (it.k === "str") items = [...it.v].map((x) => ({ k: "str", v: x }));
    else if (it.k === "rom") items = it.rom.table.map((x) => C(x, it.rom.type || undefined));
    else this.fail(fr, s.right, "for…of walks a constant array (a .lib() value)");
    let n = 0;
    for (const v of items) {
      if (this.dead(fr)) return;
      if (++n > ITER_LIMIT) this.fail(fr, s, `this loop ran ${ITER_LIMIT} times while unrolling`);
      const scope = { vars: new Map(), parent: env };
      if (s.left.type === "VariableDeclaration") this.bindPattern(s.left.declarations[0].id, v, scope, fr);
      else this.fail(fr, s.left, "declare the loop variable: for (const x of …)");
      const ctl = this.loopBody(fr, s.body, scope, fr.pc);
      if (ctl === "break") break;
    }
  }
  execWhile(s, fr, env) {
    let n = 0;
    while (true) {
      if (this.dead(fr)) return;
      const t = this.ev(s.test, fr, env);
      if (!isC(t)) this.fail(fr, s.test, "a loop condition must be a constant: loops unroll at build time");
      if (isZero(t)) break;
      if (++n > ITER_LIMIT) this.fail(fr, s, `this loop ran ${ITER_LIMIT} times while unrolling`);
      const ctl = this.loopBody(fr, s.body, { vars: new Map(), parent: env }, fr.pc);
      if (ctl === "break") break;
    }
  }

  // ---------- expressions ----------
  ev(node, fr, env, expect = null) {
    const o = this.ops;
    switch (node.type) {
      case "Literal": {
        if (typeof node.value === "number") return Number.isInteger(node.value) ? C(node.value) : { k: "js", v: node.value };
        if (typeof node.value === "boolean") return C(node.value ? 1 : 0, BIT);
        if (typeof node.value === "string") return { k: "str", v: node.value };
        if (node.bigint != null) return C(BigInt(node.bigint));
        if (node.value === null) return UNDEF;
        this.fail(fr, node, "this literal is not a hardware value");
      }
      // falls through
      case "TemplateLiteral": {
        let s = node.quasis[0].value.cooked;
        node.expressions.forEach((e, i) => {
          const v = this.ev(e, fr, env);
          if (v.k === "c") s += String(v.v); else if (v.k === "str" || v.k === "js") s += String(v.v);
          else this.fail(fr, e, "a template string in hardware needs constant parts");
          s += node.quasis[i + 1].value.cooked;
        });
        return { k: "str", v: s };
      }
      case "Identifier": return this.lookup(node.name, fr, env, node);
      case "MemberExpression": return this.evMember(node, fr, env);
      case "ChainExpression": return this.ev(node.expression, fr, env, expect);
      case "CallExpression": return this.evCall(node, fr, env, expect);
      case "BinaryExpression": return this.evBinary(node, fr, env, expect);
      case "LogicalExpression": {
        if (node.operator === "??") this.fail(fr, node, "?? is not a hardware operator");
        const a = o.truth(this.ev(node.left, fr, env));
        if (node.operator === "&&") {
          if (isC(a)) return isZero(a) ? ZERO : o.truth(this.ev(node.right, fr, env));
          const r = this.under(fr, a, () => this.ev(node.right, fr, env));
          o.origin = this.origin(fr, node);
          return o.and(a, r);
        }
        if (isC(a)) return isOne(a) ? ONE : o.truth(this.ev(node.right, fr, env));
        const r = this.under(fr, o.not(a), () => this.ev(node.right, fr, env));
        o.origin = this.origin(fr, node);
        return o.or(a, r);
      }
      case "UnaryExpression": {
        const a = this.ev(node.argument, fr, env);
        o.origin = this.origin(fr, node);
        switch (node.operator) {
          case "-": if (a.k === "js") return this.toVal(-a.v); return this.op(fr, node, () => o.un("neg", a));
          case "+": return a;
          case "~": return this.op(fr, node, () => o.un("not", a));
          case "!": return this.op(fr, node, () => o.not(a));
          case "typeof": return { k: "str", v: a.k === "js" ? typeof a.v : "number" };
          default: this.fail(fr, node, `unary ${node.operator} is not a hardware operator`);
        }
      }
      // falls through
      case "ConditionalExpression": {
        const c = o.truth(this.ev(node.test, fr, env));
        if (isC(c)) return isZero(c) ? this.ev(node.alternate, fr, env, expect) : this.ev(node.consequent, fr, env, expect);
        const a = this.under(fr, c, () => this.ev(node.consequent, fr, env, expect));
        const b = this.under(fr, o.not(c), () => this.ev(node.alternate, fr, env, expect));
        o.origin = this.origin(fr, node);
        return this.op(fr, node, () => o.mux(c, a, b));
      }
      case "ObjectExpression": {
        const fields = new Map();
        for (const p of node.properties) {
          if (p.type === "SpreadElement") {
            const v = this.ev(p.argument, fr, env);
            if (v.k === "rec") for (const [k, x] of v.fields) fields.set(k, x);
            else if (v.k === "n" && v.T.k === "struct") for (const [k] of v.T.fields) fields.set(k, o.field(v, k));
            else this.fail(fr, p, "spread a record or a struct");
            continue;
          }
          const key = p.computed ? this.constKey(this.ev(p.key, fr, env)) : p.key.name ?? p.key.value;
          const sub = expect?.k === "struct" ? expect.fields.find(([n]) => n === key)?.[1] : null;
          fields.set(String(key), this.ev(p.value, fr, env, sub));
        }
        return { k: "rec", fields };
      }
      case "ArrayExpression": {
        const vals = node.elements.map((e) => this.ev(e, fr, env));
        if (vals.every((v) => v.k === "c" || v.k === "js" || v.k === "str")) return { k: "js", v: vals.map((v) => v.v) };
        this.fail(fr, node, "an array in a hardware lambda must be constant (use vec() signals for hardware arrays)");
      }
      // falls through
      case "AssignmentExpression": return this.evAssign(node, fr, env);
      case "UpdateExpression": {
        const one = C(1);
        const op = node.operator === "++" ? "add" : "sub";
        return this.assignTo(node.argument, fr, env, (cur) => this.ops.bin(op, cur, one), node, true, node.prefix);
      }
      case "SequenceExpression": { let v = UNDEF; for (const e of node.expressions) v = this.ev(e, fr, env); return v; }
      case "ParenthesizedExpression": return this.ev(node.expression, fr, env, expect);
      case "ArrowFunctionExpression": case "FunctionExpression":
        return { k: "js", v: null, fnNode: node, lam: fr.lam };
      default: this.fail(fr, node, `${node.type} is not supported in a hardware lambda`);
    }
  }
  op(fr, node, f) {
    try { return f(); }
    catch (e) { if (e instanceof LowerError && !e.at) { e.at = this.pos(fr, node); e.code = e.code || "type"; } throw e; }
  }
  // evaluate f() with the path condition narrowed by c (short-circuit operators and ?: guard side effects)
  under(fr, c, f) {
    const o = this.ops;
    const pc0 = fr.pc, pcv0 = fr.pcv;
    fr.pc = o.and(pc0, c); fr.pcv = o.and(pcv0, c);
    try { return f(); } finally { fr.pc = pc0; fr.pcv = pcv0; }
  }
  lookup(name, fr, env, node) {
    const b = this.lookupBinding(env, name);
    if (b) return this.readVar(fr, b);
    if (fr.helperScope) {
      // helpers see only their own params and the module's reach
    }
    const I = this.I;
    if (Object.prototype.hasOwnProperty.call(I.params, name)) return this.toVal(I.params[name]);
    if (Object.prototype.hasOwnProperty.call(I.lib, name)) return this.toVal(I.lib[name], name);
    switch (name) {
      case "wrap": case "sat": case "past": case "within": case "sequence": return { k: "builtin", name };
      case "u": return this.toVal(T.u); case "s": return this.toVal(T.s); case "vec": return this.toVal(T.vec); case "struct": return this.toVal(T.struct);
      case "bit": return { k: "type", T: T.bit }; case "pulse": return { k: "type", T: T.pulse };
      case "clog2": return this.toVal(T.clog2);
      case "undefined": return UNDEF;
      case "Infinity": return { k: "js", v: Infinity };
      case "NaN": return { k: "js", v: NaN };
    }
    if (HW_GLOBALS.has(name) && globalThis[name] !== undefined) return { k: "js", v: globalThis[name] };
    if (I.captured && I.captured.has(name)) return this.toVal(I.captured.get(name), name);
    if (I.captureReported?.has(name)) throw Object.assign(new LowerError(""), { silent: true });
    this.fail(fr, node, `\`${name}\` is not defined here: hardware lambdas see their parameters, locals, the module's params and its .lib()`, "capture");
  }
  // build-time JS value → hardware value
  toVal(x, name = null) {
    if (x == null) return UNDEF;
    if (typeof x === "number") return Number.isInteger(x) ? C(x) : { k: "js", v: x };
    if (typeof x === "bigint") return C(x);
    if (typeof x === "boolean") return C(x ? 1 : 0, BIT);
    if (typeof x === "string") return { k: "str", v: x };
    if (T.isType(x)) return { k: "type", T: x };
    if (x && x._ && x._.kind === "rom") return { k: "rom", rom: x._, name };
    return { k: "js", v: x, name };
  }
  evMember(node, fr, env) {
    const o = this.ops;
    const objV = this.ev(node.object, fr, env);
    if (objV.k === "self") {
      if (node.computed) this.fail(fr, node, "$[…] is not allowed: name the signal");
      return this.readSig(node.property.name, fr, node);
    }
    let key;
    if (node.computed) key = this.ev(node.property, fr, env);
    else key = node.property.name;
    o.origin = this.origin(fr, node);
    return this.op(fr, node, () => this.member(objV, key, node.computed, fr, node));
  }
  member(v, key, computed, fr, node) {
    const o = this.ops;
    if (v.k === "rec") {
      const k = typeof key === "object" ? this.constKey(key) : key;
      if (!v.fields.has(String(k))) throw new LowerError(`the record has no field ${k}`);
      return v.fields.get(String(k));
    }
    if (v.k === "vecsig") {
      if (!computed) { if (key === "length") return C(v.sig.T.n); throw new LowerError(`${v.sig.path} is a vector; index it`); }
      return this.vecElem(v.sig, key, fr, node);
    }
    if (v.k === "js") {
      const js = v.v;
      if (computed && isNum(key) && !isC(key)) return this.indexArray(js, key, v.name);
      const k = typeof key === "object" ? (key.k === "c" ? Number(key.v) : key.v) : key;
      if (js == null) throw new LowerError(`cannot read ${k} of nothing`);
      const r = js[k];
      if (typeof r === "function" && !Array.isArray(js)) return { k: "js", v: r, self: js, name: k };
      return this.toVal(r, v.name ? `${v.name}[${k}]` : null);
    }
    if (v.k === "rom") {
      if (!computed) { if (key === "length") return C(v.rom.table.length); throw new LowerError(`a rom has .length and [index]`); }
      return this.romRead(v.rom.table, v.rom.type, key, v.rom.name);
    }
    if (v.k === "str") { if (key === "length") return C(v.v.length); if (computed && isC(key)) return { k: "str", v: v.v[Number(key.v)] }; throw new LowerError("strings are build-time values"); }
    if (v.k === "ram") {
      if (key === "q") return this.ramQ(v.sig);
      throw new LowerError(`a memory has .q, .read(address) and .write(address, value)`);
    }
    if (v.k === "type") { if (key === "w" || key === "width") return C(v.T.w); throw new LowerError(`a type has .width`); }
    if (isNum(v)) {
      if (v.T.k === "struct" && !computed) return o.field(v, key);
      if (v.T.k === "vec") {
        if (!computed) { if (key === "length") return C(v.T.n); throw new LowerError("index a vector"); }
        return o.elemOf(v, key);
      }
      if (computed) {
        if (!isNum(key)) throw new LowerError("a bit index must be a number");
        return o.bitAt(v, key);
      }
      if (key === "width") return C(v.T.w);
      throw new LowerError(`a ${T.typeName(v.T)} has no .${key} (it has [bit], .bits(hi, lo) and .as(type))`);
    }
    throw new LowerError(`cannot read .${typeof key === "object" ? "[…]" : key} here`);
  }
  // a dynamic index into a build-time array: numbers become a ROM, objects a record of ROMs (one per leaf)
  indexArray(arr, idx, name) {
    if (!Array.isArray(arr)) throw new LowerError("only arrays can be indexed by a hardware value");
    if (arr.every((x) => Number.isInteger(x) || typeof x === "bigint" || typeof x === "boolean")) return this.romRead(arr.map((x) => (typeof x === "boolean" ? +x : x)), null, idx, name);
    if (arr.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
      const keys = Object.keys(arr[0]);
      const fields = new Map();
      for (const k of keys) {
        const col = arr.map((x) => x[k]);
        fields.set(k, Array.isArray(col[0]) || (col[0] && typeof col[0] === "object") ? this.indexArray(col, idx, `${name}.${k}`) : this.romRead(col, null, idx, `${name}.${k}`));
      }
      return { k: "rec", fields };
    }
    throw new LowerError("a table indexed in hardware must hold integers (or objects of integers)");
  }
  romRead(table, Ty, idx, name) {
    const o = this.ops;
    if (!Ty) { let J = null; for (const x of table) { const t = T.constType(x); J = J ? T.join(J, t) : t; } Ty = J || T.u(1); }
    if (isC(idx)) {
      const i = Number(idx.v);
      return C(table[i] ?? 0, Ty);
    }
    if (!isNum(idx) || !T.isScalar(idx.T)) throw new LowerError("a table index must be a number");
    const vals = table.map((x) => T.conv(T.wrapTo(x, Ty), Ty));
    return o.N(o.add("rom", [idx.id], Ty, { table: vals, name: name || null }));
  }
  vecElem(sig, idx, fr, node) {
    const o = this.ops;
    if (!isNum(idx)) throw new LowerError("a vector index must be a number");
    if (isC(idx)) {
      const i = Number(idx.v);
      if (i < 0 || i >= sig.elems.length) throw new LowerError(`index ${i} is outside ${sig.path} (${sig.elems.length} elements)`);
      return this.readElem(sig.elems[i], fr, node);
    }
    let r = this.readElem(sig.elems[0], fr, node);
    for (let i = 1; i < sig.elems.length; i++) r = o.mux(o.bin("eq", idx, C(i)), this.readElem(sig.elems[i], fr, node), r);
    return r;
  }
  readElem(e, fr, node) {
    if (fr?.mode === "comb" && e.store === "wire") return this.combRead(e, e.parent?.name ?? e.name, fr, node);
    return this.ops.N(e.node);
  }
  readSig(name, fr, node) {
    // pipeline stage values shadow signals
    if (fr.mode === "stage" && this.stageVals?.has(name)) return this.stageVals.get(name);
    const sig = this.sigs.get(name);
    if (!sig) {
      if (fr.mode === "stage") this.fail(fr, node, `stage value $.${name} is read before any stage writes it`);
      const hint = this.I.knobs.length || this.I.ports.length ? ` (it has ${[...this.sigs.keys()].join(", ")})` : "";
      this.fail(fr, node, `${this.path} has no signal ${name}${hint}`);
    }
    if (sig.store === "ram") return { k: "ram", sig };
    if (sig.elems) return { k: "vecsig", sig, fr };
    if (fr.mode === "comb" && sig.store === "wire") return this.combRead(sig, name, fr, node);
    return this.ops.N(sig.node);
  }
  // D5: in .comb a wire read sees the latest earlier write in program order; reading it before this block writes it is an error
  combRead(sig, name, fr, node) {
    if (fr.wrote?.has(sig.path)) return this.pending(sig);
    if (fr.combWrites?.has(name)) this.fail(fr, node, `$.${name} is read in this .comb() before the block writes it (comb-read-before-write): give it a value first`, "comb-read-before-write");
    return this.ops.N(sig.node);
  }
  ramQ(sig) {
    if (sig.rd == null) {
      const g = this.g;
      const z = g.add("const", [], sig.aT, { value: 0, module: this.path });
      const e = g.add("const", [], BIT, { value: 0, module: this.path });
      sig.rd = g.add("memrd", [sig.mem, z, e], sig.T, { path: `${sig.path}.q`, module: this.path });
    }
    return this.ops.N(sig.rd);
  }

  evBinary(node, fr, env) {
    const o = this.ops;
    const OPS = { "+": "add", "-": "sub", "*": "mul", "&": "and", "|": "or", "^": "xor", "<<": "shl", ">>": "shr", ">>>": "shr", "==": "eq", "===": "eq", "!=": "ne", "!==": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge" };
    const cmp = /^(==|===|!=|!==|<|<=|>|>=)$/.test(node.operator);
    let a, b;
    // wrap() on one side of a comparison takes the other side's type (finding 13)
    if (cmp && isBareWrap(node.left) && !isBareWrap(node.right)) { b = this.ev(node.right, fr, env); a = this.ev(node.left, fr, env, b.T || null); }
    else { a = this.ev(node.left, fr, env); b = this.ev(node.right, fr, env, cmp ? a.T || null : null); }
    o.origin = this.origin(fr, node);
    const op = OPS[node.operator];
    // build-time arithmetic on JS values
    const jsy = (v) => v.k === "js" || v.k === "str" || v.k === "undef";
    if ((jsy(a) || jsy(b)) && !(isNum(a) && b.k === "undef") && !(isNum(b) && a.k === "undef")) {
      const A = a.k === "c" ? Number(a.v) : a.v, B = b.k === "c" ? Number(b.v) : b.v;
      if ((jsy(a) || isC(a)) && (jsy(b) || isC(b))) return this.toVal(jsOp(node.operator, A, B));
      this.fail(fr, node, `${a.k === "str" || b.k === "str" ? "a string" : "a build-time value"} meets a hardware value in ${node.operator}`);
    }
    if (a.k === "undef" || b.k === "undef") {
      if (node.operator === "===" || node.operator === "==") return C(a.k === b.k ? 1 : 0, BIT);
      if (node.operator === "!==" || node.operator === "!=") return C(a.k === b.k ? 0 : 1, BIT);
      this.fail(fr, node, "undefined in arithmetic");
    }
    if (!op) {
      if (isC(a) && isC(b)) return this.toVal(jsOp(node.operator, Number(a.v), Number(b.v)));
      if (node.operator === "/" || node.operator === "%") this.fail(fr, node, `${node.operator} is not a hardware operator: divide by a power of two with >>, or use a table`, "type");
      this.fail(fr, node, `${node.operator} is not a hardware operator`, "type");
    }
    return this.op(fr, node, () => o.bin(op, a, b));
  }

  // ---------- assignment ----------
  evAssign(node, fr, env) {
    const opMap = { "+=": "add", "-=": "sub", "*=": "mul", "&=": "and", "|=": "or", "^=": "xor", "<<=": "shl", ">>=": "shr", ">>>=": "shr" };
    if (node.operator === "=") {
      const tT = this.targetType(node.left, fr, env);
      const v = this.ev(node.right, fr, env, tT);
      return this.assignTo(node.left, fr, env, () => v, node, false);
    }
    const op = opMap[node.operator];
    if (!op) this.fail(fr, node, `${node.operator} is not a hardware operator`);
    const r = this.ev(node.right, fr, env);
    return this.assignTo(node.left, fr, env, (cur) => this.ops.bin(op, cur, r), node, true);
  }
  // the type a target holds (so a bare wrap()/sat() on the right knows where it goes)
  targetType(t, fr, env) {
    try {
      if (t.type === "Identifier") { const b = this.lookupBinding(env, t.name); const v = b ? this.readVar(fr, b) : null; return v?.T || null; }
      const p = this.targetPath(t, fr, env, false);
      if (!p) return null;
      return p.T;
    } catch { return null; }
  }
  // resolve $.x / $.x[i] / $.x.f / $.x[i].f to { sig, index (Value|null), field, bit, T }
  targetPath(t, fr, env, strict = true) {
    const chain = [];
    let n = t;
    while (n.type === "MemberExpression") {
      const obj = n.object;
      if (obj.type === "Identifier" && this.lookupBinding(env, obj.name) && this.readVar(fr, this.lookupBinding(env, obj.name)).k === "self") {
        if (n.computed) this.fail(fr, n, "$[…] is not allowed: name the signal");
        chain.unshift({ kind: "name", name: n.property.name });
        break;
      }
      chain.unshift(n.computed ? { kind: "index", node: n.property } : { kind: "field", name: n.property.name });
      n = obj;
    }
    if (!chain.length || chain[0].kind !== "name") return null;
    const name = chain[0].name;
    if (fr.mode === "stage") return { stage: name, T: this.stageVals?.get(name)?.T || null, rest: chain.slice(1) };
    const sig = this.sigs.get(name);
    if (!sig) { if (strict) this.fail(fr, t, `${this.path} has no signal ${name}`); return null; }
    const res = { sig, T: sig.T, rest: chain.slice(1) };
    if (sig.elems && res.rest[0]?.kind === "index") {
      const idx = this.ev(res.rest[0].node, fr, env);
      res.index = idx;
      res.T = sig.T.elem;
      res.rest = res.rest.slice(1);
    }
    for (const r of res.rest) {
      if (r.kind === "field" && res.T?.k === "struct") res.T = res.T.fields.find(([n]) => n === r.name)?.[1] || null;
      else if (r.kind === "index") res.T = res.T?.k === "vec" ? res.T.elem : BIT;
    }
    return res;
  }
  // assign through a target; f(current) → new value. compound=true wraps into the target (+= wraps by definition)
  assignTo(t, fr, env, f, node, compound, prefix = true) {
    const o = this.ops;
    if (t.type === "Identifier") {
      const b = this.lookupBinding(env, t.name);
      if (!b) this.fail(fr, t, `\`${t.name}\` is not a local of this lambda: write signals as $.${t.name}`, "capture");
      if (b.const) this.fail(fr, t, `\`${t.name}\` is const`);
      const cur = this.readVar(fr, b);
      let v = f(cur);
      // a hardware local wraps like a signal (+= wraps by definition); a build-time constant (a loop counter) is plain JS
      if (compound && isNum(cur) && isNum(v) && T.isScalar(cur.T) && !(isC(cur) && isC(v))) v = o.cast(v, cur.T, "wrap");
      if (this.dead(fr)) return v;
      // a local assigned under a condition merges at the end of the branch (mergeBranches)
      this.writeVar(fr, b, v);
      return prefix ? v : cur;
    }
    if (t.type !== "MemberExpression") this.fail(fr, t, "assign to $.signal or a local");
    const p = this.targetPath(t, fr, env);
    if (!p) this.fail(fr, t, "only $.signals and locals can be assigned in hardware");
    o.origin = this.origin(fr, node);
    if (p.stage != null) {
      if (p.rest.length) this.fail(fr, t, "stage values are written whole");
      const cur = this.stageVals.get(p.stage) || C(0);
      let v = f(cur);
      if (compound && isNum(cur) && T.isScalar(cur.T)) v = o.cast(v, cur.T, "wrap");
      this.stageVals.set(p.stage, isOne(fr.pc) || !this.stageVals.has(p.stage) ? v : o.mux(fr.pc, v, cur));
      return v;
    }
    const sig = p.sig;
    if (sig.store === "input") this.fail(fr, t, `${sig.path} is an input`, "driver");
    if (sig.store === "ram") this.fail(fr, t, `write a memory with ${sig.name}.write(address, value)`, "memory");
    if (sig.role === "knob") this.err(`${sig.path} is a knob: the host writes it; hardware writes would fight the host`, this.pos(fr, t), "driver", "warn");
    if (fr.mode === "assert") this.fail(fr, t, "asserts observe; they cannot write signals", "assert");
    if (sig.store === "reg" && fr.mode === "comb") this.fail(fr, t, `${sig.path} is a register (written in a clocked block); .comb() writes wires`, "driver");
    if (sig.store === "wire" && fr.mode !== "comb") this.fail(fr, t, `${sig.path} is a wire (written in .comb()); a clocked block cannot write it`, "driver");
    if (sig.role === "state") this.fail(fr, t, "the state register is written by returning a state name", "fsm");
    // which element(s)
    const targets = [];
    if (p.index != null) {
      if (isC(p.index)) {
        const i = Number(p.index.v);
        if (i < 0 || i >= sig.elems.length) this.fail(fr, t, `index ${i} is outside ${sig.path}`);
        targets.push({ e: sig.elems[i], guard: fr.pc });
      } else for (let i = 0; i < sig.elems.length; i++) targets.push({ e: sig.elems[i], guard: o.and(fr.pc, o.bin("eq", p.index, C(i))) });
    } else {
      if (sig.elems && p.rest.length === 0) {
        // whole-vector write: element by element
        const curW = o.vecWhole({ k: "vecsig", sig });
        const v = f(curW);
        sig.elems.forEach((e, i) => this.pushWrite(e, fr, fr.pc, o.elemOf(isNum(v) ? v : o.cast(v, sig.T, "fit"), C(i)), node, false));
        return v;
      }
      targets.push({ e: sig, guard: fr.pc });
    }
    let last = UNDEF;
    for (const { e, guard } of targets) {
      if (isZero(guard)) continue;
      let value;
      if (!p.rest.length) {
        value = f(o.N(e.node));
        if (compound) value = this.op(fr, node, () => o.cast(value, e.T, "wrap"));
        last = value;
        this.pushWrite(e, fr, guard, value, node, compound);
      } else {
        // a field or bit of the signal: rebuild the whole value around it
        const curNow = o.N(e.node);
        const sub = this.subRead(curNow, p.rest, fr, env, t);
        let v = f(sub);
        if (compound) v = o.cast(v, sub.T, "wrap");
        last = v;
        const whole = this.subWrite(this.pending(e), p.rest, v, fr, env, t);
        this.pushWrite(e, fr, guard, whole, node, false);
      }
    }
    return last;
  }
  subRead(v, rest, fr, env, t) {
    for (const r of rest) v = r.kind === "field" ? this.ops.field(v, r.name) : this.member(v, this.ev(r.node, fr, env), true, fr, t);
    return v;
  }
  subWrite(whole, rest, v, fr, env, t) {
    const o = this.ops;
    const [r, ...more] = rest;
    if (r.kind === "field") {
      if (whole.T.k !== "struct") this.fail(fr, t, `.${r.name} of a ${T.typeName(whole.T)}`);
      const fields = new Map();
      for (const [n] of whole.T.fields) fields.set(n, n === r.name ? (more.length ? this.subWrite(o.field(whole, n), more, v, fr, env, t) : v) : o.field(whole, n));
      return o.cast({ k: "rec", fields }, whole.T, "fit", (m) => this.err(m, this.pos(fr, t), "width"));
    }
    // a bit of a scalar
    const idx = this.ev(r.node, fr, env);
    if (!isC(idx)) this.fail(fr, t, "writing one bit needs a constant index (or write the whole value)");
    const i = Number(idx.v), W = whole.T.w;
    const parts = [];
    if (i < W - 1) parts.push(o.nid(o.slice(whole, W - 1, i + 1)));
    parts.push(o.nid(o.cast(o.truth(v), BIT, "fit")));
    if (i > 0) parts.push(o.nid(o.slice(whole, i - 1, 0)));
    const cat = parts.length === 1 ? o.N(parts[0]) : o.N(o.add("concat", parts, T.u(W)));
    return o.cast(cat, whole.T, "as");
  }
  // the value a signal will take if nothing else writes it this cycle (for partial writes)
  pending(sig) {
    const o = this.ops;
    let cur = sig.store === "reg" ? (sig.pulse ? C(0, sig.T) : o.N(sig.node)) : C(0, T.isScalar(sig.T) ? sig.T : undefined);
    if (!T.isScalar(sig.T) && sig.store !== "reg") cur = o.N(o.kc(T.isBig(sig.T) ? 0n : 0, sig.T));
    for (const w of sig.writes) cur = o.mux(w.guard, o.cast(w.value, sig.T, "wrap"), cur);
    return cur;
  }
  pushWrite(sig, fr, guard, value, node, compound) {
    const o = this.ops;
    let v = value;
    if (!compound) {
      v = this.op(fr, node, () => o.cast(value, sig.T, "fit", (m) => this.err(`${sig.path} = …: ${m}`, this.pos(fr, node), "width")));
    }
    sig.writes.push({ guard, value: v, origin: this.origin(fr, node), line: this.pos(fr, node).line });
    if (sig.store === "wire") { fr.assigned.add(sig.path); fr.wrote?.add(sig.path); }
  }

  // ---------- calls ----------
  evCall(node, fr, env, expect) {
    const o = this.ops;
    const callee = node.callee;
    if (callee.type === "MemberExpression" && !callee.computed) {
      const m = callee.property.name;
      const objV = this.ev(callee.object, fr, env);
      if (objV.k === "self") return this.selfCall(m, node, fr, env, expect);
      if (objV.k === "ram") return this.ramCall(objV.sig, m, node, fr, env);
      if (isNum(objV) || objV.k === "vecsig") {
        const v = objV.k === "vecsig" ? o.vecWhole(objV) : objV;
        o.origin = this.origin(fr, node);
        if (m === "bits") {
          const [hi, lo] = node.arguments.map((a) => this.ev(a, fr, env));
          if (!isC(hi) || (lo && !isC(lo))) this.fail(fr, node, ".bits(hi, lo) takes constants");
          return this.op(fr, node, () => o.slice(v, Number(hi.v), lo ? Number(lo.v) : Number(hi.v)));
        }
        if (m === "as") {
          const t = this.ev(node.arguments[0], fr, env);
          if (t.k !== "type") this.fail(fr, node, ".as() takes a type");
          return this.op(fr, node, () => o.cast(v, t.T, "as"));
        }
        this.fail(fr, node, `a ${T.typeName(v.T)} has no method .${m}() (it has .bits(hi, lo) and .as(type))`);
      }
      if (objV.k === "type" && m === "init") return { k: "type", T: objV.T.init(this.jsOf(this.ev(node.arguments[0], fr, env))) };
      if (objV.k === "js" || objV.k === "str" || objV.k === "rom") {
        const base = objV.k === "rom" ? objV.rom.table : objV.v;
        const f = base?.[m];
        if (typeof f !== "function") this.fail(fr, node, `.${m}() is not a function here`);
        const args = node.arguments.map((a) => this.ev(a, fr, env));
        if (!args.every((a) => a.k === "c" || a.k === "js" || a.k === "str" || a.k === "type")) this.fail(fr, node, `.${m}() runs at build time, so its arguments must be constants`);
        try { return this.toVal(f.apply(base, args.map((a) => this.jsOf(a)))); }
        catch (e) { this.fail(fr, node, `.${m}(): ${e.message}`); }
      }
      this.fail(fr, node, `.${m}() is not available on this value`);
    }
    const f = this.ev(callee, fr, env);
    if (f.k === "builtin") return this.builtin(f.name, node, fr, env, expect);
    if (f.k === "js" && typeof f.v === "function") {
      const fn = f.v;
      if (TYPE_FNS.has(fn) || /\[native code\]/.test(Function.prototype.toString.call(fn))) {
        const args = node.arguments.map((a) => this.ev(a, fr, env));
        if (!args.every((a) => a.k === "c" || a.k === "js" || a.k === "str" || a.k === "type")) this.fail(fr, node, `${f.name || fn.name || "this function"}() runs at build time, so its arguments must be constants`);
        try { return this.toVal(fn.apply(f.self ?? null, args.map((a) => this.jsOf(a)))); }
        catch (e) { this.fail(fr, node, `${f.name || fn.name}(): ${e.message}`); }
      }
      return this.inline(fn, f.name || fn.name, node, fr, env);
    }
    if (f.k === "js" && f.fnNode) this.fail(fr, node, "a lambda inside a hardware lambda cannot be called");
    this.fail(fr, node, `${callee.type === "Identifier" ? callee.name : "this"} is not a function`);
  }
  jsOf(v) {
    if (v.k === "c") return typeof v.v === "bigint" ? v.v : v.v;
    if (v.k === "type") return v.T;
    if (v.k === "str" || v.k === "js") return v.v;
    return undefined;
  }
  // a .lib() helper: re-parsed and inlined at the call, with its own locals
  inline(fn, name, node, fr, env) {
    if (fr.depth > HELPER_DEPTH) this.fail(fr, node, `helpers nest more than ${HELPER_DEPTH} deep (recursion is not hardware)`);
    let parsed;
    try { parsed = parseLambda(fn); } catch (e) { this.fail(fr, node, `cannot read the helper ${name}: ${e.message}`); }
    const args = node.arguments.map((a) => this.ev(a, fr, env));
    const lam = this.I.helperLams?.get(fn) || { parsed, base: this.L.E.locate(parsed.src), line: null, src: parsed.src };
    const sub = { ...fr, lam, returns: [], depth: fr.depth + 1, retCount: 0, loop: null, helper: name, overlays: [] };
    const henv = { vars: new Map(), parent: null };
    parsed.params.forEach((pat, i) => this.bindPattern(pat, args[i] ?? UNDEF, henv, sub));
    let result;
    try {
      if (parsed.exprBody) result = this.ev(parsed.body, sub, henv);
      else { this.execList(parsed.body.body, sub, henv); result = this.returnValue(sub); }
    } catch (e) {
      if (e instanceof LowerError && !e.at) e.at = this.pos(fr, node);
      throw e;
    }
    // side effects (writes, pushes) already happened under sub's path conditions; the caller continues as before
    fr.assigned = sub.assigned;
    for (const s of sub.pushed) fr.pushed.add(s);
    return result;
  }
  builtin(name, node, fr, env, expect) {
    const o = this.ops;
    const A = node.arguments;
    const typeArg = (i) => { if (!A[i]) return null; const t = this.ev(A[i], fr, env); if (t.k !== "type") this.fail(fr, A[i], `${name}() takes a type here`); return t.T; };
    switch (name) {
      case "wrap": case "sat": {
        const Tt = typeArg(1) || expect;
        if (!Tt) this.fail(fr, node, `${name}() needs to know its type here: ${name}(x, u(8)), or use it where the target says (an assignment, a comparison, an address)`, "width");
        const v = this.ev(A[0], fr, env);
        o.origin = this.origin(fr, node);
        return this.op(fr, node, () => o.cast(v, Tt, name));
      }
      case "past": {
        const v = this.ev(A[0], fr, env);
        const n = A[1] ? Number(this.ev(A[1], fr, env).v) : 1;
        let cur = v;
        for (let k = 0; k < n; k++) cur = this.monitorReg(cur, `past${this.mon++}`, node, fr);
        return cur;
      }
      case "within": {
        const nV = this.ev(A[0], fr, env);
        if (!isC(nV)) this.fail(fr, node, "within(n, …) takes a constant number of cycles");
        const n = Number(nV.v);
        const c = o.truth(this.ev(A[1], fr, env));
        const active = fr.pc;
        const w = T.bitlen(n + 1) || 1;
        const g = this.g;
        o.origin = this.origin(fr, node);
        const r = g.add("reg", [], T.u(w), { path: `${this.path}.within${this.mon++}`, init: 0, next: null, module: this.path, monitor: "within" }, o.origin);
        const R = o.N(r);
        const nxt = o.mux(o.or(c, o.not(active)), C(0, T.u(w)), o.mux(o.bin("ge", R, C(n)), R, o.cast(o.bin("add", R, C(1)), T.u(w), "wrap")));
        g.setNext(r, o.nid(nxt));
        return o.or(c, o.bin("lt", R, C(n)));
      }
      case "sequence": {
        const cs = A.map((a) => o.truth(this.ev(a, fr, env)));
        let st = null;
        for (let i = 0; i < cs.length; i++) {
          const here = st ? o.and(st, cs[i]) : cs[i];
          if (i === cs.length - 1) return here;
          st = this.monitorReg(here, `seq${this.mon++}`, node, fr);
        }
        return ONE;
      }
    }
    this.fail(fr, node, `${name}() is not known`);
  }
  monitorReg(v, name, node, fr) {
    const o = this.ops, g = this.g;
    if (v.k === "vecsig") v = o.vecWhole(v);
    if (!isNum(v)) this.fail(fr, node, "past() takes a value");
    o.origin = this.origin(fr, node);
    const r = g.add("reg", [], v.T, { path: `${this.path}.${name}`, init: T.isBig(v.T) ? 0n : 0, next: null, module: this.path, monitor: true }, o.origin);
    g.setNext(r, o.nid(v));
    return o.N(r);
  }
  // $.push / $.has / $.take
  selfCall(m, node, fr, env, expect) {
    const o = this.ops;
    const A = node.arguments;
    const nameOf = () => {
      const v = this.ev(A[0], fr, env);
      if (v.k !== "str") this.fail(fr, A[0] || node, `$.${m}() names a stream with a string (a literal or a .lib() constant)`);
      const S = this.L.streams.get(v.v);
      if (!S) this.fail(fr, A[0], `there is no stream "${v.v}"`, "link");
      return S;
    };
    o.origin = this.origin(fr, node);
    if (m === "push") {
      const S = nameOf();
      if (S.producer?.path !== this.path) this.fail(fr, node, `${this.path} pushes to "${S.name}" but does not .provides() it`, "link");
      if (fr.mode === "comb" || fr.mode === "assert") this.fail(fr, node, "$.push() belongs in a clocked block", "stream");
      const v = this.ev(A[1], fr, env, S.T || null);
      const value = S.T ? this.op(fr, node, () => o.cast(v, S.T, "fit", (msg) => this.err(`push to ${S.name}: ${msg}`, this.pos(fr, node), "width"))) : v;
      if (!isZero(fr.pcv)) S.pushes.push({ guard: fr.pc, guardv: fr.pcv, value, at: this.pos(fr, node), origin: this.origin(fr, node) });
      fr.pushed.add(S.name);
      return o.N(S.pReady);
    }
    if (m === "has" || m === "take") {
      const S = nameOf();
      const view = this.L.view(S, this.I, this.pos(fr, node));
      if (m === "has") return o.N(view.valid);
      if (fr.mode === "comb" || fr.mode === "assert") this.fail(fr, node, "$.take() belongs in a clocked block", "stream");
      const data = o.N(view.data());
      this.ready(S.name, fr.pc);
      return data;
    }
    this.fail(fr, node, `$.${m}() is not a hardware call ($.push, $.has, $.take)`);
  }
  ramCall(sig, m, node, fr, env) {
    const o = this.ops;
    const A = node.arguments;
    o.origin = this.origin(fr, node);
    if (m === "write") {
      const addr = this.ev(A[0], fr, env, sig.aT), data = this.ev(A[1], fr, env, sig.T);
      if (fr.mode === "comb" || fr.mode === "assert") this.fail(fr, node, "memories are written in clocked blocks", "memory");
      const a = this.op(fr, node, () => o.cast(addr, sig.aT, "fit", (msg) => this.err(`${sig.name}.write address: ${msg}`, this.pos(fr, node), "width")));
      const d = this.op(fr, node, () => o.cast(data, sig.T, "fit", (msg) => this.err(`${sig.name}.write value: ${msg}`, this.pos(fr, node), "width")));
      if (!isZero(fr.pc)) sig.writes.push({ guard: fr.pc, addr: a, data: d, origin: this.origin(fr, node) });
      return UNDEF;
    }
    if (m === "read") {
      const addr = this.ev(A[0], fr, env, sig.aT);
      const a = this.op(fr, node, () => o.cast(addr, sig.aT, "fit", (msg) => this.err(`${sig.name}.read address: ${msg}`, this.pos(fr, node), "width")));
      this.ramQ(sig);
      if (!isZero(fr.pc)) sig.reads.push({ guard: fr.pc, addr: a, origin: this.origin(fr, node) });
      return UNDEF;
    }
    this.fail(fr, node, `a memory has .q, .read(address) and .write(address, value)`, "memory");
  }
  streamType(S, at) { return this.L.streamType(S, at); }
}

// ---------- small helpers ----------
function initOf(Ty, initVal, i = null) {
  let v = initVal ?? 0;
  if (Array.isArray(v)) v = v[i ?? 0] ?? 0;
  return T.isBig(Ty) ? BigInt(v) : typeof v === "bigint" ? Number(v) : +v;
}
function selfOf(parsed) { const p = parsed.params[0]; return p && p.type === "Identifier" ? p.name : null; }
function selfMembers(parsed) {
  const self = selfOf(parsed), out = new Set();
  const visit = (n) => {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "MemberExpression" && n.object.type === "Identifier" && n.object.name === self && !n.computed) out.add(n.property.name);
    for (const k in n) { if (k === "loc") continue; const v = n[k]; if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v.type === "string") visit(v); }
  };
  visit(parsed.node.body);
  return out;
}
function isBareWrap(n) { return n.type === "CallExpression" && n.callee.type === "Identifier" && (n.callee.name === "wrap" || n.callee.name === "sat") && n.arguments.length === 1; }
function jsOp(op, a, b) {
  switch (op) {
    case "+": return a + b; case "-": return a - b; case "*": return a * b; case "/": return a / b; case "%": return a % b; case "**": return a ** b;
    case "&": return a & b; case "|": return a | b; case "^": return a ^ b; case "<<": return a << b; case ">>": return a >> b; case ">>>": return a >>> b;
    case "==": case "===": return a === b; case "!=": case "!==": return a !== b;
    case "<": return a < b; case "<=": return a <= b; case ">": return a > b; case ">=": return a >= b;
    case "in": return a in b; case "instanceof": return false;
  }
  throw new LowerError(`operator ${op}`);
}
function dedupe(ts) { const seen = new Set(); return ts.filter((t) => { const k = t.from + ">" + t.to; if (seen.has(k)) return false; seen.add(k); return true; }); }
export { Ops, C as constValue };
