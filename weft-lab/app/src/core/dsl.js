// The Weft grammar as immutable builders (owner A). Every call returns a new value; nothing is built until
// compile() elaborates the design. Three kinds of lambda pass through here:
//   builder lambdas  run now, while the graph is built (.from(), .lib(fn), .in(name, fn), recorders);
//   hardware lambdas are kept as { fn, src, line, col } and parsed by front.js, never called;
//   runtime lambdas  are kept as functions for the simulator, the host and the scenario runner.
import * as T from "./types.js";
import * as P from "./passes.js";
import { resolveBoard } from "./boards.js";

// ---------- where in the script a call came from ----------
// The script is the body of `new Function(...)`; V8 and Firefox report its frames as `<anonymous>:L:C` /
// `Function:L:C`, two lines below the script line (the wrapper's "function anonymous(…\n) {\n").
export const LINE_OFFSET = 2;
export function callSite(stack = new Error().stack) {
  const m = String(stack || "").match(/<anonymous>:(\d+):(\d+)/) || String(stack || "").match(/Function:(\d+):(\d+)/);
  return m ? { line: +m[1] - LINE_OFFSET, col: +m[2] } : null;
}
export class WeftError extends Error {
  constructor(message, { code = "builder", line = null, col = null } = {}) {
    super(message);
    this.code = code;
    const at = line != null ? { line, col } : callSite(this.stack);
    this.line = at?.line ?? null;
    this.col = at?.col ?? null;
  }
}
const fail = (msg, code = "builder") => { throw new WeftError(msg, { code }); };

// a hardware lambda as the compiler keeps it
function hw(fn, what) {
  if (typeof fn !== "function") fail(`${what} needs a hardware lambda ($ => { … })`);
  const at = callSite();
  return { fn, src: fn.toString(), line: at?.line ?? null, col: at?.col ?? null, what };
}
// a runtime lambda
function rt(fn, what) {
  if (typeof fn !== "function") fail(`${what} needs a function`);
  return fn;
}

// ---------- recorders (builder lambdas over a chain of calls) ----------
// record(c => c.a(1).b(2)) → [{ op: "a", args: [1] }, { op: "b", args: [2] }]. Lines are kept per call.
export function recorder(onCall) {
  const calls = [];
  const rec = new Proxy(function () {}, {
    get(_, op) {
      if (op === "calls") return calls;
      if (typeof op === "symbol" || op === "toJSON") return undefined;   // "then" is a recorded call here (.boot(b => b.start().then()))
      return (...args) => {
        const at = callSite();
        const call = { op, args, line: at?.line ?? null };
        if (onCall) onCall(call, rec);
        calls.push(call);
        return rec;
      };
    },
  });
  return rec;
}
export function record(fn, ...extra) {
  if (fn == null) return [];
  if (typeof fn !== "function") return Array.isArray(fn) ? fn : [];
  const rec = recorder();
  fn(rec, ...extra);
  return rec.calls;
}

// ---------- the immutable base ----------
let SEQ = 0;
const nextDef = () => ++SEQ;
class Builder {
  constructor(st) { this._ = Object.freeze(st); }
  _w(patch, { def = false } = {}) {
    const st = { ...this._, ...patch };
    if (def) st.defId = nextDef();
    return new this.constructor(st);
  }
  _add(key, item, opts = { def: true }) { return this._w({ [key]: [...(this._[key] || []), item] }, opts); }
  get name() { return this._.inst || this._.name; }
  get kind() { return this._.kind; }
  toString() { return `${this._.kind}("${this.name}")`; }
}

// ---------- module, fsm, pipeline ----------
function portArgs(nameOrObj, type, dir) {
  if (nameOrObj && typeof nameOrObj === "object") return Object.entries(nameOrObj).map(([name, t]) => ({ name, type: t, dir }));
  if (typeof nameOrObj !== "string") fail(`.${dir}() takes a name and a type, or an object of them`);
  if (type == null) fail(`.${dir}("${nameOrObj}") needs a type`);
  return [{ name: nameOrObj, type, dir }];
}
const SIGNAL_KINDS = ["seq", "comb", "every", "on"];

