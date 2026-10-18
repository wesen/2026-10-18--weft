// The compile pipeline (owner B): stages and passes over the per-domain DAGs (decision D11), custom passes,
// analyses and rewrites written in the design script, the technology/timing estimate and the build report.
//
//   runPipeline(ctx) → { stages, report, emits, levels }
//
// ctx is the compiled design as fork A builds it (ARCH §3, §7): { domains, instances, streams, cells, pins,
// knobs, asserts, board, target, compileCfg, diags, hir, timings, name }. Graphs in ctx.domains are optimized
// in place; `levels` keeps clones at "lower" (before optimize) and "dag" (before map).
import * as acorn from "acorn";
import { Graph, PURE, STATEFUL } from "./ir.js";
import { u, s, vec, typeName, binType, unType, shiftType, evalOp, wrapTo, satTo, isBig, clog2, constType, fits, join as joinType } from "./types.js";
import { estimate, timingOf, partInfo, familyOf, FAMILY, classifyMemories, synthLive, pathModule, nodeCost } from "./estimate.js";
import { emitVerilog, encodeValue } from "./verilog.js";

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const round = (x, d = 2) => (x == null || !isFinite(x) ? x : Math.round(x * 10 ** d) / 10 ** d);
const hidden = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: false, configurable: true, writable: true });
const camel = (name) => String(name).replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : "")).replace(/^./, (c) => c.toLowerCase());
const isBigV = (v) => typeof v === "bigint";
const toBig = (v) => (isBigV(v) ? v : BigInt(v));
const eqVal = (a, b) => toBig(a) === toBig(b);
const COMMUTATIVE = new Set(["add", "mul", "and", "or", "xor", "eq", "ne", "land", "lor"]);
const ROUTING = new Set(["const", "zext", "sext", "wrap", "slice", "concat", "pack", "field"]);

// ═════════════════════════════════════════════ pass, analysis, rewrite, backend ═════════════════════════════
const PASS = Symbol.for("weft.pass");
export class PassDef {
  constructor(kind, name, f = {}) {
    Object.assign(this, { kind, name, level: "dag", reqs: [], pres: [], pparams: {}, ro: false, visits: [], runFn: null, emitFn: null, std: false, impl: null, scope: "graph", by: null }, f);
    this[PASS] = true;
  }
  _c(f) { return new PassDef(this.kind, this.name, { ...this, ...f }); }
  on(level) { return this._c({ level }); }
  requires(...as) { return this._c({ reqs: [...this.reqs, ...as.flat()] }); }
  preserves(...names) { return this._c({ pres: [...this.pres, ...names.flat()] }); }
  params(p) { return this._c({ pparams: { ...this.pparams, ...p } }); }
  with(p) { return this._c({ pparams: { ...this.pparams, ...p } }); }
  readonly() { return this._c({ ro: true }); }
  visit(ops, fn) { return this._c({ visits: [...this.visits, { ops: [ops].flat(), fn }] }); }
  run(fn) { return this._c({ runFn: fn }); }
  emit(fn) { return this._c({ emitFn: fn }); }
  toString() { return `${this.kind} ${this.name}`; }
}
export const pass = (name) => new PassDef("pass", name);
export const analysis = (name) => new PassDef("analysis", name);
export const backend = (name) => new PassDef("backend", name, { level: "net" });

// rewrite rules: patterns written as hardware lambdas (parsed here), a builder-lambda guard and examples
export class RuleDef {
  constructor(name, f = {}) { Object.assign(this, { kind: "rewrite", name, fromFn: null, whereFn: null, toFn: null, exampleList: [] }, f); this[PASS] = true; }
  _c(f) { return new RuleDef(this.name, { ...this, ...f }); }
  from(fn) { return this._c({ fromFn: fn }); }
  where(fn) { return this._c({ whereFn: fn }); }
  to(fn) { return this._c({ toFn: fn }); }
  examples(list) { return this._c({ exampleList: list || [] }); }
  get level() { return "dag"; }
  toString() { return `rewrite ${this.name}`; }
}
export const rewrite = (name) => new RuleDef(name);

// ═════════════════════════════════════════════ standard passes ═════════════════════════════════════════════
// passes that fork A runs inside front.js / lower.js; the pipeline records them with A's timings
const EXTERNAL = { parse: "front", elaborate: "front", link: "front", "fsm.extract": "lower", "pipeline.registers": "lower", "stream.lower": "lower", "csr.collect": "lower", flatten: "lower", widths: "lower" };
const stdPass = (name, impl, f = {}) => new PassDef("pass", name, { std: true, impl, ...f });
const ext = (name) => stdPass(name, null, { external: EXTERNAL[name], level: EXTERNAL[name] === "front" ? "hir" : "dag" });

export const STD_PASSES = {
  parse: ext("parse"), elaborate: ext("elaborate"), link: ext("link"),
  fsm: { extract: ext("fsm.extract"), encode: stdPass("fsm.encode", (r) => fsmEncode(r), { scope: "design", level: "net" }) },
  pipeline: { registers: ext("pipeline.registers"), cut: stdPass("pipeline.cut", (r, p) => pipelineCut(r, p), { scope: "design" }) },
  stream: { lower: ext("stream.lower") },
  csr: { collect: ext("csr.collect") },
  flatten: ext("flatten"), widths: ext("widths"),
  checks: {
    loops: stdPass("checks.loops", (r, p, g) => checkLoops(r, g), { ro: true }),
    latches: stdPass("checks.latches", (r, p, g) => checkLatches(r, g), { ro: true }),
    cdc: stdPass("checks.cdc", (r) => checkCdc(r), { scope: "design", ro: true }),
  },
  constFold: stdPass("constFold", (r, p, g) => constFold(r, g)),
  cse: stdPass("cse", (r, p, g) => cse(r, g)),
  muxTree: stdPass("muxTree", (r, p, g) => muxTree(r, g)),
  dce: stdPass("dce", (r, p, g) => dce(r, g)),
  retime: stdPass("retime", (r, p) => retime(r, p), { scope: "design", pparams: { moves: "forward" } }),
  mem: { infer: stdPass("mem.infer", (r) => memInfer(r), { scope: "design", level: "net" }) },
  dsp: { pack: stdPass("dsp.pack", (r) => dspPack(r), { scope: "design", level: "net" }) },
  srl: { infer: stdPass("srl.infer", (r) => srlInfer(r), { scope: "design", level: "net", ro: true }) },
  techmap: stdPass("techmap", (r) => techmap(r), { scope: "design", level: "net" }),
  place: stdPass("place", (r, p) => place(r, p), { scope: "design", level: "phys", pparams: { effort: "normal" } }),
  route: stdPass("route", (r, p) => route(r, p), { scope: "design", level: "phys" }),
  timing: stdPass("timing", (r) => timingPass(r), { scope: "design", level: "phys", ro: true }),
  saturate: (rules, opts = {}) => stdPass("saturate", (r, p) => saturate(r, [rules].flat(), { iters: 6, cost: "luts", ...opts, ...p }), { scope: "design", rules: [rules].flat() }),
};
const flatStd = new Map();
(function index(o) {
  for (const v of Object.values(o)) {
    if (v instanceof PassDef) flatStd.set(v.name, v);
    else if (v && typeof v === "object") index(v);
  }
})(STD_PASSES);
// a pass value from the script: ours, a std pass by name, or a lookalike from another std object
function resolvePass(p) {
  if (p instanceof PassDef || p instanceof RuleDef) return p;
  if (typeof p === "string") return flatStd.get(p) || null;
  if (p && typeof p === "object" && p.name) {
    if (typeof p.from === "function" && (p.fromFn || p.toFn)) return new RuleDef(p.name, p);
    const base = flatStd.get(p.name);
    if (base) return p.params && typeof p.params === "object" ? base.with(p.params) : base;
  }
  return null;
}

// analyses (cached per domain, invalidated by passes that change the graph and do not preserve them)
export const STD_ANALYSES = {
  timing: new PassDef("analysis", "timing", { std: true, runFn: null, impl: (r, g) => timingAnalysis(r, g) }),
  widths: new PassDef("analysis", "widths", { std: true, impl: (r, g) => new Map(g.live().map((n) => [n.id, n.type.w])) }),
  domains: new PassDef("analysis", "domains", { std: true, impl: (r, g) => new Map(g.live().map((n) => [n.id, g.domain])) }),
  fanout: new PassDef("analysis", "fanout", { std: true, impl: (r, g) => new Map(g.live().map((n) => [n.id, g.users(n.id).length])) }),
};

// the D11 default pipeline
const S = STD_PASSES;
export const STD_PIPELINE = Object.freeze({
  name: "default",
  stages: [
    { name: "front", level: "hir", passes: [S.parse, S.elaborate, S.link] },
    { name: "lower", level: "dag", passes: [S.fsm.extract, S.pipeline.registers, S.stream.lower, S.csr.collect, S.flatten, S.widths, S.checks.loops, S.checks.latches, S.checks.cdc] },
    { name: "optimize", level: "dag", passes: [S.constFold, S.cse, S.muxTree, S.dce], fixpoint: { max: 8 } },
    { name: "time", level: "dag", passes: [S.pipeline.cut, S.retime] },
    { name: "map", level: "net", passes: [S.mem.infer, S.dsp.pack, S.fsm.encode, S.techmap], family: { xc7: [S.srl.infer] } },
    { name: "back", level: "phys", passes: [S.place, S.route, S.timing] },
  ],
});
const STAGE_LEVEL = { front: "hir", lower: "dag", optimize: "dag", time: "dag", map: "net", back: "phys" };

// ═════════════════════════════════════════════ the .compile(c => …) recorder ═══════════════════════════════
class StageB {
  constructor() { this.passes = []; this.fix = null; }
  pass(...ps) { for (const p of ps.flat()) this.passes.push(p); return this; }
  fixpoint(o = {}) { this.fix = { max: o.max ?? 8 }; return this; }
}
class ExploreB {
  constructor() { this.spec = { knobs: [], pareto: [], parallel: 1, report: null }; }
  knob(path, values) { this.spec.knobs.push({ path, values: [values].flat() }); return this; }
  measure(fn) { hidden(this.spec, "measure", fn); return this; }
  keep(fn) { hidden(this.spec, "keep", fn); return this; }
  pareto(keys) { this.spec.pareto = [keys].flat(); return this; }
  parallel(n) { this.spec.parallel = n; return this; }
  report(path) { this.spec.report = path; return this; }
}
export class CompilerB {
  constructor(target = null) {
    this.target = target;
    this.plan = null;                 // [{ name, level, passes: [PassDef], fixpoint }]
    this.cacheDir = null; this.verify = false; this.validateOpts = null; this.explain = false;
    this.snapshots = []; this.inspects = []; this.checks = []; this.emits = []; this.exploreSpec = null;
    this.errors = [];
    this.log = [];
  }
  _ensure(custom = false) {
    if (!this.plan) this.plan = custom ? [] : clonePlan(STD_PIPELINE, this.target);
    return this.plan;
  }
  use(pipeline) {
    const p = pipeline && (pipeline.stages || (Array.isArray(pipeline) ? pipeline : null));
    if (!p) { this.errors.push(`use(): not a pipeline`); return this; }
    this.plan = clonePlan({ stages: p }, this.target);
    this.log.push("use " + (pipeline.name || "pipeline"));
    return this;
  }
  stage(name, fn) {
    const plan = this._ensure(true);
    const b = new StageB();
    try { fn?.(b); } catch (e) { this.errors.push(`stage("${name}"): ${e.message}`); }
    const st = { name, level: STAGE_LEVEL[name] || guessLevel(b.passes), passes: b.passes.map(resolveOrKeep), fixpoint: b.fix };
    const i = plan.findIndex((x) => x.name === name);
    if (i >= 0) plan[i] = st; else plan.push(st);
    return this;
  }
  _insert(where, name, fn) {
    const plan = this._ensure();
    const b = new StageB();
    try { fn?.(b); } catch (e) { this.errors.push(`${where}("${name}"): ${e.message}`); }
    const passes = b.passes.map(resolveOrKeep);
    const si = plan.findIndex((x) => x.name === name);
    if (si >= 0) {
      const lvl = plan[si].level;
      plan.splice(where === "after" ? si + 1 : si, 0, { name: `${where} ${name}`, level: lvl, passes, fixpoint: b.fix, inserted: true });
      return this;
    }
    for (const st of plan) {
      const pi = st.passes.findIndex((p) => p?.name === name);
      if (pi >= 0) { st.passes.splice(where === "after" ? pi + 1 : pi, 0, ...passes); return this; }
    }
    this.errors.push(`${where}("${name}"): no stage or pass by that name`);
    return this;
  }
  after(name, fn) { return this._insert("after", name, fn); }
  before(name, fn) { return this._insert("before", name, fn); }
  replace(name, p) {
    const plan = this._ensure();
    const np = resolveOrKeep(p);
    for (const st of plan) {
      const pi = st.passes.findIndex((x) => x?.name === name);
      if (pi >= 0) { st.passes[pi] = np; return this; }
    }
    this.errors.push(`replace("${name}"): no pass by that name`);
    return this;
  }
  remove(name) {
    const plan = this._ensure();
    for (const st of plan) st.passes = st.passes.filter((x) => x?.name !== name);
    return this;
  }
  when(pred, fn) {
    let ok = false;
    try { ok = !!pred(this.target || {}); } catch (e) { this.errors.push(`when(): ${e.message}`); }
    if (ok) { try { fn(this); } catch (e) { this.errors.push(`when(): ${e.message}`); } }
    return this;
  }
  cache(dir) { this.cacheDir = dir || ".weft/cache"; return this; }
  verifyEach() { this.verify = true; return this; }
  validate(opts = {}) { this.validateOpts = { cycles: 48, seed: 1, ...opts }; return this; }
  snapshot(level, opts = {}) { this.snapshots.push({ level, ...opts }); return this; }
  inspect(level, fn, opts = {}) { this.inspects.push({ level, fn, ...opts }); return this; }
  check(name, fn) { this.checks.push({ name, fn }); return this; }
  emit(b, opts = {}) { this.emits.push({ backend: b, opts }); return this; }
  explore(fn) {
    const x = new ExploreB();
    try { fn(x); } catch (e) { this.errors.push(`explore(): ${e.message}`); }
    this.exploreSpec = x.spec;
    return this;
  }
  explainPlan() { this.explain = true; return this; }
}
function resolveOrKeep(p) { return resolvePass(p) || p; }
function guessLevel(passes) {
  const names = passes.map((p) => p?.name);
  if (names.some((n) => ["place", "route", "timing"].includes(n))) return "phys";
  if (names.some((n) => ["techmap", "mem.infer", "dsp.pack"].includes(n))) return "net";
  if (names.some((n) => EXTERNAL[n] === "front")) return "hir";
  return "dag";
}
function clonePlan(pl, target) {
  const fam = target?.family;
  return pl.stages.map((st) => ({
    name: st.name, level: st.level || STAGE_LEVEL[st.name] || "dag", fixpoint: st.fixpoint || null,
    passes: [...st.passes.map(resolveOrKeep), ...((st.family && fam && st.family[fam]) || [])],
  }));
}
// apply the recorded configuration: a lambda, a list of calls, or nothing
export function configure(compileCfg, target) {
  const c = new CompilerB(target);
  if (!compileCfg) return c;
  try {
    if (typeof compileCfg === "function") compileCfg(c);
    else {
      const calls = Array.isArray(compileCfg) ? compileCfg : compileCfg.calls || [];
      for (const { op, args = [] } of calls) {
        if (typeof c[op] !== "function") { c.errors.push(`.compile(): unknown call ${op}()`); continue; }
        c[op](...args);
      }
    }
  } catch (e) { c.errors.push(`.compile(): ${e.message}`); }
  return c;
}