export class Module extends Builder {
  static make(kind, name) {
    if (typeof name !== "string" || !name) fail(`${kind}() needs a name`);
    const at = callSite();
    return new Module({
      kind, name, inst: null, defId: nextDef(), line: at?.line ?? null,
      params: {}, ports: [], regs: [], libs: [], blocks: [], provides: [], needs: [], binds: {},
      domain: null, knobs: [], rams: [], asserts: [], requires: [], budget: null, hints: null, pipelined: null,
      supervise: null, probe: null, migrate: null, overrides: {},
      states: [], initial: null, step: null, encode: null, stages: [], stall: "global",
    });
  }
  // instance-level: same definition, same elaboration memo entry (D3)
  as(name) { return this._w({ inst: String(name) }); }
  with(params) { return this._w({ overrides: { ...this._.overrides, ...params } }); }
  domain(d) { return this._w({ domain: String(d) }); }
  bind(map) { return this._w({ binds: { ...this._.binds, ...map } }); }
  // definition
  params(p) { return this._w({ params: { ...this._.params, ...p } }, { def: true }); }
  in(n, t) { return this._w({ ports: [...this._.ports, ...portArgs(n, t, "in").map(withLine)] }, { def: true }); }
  out(n, t) { return this._w({ ports: [...this._.ports, ...portArgs(n, t, "out").map(withLine)] }, { def: true }); }
  regs(r) { return this._add("regs", { value: r, line: callSite()?.line ?? null }); }
  lib(l) { return this._add("libs", { value: l, line: callSite()?.line ?? null }); }
  seq(fn) { return this._add("blocks", { kind: "seq", lam: hw(fn, ".seq()") }); }
  comb(fn) { return this._add("blocks", { kind: "comb", lam: hw(fn, ".comb()") }); }
  every(period, fn) { return this._add("blocks", { kind: "every", arg: period, lam: hw(fn, ".every()") }); }
  on(event, fn) { return this._add("blocks", { kind: "on", arg: String(event), lam: hw(fn, ".on()") }); }
  provides(...names) { return this._w({ provides: [...this._.provides, ...names.flat()] }, { def: true }); }
  needs(...names) { return this._w({ needs: [...this._.needs, ...names.flat()] }, { def: true }); }
  knob(name, type, opts = {}) { return this._add("knobs", { kind: "knob", name, type, opts, line: callSite()?.line ?? null }); }
  status(name, type) { return this._add("knobs", { kind: "status", name, type, opts: {}, line: callSite()?.line ?? null }); }
  irq(name) { return this._add("knobs", { kind: "irq", name, type: T.pulse, opts: {}, line: callSite()?.line ?? null }); }
  ram(name, opts = {}) { return this._add("rams", { name, opts, line: callSite()?.line ?? null }); }
  assert(name, fn) { return this._add("asserts", { kind: "assert", name, lam: hw(fn, ".assert()") }); }
  assume(name, fn) { return this._add("asserts", { kind: "assume", name, lam: hw(fn, ".assume()") }); }
  cover(name, fn) { return this._add("asserts", { kind: "cover", name, lam: hw(fn, ".cover()") }); }
  require(fn) { return this._add("requires", { fn, line: callSite()?.line ?? null }); }
  budget(b) { return this._w({ budget: b }, { def: true }); }
  hint(h) { return this._w({ hints: h }, { def: true }); }
  pipelined(p = {}) { return this._w({ pipelined: p }, { def: true }); }
  supervise(fn) { return this._w({ supervise: { fn, line: callSite()?.line ?? null } }, { def: true }); }
  probe(fn) { return this._w({ probe: fn }, { def: true }); }
  migrate(fn) { return this._w({ migrate: rt(fn, ".migrate()") }); }
  // fsm
  initial(s) { return this._w({ initial: String(s) }, { def: true }); }
  state(name, fn) { return this._add("states", { name: String(name), lam: hw(fn, `.state("${name}")`) }); }
  step(stream) { return this._w({ step: String(stream) }, { def: true }); }
  encode(e) { return this._w({ encode: e }, { def: true }); }
  // pipeline
  stage(name, fn) { return this._add("stages", { name: String(name), lam: hw(fn, `.stage("${name}")`) }); }
  stall(mode) { return this._w({ stall: String(mode) }, { def: true }); }
}
function withLine(p) { return { ...p, line: callSite()?.line ?? null }; }

export const module = (name) => Module.make("module", name);
export const fsm = (name) => Module.make("fsm", name);
export const pipeline = (name) => Module.make("pipeline", name);

// ---------- streams and roms ----------
export class Stream extends Builder {
  of(type) { if (!T.isType(type)) fail(`stream("${this._.name}").of() needs a type`); return this._w({ type }); }
  buffer(depth, opts = {}) {
    const overflow = opts.overflow || "block";
    if (!["block", "drop-oldest", "drop-newest", "latest"].includes(overflow)) fail(`unknown overflow policy "${overflow}" (block, drop-oldest, drop-newest, latest)`);
    if (!Number.isInteger(depth) || depth < 1) fail(`a buffer depth is a whole number ≥ 1, got ${depth}`);
    return this._w({ depth, overflow });
  }
  cross(spec = {}) { return this._w({ cross: { from: spec.from ?? null, to: spec.to ?? null, stages: spec.stages ?? 2 } }); }
}
export const stream = (name) => new Stream({ kind: "stream", name: String(name), type: null, depth: 0, overflow: "block", cross: null, line: callSite()?.line ?? null });

export class Rom extends Builder {
  of(type) { return this._w({ type }); }
  from(n, fn) {
    let table;
    if (Array.isArray(n)) table = fn ? n.map((v, i) => fn(v, i)) : n.slice();
    else if (typeof fn === "function") table = Array.from({ length: n }, (_, i) => fn(i));   // builder lambda, n calls
    else fail(`rom("${this._.name}").from(n, i => value) needs a length and a builder lambda`);
    for (const v of table) if (!(Number.isInteger(v) || typeof v === "bigint")) fail(`rom("${this._.name}") holds integers; got ${v}`);
    return this._w({ table });
  }
}
export const rom = (name) => new Rom({ kind: "rom", name: String(name), type: null, table: null, line: callSite()?.line ?? null });

// ---------- boards ----------
export class Board extends Builder {
  part(p) { return this._w({ part: String(p) }); }
  get resolved() { return resolveBoard(this._); }
}
export const board = (profile) => new Board({ kind: "board", name: String(profile), profile: String(profile), part: null });

// ---------- groups (reset trees), changes, agents, hosts ----------
export class Group extends Builder {
  children(...names) { return this._w({ children: [...this._.children, ...names.flat()] }); }
  supervise(fn) {
    const calls = record(fn);
    const st = { strategy: "one-for-one", maxResets: null, window: null, escalate: null };
    for (const c of calls) {
      if (c.op === "strategy") st.strategy = c.args[0];
      else if (c.op === "maxResets") { st.maxResets = c.args[0]; st.window = c.args[1] ?? null; }
      else if (c.op === "escalate") st.escalate = c.args[0];
    }
    return this._w(st);
  }
}
export const group = (name) => new Group({ kind: "group", name: String(name), children: [], strategy: "one-for-one", maxResets: null, window: null, escalate: null });

export class Change extends Builder {
  knob(path, value) { return this._add("ops", { op: "knob", path, value }, {}); }
  replace(target, mod) { return this._add("ops", { op: "replace", target, module: mod }, {}); }
  patch(target, patch) { return this._add("ops", { op: "patch", target, patch }, {}); }
  verify(fn) { return this._w({ verify: record(fn), verifyFn: fn }); }
  deploy(fn) { return this._w({ deploy: record(fn), deployFn: fn }); }
  rollbackOn(...events) { return this._w({ rollbackOn: [...this._.rollbackOn, ...events.flat()] }); }
  get ops() { return this._.ops; }
  // a knob-only change is a register write: no bitstream (F-17)
  get knobOnly() { return this._.ops.length > 0 && this._.ops.every((o) => o.op === "knob"); }
}
export const change = (name) => new Change({ kind: "change", name: String(name), ops: [], verify: [], deploy: [], rollbackOn: [], line: callSite()?.line ?? null });

function scopeOf(fn) {
  const sc = { read: [], propose: [], never: [] };
  for (const c of record(fn)) if (sc[c.op]) sc[c.op].push(...c.args.flat());
  return sc;
}
export class Agent extends Builder {
  model(m) { return this._w({ model: m }); }
  guidelines(g) { return this._w({ guidelines: String(g) }); }
  scope(fn) { return this._w({ scope: scopeOf(fn) }); }
  budget(b) { return this._w({ budget: b }); }
  on(event, fn) { return this._add("on", { event: String(event), fn: rt(fn, ".on()") }, {}); }
}
export const agent = (name) => new Agent({ kind: "agent", name: String(name), model: "claude", guidelines: "", scope: { read: ["*"], propose: [], never: [] }, budget: null, on: [] });

export class Host extends Builder {
  over(bridge) { return this._w({ over: String(bridge) }); }
  onStart(fn) { return this._w({ onStart: rt(fn, ".onStart()") }); }
  every(period, fn) { return this._add("every", { period, ms: T.periodS(period) * 1000, fn: rt(fn, ".every()") }, {}); }
  on(event, fn) { return this._add("on", { event: String(event), fn: rt(fn, ".on()") }, {}); }
}
export const host = (name) => new Host({ kind: "host", name: String(name), over: null, onStart: null, every: [], on: [] });