// ═════════════════════════════════════════════ the run ══════════════════════════════════════════════════════
class Run {
  constructor(ctx, cfg) {
    this.ctx = ctx; this.cfg = cfg;
    this.graphs = Object.fromEntries(Object.entries(ctx.domains || {}).map(([d, v]) => [d, v.graph]));
    for (const [d, v] of Object.entries(ctx.domains || {})) if (v.graph && v.graph.hz == null && v.hz) v.graph.hz = v.hz;
    this.diags = [];
    this.target = makeTarget(ctx);
    this.part = this.target.part;
    this.fam = familyOf(this.target.family || this.part.family);
    this.F = FAMILY[this.fam];
    this.protect = collectProtected(ctx);
    this.roots = collectProtected(ctx, { synth: true });
    this.analyses = new Map();        // `${name}@${domain}` → { value }
    this.events = [];                 // for explainPlan
    this.ran = new Set();             // std pass names that ran
    this.memories = null; this.dsps = null; this.fsms = []; this.pipelines = {}; this.srl = null;
    this.est = null; this.timing = null; this.routeFactor = 1; this.rules = new Map(); this.placement = null;
    this.curPass = null;
  }
  diag(level, code, message, node = null, extra = {}) {
    const o = node?.origin?.[0] || null;
    const d = { level, code, message, pass: this.curPass, ...extra };
    if (o) Object.assign(d, { line: o.line, col: o.col, file: o.file, src: o.src });
    this.diags.push(d);
    return d;
  }
  isProtected(g, id) { return this.protect.all.has(id) || !!this.protect.by[g.domain]?.has(id); }
  // nodes the hardware outside a domain reads: synthesis roots and timing endpoints
  rootsOf(d) { return [...(this.roots.by[d] || []), ...[...this.roots.all].filter((id) => this.graphs[d]?.node(id))]; }
  estCtx(extra = {}) { return { ...this.ctx, domains: this.ctx.domains, target: this.target, rootsOf: (d) => this.rootsOf(d), ...extra }; }
}
function makeTarget(ctx) {
  const t = ctx.target || {};
  const b = ctx.board || {};
  const partName = (typeof t.part === "string" ? t.part : t.part?.name) || b.part || b.partData?.name || "generic";
  const part = { ...partInfo(t.part && typeof t.part === "object" && t.part.luts ? t.part : b.partData?.luts ? b.partData : partName), name: partName };
  return { name: t.name || b.profile || ctx.name || "default", family: t.family || b.family || part.family, part, board: t.board || b };
}
// node ids other structures refer to (pins, knobs, streams, cells, crossings; asserts too unless synth)
function collectProtected(ctx, { synth = false } = {}) {
  const all = new Set(), by = {};
  const add = (dom, id) => {
    if (!Number.isInteger(id)) return;
    if (dom && ctx.domains?.[dom]) (by[dom] ??= new Set()).add(id); else all.add(id);
  };
  for (const p of ctx.pins || []) add(p.domain, p.node);
  for (const k of ctx.knobs || []) add(k.domain, k.node);
  if (!synth) for (const a of ctx.asserts || []) add(a.domain, a.node);
  for (const st of ctx.streams || []) {
    const dom = st.domain || st.cross?.from || null;
    for (const id of Object.values(st.signals || {})) add(dom, id);
    add(dom, st.dropped);
  }
  for (const c of ctx.cells || []) for (const io of Object.values(c.io || {})) if (!synth || io.dir !== "drive") add(io.domain || c.domain, io.node);
  for (const [, d] of Object.entries(ctx.domains || {})) for (const n of d.graph?.live() || []) if (n.op === "in" && n.attrs?.from) add(n.attrs.from.domain, n.attrs.from.node);
  return { all, by };
}
const graphNodes = (r) => Object.values(r.graphs).reduce((a, g) => a + g.size, 0);
const designHash = (r) => Object.values(r.graphs).map((g) => g.hash()).join(":");

// ═════════════════════════════════════════════ graph surgery helpers ═══════════════════════════════════════
// replace many nodes at once: map from → to, chains resolved, users and register next values redirected
function batchReplace(r, g, map) {
  if (!map.size) return 0;
  const res = (id) => { let x = id, k = 0; while (map.has(x) && k++ < 64) x = map.get(x); return x; };
  let changed = 0;
  for (const n of g.nodes) {
    if (!n) continue;
    for (let i = 0; i < n.args.length; i++) { const t = res(n.args[i]); if (t !== n.args[i]) { n.args[i] = t; changed++; } }
    if (n.op === "reg" && n.attrs.next != null) { const t = res(n.attrs.next); if (t !== n.attrs.next) { n.attrs.next = t; changed++; } }
  }
  for (const [from] of map) {
    const f = g.node(from), t = g.node(res(from));
    if (f && t && f !== t) {
      const seen = new Set((t.origin || []).map((o) => `${o.file}:${o.line}:${o.col}`));
      for (const o of f.origin || []) if (!seen.has(`${o.file}:${o.line}:${o.col}`) && t.origin.length < 8) t.origin.push(o);
    }
  }
  g.rehash();
  return changed;
}
// remove pure nodes nothing reads (protected nodes and every stateful node stay)
function sweep(r, g) {
  const keep = new Set(), work = [];
  const mark = (id) => { if (id != null && g.node(id) && !keep.has(id)) { keep.add(id); work.push(id); } };
  for (const n of g.live()) if (STATEFUL.has(n.op) || r.isProtected(g, n.id)) mark(n.id);
  while (work.length) {
    const n = g.node(work.pop());
    for (const a of n.args) mark(a);
    if (n.op === "reg") mark(n.attrs.next);
  }
  let removed = 0;
  for (const n of g.live()) if (!keep.has(n.id)) { g.nodes[n.id] = null; removed++; }
  if (removed) g.rehash();
  return removed;
}
// a node of type T with the same value as x (widening only; equal types return x)
function extTo(g, x, T, origin) {
  const X = g.node(x);
  if (typeName(X.type) === typeName(T)) return x;
  if (X.op === "const") return g.const(wrapTo(X.attrs.value, T), T, origin || X.origin);
  if (X.type.w > T.w || (X.type.signed && !T.signed)) return g.add("wrap", [x], T, {}, origin || X.origin);
  return g.add(X.type.signed ? "sext" : "zext", [x], T, {}, origin || X.origin);
}
const constOf = (g, id) => { const n = g.node(id); return n?.op === "const" ? n.attrs.value : undefined; };
const isZero = (v) => v !== undefined && toBig(v) === 0n;
const isOne = (v) => v !== undefined && toBig(v) === 1n;

// ═════════════════════════════════════════════ checks ══════════════════════════════════════════════════════
function checkLoops(r, g) {
  try { g.topo(); return { note: "acyclic between registers" }; }
  catch (e) {
    const n = g.node(e.node);
    r.diag("error", "comb-loop", `combinational loop in ${g.domain} through ${n?.attrs?.path || n?.op || "%" + e.node}: a value depends on itself in the same cycle; break it with a register`, n);
    return { note: "loop found" };
  }
}
function checkLatches(r, g) {
  const bad = g.live().filter((n) => n.attrs?.latch);
  for (const n of bad) r.diag("error", "latch", `${n.attrs.path || "a wire"} is not assigned on every path through the lambda: give it a default or make it a register`, n);
  return { note: bad.length ? `${bad.length} latch${bad.length > 1 ? "es" : ""}` : "none" };
}
function checkCdc(r) {
  let crossings = 0, warned = 0;
  for (const g of Object.values(r.graphs)) {
    for (const n of g.live()) {
      if (n.op !== "in" || n.attrs.src !== "cross") continue;
      crossings++;
      const from = n.attrs.from || {};
      const src = r.graphs[from.domain]?.node(from.node);
      if (!src) { r.diag("error", "cdc", `${n.attrs.path}: crossing from ${from.domain} reads a node that does not exist`, n); warned++; continue; }
      if ((n.attrs.stages ?? 2) < 2) { r.diag("warn", "cdc", `${n.attrs.path}: a ${from.domain} → ${g.domain} crossing needs at least 2 synchronizer stages`, n); warned++; }
      if (!["reg", "in", "const"].includes(src.op)) { r.diag("warn", "cdc", `${n.attrs.path}: crosses from combinational logic in ${from.domain}; glitches can be sampled — register it in the source domain`, n); warned++; }
      if (n.type.w > 1 && !n.attrs.gray && !n.attrs.quasiStatic) { r.diag("info", "cdc", `${n.attrs.path}: ${n.type.w} bits through a plain synchronizer may arrive in different cycles; fine for quasi-static values, otherwise use stream.cross()`, n); }
    }
  }
  // a node in one domain read by another domain's graph other than through an `in` crossing cannot be built
  return { note: crossings ? `${crossings} crossing${crossings > 1 ? "s" : ""}, ${warned} warning${warned === 1 ? "" : "s"}` : (Object.keys(r.graphs).length > 1 ? "no crossings" : "one domain") };
}

// ═════════════════════════════════════════════ optimize ═════════════════════════════════════════════════════
function constFold(r, g) {
  let order;
  try { order = g.topo(); } catch { return { note: "skipped: combinational loop" }; }
  const map = new Map();
  const R = (id) => { let x = id, k = 0; while (map.has(x) && k++ < 64) x = map.get(x); return x; };
  let folded = 0, simplified = 0;
  for (const id of order) {
    const n = g.node(id);
    if (!n || !(n.op in PURE) || n.op === "const") continue;
    const args = n.args.map(R);
    const A = args.map((a) => g.node(a));
    const cv = A.map((a) => (a.op === "const" ? a.attrs.value : undefined));
    let to = null;
    // 1. every operand constant: evaluate
    if (cv.every((v) => v !== undefined) && args.length) {
      let v;
      try {
        if (n.op === "rom") { const t = n.attrs.table || []; const i = Number(cv[0]); v = i >= 0 && i < t.length ? fromPattern(encodeValue(t[i], n.type), n.type) : (isBig(n.type) ? 0n : 0); }
        else if (["add", "sub", "mul", "neg", "and", "or", "xor", "not", "shl", "shr", "eq", "ne", "lt", "le", "gt", "ge", "land", "lor", "lnot", "mux", "wrap", "sat", "slice", "zext", "sext"].includes(n.op)) v = evalOp(n.op, n.type, cv, n.attrs);
      } catch { v = undefined; }
      if (v !== undefined) { to = g.const(wrapTo(v, n.type), n.type, n.origin); folded++; }
    }
    // 2. identities (the result keeps its type through an explicit extension)
    if (to == null) {
      const [a, b, c] = args, [va, vb, vc] = cv;
      const T = n.type;
      const same = a !== undefined && a === b;
      switch (n.op) {
        case "add": if (isZero(vb)) to = extTo(g, a, T, n.origin); else if (isZero(va)) to = extTo(g, b, T, n.origin); break;
        case "sub": if (isZero(vb)) to = extTo(g, a, T, n.origin); else if (same) to = g.const(0, T, n.origin); break;
        case "mul": if (isZero(va) || isZero(vb)) to = g.const(isBig(T) ? 0n : 0, T, n.origin); else if (isOne(vb)) to = extTo(g, a, T, n.origin); else if (isOne(va)) to = extTo(g, b, T, n.origin); break;
        case "and": if (isZero(va) || isZero(vb)) to = g.const(isBig(T) ? 0n : 0, T, n.origin); else if (same) to = extTo(g, a, T, n.origin); break;
        case "or": if (isZero(vb)) to = extTo(g, a, T, n.origin); else if (isZero(va)) to = extTo(g, b, T, n.origin); else if (same) to = extTo(g, a, T, n.origin); break;
        case "xor": if (isZero(vb)) to = extTo(g, a, T, n.origin); else if (isZero(va)) to = extTo(g, b, T, n.origin); else if (same) to = g.const(isBig(T) ? 0n : 0, T, n.origin); break;
        case "eq": case "le": case "ge": if (same) to = g.const(1, T, n.origin); break;
        case "ne": case "lt": case "gt": if (same) to = g.const(0, T, n.origin); break;
        case "shl": case "shr": if (isZero(vb)) to = extTo(g, a, T, n.origin); break;
        case "mux": if (va !== undefined) to = extTo(g, toBig(va) !== 0n ? b : c, T, n.origin); break;
        case "land": if (isZero(va) || isZero(vb)) to = g.const(0, T, n.origin); break;
        case "lor": if ((va !== undefined && !isZero(va)) || (vb !== undefined && !isZero(vb))) to = g.const(1, T, n.origin); break;
        case "wrap": case "sat": case "zext": case "sext": {
          const X = A[0];
          if (typeName(X.type) === typeName(T)) to = a;
          else if (fits(X.type, T) && (n.op !== "zext" || !X.type.signed)) to = extTo(g, a, T, n.origin);
          else if ((n.op === "zext" || n.op === "sext") && (X.op === "zext" || X.op === "sext") && fits(g.node(X.args[0]).type, T)) to = extTo(g, X.args[0], T, n.origin);
          if (to === id) to = null;
          break;
        }
      }
      if (to != null && to !== id) simplified++;
    }
    if (to != null && to !== id) map.set(id, to);
    else if (args.some((x, i) => x !== n.args[i])) { /* operands forwarded; batchReplace fixes them */ }
  }
  batchReplace(r, g, map);
  const removed = sweep(r, g);
  return { note: `${folded} folded, ${simplified} simplified${removed ? `, ${removed} removed` : ""}` };
}
const keyOf = (n) => n.op + "|" + n.args.join(",") + "|" + typeName(n.type) + "|" + attrKey(n.attrs);
function attrKey(o) {
  if (o == null || typeof o !== "object") return typeof o === "bigint" ? o + "n" : JSON.stringify(o);
  if (Array.isArray(o)) return "[" + o.map(attrKey).join(",") + "]";
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined && k !== "next" && k !== "liveBits").sort().map((k) => k + ":" + attrKey(o[k])).join(",") + "}";
}
function cse(r, g) {
  let order;
  try { order = g.topo(); } catch { return { note: "skipped: combinational loop" }; }
  const seen = new Map(), map = new Map();
  const R = (id) => map.get(id) ?? id;
  let merged = 0;
  for (const id of order) {
    const n = g.node(id);
    if (!n || STATEFUL.has(n.op)) continue;
    const k = keyOf({ ...n, args: n.args.map(R) });
    const hit = seen.get(k);
    if (hit != null && hit !== id) { map.set(id, hit); if (g.users(id).length) merged++; }
    else seen.set(k, id);
  }
  batchReplace(r, g, map);
  const removed = sweep(r, g);
  return { note: `${merged} merged${removed ? `, ${removed} removed` : ""}` };
}
function muxTree(r, g) {
  let order;
  try { order = g.topo(); } catch { return { note: "skipped: combinational loop" }; }
  const map = new Map();
  const R = (id) => { let x = id, k = 0; while (map.has(x) && k++ < 64) x = map.get(x); return x; };
  let collapsed = 0;
  for (const id of order) {
    const n = g.node(id);
    if (!n || n.op !== "mux") continue;
    let [c, a, b] = n.args.map(R);
    let changed = false;
    const C = g.node(c);
    if (C.op === "lnot") { c = C.args[0]; [a, b] = [b, a]; changed = true; }
    const A = g.node(a), B = g.node(b);
    if (A.op === "mux" && R(A.args[0]) === c) { a = R(A.args[1]); changed = true; }
    if (B.op === "mux" && R(B.args[0]) === c) { b = R(B.args[2]); changed = true; }
    const Cn = g.node(c);
    if (n.type.w === 1 && !n.type.signed && Cn.type.w === 1 && isOne(constOf(g, a)) && isZero(constOf(g, b))) { map.set(id, c); collapsed++; continue; }
    if (changed) {
      const m = g.add("mux", [c, a, b], n.type, { ...n.attrs, liveBits: undefined }, n.origin);
      if (m !== id) { map.set(id, m); collapsed++; }
    }
  }
  batchReplace(r, g, map);
  const cases = caseChains(r, g);
  const removed = sweep(r, g);
  // priority chains: muxes whose else arm is another mux
  let deepest = 0, chains = 0;
  const depth = new Map();
  for (const id of g.topo()) {
    const n = g.node(id);
    if (n.op !== "mux") continue;
    const d = 1 + (g.node(n.args[2])?.op === "mux" ? depth.get(n.args[2]) || 0 : 0);
    depth.set(id, d);
  }
  for (const [id, d] of depth) if (d >= 4 && !g.users(id).some((u) => g.node(u)?.op === "mux" && g.node(u).args[2] === id)) { chains++; deepest = Math.max(deepest, d); }
  return { note: `${collapsed} collapsed${cases.n ? `, ${cases.n} case chain${cases.n > 1 ? "s" : ""} → indexed mux (${cases.desc.join(", ")})` : ""}${removed ? `, ${removed} removed` : ""}${chains ? `; ${chains} priority chain${chains > 1 ? "s" : ""} left (deepest ${deepest})` : ""}` };
}
// a chain mux(S == k0, a0, mux(S == k1, a1, … d)) over one selector becomes index(pack(a_0 … a_{2^w-1}), S):
// a balanced tree of log2(n) levels instead of n levels, with the same value for every S
function caseChains(r, g) {
  let order;
  try { order = g.topo(); } catch { return { n: 0, desc: [] }; }
  const sel = (id) => {
    const m = g.node(id);
    if (!m || m.op !== "mux") return null;
    const c = g.node(m.args[0]);
    if (!c || c.op !== "eq") return null;
    const [x, y] = c.args, X = g.node(x), Y = g.node(y);
    if (Y.op === "const" && X.op !== "const") return { S: x, k: Number(Y.attrs.value) };
    if (X.op === "const" && Y.op !== "const") return { S: y, k: Number(X.attrs.value) };
    return null;
  };
  const map = new Map(), desc = [];
  const inner = new Set();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if (inner.has(id) || map.has(id)) continue;
    const h = sel(id);
    if (!h) continue;
    const S = g.node(h.S);
    if (S.type.signed || S.type.w > 6) continue;
    const entries = [];
    let x = id, dflt = null;
    const members = [];
    for (;;) {
      const c = sel(x);
      if (!c || c.S !== h.S || (x !== id && g.users(x).length !== 1)) { dflt = x; break; }
      const m = g.node(x);
      if (!entries.some((e) => e.k === c.k)) entries.push({ k: c.k, a: m.args[1] });
      members.push(x);
      x = m.args[2];
    }
    const n = 2 ** S.type.w;
    if (entries.length < 4 || entries.length * 2 < n) continue;
    for (const mm of members) inner.add(mm);
    const T = g.node(id).type;
    const origin = g.node(id).origin;
    const elems = [];
    for (let v = 0; v < n; v++) { const e = entries.find((q) => q.k === v); elems.push(extTo(g, e ? e.a : dflt, T, origin)); }
    const pk = g.add("pack", elems, vec(T, n), {}, origin);
    const ix = g.add("index", [pk, h.S], T, { ...(g.node(id).attrs.module ? { module: g.node(id).attrs.module } : {}) }, origin);
    map.set(id, ix);
    desc.push(`${entries.length} arms on ${S.attrs.path || "%" + h.S}`);
  }
  batchReplace(r, g, map);
  return { n: map.size, desc: desc.slice(0, 3) };
}
// dead code and demanded bits: liveBits = how many low bits of a node anything reads
function dce(r, g) {
  const removed = sweep(r, g);
  let order;
  try { order = g.topo(); } catch { return { note: `${removed} removed` }; }
  const demand = new Map();
  const need = (id, d) => { const n = g.node(id); if (!n) return; const v = Math.min(n.type.w, Math.max(0, d)); if (v > (demand.get(id) ?? -1)) demand.set(id, v); };
  for (const n of g.live()) {
    if (STATEFUL.has(n.op)) { for (const a of n.args) need(a, Infinity); if (n.op === "reg" && n.attrs.next != null) need(n.attrs.next, Infinity); }
    if (r.isProtected(g, n.id)) need(n.id, Infinity);
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const n = g.node(order[i]);
    if (!n || STATEFUL.has(n.op)) continue;
    const d = demand.get(n.id) ?? 0;
    switch (n.op) {
      case "add": case "sub": case "mul": case "neg": case "and": case "or": case "xor": case "not": case "wrap": case "zext": case "sext":
        for (const a of n.args) need(a, d); break;
      case "shl": {
        const k = constOf(g, n.args[1]);
        if (k !== undefined) need(n.args[0], d - Number(k)); else need(n.args[0], d);
        need(n.args[1], Infinity); break;
      }
      case "slice": need(n.args[0], (n.attrs.lo ?? 0) + Math.min(d, n.type.w)); break;
      case "mux": need(n.args[0], Infinity); need(n.args[1], d); need(n.args[2], d); break;
      default: for (const a of n.args) need(a, Infinity);
    }
  }
  let narrowed = 0, bits = 0;
  for (const n of g.live()) {
    if (STATEFUL.has(n.op) || n.op === "const") continue;
    const d = demand.get(n.id) ?? 0;
    if (d < n.type.w) { if (n.attrs.liveBits !== d) n.attrs.liveBits = d; narrowed++; bits += n.type.w - d; }
    else if (n.attrs.liveBits !== undefined) delete n.attrs.liveBits;
  }
  g.rehash();
  return { note: `${removed} removed, ${narrowed} narrowed (${bits} bits nothing reads)` };
}

// ═════════════════════════════════════════════ time ═════════════════════════════════════════════════════════
function estCtxFor(r, g) {
  const one = estimate(r.estCtx({ domains: { [g.domain]: { hz: g.hz, graph: g } }, cells: [] }), { dsp: true, mem: true });
  return one.domainCtx[g.domain];
}
function domainOfInstance(r, inst) {
  if (inst.domain && r.graphs[inst.domain]) return inst.domain;
  for (const [d, g] of Object.entries(r.graphs)) if (g.live().some((n) => n.attrs?.module === inst.path)) return d;
  return Object.keys(r.graphs)[0];
}
// Tree-height reduction, timing-driven: an add/sub chain on a path within 10% of the clock period is rebuilt as a
// tree that combines the earliest-arriving terms first. D1 types are exact, so the sum is the same integer; the
// root keeps its type. Latency does not change, so this runs whether or not the path is .pipelined().
function balanceChains(r) {
  let chains = 0, saved = 0;
  for (const [d, g] of Object.entries(r.graphs)) {
    const hz = r.ctx.domains[d]?.hz ?? g.hz;
    if (!hz) continue;
    const period = 1e9 / hz, margin = 0.1 * period;
    const cx = estCtxFor(r, g);
    const t = timingOf(g, r.F, cx, { hz, endpoints: r.rootsOf(d) });
    if (t.slack == null || t.slack >= margin) continue;
    let order;
    try { order = g.topo(); } catch { continue; }
    const isChainOp = (n) => n && (n.op === "add" || n.op === "sub");
    const inner = new Set(), map = new Map();
    for (let i = order.length - 1; i >= 0; i--) {
      const R = g.node(order[i]);
      if (!isChainOp(R) || inner.has(R.id) || t.slackOf(R.id) >= margin) continue;
      // flatten through single-use add/sub (and value-preserving extensions) into signed leaves
      const leaves = [], members = [];
      const walk = (id, sign, top) => {
        const n = g.node(id);
        const through = top || (g.users(id).length === 1 && !r.isProtected(g, id));
        if (through && isChainOp(n)) { members.push(id); walk(n.args[0], sign, false); walk(n.args[1], n.op === "sub" ? -sign : sign, false); return; }
        if (through && !top && (n.op === "sext" || n.op === "zext") && isChainOp(g.node(n.args[0])) && g.users(n.args[0]).length === 1) { members.push(id); walk(n.args[0], sign, false); return; }
        leaves.push({ id, sign, at: t.arrival(id) });
      };
      walk(R.id, 1, true);
      if (leaves.length < 4) continue;
      for (const m of members) inner.add(m);
      // combine the two earliest terms until one is left (Huffman on arrival time)
      const addDelay = r.F.lut + r.F.route + R.type.w * r.F.carryPerBit;
      let terms = leaves.map((x) => ({ ...x }));
      while (terms.length > 1) {
        terms.sort((a, b) => a.at - b.at || a.id - b.id);
        const [a, b] = terms.splice(0, 2);
        const A = g.node(a.id).type, B = g.node(b.id).type;
        let id, sign;
        if (a.sign === b.sign) { id = g.add("add", [a.id, b.id], binType("add", A, B), { module: R.attrs.module }, R.origin); sign = a.sign; }
        else if (a.sign > 0) { id = g.add("sub", [a.id, b.id], binType("sub", A, B), { module: R.attrs.module }, R.origin); sign = 1; }
        else { id = g.add("sub", [b.id, a.id], binType("sub", B, A), { module: R.attrs.module }, R.origin); sign = 1; }
        terms.push({ id, sign, at: Math.max(a.at, b.at) + addDelay });
      }
      let root = terms[0].id;
      if (terms[0].sign < 0) root = g.add("neg", [root], unType("neg", g.node(root).type), { module: R.attrs.module }, R.origin);
      root = extTo(g, root, R.type, R.origin);
      if (root === R.id) continue;
      map.set(R.id, root);
      chains++;
      saved += Math.max(0, t.arrival(R.id) - terms[0].at);
    }
    if (map.size) { batchReplace(r, g, map); sweep(r, g); }
  }
  return { chains, saved };
}
function pipelineCut(r) {
  const bal = balanceChains(r);
  const balNote = bal.chains ? `balanced ${bal.chains} add/sub chain${bal.chains > 1 ? "s" : ""} on near-critical paths (tree-height reduction, about ${round(bal.saved, 2)} ns shorter, no latency change)` : "";
  const insts = (r.ctx.instances || []).filter((i) => i.pipelined);
  if (!insts.length) return { note: [balNote, "no .pipelined() paths: latency stays as written"].filter(Boolean).join("; ") };
  const notes = balNote ? [balNote] : [];
  for (const inst of insts) {
    const d = domainOfInstance(r, inst), g = r.graphs[d];
    if (!g || !g.hz) continue;
    const cx = estCtxFor(r, g);
    const t = timingOf(g, r.F, cx, { hz: g.hz, endpoints: r.rootsOf(d) });
    const mine = g.live().filter((n) => n.attrs?.module === inst.path);
    let D = 0;
    for (const n of mine) D = Math.max(D, t.arrival(n.id));
    const period = 1e9 / g.hz, budget = period - r.F.overhead;
    const stages = Math.max(1, Math.ceil(D / Math.max(0.1, budget)));
    // registers on every edge that crosses a stage boundary
    let ffs = 0;
    for (let k = 1; k < stages; k++) {
      const T = (D * k) / stages, cut = new Set();
      // a DSP's own pipeline registers (MREG/PREG) cost nothing; everything else crossing the cut gets a register
      for (const n of mine) for (const a of n.args) if (t.arrival(a) <= T && t.arrival(n.id) > T && g.node(a).op !== "const" && !(cx.muls.get(a)?.kind === "dsp") && !cx.absorbed.has(a)) cut.add(a);
      for (const a of cut) ffs += Math.min(g.node(a).type.w, g.node(a).attrs.liveBits ?? Infinity);
    }
    r.pipelines[inst.path] = { domain: d, stages, latency: stages, ffs, combNs: round(D, 2), path: inst.pipelined.path || null };
    notes.push(`${inst.path}: ${round(D, 1)} ns of logic at ${round(period, 2)} ns → ${stages} stage${stages > 1 ? "s" : ""}${stages > 1 ? ` (+${ffs} FFs)` : ""}`);
  }
  return { note: notes.join("; ") };
}
function retime(r, p) {
  const ps = Object.entries(r.pipelines);
  if (!ps.length) return { note: "nothing to move: registers stay where the source put them (only .pipelined() paths are retimed)" };
  return { note: ps.map(([path, x]) => `${path}: registers balanced across ${x.stages} stage${x.stages > 1 ? "s" : ""} (moves: ${p.moves || "forward"})`).join("; ") };
}