// ---------- scenarios ----------
// sc => sc.wait("1s").expectPins(…) records [{ op, args, line }]; .repeat(n, s => …) records its own steps
export function recordScenario(fn) {
  const steps = [];
  const make = (list) => {
    const rec = new Proxy({}, {
      get(_, op) {
        if (op === "steps") return list;
        if (typeof op === "symbol" || op === "then" || op === "toJSON") return undefined;
        return (...args) => {
          const at = callSite();
          const step = { op, args, line: at?.line ?? null };
          if (op === "repeat" && typeof args[1] === "function") {
            step.steps = [];
            args[1](make(step.steps));
          }
          list.push(step);
          return rec;
        };
      },
    });
    return rec;
  };
  fn(make(steps));
  return steps;
}

// ---------- the design ----------
export class Design extends Builder {
  board(b) { return this._w({ board: typeof b === "string" ? { profile: b, part: null } : b?._ ? { ...b._ } : b, boardLine: callSite()?.line ?? null }); }
  boards(map) {
    const targets = Object.entries(map).map(([name, b]) => ({ name, spec: typeof b === "string" ? { profile: b, part: null } : { ...b._ } }));
    return this._w({ targets, boardLine: callSite()?.line ?? null });
  }
  part(p) { return this._w({ part: String(p) }); }
  clocks(fn) { return this._w({ clocks: record(fn), clocksLine: callSite()?.line ?? null }); }
  use(...items) {
    const at = callSite();
    const flat = items.flat(Infinity);
    for (const it of flat) if (!it || !(it instanceof Builder)) fail(`.use() takes modules, streams, components, hosts, agents and groups; got ${it === undefined ? "undefined" : JSON.stringify(it)}`);
    return this._w({ items: [...this._.items, ...flat.map((item) => ({ item, line: at?.line ?? null }))] });
  }
  wire(a, b) {
    const at = callSite();
    const pairs = Array.isArray(a) ? a : [[a, b]];
    return this._w({ wires: [...this._.wires, ...pairs.map(([from, to]) => ({ from: String(from), to: String(to), line: at?.line ?? null }))] });
  }
  pins(map) {
    const at = callSite();
    return this._w({ pins: [...this._.pins, ...Object.entries(map).map(([port, res]) => ({ port, res, line: at?.line ?? null }))] });
  }
  scenario(name, fn, opts = {}) {
    const at = callSite();
    let sc;
    if (typeof fn !== "function") fail(`.scenario("${name}") needs sc => sc… or an async tb => {…}`);
    const isAsync = fn.constructor?.name === "AsyncFunction" || /^\s*async\b/.test(fn.toString());
    if (isAsync) sc = { name: String(name), kind: "tb", fn, opts: { levels: opts.levels || ["dag"], targets: opts.targets || null }, line: at?.line ?? null };
    else sc = { name: String(name), kind: "steps", steps: recordScenario(fn), opts: { levels: opts.levels || ["dag"], targets: opts.targets || null }, line: at?.line ?? null };
    return this._w({ scenarios: [...this._.scenarios, sc] });
  }
  compile(fn) { return this._w({ compileCfg: fn ?? null, compileLine: callSite()?.line ?? null }); }
  prove(fn) {
    const st = { module: null, bmc: null, induction: false, engine: null };
    for (const c of record(fn)) {
      if (c.op === "module") st.module = c.args[0];
      else if (c.op === "bmc") st.bmc = c.args[0];
      else if (c.op === "induction") st.induction = true;
      else if (c.op === "engine") st.engine = c.args[0];
    }
    return this._w({ prove: st });
  }
  regions(fn) {
    const regions = record(fn).filter((c) => c.op === "partition").map((c) => ({ name: c.args[0], ...(c.args[1] || {}) }));
    return this._w({ regions });
  }
  place(map) { return this._w({ place: { ...this._.place, ...map } }); }
  record(spec) { return this._w({ record: { streams: spec?.streams || [], keep: spec?.keep ?? null, keepMs: spec?.keep ? T.durMs(spec.keep) : null } }); }
  boot(fn) {
    const stages = [], background = [];
    for (const c of record(fn)) {
      if (c.op === "start" || c.op === "then") stages.push(c.args.flat());
      else if (c.op === "background") background.push(...c.args.flat());
    }
    return this._w({ boot: stages, bootBackground: background });
  }
  // helpers for the change pipeline (owner C): a design with one module replaced or patched
  replaceModule(name, mod) {
    return this._w({
      items: this._.items.map((e) => {
        if (!(e.item instanceof Module) || e.item.name !== name) return e;
        let m = mod.as(name);
        const dom = e.item._.domain || mod._.domain;
        if (dom) m = m.domain(dom);
        if (Object.keys(e.item._.binds || {}).length) m = m.bind(e.item._.binds);
        return { ...e, item: m };
      }),
    });
  }
  patchModule(name, patch = {}) {
    return this._w({
      items: this._.items.map((e) => {
        if (!(e.item instanceof Module) || e.item.name !== name) return e;
        let m = e.item;
        if (patch.lib) m = m.lib(patch.lib);
        if (patch.params || patch.with) m = m.with(patch.params || patch.with);
        if (patch.knobs) for (const [k, v] of Object.entries(patch.knobs)) m = m._w({ knobs: m._.knobs.map((x) => (x.name === k ? { ...x, opts: { ...x.opts, reset: v } } : x)) }, { def: true });
        return { ...e, item: m };
      }),
    });
  }
  get items() { return this._.items.map((e) => e.item); }
}
export const design = (name) => new Design({
  kind: "design", name: String(name), board: null, targets: null, part: null, clocks: null, items: [], wires: [], pins: [],
  scenarios: [], compileCfg: null, prove: null, regions: [], place: {}, record: null, boot: [], bootBackground: [],
  line: callSite()?.line ?? null,
});