// ═════════════════════════════════════════════ map ══════════════════════════════════════════════════════════
const budgetsOf = (r) => Object.fromEntries((r.ctx.instances || []).filter((i) => i.budget).map((i) => [i.path, i.budget]));
function memInfer(r) {
  r.ran.add("mem.infer");
  r.memories = [];
  for (const [d, g] of Object.entries(r.graphs)) for (const m of classifyMemories(g, r.F, r.fam, budgetsOf(r))) r.memories.push({ ...m, domain: d });
  if (!r.memories.length) return { note: "no memories" };
  const desc = (m) => `${m.path} ${m.words}×${m.width} → ${m.place === "bram" ? `${m.brams} ${m.unit || "BRAM"} (${m.cfg})` : m.place === "spram" ? `${m.sprams} SPRAM` : m.place === "lutram" ? "LUT RAM" : m.place === "ff" ? "flip-flops" : "LUTs"}`;
  return { note: r.memories.map(desc).join("; ") };
}
function dspPack(r) {
  r.ran.add("dsp.pack");
  const e = estimate(r.estCtx(), { dsp: true, mem: r.ran.has("mem.infer") });
  r.dsps = e.dsps;
  if (!e.dsps.length) return { note: "no multipliers left for DSPs" };
  const cell = r.F.cells.dsp;
  return { note: e.dsps.map((d) => `${d.module || "(top)"}: ${d.widths.join("×")}${d.mac ? " multiply-accumulate" : ""} → ${d.count} ${cell}${d.mac ? " (adder and register absorbed)" : ""}`).slice(0, 6).join("; ") + (e.dsps.length > 6 ? `; … ${e.dsps.length} in all` : "") };
}
function fsmEncode(r) {
  r.ran.add("fsm.encode");
  r.fsms = [];
  for (const inst of r.ctx.instances || []) {
    if (inst.kind !== "fsm") continue;
    let reg = null;
    for (const g of Object.values(r.graphs)) for (const nd of g.live()) if (nd.op === "reg" && (nd.attrs.path === `${inst.path}.state` || (nd.attrs.module === inst.path && nd.attrs.name === "state"))) reg = nd;
    const list = inst.states || reg?.attrs.states;
    if (!list) continue;
    const states = list.map((x) => (typeof x === "string" ? x : x.name));
    const n = states.length;
    const ring = isRing(states, inst.transitions);
    const asked = inst.encoding && inst.encoding !== "auto" ? (inst.encoding === "onehot" ? "one-hot" : inst.encoding) : null;
    const enc = asked || (ring ? "gray" : n <= 4 ? "binary" : "one-hot");
    const ffs = enc === "one-hot" ? n : Math.max(1, clog2(n));
    const why = asked ? `requested with .encode("${inst.encoding}")` : ring ? "the transitions form one ring: one bit changes per step" : n <= 4 ? `${n} states: binary is smallest` : `${n} states: one-hot decodes fastest`;
    r.fsms.push({ path: inst.path, states: n, encoding: enc, ffs, why, regW: reg ? reg.type.w : Math.max(1, clog2(n)) });
    // the DAG keeps the state as it is (sim.js reads attrs.encoding as the value's encoding, so that is not
    // touched); the physical choice is recorded beside it for the report and the Verilog comment
    if (reg) reg.attrs.physEncoding = enc;
  }
  if (!r.fsms.length) return { note: "no state machines" };
  return { note: r.fsms.map((f) => `${f.path}: ${f.states} states → ${f.encoding} (${f.ffs} FF${f.ffs > 1 ? "s" : ""})`).join("; ") };
}
function isRing(states, transitions) {
  if (!transitions || states.length < 3) return false;
  const next = new Map();
  for (const t of transitions) {
    if (t.from === t.to) continue;
    if (next.has(t.from) && next.get(t.from) !== t.to) return false;
    next.set(t.from, t.to);
  }
  if (next.size !== states.length) return false;
  let x = states[0];
  const seen = new Set();
  for (let i = 0; i < states.length; i++) { if (seen.has(x)) return false; seen.add(x); x = next.get(x); }
  return x === states[0];
}
function srlInfer(r) {
  r.ran.add("srl.infer");
  const chains = [];
  for (const g of Object.values(r.graphs)) {
    const prevOf = new Map();
    for (const n of g.live()) {
      if (n.op !== "reg" || n.attrs.next == null) continue;
      let src = g.node(n.attrs.next);
      if (src?.op === "mux" && (src.args[1] === n.id || src.args[2] === n.id)) src = g.node(src.args[1] === n.id ? src.args[2] : src.args[1]);
      if (src?.op === "reg" && src.type.w === n.type.w && src.id !== n.id) prevOf.set(n.id, src.id);
    }
    // walk back from chain tails: registers no other chain register follows
    const isPrev = new Set(prevOf.values());
    for (const [tail] of prevOf) {
      if (isPrev.has(tail)) continue;
      let len = 1, x = tail;
      while (prevOf.has(x) && len < 4096) { x = prevOf.get(x); len++; }
      if (len >= 3) chains.push({ domain: g.domain, tail: g.node(tail).attrs.path, length: len, width: g.node(tail).type.w });
    }
  }
  r.srl = chains;
  if (!chains.length) return { note: "no register chains of 3 or more" };
  const ffs = chains.reduce((a, c) => a + c.length * c.width, 0);
  const srls = chains.reduce((a, c) => a + Math.ceil(c.length / 32) * c.width, 0);
  return { note: `${chains.length} chain${chains.length > 1 ? "s" : ""} (${ffs} FFs) could be ${srls} SRLC32E — report only, the estimate keeps flip-flops` };
}
function techmap(r) {
  r.ran.add("techmap");
  const e = estimate(r.estCtx(), { dsp: r.ran.has("dsp.pack"), mem: r.ran.has("mem.infer") });
  // FSM encodings and pipeline registers change the flip-flop count
  for (const f of r.fsms) {
    const extra = f.ffs - f.regW;
    if (extra) { const m = (e.perModule[f.path] ??= { luts: 0, ffs: 0, brams: 0, dsps: 0, carry: 0, lutram: 0, sprams: 0 }); m.ffs += extra; e.resources.ffs += extra; }
  }
  for (const [path, p] of Object.entries(r.pipelines)) {
    if (!p.ffs) continue;
    const m = (e.perModule[path] ??= { luts: 0, ffs: 0, brams: 0, dsps: 0, carry: 0, lutram: 0, sprams: 0 });
    m.ffs += p.ffs; e.resources.ffs += p.ffs;
    for (let i = 0; i < p.ffs; i++) e.cells.push({ type: r.F.cells.ff, module: path });
  }
  r.est = e;
  if (!r.memories) r.memories = e.memories;
  if (!r.dsps) r.dsps = e.dsps;
  const counts = {};
  for (const c of e.cells) counts[c.type] = (counts[c.type] || 0) + 1;
  return { note: Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ×${n}`).join(", ") || "no cells" };
}
function ensureEstimate(r) {
  if (!r.est) techmap(r);
  return r.est;
}
function place(r, p) {
  const e = ensureEstimate(r);
  const P = r.part, res = e.resources;
  const util = { luts: res.luts / P.luts, ffs: res.ffs / P.ffs, brams: P.brams ? res.brams / P.brams : 0, dsps: P.dsps ? res.dsps / P.dsps : res.dsps ? Infinity : 0 };
  r.placement = { util, effort: p.effort || "normal" };
  for (const [k, v] of Object.entries(util)) if (v > 1) r.diag("error", "fit", `the design needs ${res[k]} ${k.toUpperCase()} but ${P.name} has ${P[k]}`);
  return { note: `estimated (no placement is run): LUTs ${pct(util.luts)}, FFs ${pct(util.ffs)}, BRAM ${pct(util.brams)}, DSP ${pct(util.dsps)} of ${P.name}; effort ${p.effort || "normal"}` };
}
const pct = (x) => (isFinite(x) ? `${Math.round(x * 1000) / 10}%` : "over");
function route(r) {
  if (!r.placement) place(r, {});
  const u = r.placement.util.luts;
  r.routeFactor = u > 0.7 ? 1 + (u - 0.7) * 1.5 : 1;
  return { note: `estimated: routing ≈ ${r.F.route} ns per level${r.routeFactor > 1 ? ` ×${round(r.routeFactor, 2)} for congestion at ${pct(u)} LUTs` : ""}` };
}
function timingPass(r) {
  const e = ensureEstimate(r);
  const F = r.routeFactor > 1 ? { ...r.F, route: r.F.route * r.routeFactor } : r.F;
  const pipelined = Object.fromEntries(Object.entries(r.pipelines).map(([k, v]) => [k, { stages: v.stages }]));
  r.timing = {};
  const notes = [];
  for (const [d, g] of Object.entries(r.graphs)) {
    const hz = r.ctx.domains[d].hz ?? g.hz;
    const t = timingOf(g, F, e.domainCtx[d] || estCtxFor(r, g), { hz, pipelined, endpoints: r.rootsOf(d) });
    r.timing[d] = t;
    notes.push(`${d}: ${t.worstNs} ns${t.periodNs != null ? ` / ${t.periodNs} ns, slack ${t.slack}` : ""}`);
    if (t.slack != null && t.slack < 0) {
      const end = t.path[t.path.length - 1];
      r.diag("warn", "timing", `timing not met in ${d}: worst path ${t.worstNs} ns > ${t.periodNs} ns at ${fmtHz(hz)} (estimated)`, end ? g.node(end.id) : null);
    }
  }
  return { note: notes.join("; ") + " (estimated)" };
}
function timingAnalysis(r, g) {
  const cx = r.est?.domainCtx?.[g.domain] || estCtxFor(r, g);
  const t = timingOf(g, r.F, cx, { hz: r.ctx.domains[g.domain]?.hz ?? g.hz, endpoints: r.rootsOf(g.domain) });
  return { slack: (n) => t.slackOf(typeof n === "object" ? n.id : n), arrival: (n) => t.arrival(typeof n === "object" ? n.id : n), worstNs: t.worstNs, periodNs: t.periodNs, path: t.path };
}
const fmtHz = (hz) => (hz == null ? "?" : hz >= 1e6 ? `${round(hz / 1e6, 3)} MHz` : hz >= 1e3 ? `${round(hz / 1e3, 3)} kHz` : `${hz} Hz`);

// ═════════════════════════════════════════════ the Graph API for passes written in the script ══════════════
function graphView(r, g, p) {
  const cache = new Map();
  let edited = false;
  const V = (id) => {
    if (id == null) return null;
    if (typeof id === "object") id = id.id;
    if (cache.has(id)) return cache.get(id);
    const n = g.node(id);
    if (!n) return null;
    const v = {
      id: n.id, op: n.op, attrs: n.attrs, origin: n.origin, domain: g.domain,
      get type() { return n.type; }, get width() { return n.type.w; }, get signed() { return !!n.type.signed; },
      get args() { return n.args.map(V); }, get users() { return g.users(n.id).map(V); },
      get isConst() { return n.op === "const"; }, get value() { return n.op === "const" ? n.attrs.value : undefined; },
      get path() { return n.attrs.path; }, get name() { return n.attrs.name || n.attrs.path; },
      get next() { return n.op === "reg" ? V(n.attrs.next) : undefined; },
      get liveBits() { return n.attrs.liveBits ?? n.type.w; },
      toString() { return `%${n.id} ${n.op} : ${typeName(n.type)}`; },
    };
    cache.set(id, v);
    return v;
  };
  const opsMatch = (n, op) => op == null || op === "*" || (Array.isArray(op) ? op.includes(n.op) : n.op === op);
  const view = {
    domain: g.domain, hz: g.hz, level: p?.level || "dag",
    nodes: (op) => g.live().filter((n) => opsMatch(n, op)).map((n) => V(n.id)),
    node: (id) => V(id),
    count: (op) => g.live().filter((n) => opsMatch(n, op)).length,
    print: (o) => g.print(o), stats: () => g.stats(), hash: () => g.hash(),
    get edited() { return edited; },
    const: (v, T) => { edited = true; return V(g.const(v, T || constType(v))); },
    add: (op, args, T, attrs = {}) => { edited = true; return V(g.add(op, args.map((a) => (typeof a === "object" ? a.id : a)), T, attrs)); },
    replace(a, b) {
      const from = typeof a === "object" ? a.id : a, to = typeof b === "object" ? b.id : b;
      if (from === to) return;
      const F = g.node(from), T = g.node(to);
      const t = T && F && typeName(T.type) !== typeName(F.type) ? extTo(g, to, F.type, F.origin) : to;
      batchReplace(r, g, new Map([[from, t]]));
      cache.clear(); edited = true;
    },
    duplicate(a, { copies = 2, split = "users" } = {}) {
      const id = typeof a === "object" ? a.id : a;
      const n = g.node(id);
      if (!n || copies < 2) return [V(id)];
      const users = g.users(id).filter((u) => g.node(u)?.op !== "reg" || g.node(u).attrs.next !== id || g.node(u).args.includes(id));
      const ids = [id];
      for (let k = 1; k < copies; k++) {
        let c;
        if (n.op === "reg") { c = g.reg(`${n.attrs.path}~${k}`, n.type, { ...n.attrs, path: `${n.attrs.path}~${k}`, dupOf: n.attrs.path }, n.origin); g.setNext(c, n.attrs.next); }
        else if (n.op in PURE) c = g.add(n.op, n.args, n.type, { ...n.attrs, dup: k }, n.origin);
        else return [V(id)];
        ids.push(c);
      }
      if (split === "users") {
        const per = Math.ceil(users.length / copies);
        users.forEach((u, i) => {
          const k = Math.min(copies - 1, Math.floor(i / per));
          if (!k) return;
          const un = g.node(u);
          for (let j = 0; j < un.args.length; j++) if (un.args[j] === id) un.args[j] = ids[k];
        });
        g.rehash();
      }
      cache.clear(); edited = true;
      r.dupes = (r.dupes || 0) + copies - 1;
      return ids.map(V);
    },
    remove(a) { const id = typeof a === "object" ? a.id : a; if (!g.users(id).length && !STATEFUL.has(g.node(id)?.op)) { g.remove(id); g.rehash(); edited = true; } },
    warn: (n, msg) => r.diag("warn", "lint", msg, n ? g.node(typeof n === "object" ? n.id : n) : null, { domain: g.domain }),
    error: (n, msg) => r.diag("error", "lint", msg, n ? g.node(typeof n === "object" ? n.id : n) : null, { domain: g.domain }),
    info: (n, msg) => r.diag("info", "lint", msg, n ? g.node(typeof n === "object" ? n.id : n) : null, { domain: g.domain }),
    raw: g,
  };
  return view;
}
// a view over every domain at once (inspect lambdas, backends)
function designView(r, level) {
  const views = Object.values(r.graphs).map((g) => graphView(r, g, { level }));
  const e = level === "net" || level === "phys" ? r.est : null;
  const cells = () => (e ? e.cells.map((c) => ({ ...c })) : []);
  return {
    level, domains: Object.keys(r.graphs),
    graph: (d) => views.find((v) => v.domain === d) || null,
    nodes: (op) => views.flatMap((v) => v.nodes(op)),
    count: (op) => views.reduce((a, v) => a + v.count(op), 0),
    print: () => views.map((v) => `── ${v.domain}${v.hz ? ` @ ${fmtHz(v.hz)}` : ""}\n${v.print()}`).join("\n"),
    stats: () => {
      const st = { level, nodes: 0, regs: 0, ops: {} };
      for (const v of views) { const x = v.stats(); st.nodes += x.nodes; st.regs += x.regs; for (const [k, c] of Object.entries(x.ops)) st.ops[k] = (st.ops[k] || 0) + c; }
      if (e) { st.cells = {}; for (const c of e.cells) st.cells[c.type] = (st.cells[c.type] || 0) + 1; st.resources = { ...e.resources }; }
      return st;
    },
    cells, resources: e ? { ...e.resources } : null, part: r.part, family: r.fam,
    timing: r.timing ? Object.fromEntries(Object.entries(r.timing).map(([d, t]) => [d, { worstNs: t.worstNs, slack: t.slack, fmax: t.fmax }])) : null,
  };
}

// ═════════════════════════════════════════════ rewrite rules ═══════════════════════════════════════════════
const BINOP = { "*": "mul", "+": "add", "-": "sub", "<<": "shl", ">>": "shr", ">>>": "shr", "&": "and", "|": "or", "^": "xor", "==": "eq", "===": "eq", "!=": "ne", "!==": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge" };
const LOGOP = { "&&": "land", "||": "lor" };
const UNOP = { "~": "not", "!": "lnot", "-": "neg" };
const PATTERN_CACHE = new Map();
// a lambda → { params: [names], body: pattern tree }
export function parseLambda(fn) {
  const src = typeof fn === "function" ? fn.toString() : String(fn);
  if (PATTERN_CACHE.has(src)) return PATTERN_CACHE.get(src);
  let ast;
  try { ast = acorn.parseExpressionAt(src, 0, { ecmaVersion: "latest" }); }
  catch { ast = acorn.parse("(" + src + ")", { ecmaVersion: "latest" }).body[0].expression; }
  if (ast.type !== "ArrowFunctionExpression" && ast.type !== "FunctionExpression") throw new Error(`not a lambda: ${src.slice(0, 60)}`);
  const params = ast.params.map((p) => { if (p.type !== "Identifier") throw new Error("pattern parameters must be plain names"); return p.name; });
  let body = ast.body;
  if (body.type === "BlockStatement") {
    const ret = body.body.find((s) => s.type === "ReturnStatement");
    if (!ret || body.body.length !== 1) throw new Error("a pattern lambda is one expression");
    body = ret.argument;
  }
  const conv = (e) => {
    switch (e.type) {
      case "Identifier": return params.includes(e.name) ? { t: "var", name: e.name } : { t: "name", name: e.name };
      case "Literal":
        if (typeof e.value === "number" || typeof e.value === "bigint" || typeof e.value === "boolean") return { t: "lit", value: typeof e.value === "boolean" ? +e.value : e.value };
        throw new Error(`literal ${e.raw} in a pattern`);
      case "BinaryExpression": if (!BINOP[e.operator]) throw new Error(`operator ${e.operator} in a pattern`); return { t: "op", op: BINOP[e.operator], args: [conv(e.left), conv(e.right)] };
      case "LogicalExpression": if (!LOGOP[e.operator]) throw new Error(`operator ${e.operator} in a pattern`); return { t: "op", op: LOGOP[e.operator], args: [conv(e.left), conv(e.right)] };
      case "UnaryExpression":
        if (e.operator === "-" && e.argument.type === "Literal") return { t: "lit", value: -e.argument.value };
        if (e.operator === "+") return conv(e.argument);
        if (!UNOP[e.operator]) throw new Error(`operator ${e.operator} in a pattern`);
        return { t: "op", op: UNOP[e.operator], args: [conv(e.argument)] };
      case "ConditionalExpression": return { t: "op", op: "mux", args: [conv(e.test), conv(e.consequent), conv(e.alternate)] };
      case "CallExpression": {
        const callee = e.callee.type === "Identifier" ? e.callee.name : e.callee.type === "MemberExpression" && e.callee.object.name === "Math" ? "Math." + e.callee.property.name : null;
        if (!callee) throw new Error("calls in a pattern must name a function");
        return { t: "call", fn: callee, args: e.arguments.map(conv) };
      }
      default: throw new Error(`${e.type} in a pattern`);
    }
  };
  const res = { params, body: conv(body), src };
  PATTERN_CACHE.set(src, res);
  return res;
}
const FUNCS = {
  clog2, log2: (x) => Math.log2(x), abs: Math.abs, min: Math.min, max: Math.max,
  "Math.log2": Math.log2, "Math.abs": Math.abs, "Math.min": Math.min, "Math.max": Math.max, "Math.floor": Math.floor, "Math.ceil": Math.ceil,
  u, s,
};
// type a pattern for one assignment of operand types and constant values (types never depend on input values)
// env: name → { type, isConst, value }
function annotate(p, env) {
  switch (p.t) {
    case "var": { const b = env[p.name]; if (!b) throw new Error(`unbound ${p.name}`); return { t: "var", name: p.name, T: b.type }; }
    case "lit": return { t: "lit", v: p.value, T: constType(p.value) };
    case "name": throw new Error(`unknown name ${p.name}`);
    case "call": {
      if (p.fn === "wrap" || p.fn === "sat") { const x = annotate(p.args[0], env); return { t: p.fn, kids: [x], T: evalJs(p.args[1], env) }; }
      const v = evalJs(p, env);
      return { t: "lit", v, T: constType(v) };
    }
    case "op": {
      if (p.op === "shl" || p.op === "shr") {
        const x = annotate(p.args[0], env);
        let k = null;
        try { k = evalJs(p.args[1], env); } catch { k = null; }
        if (typeof k === "number") return { t: "op", op: p.op, kids: [x, { t: "lit", v: k, T: constType(k) }], T: shiftType(p.op, x.T, k, null) };
        const kk = annotate(p.args[1], env);
        return { t: "op", op: p.op, kids: [x, kk], T: shiftType(p.op, x.T, null, kk.T) };
      }
      const kids = p.args.map((a) => annotate(a, env));
      return { t: "op", op: p.op, kids, T: opType(p.op, kids.map((k) => k.T)) };
    }
  }
  throw new Error(`cannot type ${p.t}`);
}
function evalAnn(a, vals) {
  switch (a.t) {
    case "var": return vals[a.name];
    case "lit": return isBig(a.T) ? BigInt(a.v) : a.v;
    case "wrap": return wrapTo(evalAnn(a.kids[0], vals), a.T);
    case "sat": return satTo(evalAnn(a.kids[0], vals), a.T);
    case "op": return evalOp(a.op, a.T, a.kids.map((k) => evalAnn(k, vals)), {});
  }
  throw new Error(`cannot evaluate ${a.t}`);
}
// a fast evaluator for annotated trees whose every type fits 31 bits (rule checks run it ~10^5 times)
function compileAnn(a) {
  let small = true;
  (function scan(x) { if (x.T && x.T.w > 31) small = false; for (const k of x.kids || []) scan(k); })(a);
  if (!small) return (vals) => evalAnn(a, vals);
  const wr = (T) => (T.signed ? (v) => (v << (32 - T.w)) >> (32 - T.w) : T.w === 31 ? (v) => (v & 0x7fffffff) : (v) => v & ((1 << T.w) - 1));
  const build = (x) => {
    if (x.t === "var") { const nm = x.name; return (v) => v[nm]; }
    if (x.t === "lit") { const c = Number(x.v); return () => c; }
    const ks = (x.kids || []).map(build), W = wr(x.T), [k0, k1, k2] = ks;
    if (x.t === "wrap") return (v) => W(k0(v));
    if (x.t === "sat") { const lo = x.T.signed ? -(2 ** (x.T.w - 1)) : 0, hi = x.T.signed ? 2 ** (x.T.w - 1) - 1 : 2 ** x.T.w - 1; return (v) => { const y = k0(v); return y < lo ? lo : y > hi ? hi : y; }; }
    switch (x.op) {
      case "add": return (v) => k0(v) + k1(v);
      case "sub": return (v) => k0(v) - k1(v);
      case "mul": return (v) => k0(v) * k1(v);
      case "neg": return (v) => -k0(v);
      case "and": return (v) => W(k0(v) & k1(v));
      case "or": return (v) => W(k0(v) | k1(v));
      case "xor": return (v) => W(k0(v) ^ k1(v));
      case "not": return (v) => W(~k0(v));
      case "shl": return (v) => W(k0(v) * 2 ** k1(v));
      case "shr": return (v) => Math.floor(k0(v) / 2 ** k1(v));
      case "eq": return (v) => +(k0(v) === k1(v));
      case "ne": return (v) => +(k0(v) !== k1(v));
      case "lt": return (v) => +(k0(v) < k1(v));
      case "le": return (v) => +(k0(v) <= k1(v));
      case "gt": return (v) => +(k0(v) > k1(v));
      case "ge": return (v) => +(k0(v) >= k1(v));
      case "land": return (v) => +(k0(v) !== 0 && k1(v) !== 0);
      case "lor": return (v) => +(k0(v) !== 0 || k1(v) !== 0);
      case "lnot": return (v) => +(k0(v) === 0);
      case "mux": return (v) => (k0(v) !== 0 ? k1(v) : k2(v));
    }
    return (v) => evalAnn(x, v);
  };
  const f = build(a);
  return (vals) => f(vals);
}
// convenience: one evaluation (env entries carry value, type, isConst)
function evalPatC(p, env) {
  const a = annotate(p, env);
  return { value: evalAnn(a, Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.value]))), type: a.T };
}
// compile-time JS inside .to(): constants of bound nodes, numbers and the FUNCS table
function evalJs(p, env) {
  switch (p.t) {
    case "lit": return p.value;
    case "var": { const b = env[p.name]; if (!b || !b.isConst) throw new Error(`${p.name} is not a constant here`); return typeof b.value === "bigint" ? Number(b.value) : b.value; }
    case "name": if (p.name in FUNCS) return FUNCS[p.name]; throw new Error(`unknown name ${p.name}`);
    case "call": { const f = FUNCS[p.fn]; if (!f) throw new Error(`unknown function ${p.fn}()`); return f(...p.args.map((a) => evalJs(a, env))); }
    case "op": {
      const xs = p.args.map((a) => evalJs(a, env));
      const [a, b, c] = xs;
      switch (p.op) {
        case "add": return a + b; case "sub": return a - b; case "mul": return a * b; case "shl": return a * 2 ** b; case "shr": return Math.floor(a / 2 ** b);
        case "and": return a & b; case "or": return a | b; case "xor": return a ^ b; case "neg": return -a; case "not": return ~a;
        case "mux": return a ? b : c; case "eq": return +(a === b); case "ne": return +(a !== b); case "lt": return +(a < b); case "le": return +(a <= b); case "gt": return +(a > b); case "ge": return +(a >= b);
        case "land": return +(!!a && !!b); case "lor": return +(!!a || !!b); case "lnot": return +!a;
      }
      throw new Error(`${p.op} at build time`);
    }
  }
  throw new Error(`cannot evaluate ${p.t} at build time`);
}
function opType(op, ts) {
  switch (op) {
    case "add": case "sub": case "mul": case "and": case "or": case "xor": case "eq": case "ne": case "lt": case "le": case "gt": case "ge": case "land": case "lor": return binType(op, ts[0], ts[1]);
    case "neg": case "not": case "lnot": return unType(op, ts[0]);
    case "mux": return joinType(ts[1], ts[2]);
  }
  throw new Error(`no type for ${op}`);
}

// match a pattern at node id; yields bindings name → node id
function* matchAt(g, p, id, bind) {
  const n = g.node(id);
  if (!n) return;
  if (p.t === "var") {
    if (bind[p.name] != null) { if (bind[p.name] === id) yield bind; return; }
    yield { ...bind, [p.name]: id };
    return;
  }
  if (p.t === "lit") { if (n.op === "const" && eqVal(n.attrs.value, p.value)) yield bind; return; }
  if (p.t !== "op") return;
  if (n.op !== p.op || n.args.length !== p.args.length) return;
  const orders = COMMUTATIVE.has(p.op) && p.args.length === 2 ? [[0, 1], [1, 0]] : [p.args.map((_, i) => i)];
  for (const ord of orders) {
    const step = function* (i, b) {
      if (i === ord.length) { yield b; return; }
      for (const b2 of matchAt(g, p.args[i], n.args[ord[i]], b)) yield* step(i + 1, b2);
    };
    yield* step(0, bind);
  }
}
const bindView = (g, id) => {
  const n = g.node(id);
  return { id, op: n.op, isConst: n.op === "const", value: n.op === "const" ? n.attrs.value : undefined, width: n.type.w, signed: !!n.type.signed, type: n.type };
};
// build the replacement in the graph
function buildPat(g, p, bind, origin) {
  switch (p.t) {
    case "var": return bind[p.name];
    case "lit": return g.const(p.value, constType(p.value), origin);
    case "name": throw new Error(`unknown name ${p.name}`);
    case "call": {
      if (p.fn === "wrap" || p.fn === "sat") {
        const x = buildPat(g, p.args[0], bind, origin), T = evalJs(p.args[1], envOf(g, bind));
        return g.add(p.fn, [x], T, {}, origin);
      }
      const v = evalJs(p, envOf(g, bind));
      return g.const(v, constType(v), origin);
    }
    case "op": {
      if ((p.op === "shl" || p.op === "shr")) {
        const x = buildPat(g, p.args[0], bind, origin);
        let k;
        try { k = evalJs(p.args[1], envOf(g, bind)); } catch { k = null; }
        const X = g.node(x);
        if (k != null) { const kid = g.const(k, constType(k), origin); return g.add(p.op, [x, kid], shiftType(p.op, X.type, k, null), {}, origin); }
        const kid = buildPat(g, p.args[1], bind, origin);
        return g.add(p.op, [x, kid], shiftType(p.op, X.type, null, g.node(kid).type), {}, origin);
      }
      let k;
      try { k = evalJs(p, envOf(g, bind)); } catch { k = undefined; }
      if (typeof k === "number" && Number.isInteger(k) && p.args.every((a) => a.t !== "var" || g.node(bind[a.name])?.op === "const")) return g.const(k, constType(k), origin);
      const args = p.args.map((a) => buildPat(g, a, bind, origin));
      const T = opType(p.op, args.map((a) => g.node(a).type));
      return g.add(p.op, args, T, {}, origin);
    }
  }
}
const envOf = (g, bind) => Object.fromEntries(Object.entries(bind).map(([k, id]) => { const n = g.node(id); return [k, { isConst: n.op === "const", value: n.attrs.value, type: n.type }]; }));

// rule soundness: exhaustive over operand widths 1..8 where the product of value ranges is small, sampled above
const RULE_CHECKS = new Map();
function rng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
const bigRange = (T) => (T.signed ? [-(1n << BigInt(T.w - 1)), (1n << BigInt(T.w - 1)) - 1n] : [0n, (1n << BigInt(T.w)) - 1n]);
// edge cases first, then random values of type T
function values(T, rand, n) {
  const big = isBig(T);
  const [lo, hi] = bigRange(T);
  const cand = [0n, 1n, lo, hi, -1n, lo + 1n, hi - 1n, hi >> 1n, (hi >> 1n) + 1n].filter((v) => v >= lo && v <= hi);
  const out = new Set(cand.map(String));
  let guard = 0;
  while (out.size < n && guard++ < n * 4) {
    let r = 0n;
    for (let b = 0; b < T.w; b += 30) r = (r << 30n) | BigInt(Math.floor(rand() * 2 ** 30));
    out.add(String(T.signed ? BigInt.asIntN(T.w, r) : BigInt.asUintN(T.w, r)));
  }
  return [...out].map((x) => (big ? BigInt(x) : Number(x)));
}
function allValues(T) { const [lo, hi] = [Number(bigRange(T)[0]), Number(bigRange(T)[1])]; const a = []; for (let v = lo; v <= hi; v++) a.push(v); return a; }
const sampleOf = (lists, n, rand) => Array.from({ length: n }, () => lists.map((l) => l[Math.floor(rand() * l.length)]));
// Soundness of a rule, without a solver: for operand widths 1..8, every assignment of values is evaluated through both
// sides (D1 types: nothing overflows, so equal integers mean equal hardware) while the assignment space is at most
// 2^16 per configuration; larger spaces are sampled and reported as such. Mixed signedness is enumerated up to 4 bits.
export function checkRule(rule) {
  const key = [rule.name, rule.fromFn?.toString(), rule.whereFn?.toString(), rule.toFn?.toString()].join("§");
  if (RULE_CHECKS.has(key)) return RULE_CHECKS.get(key);
  const res = { name: rule.name, status: "sound", exhaustiveUpTo: 0, mixedSignsUpTo: 0, sampled: [], examples: null, counterexample: null, error: null, configs: 0, vectors: 0 };
  RULE_CHECKS.set(key, res);
  let from, to;
  try { from = parseLambda(rule.fromFn); to = parseLambda(rule.toFn); }
  catch (e) { res.status = "error"; res.error = e.message; return res; }
  const vars = from.params, nv = vars.length;
  const toBody = renameVars(to.body, Object.fromEntries(to.params.map((n, i) => [n, vars[i]])));
  const rand = rng(12345);
  const t0 = now();
  const BUDGET = 1 << 16;
  // a variable the guard never reads and .to never needs as a build-time constant behaves the same whether it
  // matched a constant or not, so only its value is enumerated (as an input)
  const needC = new Set();
  (function scanTo(p, ct) {
    if (p.t === "var" && ct) needC.add(p.name);
    if (p.t === "call") for (const a of p.args) scanTo(a, p.fn !== "wrap" && p.fn !== "sat" ? true : ct);
    else if (p.t === "op" && (p.op === "shl" || p.op === "shr")) { scanTo(p.args[0], ct); scanTo(p.args[1], true); }
    else for (const a of p.args || []) scanTo(a, ct);
  })(toBody, false);
  if (rule.whereFn) {
    for (let m = 0; m < 1 << nv; m++) for (const val of [0, 1, 2, 3, 8]) {
      const view = {};
      vars.forEach((name, i) => {
        const o = { op: (m >> i) & 1 ? "const" : "in", isConst: !!((m >> i) & 1), value: (m >> i) & 1 ? val : undefined, width: 8, signed: false, type: u(8) };
        view[name] = new Proxy(o, { get: (t, k) => { needC.add(name); return t[k]; } });
      });
      try { rule.whereFn(view); } catch { /* the guard may throw on some shapes */ }
    }
  }
  const cVars = vars.map((_, i) => i).filter((i) => needC.has(vars[i]));
  outer: for (let w = 1; w <= 8; w++) {
    let exhaustive = now() - t0 < 1500;
    const all = (1 << nv) - 1;
    const signSets = w <= 4 && nv <= 3 ? [...Array(1 << nv).keys()] : [0, all];
    const masks = [...Array(1 << cVars.length).keys()].map((m) => cVars.reduce((acc, vi, j) => ((m >> j) & 1 ? acc | (1 << vi) : acc), 0));
    for (const sm of signSets) {
      for (const cm of masks) {
        const T = vars.map((_, i) => ((sm >> i) & 1 ? s(w) : u(w)));
        const isC = vars.map((_, i) => !!((cm >> i) & 1));
        const cIdx = vars.map((_, i) => i).filter((i) => isC[i]);
        const vIdx = vars.map((_, i) => i).filter((i) => !isC[i]);
        const full = (idx) => exhaustive && 2 ** (w * idx.length) <= BUDGET;
        const cLists = cIdx.map((i) => (full(cIdx) ? allValues(T[i]) : values(T[i], rand, 16)));
        const cCombos = full(cIdx) ? cartesian(cLists, BUDGET) : sampleOf(cLists, 256, rand);
        if (!full(cIdx)) exhaustive = false;
        const accepted = [];
        for (const cv of cCombos) {
          if (rule.whereFn) {
            const view = {};
            vars.forEach((name, i) => { const ci = cIdx.indexOf(i); view[name] = { op: isC[i] ? "const" : "in", isConst: isC[i], value: isC[i] ? cv[ci] : undefined, width: w, signed: !!T[i].signed, type: T[i] }; });
            let ok = false;
            try { ok = !!rule.whereFn(view); } catch { ok = false; }
            if (!ok) continue;
          }
          accepted.push(cv);
        }
        if (!accepted.length) continue;
        const vSpace = 2 ** (w * vIdx.length);
        const vFull = exhaustive && accepted.length * vSpace <= BUDGET;
        if (!vFull) exhaustive = false;
        const vLists = vIdx.map((i) => (vFull ? allValues(T[i]) : values(T[i], rand, 24)));
        const per = vFull ? null : Math.max(16, Math.ceil(4096 / accepted.length));
        for (const cv of accepted) {
          res.configs++;
          const env = {};
          vars.forEach((name, i) => { const ci = cIdx.indexOf(i); env[name] = { type: T[i], isConst: isC[i], value: isC[i] ? cv[ci] : 0 }; });
          let A, B;
          try { A = compileAnn(annotate(from.body, env)); } catch { continue; }
          try { B = compileAnn(annotate(toBody, env)); }
          catch (e) { if (/not a constant/.test(e.message)) continue; res.status = "error"; res.error = e.message; break outer; }
          const vals = {};
          vars.forEach((name, i) => { if (isC[i]) vals[name] = cv[cIdx.indexOf(i)]; });
          // an odometer over the input values (no per-vector allocation), or random samples
          const names = vIdx.map((i) => vars[i]), L = vLists.map((l) => l.length), ix = new Array(names.length).fill(0);
          const total = vFull ? L.reduce((p, x) => p * x, 1) : per;
          for (let t = 0; t < total; t++) {
            if (vFull) {
              for (let j = 0; j < names.length; j++) vals[names[j]] = vLists[j][ix[j]];
              for (let j = 0; j < names.length; j++) { if (++ix[j] < L[j]) break; ix[j] = 0; }
            } else for (let j = 0; j < names.length; j++) vals[names[j]] = vLists[j][Math.floor(rand() * L[j])];
            let a, b;
            try { a = A(vals); b = B(vals); } catch { continue; }
            res.vectors++;
            if (a !== b && !eqVal(a, b)) {
              res.status = "unsound";
              res.counterexample = { width: w, inputs: Object.fromEntries(vars.map((nm, i) => [nm, `${vals[nm]} (${typeName(T[i])}${isC[i] ? ", constant" : ""})`])), from: String(a), to: String(b) };
              break outer;
            }
          }
        }
      }
    }
    if (exhaustive) { res.exhaustiveUpTo = w; if (w <= 4) res.mixedSignsUpTo = w; } else res.sampled.push(w);
  }
  // examples: [[fromLambda, toLambda | null], …]
  if (res.status === "sound" && rule.exampleList?.length) {
    let ok = 0;
    const fails = [];
    rule.exampleList.forEach((ex, i) => {
      try { if (exampleHolds(rule, from, toBody, ex)) ok++; else fails.push(i + 1); }
      catch (e) { fails.push(`${i + 1} (${e.message})`); }
    });
    res.examples = { ok, total: rule.exampleList.length, fails };
    if (fails.length) res.status = "examples-fail";
  }
  return res;
}
function renameVars(p, ren) {
  if (p.t === "var") return { t: "var", name: ren[p.name] ?? p.name };
  if (p.args) return { ...p, args: p.args.map((a) => renameVars(a, ren)) };
  return p;
}
function cartesian(lists, cap) {
  let out = [[]];
  for (const l of lists) {
    const next = [];
    for (const a of out) for (const v of l) { next.push([...a, v]); if (next.length >= cap) break; }
    out = next;
    if (!out.length) return [];
  }
  return out;
}
// build the example's left side as a tiny graph at 8 bits, apply the rule at its root, compare with the right side
function exampleHolds(rule, from, toBody, [lhs, rhs]) {
  const L = parseLambda(lhs);
  const T = u(8);
  const g = new Graph("example", null);
  const ins = Object.fromEntries(L.params.map((nm) => [nm, g.input(nm, T)]));
  const root = buildPat(g, L.body, ins);
  const m = firstMatch(g, rule, from, root);
  if (rhs == null) return !m;
  if (!m) return false;
  const R = parseLambda(rhs);
  for (const vals of cartesian(L.params.map(() => allValues(T)), 1 << 16)) {
    const env = Object.fromEntries(L.params.map((nm, i) => [nm, { value: vals[i], type: T }]));
    const envR = Object.fromEntries(R.params.map((nm, i) => [nm, env[L.params[i]]]));
    const a = evalPatC(L.body, env), b = evalPatC(R.body, envR);
    const bind = Object.fromEntries(Object.entries(m).map(([k, id]) => [k, nodeEnv(g, id, env, ins)]));
    const c = evalPatC(toBody, bind);
    if (!eqVal(a.value, b.value) || !eqVal(c.value, b.value)) return false;
  }
  return true;
}
function nodeEnv(g, id, env, ins) {
  const n = g.node(id);
  if (n.op === "const") return { value: n.attrs.value, type: n.type, isConst: true };
  const name = Object.keys(ins).find((k) => ins[k] === id);
  if (name) return { ...env[name], isConst: false };
  return { value: evalNode(g, id, (x) => { const nm = Object.keys(ins).find((k) => ins[k] === x); return env[nm].value; }), type: n.type, isConst: false };
}
function evalNode(g, id, leaf) {
  const n = g.node(id);
  if (n.op === "const") return n.attrs.value;
  if (n.op === "in") return leaf(id);
  return evalOp(n.op, n.type, n.args.map((a) => evalNode(g, a, leaf)), n.attrs);
}
function firstMatch(g, rule, from, id) {
  for (const b of matchAt(g, from.body, id, {})) {
    if (Object.keys(b).length < from.params.length) continue;
    if (rule.whereFn) {
      const view = Object.fromEntries(Object.entries(b).map(([k, x]) => [k, bindView(g, x)]));
      let ok = false;
      try { ok = !!rule.whereFn(view); } catch { ok = false; }
      if (!ok) continue;
    }
    return b;
  }
  return null;
}
// per-match check at the real widths: random and edge vectors through both sides (cached per signature)
const INSTANCE_CHECKS = new Map();
function instanceHolds(g, rule, from, toBody, bind) {
  const sig = rule.name + "|" + Object.entries(bind).map(([k, id]) => { const n = g.node(id); return `${k}:${typeName(n.type)}${n.op === "const" ? "=" + n.attrs.value : ""}`; }).join(",");
  if (INSTANCE_CHECKS.has(sig)) return INSTANCE_CHECKS.get(sig);
  const rand = rng(777);
  const names = Object.keys(bind);
  const env = Object.fromEntries(names.map((k) => { const n = g.node(bind[k]); return [k, { type: n.type, isConst: n.op === "const", value: n.op === "const" ? n.attrs.value : 0 }]; }));
  let ok = true, tried = 0;
  try {
    const A = annotate(from.body, env), B = annotate(toBody, env);
    const lists = names.map((k) => (env[k].isConst ? [env[k].value] : values(env[k].type, rand, 64)));
    for (let t = 0; t < 256 && ok; t++) {
      const vals = {};
      names.forEach((k, i) => { const l = lists[i]; vals[k] = t < l.length ? l[t] : l[Math.floor(rand() * l.length)]; });
      if (!eqVal(evalAnn(A, vals), evalAnn(B, vals))) ok = false;
      tried++;
    }
  } catch { ok = false; }
  const res = { ok, tried, width: Math.max(...names.map((k) => g.node(bind[k]).type.w)) };
  INSTANCE_CHECKS.set(sig, res);
  return res;
}
// local cost of a set of nodes for saturation decisions
function localCost(r, g, ids, cx) {
  let c = 0;
  for (const id of ids) {
    const n = g.node(id);
    if (!n) continue;
    const k = nodeCost(g, n, r.F, r.fam, cx);
    c += k.luts + k.dsps * 40 + k.carry * 0.25;
    if (!ROUTING.has(n.op) && !((n.op === "shl" || n.op === "shr") && g.node(n.args[1])?.op === "const")) c += 0.01;
  }
  return c;
}
function newNodes(g, before) { const out = []; for (let i = before; i < g.nodes.length; i++) if (g.nodes[i]) out.push(i); return out; }
// saturation, e-graph-lite: every rule is tried at every node each round; a match is applied when its local cost
// does not grow (the cheapest form wins one match at a time; no e-classes are kept)
function saturate(r, rules, opts) {
  const iters = opts.iters ?? 6;
  const loaded = [];
  for (const raw of rules) {
    const rule = raw instanceof RuleDef ? raw : resolvePass(raw);
    if (!(rule instanceof RuleDef)) continue;
    const chk = checkRule(rule);
    const rec = { name: rule.name, status: chk.status, exhaustiveUpTo: chk.exhaustiveUpTo, sampled: chk.sampled, examples: chk.examples, counterexample: chk.counterexample, error: chk.error, matches: 0, applied: 0, rejected: 0 };
    r.rules.set(rule.name, rec);
    if (chk.status === "unsound") { r.diag("error", "rule-unsound", `rule "${rule.name}" is unsound: ${Object.entries(chk.counterexample.inputs).map(([k, v]) => `${k} = ${v}`).join(", ")} gives ${chk.counterexample.from} before and ${chk.counterexample.to} after`); continue; }
    if (chk.status === "error") { r.diag("error", "rule", `rule "${rule.name}": ${chk.error}`); continue; }
    if (chk.status === "examples-fail") { r.diag("error", "rule-example", `rule "${rule.name}": example${chk.examples.fails.length > 1 ? "s" : ""} ${chk.examples.fails.join(", ")} do not hold`); continue; }
    const from = parseLambda(rule.fromFn), to = parseLambda(rule.toFn);
    loaded.push({ rule, from, toBody: renameVars(to.body, Object.fromEntries(to.params.map((n, i) => [n, from.params[i]]))), rec });
  }
  if (!loaded.length) return { note: "no usable rules" };
  let rounds = 0, total = 0, before = 0, after = 0;
  for (const g of Object.values(r.graphs)) {
    const cx = estCtxFor(r, g);
    for (let it = 0; it < iters; it++) {
      let order;
      try { order = g.topo(); } catch { break; }
      const map = new Map();
      let applied = 0;
      for (const id of order) {
        const n = g.node(id);
        if (!n || !(n.op in PURE) || n.op === "const" || map.has(id)) continue;
        for (const L of loaded) {
          const b = firstMatch(g, L.rule, L.from, id);
          if (!b) continue;
          L.rec.matches++;
          const chk = instanceHolds(g, L.rule, L.from, L.toBody, b);
          if (!chk.ok) { L.rec.rejected++; continue; }
          const mark = g.nodes.length;
          let rep;
          try { rep = buildPat(g, L.toBody, b, n.origin); } catch (e) { L.rec.rejected++; L.rec.error = e.message; continue; }
          rep = extTo(g, rep, n.type, n.origin);
          if (rep === id) continue;
          const created = newNodes(g, mark);
          const oldCost = localCost(r, g, [id], cx), newCost = created.length ? localCost(r, g, created, cx) : 0;
          if (newCost > oldCost + 1e-9 && opts.cost !== "none") { L.rec.rejected++; for (const c of created) if (!g.users(c).length) g.nodes[c] = null; g.rehash(); continue; }
          map.set(id, rep);
          before += oldCost; after += newCost;
          L.rec.applied++; applied++;
          break;
        }
      }
      if (!applied) break;
      batchReplace(r, g, map);
      sweep(r, g);
      rounds = Math.max(rounds, it + 1);
      total += applied;
    }
    sweep(r, g);
  }
  const by = loaded.filter((L) => L.rec.applied).map((L) => `${L.rule.name} ×${L.rec.applied}`);
  return { note: `greedy saturation (e-graph-lite): ${total} rewrite${total === 1 ? "" : "s"} in ${rounds} round${rounds === 1 ? "" : "s"}${by.length ? ` — ${by.join(", ")}` : ""}; local cost ${round(before, 2)} → ${round(after, 2)} ${opts.cost || "luts"}` };
}

// ═════════════════════════════════════════════ validation (translation validation by random vectors) ═════════
// a small cycle evaluator over one Graph, deterministic per input path and cycle
function hash32(str) { let h = 2166136261 >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
function randFor(T, seed, path, cycle) {
  const h = hash32(`${seed}|${path}|${cycle}`), h2 = hash32(`${cycle}|${path}|${seed}`);
  if (isBig(T)) return wrapTo((BigInt(h) << 32n) | BigInt(h2), T);
  return wrapTo(T.w > 32 ? h * 2 ** 21 + (h2 >>> 11) : h, T);
}
export function evalNodeOp(n, vals, g) {
  switch (n.op) {
    case "const": return n.attrs.value;
    case "rom": { const t = n.attrs.table || []; const i = Number(vals[0]); return i >= 0 && i < t.length ? fromPattern(encodeValue(t[i], n.type), n.type) : (isBig(n.type) ? 0n : 0); }
    case "concat": case "pack": {
      // concat and struct pack: most significant operand first; vec pack: element 0 in the low bits (as sim.js)
      const R = n.type;
      const ws = n.op === "pack" && R.k === "vec" ? n.args.map(() => R.elem.w) : n.args.map((a, i) => (n.op === "pack" && R.k === "struct" && R.fields[i] ? R.fields[i][1].w : g.node(a).type.w));
      let acc = 0n;
      const order = n.op === "pack" && R.k === "vec" ? n.args.map((_, i) => n.args.length - 1 - i) : n.args.map((_, i) => i);
      for (const i of order) acc = (acc << BigInt(ws[i])) | BigInt.asUintN(ws[i], toBig(vals[i]));
      return fromPattern(acc, R);
    }
    case "field": {
      const T = g.node(n.args[0]).type;
      let lo = n.attrs.lo;
      if (lo == null && T.fields) { lo = T.w; for (const [nm, F] of T.fields) { lo -= F.w; if (nm === n.attrs.name) break; } }
      const p = BigInt.asUintN(T.w, toBig(vals[0])) >> BigInt(lo || 0);
      return wrapTo(isBig(n.type) ? BigInt.asUintN(n.type.w, p) : Number(BigInt.asUintN(n.type.w, p)), n.type);
    }
    case "index": {
      const T = g.node(n.args[0]).type, ew = n.type.w, i = Number(vals[1]);
      if (i >= (T.n ?? Math.floor(T.w / ew))) return isBig(n.type) ? 0n : 0;
      const p = BigInt.asUintN(T.w, toBig(vals[0])) >> BigInt(i * ew);
      return wrapTo(isBig(n.type) ? BigInt.asUintN(ew, p) : Number(BigInt.asUintN(ew, p)), n.type);
    }
    default: return evalOp(n.op, n.type, vals, n.attrs);
  }
}
// input(n, cycle) supplies input values; by default a hash of (seed, path, cycle), so two graphs agree by path
export function traceGraph(g, { cycles = 32, seed = 1, input = null } = {}) {
  const order = g.topo();
  const regs = g.live().filter((n) => n.op === "reg");
  const state = new Map(regs.map((n) => [n.id, fromPattern(encodeValue(n.attrs.init ?? 0, n.type), n.type)]));
  const mems = new Map(), rdq = new Map();
  for (const n of g.live()) if (n.op === "mem") { const E = n.attrs.elem || n.type; mems.set(n.id, Array.from({ length: n.attrs.words }, (_, i) => fromPattern(encodeValue(n.attrs.init?.[i] ?? 0, E), E))); }
  const trace = [];
  for (let c = 0; c < cycles; c++) {
    const v = new Map();
    for (const id of order) {
      const n = g.node(id);
      if (n.op === "in") v.set(id, input ? wrapTo(input(n, c), n.type) : randFor(n.type, seed, n.attrs.path || `in${id}`, c));
      else if (n.op === "reg") v.set(id, state.get(id));
      else if (n.op === "mem") v.set(id, 0);
      else if (n.op === "memrd") v.set(id, rdq.get(id) ?? 0);
      else if (n.op === "memwr" || n.op === "cell") v.set(id, 0);
      else if (n.op === "out" || n.op === "probe") v.set(id, v.get(n.args[0]));
      else v.set(id, evalNodeOp(n, n.args.map((a) => v.get(a)), g));
    }
    const snap = {};
    for (const n of regs) snap[n.attrs.path || `%${n.id}`] = String(state.get(n.id));
    for (const n of g.live()) if (n.op === "out" && n.attrs.path) snap["out:" + n.attrs.path] = String(v.get(n.id));
    trace.push(snap);
    for (const n of regs) if (n.attrs.next != null) state.set(n.id, wrapTo(v.get(n.attrs.next), n.type));
    for (const n of g.live()) {
      if (n.op === "memrd" && truthy(v.get(n.args[2] ?? -1) ?? 1)) { const m = mems.get(n.args[0]); rdq.set(n.id, m?.[Number(v.get(n.args[1]))] ?? 0); }
    }
    for (const n of g.live()) {
      if (n.op === "memwr" && truthy(v.get(n.args[3]))) { const m = mems.get(n.args[0]); const a = Number(v.get(n.args[1])); if (m && a >= 0 && a < m.length) m[a] = v.get(n.args[2]); }
    }
  }
  return trace;
}
const truthy = (x) => x != null && toBig(x) !== 0n;
const fromPattern = (p, T) => wrapTo(isBig(T) ? p : Number(BigInt.asUintN(T.w, p)), T);
function compareTraces(a, b) {
  for (let c = 0; c < Math.min(a.length, b.length); c++) {
    for (const k of Object.keys(a[c])) {
      if (k.includes("~")) continue;
      if (k in b[c] && a[c][k] !== b[c][k]) return { cycle: c, path: k, expected: a[c][k], got: b[c][k] };
    }
  }
  return null;
}

// ═════════════════════════════════════════════ runPipeline ═════════════════════════════════════════════════
const STAGE_CACHE = new Map();
export function runPipeline(ctx) {
  const t0 = now();
  ctx = ctx || {};
  ctx.domains ||= {};
  const cfg = configure(ctx.compileCfg, makeTarget(ctx));
  const r = new Run(ctx, cfg);
  for (const e of cfg.errors) r.diag("error", "compile-config", e);
  const plan = cfg.plan || clonePlan(STD_PIPELINE, r.target);
  const stages = [];
  const levels = {};
  const snapshotsOut = [];
  const timings = ctx.timings || {};
  if (cfg.validateOpts) r._prev = cloneGraphs(r);
  for (const st of plan) {
    // level boundaries: keep clones for scenarios at several IR levels and for report.ir(level)
    if (st.level === "net" && !levels.dag) levels.dag = cloneGraphs(r);
    const rec = { name: st.name, level: st.level, passes: [], ms: 0, iterations: 1 };
    const ts = now();
    if (st.level === "dag" && !levels.lower && !st.passes.every((p) => p?.external)) levels.lower = cloneGraphs(r);
    // stage cache: a dag stage whose input hash and pass list are unchanged reuses its output
    const cacheKey = cfg.cacheDir && st.level === "dag" && st.passes.every((p) => p?.std) ? `${st.name}|${st.passes.map((p) => p.name + JSON.stringify(p.pparams || {})).join(",")}|${designHash(r)}` : null;
    const hit = cacheKey && STAGE_CACHE.get(cacheKey);
    if (hit) {
      for (const [d, g] of Object.entries(hit.graphs)) { const c = g.clone(); r.graphs[d] = c; ctx.domains[d].graph = c; }
      rec.passes = hit.passes.map((p) => ({ ...p, ms: 0, reused: true, note: (p.note ? p.note + " · " : "") + "reused from cache" }));
      r.events.push({ kind: "stage", stage: st.name, reused: true });
    } else {
      const maxIt = st.fixpoint ? st.fixpoint.max ?? 8 : 1;
      let it = 0;
      for (; it < maxIt; it++) {
        const h0 = st.fixpoint ? designHash(r) : null;
        st.passes.forEach((p, i) => {
          const pr = runOne(r, p, st, timings, i, st.passes.length);
          if (!pr) return;
          const prev = rec.passes[i];
          if (prev) { prev.ms = round(prev.ms + pr.ms, 3); prev.nodesAfter = pr.nodesAfter; if (pr.changed) prev.note = pr.note; prev.changed = prev.changed || pr.changed; prev.diags.push(...pr.diags); }
          else rec.passes[i] = pr;
        });
        if (!st.fixpoint || designHash(r) === h0) { it++; break; }
      }
      rec.iterations = it;
      rec.passes = rec.passes.filter(Boolean);
      if (st.fixpoint) rec.note = `fixpoint after ${it} iteration${it > 1 ? "s" : ""} (max ${maxIt})`;
      if (cacheKey) {
        STAGE_CACHE.set(cacheKey, { graphs: cloneGraphs(r), passes: rec.passes.map((p) => ({ ...p, diags: [] })) });
        if (STAGE_CACHE.size > 32) STAGE_CACHE.delete(STAGE_CACHE.keys().next().value);
      }
    }
    rec.ms = round(now() - ts, 3);
    if (st.passes.every((p) => p?.external)) rec.ms = round(rec.passes.reduce((a, p) => a + (p.ms || 0), 0), 3);
    // structure is checked after every stage (and after every pass with verifyEach)
    if (st.level !== "hir") verifyAll(r, `end of stage ${st.name}`);
    for (const sn of cfg.snapshots) if (sn.after === st.name || (!sn.after && sn.level === st.level && nextLevelChanges(plan, st))) {
      const text = snapshotText(r, sn);
      rec.snapshot = { level: sn.level, as: sn.as || "text", to: sn.to || null, text };
      snapshotsOut.push({ path: sn.to || `${st.name}.${sn.as || "txt"}`, text });
    }
    for (const ins of cfg.inspects) if (ins.after === st.name || (!ins.after && ins.level === st.level && nextLevelChanges(plan, st))) rec.inspect = runInspect(r, ins);
    stages.push(rec);
  }
  // the report needs the estimate and timing even when a custom pipeline left them out
  r.curPass = null;
  if (!r.est) techmap(r);
  if (!r.timing) timingPass(r);
  if (!levels.lower) levels.lower = cloneGraphs(r);
  if (!levels.dag) levels.dag = cloneGraphs(r);
  levels.net = { ...r.graphs };
  const report = buildReport(r, levels, stages);
  // checks: builder lambdas over the report (and the target)
  for (const c of cfg.checks) {
    let v, err = null;
    try { v = c.fn(report, r.target); } catch (e) { err = e.message; }
    const ok = err == null && (v === undefined || (!!v && typeof v !== "string"));
    const message = err ? `threw: ${err}` : typeof v === "string" ? v : ok ? "holds" : "does not hold";
    report.checks.push({ kind: "check", name: c.name, ok, message });
    if (!ok) r.diag("error", "check-failed", `check "${c.name}": ${message}`);
  }
  // emits
  const emits = runEmits(r, cfg, report, snapshotsOut);
  report.emits = emits.map((e) => ({ backend: e.backend, files: e.files.map((f) => ({ path: f.path, bytes: f.text.length })), note: e.note }));
  // explore
  report.explore = cfg.exploreSpec ? { spec: cfg.exploreSpec, points: null, pending: true, size: cfg.exploreSpec.knobs.reduce((a, k) => a * k.values.length, 1) } : null;
  if (report.explore && typeof ctx.recompile === "function") {
    // the grid is a recompile per point, so it runs when asked: report.explore.run({ onPoint, limit })
    hidden(report.explore, "run", (o = {}) => runExplore(report.explore, ctx.recompile, o));
    if (ctx.explore === true) runExplore(report.explore, ctx.recompile);
  }
  if (cfg.explain) report.plan = explainPlan(r, plan, stages);
  report.diags = r.diags;
  report.ms = round(now() - t0, 2);
  // pass diags flow back to the compiler's list
  if (Array.isArray(ctx.diags)) for (const d of r.diags) ctx.diags.push(d);
  return { stages, report, emits, levels, diags: r.diags };
}
function nextLevelChanges(plan, st) {
  const i = plan.indexOf(st);
  return i === plan.length - 1 || plan[i + 1].level !== st.level;
}
function cloneGraphs(r) { return Object.fromEntries(Object.entries(r.graphs).map(([d, g]) => [d, g.clone()])); }
function verifyAll(r, where) {
  for (const g of Object.values(r.graphs)) {
    for (const d of g.verify()) {
      if (d.level === "warn" || d.code === "comb-loop") continue;
      const n = g.node(d.node);
      r.diag("error", d.code === "comb-loop" ? "comb-loop" : "ir-invariant", `${d.message} (${where}${r.curPass ? `, after ${r.curPass}` : ""})`, n);
    }
  }
}
// one pass over the design; returns its record
function runOne(r, p0, st, timings, idx, count) {
  const p = resolvePass(p0) || p0;
  const rec = { name: p?.name || String(p0), kind: p?.kind || "pass", ms: 0, nodesBefore: graphNodes(r), nodesAfter: 0, diags: [], note: "", changed: false };
  if (!p || (!(p instanceof PassDef) && !(p instanceof RuleDef))) {
    rec.note = "not a pass"; rec.nodesAfter = rec.nodesBefore;
    r.diag("error", "compile-config", `${st.name}: ${String(p0?.name || p0)} is not a pass`);
    return rec;
  }
  r.curPass = rec.name;
  const d0 = r.diags.length;
  const h0 = designHash(r);
  const ts = now();
  try {
    if (p instanceof RuleDef) Object.assign(rec, { note: saturate(r, [p], { iters: 4, cost: "luts" }).note });
    else if (p.external) {
      const total = timings[p.external];
      const nExt = st.passes.filter((x) => x?.external === p.external).length || 1;
      rec.note = `done in ${p.external === "front" ? "front.js" : "lower.js"}`;
      rec.ms = total != null ? round(total / nExt, 3) : 0;
      rec.external = true;
      r.events.push({ kind: "pass", stage: st.name, pass: p.name, ran: true, external: true });
      rec.nodesBefore = p.external === "front" ? null : rec.nodesBefore;
      rec.nodesAfter = p.external === "front" ? null : graphNodes(r);
      r.curPass = null;
      return rec;
    } else if (p.kind === "analysis") {
      for (const g of Object.values(r.graphs)) getAnalysis(r, p, g);
      rec.note = "analysis";
    } else if (p.kind === "backend") {
      rec.note = "backends run with emit()";
    } else if (p.std && p.impl) {
      r.ran.add(p.name);
      if (p.scope === "design") rec.note = p.impl(r, p.pparams || {})?.note || "";
      else {
        const notes = [];
        for (const g of Object.values(r.graphs)) { const o = p.impl(r, p.pparams || {}, g); if (o?.note) notes.push(Object.keys(r.graphs).length > 1 ? `${g.domain}: ${o.note}` : o.note); }
        rec.note = notes.join("; ");
      }
    } else rec.note = runCustom(r, p, st);
  } catch (e) {
    r.diag("error", "pass-failed", `${rec.name} failed: ${e.message}`);
    rec.note = "failed: " + e.message;
  }
  rec.ms = round(now() - ts, 3);
  rec.nodesAfter = graphNodes(r);
  const h1 = designHash(r);
  rec.changed = h0 !== h1;
  // analyses: invalidate what this pass did not preserve
  if (rec.changed) {
    const keep = p instanceof PassDef ? (p.ro ? null : new Set(p.pres || [])) : new Set();
    if (keep) for (const [k, a] of r.analyses) { const nm = k.split("@")[0]; if (!keep.has(nm) && a.valid) { a.valid = false; r.events.push({ kind: "invalidate", analysis: k, by: rec.name }); } }
    if (p instanceof PassDef && p.ro && !p.std) r.diag("error", "pass-readonly", `${rec.name} is readonly but changed the graph`);
  }
  if (r.cfg.verify) verifyAll(r, `verifyEach`);
  if (r.cfg.validateOpts && rec.changed && r._prev) validatePass(r, rec);
  if (r.cfg.validateOpts) r._prev = cloneGraphs(r);
  rec.diags = r.diags.slice(d0);
  r.events.push({ kind: "pass", stage: st.name, pass: rec.name, ran: true, changed: rec.changed, ms: rec.ms });
  r.curPass = null;
  return rec;
}
function validatePass(r, rec) {
  const o = r.cfg.validateOpts;
  for (const [d, before] of Object.entries(r._prev)) {
    const g = r.graphs[d];
    if (!g) continue;
    let a, b;
    try { a = traceGraph(before, o); b = traceGraph(g, o); } catch (e) { rec.validate = `not validated: ${e.message}`; return; }
    const m = compareTraces(a, b);
    if (m) r.diag("error", "validate", `${rec.name} changed behaviour in ${d}: ${m.path} is ${m.got} at cycle ${m.cycle}, was ${m.expected} (${o.cycles} random cycles)`);
    else rec.validate = `${o.cycles} random cycles agree`;
  }
}
function getAnalysis(r, a, g) {
  const key = `${a.name}@${g.domain}`;
  const c = r.analyses.get(key);
  if (c && c.valid) { r.events.push({ kind: "analysis", analysis: key, reused: true, for: r.curPass }); return c.value; }
  const ts = now();
  let v;
  for (const dep of a.reqs || []) getAnalysis(r, dep, g);
  if (a.impl) v = a.impl(r, g);
  else if (a.runFn) v = a.runFn(graphView(r, g, a), { ...a.pparams });
  r.analyses.set(key, { value: v, valid: true });
  r.events.push({ kind: "analysis", analysis: key, computed: true, ms: round(now() - ts, 3), for: r.curPass });
  return v;
}
function runCustom(r, p, st) {
  if (p.level === "hir") return "hir passes run inside front.js: skipped here";
  const notes = [];
  for (const g of Object.values(r.graphs)) {
    const params = { ...p.pparams };
    for (const a of p.reqs || []) {
      const A = resolveAnalysis(a);
      if (!A) { r.diag("error", "compile-config", `${p.name} requires ${a?.name || a}, which is not an analysis`); continue; }
      params[camel(A.name)] = getAnalysis(r, A, g);
    }
    const view = graphView(r, g, p);
    let visited = 0;
    try {
      if (p.runFn) p.runFn(view, params);
      for (const v of p.visits) {
        for (const n of view.nodes(v.ops.includes("*") ? null : v.ops)) { visited++; v.fn(n, view, params); }
      }
    } catch (e) {
      r.diag("error", "pass-failed", `${p.name}: ${e.message}`);
    }
    if (view.edited) sweep(r, g);
    if (p.visits.length) notes.push(`${Object.keys(r.graphs).length > 1 ? g.domain + ": " : ""}visited ${visited}`);
  }
  if (r.dupes) notes.push(`${r.dupes} duplicate${r.dupes > 1 ? "s" : ""}`);
  return notes.join("; ") || "ran";
}
function resolveAnalysis(a) {
  if (a instanceof PassDef) return a;
  if (typeof a === "string") return STD_ANALYSES[a] || null;
  if (a && a.name && STD_ANALYSES[a.name]) return STD_ANALYSES[a.name];
  return null;
}
function snapshotText(r, sn) {
  const as = sn.as || "text";
  if (as === "dot") return toDot(r);
  if (as === "json") return JSON.stringify(Object.fromEntries(Object.entries(r.graphs).map(([d, g]) => [d, g.live().map((n) => ({ id: n.id, op: n.op, args: n.args, type: typeName(n.type), path: n.attrs.path, next: n.attrs.next, origin: n.origin?.[0]?.src }))])), (k, v) => (typeof v === "bigint" ? v.toString() : v), 1);
  return Object.entries(r.graphs).map(([d, g]) => `── ${d}\n${g.print()}`).join("\n");
}
function toDot(r) {
  const lines = ["digraph weft {", "  rankdir=LR; node [shape=box, fontname=monospace, fontsize=10];"];
  for (const [d, g] of Object.entries(r.graphs)) {
    lines.push(`  subgraph "cluster_${d}" { label="${d}";`);
    for (const n of g.live()) {
      const label = n.op === "const" ? String(n.attrs.value) : n.attrs.path ? `${n.op} ${n.attrs.path}` : n.op;
      lines.push(`    "${d}_${n.id}" [label="%${n.id} ${label.replace(/"/g, "'")}\\n${typeName(n.type)}"${n.op === "reg" ? ", style=filled, fillcolor=\"#e8e2d0\"" : ""}];`);
      for (const a of n.args) lines.push(`    "${d}_${a}" -> "${d}_${n.id}";`);
      if (n.op === "reg" && n.attrs.next != null) lines.push(`    "${d}_${n.attrs.next}" -> "${d}_${n.id}" [style=dashed, label="next"];`);
    }
    lines.push("  }");
  }
  lines.push("}");
  return lines.join("\n");
}
function runInspect(r, ins) {
  const out = [];
  const view = designView(r, ins.level);
  const orig = console.log;
  const fmt = (x) => (typeof x === "string" ? x : JSON.stringify(x, (k, v) => (typeof v === "bigint" ? v.toString() : v), 1));
  console.log = (...a) => { out.push(a.map(fmt).join(" ")); };
  let ret;
  try { ret = ins.fn(view); } catch (e) { out.push("error: " + e.message); }
  finally { console.log = orig; }
  if (ret !== undefined && ret !== null) out.push(fmt(ret));
  return { level: ins.level, output: out };
}

// ═════════════════════════════════════════════ report ══════════════════════════════════════════════════════
function buildReport(r, levels, stages) {
  const e = r.est;
  const P = r.part;
  const resources = { ...e.resources };
  const perModule = e.perModule;
  hidden(resources, "of", (path) => {
    const out = { luts: 0, ffs: 0, brams: 0, dsps: 0, carry: 0, lutram: 0, sprams: 0 };
    for (const [m, v] of Object.entries(perModule)) if (m === path || m.startsWith(path + ".")) for (const k of Object.keys(out)) out[k] += v[k] || 0;
    for (const m of e.memories) if ((m.path === path || m.path?.startsWith(path + ".")) && !(m.module === path || m.module?.startsWith(path + "."))) { out.brams += m.brams || 0; out.sprams += m.sprams || 0; }
    return out;
  });
  const timing = {};
  for (const [d, t] of Object.entries(r.timing)) {
    const g = r.graphs[d];
    timing[d] = {
      hz: t.hz, periodNs: t.periodNs, worstNs: t.worstNs, slack: t.slack, fmax: t.fmax, levels: t.levels, met: t.slack == null || t.slack >= 0,
      endpoint: t.endpoint,
      path: t.path.map((x) => ({ id: x.id, op: x.op, type: x.type, delay: x.delay, arrival: x.arrival, origin: x.origin, path: x.path, width: g.node(x.id)?.type.w })),
      estimated: true,
    };
    hidden(timing[d], "explain", () => explainPath(d, timing[d]));
  }
  hidden(timing, "slack", (d) => timing[d ?? firstDomain(r)]?.slack ?? null);
  hidden(timing, "fmax", (d) => timing[d ?? firstDomain(r)]?.fmax ?? null);
  hidden(timing, "worst", (d) => timing[d ?? firstDomain(r)] || { explain: () => `no clock domain "${d}"` });
  hidden(timing, "met", () => Object.values(timing).every((t) => t.met));
  const failures = Object.entries(timing).filter(([, t]) => !t.met).map(([d, t]) => ({
    event: "timing.failed", domain: d, target: fmtHz(t.hz), slack: t.slack,
    path: t.path.map((x) => ({ op: x.op, width: x.width, type: x.type, delay: x.delay, origin: x.origin })),
    resources: { ...resources },
  }));
  const registers = (r.ctx.knobs || []).map((k) => ({ path: k.path, module: k.module, name: k.name, kind: k.kind, type: typeName(k.type), width: k.type?.w, reset: k.reset, min: k.min, max: k.max, addr: k.addr, doc: k.doc }));
  const checks = r.diags.filter((d) => d.level !== "info" || d.code === "cdc").map((d) => ({ kind: "diag", level: d.level, code: d.code, message: d.message, pass: d.pass, line: d.line }));
  const ir = (level) => {
    const gs = level === "lower" ? levels.lower : level === "dag" ? levels.dag : level === "hir" ? null : r.graphs;
    const list = gs ? Object.values(gs) : [];
    return {
      level,
      count: (op) => list.reduce((a, g) => a + g.count(op), 0),
      nodes: () => list.reduce((a, g) => a + g.size, 0),
      print: () => list.map((g) => `── ${g.domain}\n${g.print()}`).join("\n"),
      stats: () => list.map((g) => ({ domain: g.domain, ...g.stats() })),
      graphs: gs,
    };
  };
  const latencies = Object.fromEntries(Object.entries(r.pipelines).map(([k, v]) => [k, v.latency]));
  const report = {
    part: P, family: r.fam, target: { name: r.target.name, family: r.target.family, part: P.name },
    estimated: true, delayModel: { lutNs: r.F.lut, routeNs: r.F.route, carryNsPerBit: r.F.carryPerBit, overheadNs: r.F.overhead, dspNs: r.F.dsp.delay, family: r.F.name },
    resources, perModule, timing, failures,
    memories: e.memories.map((m) => ({ path: m.path, module: m.module, kind: m.kind, place: m.place, words: m.words, width: m.width, brams: m.brams || 0, sprams: m.sprams || 0, cfg: m.cfg || null, primitive: m.prim || null, domain: m.domain })),
    dsps: e.dsps, fsms: r.fsms, pipelines: r.pipelines, latencies, srl: r.srl,
    rules: [...r.rules.values()],
    registers, checks,
    stagesSummary: stages.map((s) => ({ name: s.name, level: s.level, ms: s.ms, passes: s.passes.length })),
    levels: { lower: sumNodes(levels.lower), dag: sumNodes(levels.dag), net: sumNodes(r.graphs) },
    netlist: { counts: Object.fromEntries(Object.entries(countBy(e.cells, "type")).sort()) },
    emits: [], explore: null, plan: null,
  };
  hidden(report.netlist, "cells", () => e.cells.map((c) => ({ ...c })));
  hidden(report, "ir", ir);
  hidden(report, "latency", (path) => latencies[path] ?? (r.ctx.instances || []).find((i) => i.path === path)?.latency ?? 1);
  hidden(report, "resourcesOf", resources.of);
  return report;
}
const firstDomain = (r) => Object.keys(r.graphs)[0];
const sumNodes = (gs) => Object.values(gs || {}).reduce((a, g) => a + g.size, 0);
const countBy = (xs, k) => xs.reduce((a, x) => ((a[x[k]] = (a[x[k]] || 0) + 1), a), {});
function explainPath(d, t) {
  const lines = [];
  const head = t.periodNs != null
    ? `${d}: worst path ${t.worstNs} ns ${t.met ? "≤" : ">"} ${t.periodNs} ns at ${fmtHz(t.hz)} (slack ${t.slack} ns, fmax ${t.fmax} MHz, ${t.levels} level${t.levels === 1 ? "" : "s"}; estimated)`
    : `${d}: worst path ${t.worstNs} ns (no clock constraint; estimated)`;
  lines.push(head);
  for (const x of t.path) {
    if (!x.delay && x.op !== "in" && x.op !== "reg") continue;
    const o = x.origin;
    const where = o ? ` ← ${o.src ? o.src.trim().slice(0, 60) : ""}${o.line ? ` (line ${o.line})` : ""}` : x.path ? ` ← ${x.path}` : "";
    lines.push(`  ${x.op.padEnd(6)} ${String(x.type).padEnd(6)} ${x.delay ? `+${x.delay.toFixed(2)}` : "     "} → ${x.arrival.toFixed(2)} ns${where}`);
  }
  if (t.endpoint) lines.push(`  endpoint: ${t.endpoint.kind} ${t.endpoint.path || ""}`.trimEnd());
  return lines.join("\n");
}
function explainPlan(r, plan, stages) {
  const lines = [`plan: ${plan.length} stages, ${plan.reduce((a, s) => a + s.passes.length, 0)} passes (target ${r.target.name}, ${r.part.name})`];
  for (const st of stages) {
    lines.push(`${st.name.padEnd(16)} ${st.level.padEnd(5)} ${st.iterations > 1 ? `×${st.iterations} ` : ""}${st.ms} ms`);
    for (const p of st.passes) lines.push(`  ${p.reused ? "↺" : p.changed ? "●" : "○"} ${p.name.padEnd(24)} ${String(p.ms).padStart(7)} ms  ${p.note || ""}`.trimEnd());
  }
  const an = r.events.filter((e) => e.kind === "analysis" || e.kind === "invalidate");
  if (an.length) {
    lines.push("analyses:");
    for (const e of an) lines.push(e.kind === "invalidate" ? `  ✕ ${e.analysis} invalidated by ${e.by}` : e.reused ? `  ↺ ${e.analysis} reused for ${e.for}` : `  ● ${e.analysis} computed for ${e.for} (${e.ms} ms)`);
  }
  lines.push("● changed the IR  ○ ran, no change  ↺ reused");
  return lines.join("\n");
}

// ═════════════════════════════════════════════ emitters ════════════════════════════════════════════════════
const EMITTERS = {
  verilog: (r, rep) => ({ files: emitVerilog({ ...r.ctx, domains: r.ctx.domains, name: r.ctx.name || r.ctx.header?.id || "design", report: rep }) }),
  report: (r, rep) => ({ files: [{ path: `${r.ctx.name || "design"}.report.json`, text: JSON.stringify(rep, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2) }], single: true }),
  "c-header": (r) => ({ files: [{ path: `${r.ctx.name || "design"}_regs.h`, text: cHeader(r) }], single: true }),
  "host-js": (r) => ({ files: [{ path: `${r.ctx.name || "design"}.js`, text: hostJs(r) }], single: true }),
  "register-doc": (r) => ({ files: [{ path: "registers.md", text: regDoc(r) }], single: true }),
  vhdl: (r) => ({ files: vhdlWrapper(r), note: "a VHDL component wrapper around the Verilog top (mixed-language); the Lab's implementation output is Verilog" }),
  "sim:wasm": () => ({ files: [], note: "not built in the Lab: the simulator runs the DAG in JavaScript; no WebAssembly engine is bundled" }),
};
function runEmits(r, cfg, report, snapshots) {
  const out = [];
  for (const s of snapshots) out.push({ backend: "snapshot", files: [s] });
  for (const { backend: b, opts } of cfg.emits) {
    let to = opts.to;
    try { if (typeof to === "function") to = to(r.target); } catch (e) { r.diag("error", "emit", `emit: ${e.message}`); continue; }
    const join = (p) => (to ? (/\.[a-z0-9]+$/i.test(to) && !String(to).endsWith("/") ? to : `${String(to).replace(/\/$/, "")}/${p}`) : p);
    if (typeof b === "string") {
      const em = EMITTERS[b];
      if (!em) { r.diag("warn", "emit", `no backend "${b}"`); continue; }
      try {
        const res = em(r, report, opts);
        const files = res.single && to && /\.[a-z0-9]+$/i.test(to) ? res.files.map((f) => ({ path: to, text: f.text })) : res.files.map((f) => ({ path: join(f.path), text: f.text }));
        out.push({ backend: b, files, note: res.note || null });
      } catch (e) { r.diag("error", "emit", `${b}: ${e.message}`); }
      continue;
    }
    const be = b instanceof PassDef ? b : null;
    if (!be || !be.emitFn) { r.diag("error", "emit", `emit(): not a backend`); continue; }
    const files = [], logs = [];
    const o = { file: (p, text) => files.push({ path: join(p), text: String(text) }), log: (...a) => logs.push(a.join(" ")) };
    try { be.emitFn(designView(r, be.level || "net"), o, { target: r.target, report }); }
    catch (e) { r.diag("error", "emit", `${be.name}: ${e.message}`); }
    out.push({ backend: be.name, files, note: logs.join("\n") || null });
  }
  return out;
}
const macro = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
const hex = (n) => "0x" + Number(n ?? 0).toString(16).toUpperCase().padStart(2, "0");
function cHeader(r) {
  const name = macro(r.ctx.name || "design");
  const lines = [`/* ${r.ctx.name || "design"}: register map generated by Weft. Do not edit. */`, `#ifndef ${name}_REGS_H`, `#define ${name}_REGS_H`, "", "#include <stdint.h>", ""];
  for (const k of r.ctx.knobs || []) {
    const m = `${name}_${macro(k.path)}`;
    lines.push(`/* ${k.path}: ${k.kind}, ${typeName(k.type)}${k.min != null ? `, ${k.min}..${k.max}` : ""}${k.reset != null ? `, reset ${k.reset}` : ""} */`);
    lines.push(`#define ${m}_ADDR ${hex(k.addr)}`);
    if (k.min != null) lines.push(`#define ${m}_MIN ${k.min}`, `#define ${m}_MAX ${k.max}`);
    if (k.reset != null) lines.push(`#define ${m}_RESET ${k.reset}`);
    lines.push("");
  }
  lines.push(`#endif /* ${name}_REGS_H */`, "");
  return lines.join("\n");
}
function hostJs(r) {
  const map = (r.ctx.knobs || []).map((k) => ({ path: k.path, kind: k.kind, addr: k.addr, width: k.type?.w, signed: !!k.type?.signed, min: k.min ?? null, max: k.max ?? null, reset: k.reset ?? null }));
  return `// ${r.ctx.name || "design"}: host access generated by Weft. Do not edit.
export const registers = ${JSON.stringify(map, null, 2)};

// dev: an object with read(addr) and write(addr, value), e.g. the UART bridge
export function connect(dev) {
  const byPath = new Map(registers.map((r) => [r.path, r]));
  return {
    registers,
    knob(path) {
      const r = byPath.get(path);
      if (!r) throw new Error(\`no register \${path}\`);
      return {
        get: () => dev.read(r.addr),
        set(v) {
          if (r.kind !== "knob") throw new Error(\`\${path} is read-only\`);
          if (r.min != null && (v < r.min || v > r.max)) throw new RangeError(\`\${path}: \${v} is outside \${r.min}..\${r.max}\`);
          return dev.write(r.addr, v);
        },
      };
    },
  };
}
`;
}
function regDoc(r) {
  const rows = (r.ctx.knobs || []).map((k) => `| \`${hex(k.addr)}\` | \`${k.path}\` | ${k.kind} | ${typeName(k.type)} | ${k.reset ?? ""} | ${k.min != null ? `${k.min} … ${k.max}` : ""} | ${k.doc || ""} |`);
  return [`# ${r.ctx.name || "design"} registers`, "", "Generated by Weft from the design's knobs, status registers and interrupts.", "", "| addr | path | kind | type | reset | range | notes |", "| --- | --- | --- | --- | --- | --- | --- |", ...rows, ""].join("\n");
}
function vhdlWrapper(r) {
  const files = emitVerilog({ ...r.ctx, name: r.ctx.name || "design" });
  const top = files.find((f) => f.top) || files[files.length - 1];
  if (!top) return [];
  const m = top.text.match(/module\s+(\w+)\s*\(([\s\S]*?)\);/);
  if (!m) return [];
  const ports = m[2].split(",").map((x) => x.trim()).filter(Boolean).map((p) => {
    const mm = p.match(/(input|output)\s+(?:wire\s+|reg\s+)?(?:signed\s+)?(?:\[(\d+):0\]\s+)?(\w+)/);
    return mm ? { dir: mm[1] === "input" ? "in" : "out", w: mm[2] ? +mm[2] + 1 : 1, name: mm[3] } : null;
  }).filter(Boolean);
  const decl = ports.map((p) => `    ${p.name} : ${p.dir} ${p.w === 1 ? "std_logic" : `std_logic_vector(${p.w - 1} downto 0)`}`).join(";\n");
  const text = `-- ${m[1]}: VHDL wrapper generated by Weft (instantiates the Verilog top as a component).
library ieee;
use ieee.std_logic_1164.all;

entity ${m[1]}_vhd is
  port (
${decl}
  );
end entity;

architecture wrap of ${m[1]}_vhd is
  component ${m[1]} is
    port (
${decl.replace(/^/gm, "  ")}
    );
  end component;
begin
  u_top : ${m[1]} port map (
${ports.map((p) => `    ${p.name} => ${p.name}`).join(",\n")}
  );
end architecture;
`;
  return [{ path: `${m[1]}.vhd`, text }];
}

// ═════════════════════════════════════════════ explore ═════════════════════════════════════════════════════
// recompile(overrides) → Compiled; overrides like { "fir.TAPS": 15, "clock.sys": "100 MHz" }
export function runExplore(explore, recompile, { onPoint, limit = 81 } = {}) {
  const spec = explore.spec;
  const grid = cartesian(spec.knobs.map((k) => k.values.map((v) => [k.path, v])), limit);
  const points = [];
  for (const combo of grid) {
    const overrides = Object.fromEntries(combo);
    const t0 = now();
    let metrics = null, ok = false, error = null;
    try {
      const c = recompile(overrides);
      const rep = c?.report;
      ok = !!rep;
      if (rep && spec.measure) metrics = spec.measure(rep);
      else if (rep) metrics = { luts: rep.resources.luts, dsps: rep.resources.dsps };
    } catch (e) { error = e.message; }
    let kept = ok && !error;
    if (kept && spec.keep) { try { kept = !!spec.keep(metrics); } catch { kept = false; } }
    const p = { overrides, metrics, kept, pareto: false, error, ms: round(now() - t0, 1) };
    points.push(p);
    onPoint?.(p, points.length, grid.length);
  }
  const keys = spec.pareto?.length ? spec.pareto : [];
  const cand = points.filter((p) => p.kept && p.metrics);
  const val = (p, k) => { const v = p.metrics[k]; return typeof v === "boolean" ? (v ? 0 : 1) : Number(v); };
  for (const p of cand) p.pareto = !cand.some((q) => q !== p && keys.every((k) => val(q, k) <= val(p, k)) && keys.some((k) => val(q, k) < val(p, k)));
  explore.points = points;
  explore.pending = false;
  explore.front = points.filter((p) => p.pareto).map((p) => p.overrides);
  if (spec.report) hidden(explore, "html", exploreHtml(explore));
  return explore;
}
export function exploreHtml(explore) {
  const pts = explore.points || [];
  const keys = [...new Set(pts.flatMap((p) => Object.keys(p.metrics || {})))];
  const knobs = explore.spec.knobs.map((k) => k.path);
  const row = (p) => `<tr class="${p.pareto ? "front" : p.kept ? "" : "out"}">${knobs.map((k) => `<td>${p.overrides[k]}</td>`).join("")}${keys.map((k) => `<td>${p.metrics?.[k] ?? ""}</td>`).join("")}<td>${p.pareto ? "◆" : ""}</td></tr>`;
  return `<!doctype html><meta charset="utf-8"><title>Explore</title><style>body{font:13px ui-monospace,monospace}td,th{padding:2px 8px;text-align:right}.front{font-weight:700}.out{opacity:.45}</style><table><tr>${[...knobs, ...keys, "front"].map((k) => `<th>${k}</th>`).join("")}</tr>${pts.map(row).join("")}</table>`;
}

// ═════════════════════════════════════════════ small exports for tests and the UI ════════════════════════════
export { batchReplace as _batchReplace, sweep as _sweep, constFold as _constFold, explainPath };