// ---------- hardware-only functions (calling them in JS is a mistake the compiler explains) ----------
const hwOnly = (name) => {
  const f = () => fail(`${name}() only means something inside a hardware lambda`);
  Object.defineProperty(f, "name", { value: name });
  f.hardwareBuiltin = true;
  return f;
};
export const wrap = hwOnly("wrap"), sat = hwOnly("sat"), past = hwOnly("past"), within = hwOnly("within"), sequence = hwOnly("sequence");

// ---------- compiler-side builders: B's, with a recorder fallback ----------
function recBuilder(kind) {
  const mk = (st) => {
    const target = function (...args) { return mk({ ...st, calls: [...st.calls, { op: "call", args }] }); };
    return new Proxy(target, {
      get(_, op) {
        if (op === "_") return st;
        if (op === "name") return st.name;
        if (op === "kind") return kind;
        if (typeof op === "symbol" || op === "then" || op === "toJSON") return undefined;
        return (...args) => mk({ ...st, calls: [...st.calls, { op, args }] });
      },
    });
  };
  return (name) => mk({ kind, name, calls: [] });
}
function stdPassesFallback() {
  const ref = (path) => {
    const f = function (...args) { return { kind: "pass-ref", path, args }; };
    return new Proxy(f, {
      get(_, k) {
        if (k === "path") return path;
        if (k === "kind") return "pass-ref";
        if (k === "with") return (opts) => ({ kind: "pass-ref", path, opts });
        if (typeof k === "symbol" || k === "then" || k === "toJSON") return undefined;
        return ref(path ? `${path}.${k}` : k);
      },
    });
  };
  return ref("");
}
export const pass = P.pass || recBuilder("pass");
export const analysis = P.analysis || recBuilder("analysis");
export const rewrite = P.rewrite || recBuilder("rewrite");
export const backend = P.backend || recBuilder("backend");
export const STD_PASSES = P.STD_PASSES || stdPassesFallback();
export const STD_ANALYSES = P.STD_ANALYSES || stdPassesFallback();
export const STD_PIPELINE = P.STD_PIPELINE || { kind: "pipeline-ref", name: "default" };

// ---------- the scope a script sees ----------
export function makeScope(std) {
  return {
    module, fsm, pipeline, stream, rom, design, board, group, change, agent, host,
    pass, analysis, rewrite, backend,
    u: T.u, s: T.s, bit: T.bit, pulse: T.pulse, vec: T.vec, struct: T.struct, clog2: T.clog2,
    wrap, sat, past, within, sequence,
    std,
  };
}
export const SCOPE_NAMES = ["module", "fsm", "pipeline", "stream", "rom", "design", "board", "group", "change", "agent", "host",
  "pass", "analysis", "rewrite", "backend", "u", "s", "bit", "pulse", "vec", "struct", "clog2", "wrap", "sat", "past", "within", "sequence", "std"];
export { Builder };
