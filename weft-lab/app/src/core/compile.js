// compile(script, opts) → Compiled (ARCH §3), owner A. Orchestration:
//   evaluate   run the script (the body of a function) with the grammar in scope → a Design value
//   elaborate  resolve the board, clocks and targets; specialize every module (params, builder lambdas),
//              memoized per (definition, θ, domain) (D3); parse its hardware lambdas; the capture check (D2)
//   lower      HIR → one DAG per clock domain (lower.js)
//   passes     B's runPipeline: stages, checks, report, emits
// compile never throws for a bad script: every problem is a diagnostic with a line.
import * as T from "./types.js";
import { makeScope, Design, Module, Stream, Rom, Board, Group, Change, Agent, Host, WeftError, callSite, record, Builder, SCOPE_NAMES } from "./dsl.js";
import { makeStd, Cell, cellInterface } from "./std.js";
import { resolveBoard, bareBoard, expandResources, BOARDS } from "./boards.js";
import { gatematePll } from "./gatemate-pll.js";
import { parseLambda, locate, checkCaptures, parseHeader, syntaxCheck, topLevelNames, buildHir, HW_BUILTINS, HW_GLOBALS } from "./front.js";
import { lower } from "./lower.js";
import { runPipeline } from "./passes.js";

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// ---------- evaluate ----------
export function evaluate(script, { file = "design.js", diags = [] } = {}) {
  const syn = syntaxCheck(script);
  if (syn) {
    diags.push({ level: "error", code: "syntax", message: syn.message, line: syn.line, col: syn.col, file });
    return { design: null, peek: () => ({ ok: false }), std: null };
  }
  const std = makeStd();
  const scope = makeScope(std);
  const declared = new Set(topLevelNames(script));
  const names = Object.keys(scope).filter((n) => !declared.has(n));
  let peekFn = null;
  const hook = (f) => { peekFn = f; };
  // a direct eval at the start of the body can later read the script's own bindings (for the capture check
  // to follow a captured helper, and so a design with a capture error still builds what it can)
  const body = "__weft_peek__((__n) => eval(__n));" + script;
  let fn;
  try {
    fn = new Function("__weft_peek__", ...names, body);
  } catch (e) {
    diags.push({ level: "error", code: "syntax", message: e.message, line: null, col: null, file });
    return { design: null, peek: () => ({ ok: false }), std };
  }
  let design = null;
  try {
    design = fn(hook, ...names.map((n) => scope[n]));
  } catch (e) {
    const at = e instanceof WeftError ? { line: e.line, col: e.col } : callSite(e?.stack);
    diags.push({ level: "error", code: e?.code || "eval", message: e?.message || String(e), line: at?.line ?? null, col: at?.col ?? null, file });
  }
  const peek = (name) => {
    if (!peekFn || !/^[A-Za-z_$][\w$]*$/.test(name)) return { ok: false };
    try { return { ok: true, value: peekFn(name) }; } catch { return { ok: false }; }
  };
  if (design != null && !(design instanceof Design)) {
    diags.push({ level: "error", code: "eval", message: "the script must return a design: return design(\"name\")…", line: null, col: null, file });
    design = null;
  } else if (design == null && !diags.length) diags.push({ level: "error", code: "eval", message: "the script must end with return design(\"name\")…", line: null, col: null, file });
  return { design, peek, std };
}

// ---------- clocks ----------
// a PLL/MMCM solution for fout from fin on the part's family (the compiler solves the dividers, F-10)
export function solvePll(fin, fout, family) {
  let best = null;
  const consider = (hz, cfg) => {
    const err = Math.abs(hz - fout) / fout;
    if (!best || err < best.error - 1e-12) best = { hz, error: err, ...cfg };
  };
  if (family === "gatemate") {
    // CC_PLL as nextpnr configures it (SPEED mode, low jitter): the result is what the board will run at
    const r = gatematePll(fin / 1e6, fout / 1e6);
    if (!r) return { hz: fout, error: 1, impossible: true };
    return { hz: r.fcore * 1e6, error: Math.abs(r.fcore * 1e6 - fout) / fout, k: r.K, n1: r.N1, n2: r.N2, m1: r.M1, m2: r.M2, pdiv1: r.PDIV1, vco: r.fdco * 1e6 };
  }
  if (family === "ice40") {
    for (let r = 0; r <= 15; r++) for (let f = 0; f <= 127; f++) for (let q = 1; q <= 6; q++) {
      const pfd = fin / (r + 1);
      if (pfd < 10e6 || pfd > 133e6) continue;
      const vco = pfd * (f + 1);
      if (vco < 533e6 || vco > 1066e6) continue;
      consider(vco / 2 ** q, { divr: r, divf: f, divq: q, vco });
    }
  } else {
    for (let d = 1; d <= 10; d++) for (let m = 2; m <= 64; m++) {
      const vco = (fin * m) / d;
      if (vco < 600e6 || vco > 1200e6) continue;
      for (let o8 = 8; o8 <= 128 * 8; o8++) {   // O in steps of 1/8, as the MMCM's CLKOUT0 allows
        consider(vco / (o8 / 8), { m, d, o: o8 / 8, vco });
      }
    }
  }
  return best || { hz: fout, error: 0, exact: true };
}
function clockDomains(calls, board, diags, file, overrides) {
  const domains = {};
  let main = null;
  const add = (name, d) => { if (domains[name]) diags.push({ level: "error", code: "clock", message: `clock domain "${name}" is declared twice`, line: d.line, file }); domains[name] = d; main = main || name; };
  for (const c of calls || []) {
    const [name, a = {}] = c.args;
    if (c.op === "pin") {
      const res = typeof a === "string" ? a : a.pin || board.clockPin;
      const hz = board.resources[res]?.hz || board.mainHz;
      if (board.profile && !board.resources[res]) diags.push({ level: "error", code: "clock", message: `the ${board.profile} board has no clock pin "${res}"`, line: c.line, file });
      add(name, { hz, kind: "pin", pin: res, line: c.line });
    } else if (c.op === "port") {
      const hz = T.hzOf(a.hz) || board.mainHz;
      add(name, { hz, kind: "port", line: c.line });
    } else if (c.op === "pll") {
      const from = domains[a.from];
      if (!from) { diags.push({ level: "error", code: "clock", message: `pll("${name}") comes from "${a.from}", which is not a clock domain declared before it`, line: c.line, file }); continue; }
      const want = T.hzOf(a.hz);
      const sol = solvePll(from.hz, want, board.family);
      const tol = a.tolerance ? parseFloat(String(a.tolerance)) / 100 : 0.005;
      if (sol.error > tol) diags.push({ level: "error", code: "clock", message: `no PLL setting gives ${a.hz} from ${(from.hz / 1e6).toFixed(3)} MHz within ${(tol * 100).toFixed(2)} % (best ${(sol.hz / 1e6).toFixed(4)} MHz)`, line: c.line, file });
      add(name, { hz: sol.hz, want, kind: "pll", from: a.from, pll: sol, line: c.line });
    } else diags.push({ level: "error", code: "clock", message: `.clocks(): unknown call .${c.op}() (pin, port, pll)`, line: c.line, file });
  }
  if (!main) { domains.sys = { hz: board.mainHz, kind: "board", line: null }; main = "sys"; }
  for (const [k, v] of Object.entries(overrides || {})) {
    const m = k.match(/^clock\.(.+)$/);
    if (m && domains[m[1]]) domains[m[1]] = { ...domains[m[1]], hz: T.hzOf(v) || domains[m[1]].hz, override: v };
  }
  return { domains, main };
}

// ---------- elaborate ----------
const stableKey = (o) => JSON.stringify(o, (k, v) => (typeof v === "bigint" ? v.toString() + "n" : typeof v === "function" ? `fn:${v.toString().length}` : v && v._ ? `builder:${v._.kind}:${v._.name}` : v));

export function elaborate(design, ctx) {
  const { script, file, diags, peek, opts = {} } = ctx;
  const d = design._;
  const err = (message, line = null, code = "elaborate", level = "error", col = null) => diags.push({ level, code, message, line, col, file });
  // --- board and targets
  let targets = [];
  if (d.targets) targets = d.targets.map((t) => ({ name: t.name, board: resolveBoard(t.spec), spec: t.spec }));
  else if (d.board) targets = [{ name: d.board.profile || "board", board: resolveBoard(d.board), spec: d.board }];
  else targets = [{ name: d.part || "sim", board: bareBoard(d.part || null) }];
  for (const t of targets) if (!t.board) { err(`unknown board "${t.spec?.profile}" (${Object.keys(BOARDS).join(", ")})`, d.boardLine, "board"); t.board = bareBoard(); }
  if (opts.board) {
    const b = resolveBoard(typeof opts.board === "string" ? opts.board : opts.board);
    if (b) targets.unshift({ name: b.profile || "board", board: b });
  }
  let target = targets[0];
  if (opts.target) target = targets.find((t) => t.name === opts.target) || target;
  const board = target.board;
  if (d.part && d.board) board.part = d.part;
  // --- clocks
  const { domains, main } = clockDomains(d.clocks, board, diags, file, opts.overrides);
  if (!board.profile) board.mainHz = domains[main].hz;
  // --- items
  const instances = [], cells = [], streamDecls = [], hosts = [], agents = [], groups = [];
  const paths = new Map();
  const claim = (path, line) => {
    if (paths.has(path)) { err(`two components are named "${path}" (rename one with .as())`, line, "link"); return false; }
    paths.set(path, line);
    return true;
  };
  const memo = new Map();
  let memoHits = 0, tFront = 0;
  const overrides = opts.overrides || {};
  for (const { item, line } of d.items) {
    if (item instanceof Module) {
      const st = item._;
      const path = st.inst || st.name;
      if (!claim(path, line)) continue;
      const θ = { ...st.params, ...st.overrides };
      for (const [k, v] of Object.entries(overrides)) {
        const m = k.match(/^([^.]+(?:\.[^.]+)*)\.([A-Z_][A-Z0-9_]*)$/);
        if (m && m[1] === path && k.startsWith(path + ".")) θ[m[2]] = v;
      }
      const domain = st.domain || main;
      if (!domains[domain]) err(`${path} runs in clock domain "${domain}", which .clocks() does not declare (${Object.keys(domains).join(", ")})`, line, "clock");
      const key = `${st.defId}|${stableKey(θ)}|${domain}`;
      let e = memo.get(key);
      if (e) memoHits++;
      else {
        const t0 = now();
        e = specialize(st, θ, domain, { script, file, diags, peek, board, domains, main, err });
        e.key = key;
        tFront += now() - t0;
        memo.set(key, e);
      }
      e.instances.push(path);
      instances.push({
        ...e, path, line: line ?? st.line, memoKey: key, provides: [...st.provides], needs: [...st.needs], binds: { ...st.binds }, state: "todo",
        domain: domains[domain] ? domain : main,
      });
    } else if (item instanceof Cell) {
      const st = item._;
      const path = st.inst || st.name;
      if (!claim(path, line)) continue;
      const domain = st.domain || main;
      if (!domains[domain]) err(`${path} runs in clock domain "${domain}", which .clocks() does not declare`, line, "clock");
      const pinCount = {};
      if (st.binds.raw != null) pinCount.raw = expandResources(st.binds.raw, board).length;
      let iface;
      try { iface = cellInterface(st, { pinCount }); } catch (e2) { err(e2.message, line, "std"); continue; }
      cells.push({ path, kind: st.cell, st, domain: domains[domain] ? domain : main, binds: { ...st.binds }, iface, line: line ?? st.line, portNodes: {} });
    } else if (item instanceof Stream) {
      const st = item._;
      streamDecls.push({ name: st.name, type: st.type, depth: st.depth, overflow: st.overflow, cross: st.cross, line: st.line ?? line });
    } else if (item instanceof Host) hosts.push({ ...item._, line });
    else if (item instanceof Agent) agents.push({ ...item._, line });
    else if (item instanceof Group) groups.push({ ...item._, line });
    else err(`.use() cannot take a ${item._?.kind || typeof item}`, line, "builder");
  }
  // --- connections: pins (module .bind and design .pins) and wires
  const conn = new Map(), consumed = new Set();
  const instPorts = new Map(instances.map((I) => [I.path, new Set(I.ports.map((p) => p.name))]));
  const resolveRef = (ref) => {
    const all = [...instPorts.keys()].sort((a, b) => b.length - a.length);
    for (const p of all) if (ref.startsWith(p + ".")) return { path: p, port: ref.slice(p.length + 1).replace(/\[\d+\]$/, "") };
    return null;
  };
  for (const I of instances) for (const [port, res] of Object.entries(I.binds)) {
    if (!instPorts.get(I.path).has(port)) { err(`${I.path} has no port "${port}" to bind`, I.line, "pins"); continue; }
    conn.set(`${I.path}.${port}`, { kind: "pin", res, line: I.line });
  }
  for (const p of d.pins) {
    const r = resolveRef(p.port);
    if (!r || !instPorts.get(r.path).has(r.port)) { err(`.pins(): no port "${p.port}"`, p.line, "pins"); continue; }
    const k = `${r.path}.${r.port}`;
    if (conn.has(k)) err(`${k} is bound twice`, p.line, "pins");
    conn.set(k, { kind: "pin", res: p.res, line: p.line });
  }
  for (const w of d.wires) {
    const r = resolveRef(w.to);
    if (r) {
      const k = `${r.path}.${r.port}`;
      if (conn.has(k)) err(`${k} is connected twice`, w.line, "link");
      conn.set(k, { kind: "wire", from: w.from, line: w.line });
    }
    const s = resolveRef(w.from);
    if (s) consumed.add(`${s.path}.${s.port}`);
  }
  // groups, hosts, agents: light validation
  const known = new Set([...paths.keys(), ...agents.map((a) => a.name), ...hosts.map((h) => h.name)]);
  for (const g of groups) for (const c of g.children) if (!known.has(c)) err(`group("${g.name}") supervises "${c}", which is not in the design`, g.line, "link", "warn");
  for (const h of hosts) if (h.over && !cells.some((c) => c.path === h.over && c.kind === "bridge-uart")) err(`host("${h.name}") talks over "${h.over}", which is not a std.bridge in the design`, h.line, "link", "warn");
  return {
    file, script, board, targets, target, domains, main, instances, cells, streamDecls, hosts, agents, groups,
    wires: d.wires, conn, consumed, memo, memoHits, tFront, diags,
    locate: (src) => locate(script, src),
  };
}

// one definition at one θ in one domain (D3): types, lib, parsed lambdas, capture check
function specialize(st, θ, domain, ctx) {
  const { script, file, diags, peek, board, domains, err } = ctx;
  const clock = { hz: domains[domain]?.hz ?? domains[ctx.main].hz, name: domain };
  const bctx = { clock, board: { profile: board.profile, part: board.part, family: board.family }, part: board.partData };
  const run = (f, what, line, ...args) => {
    try { return f(...args); }
    catch (e) { err(`${what}: ${e.message}`, e instanceof WeftError && e.line != null ? e.line : callSite(e?.stack)?.line ?? line, "builder"); return undefined; }
  };
  const typeOf = (x, what, line) => {
    const t = typeof x === "function" ? run(x, what, line, θ, bctx) : x;
    if (!T.isType(t)) { err(`${what} needs a type, got ${t === undefined ? "nothing" : String(t)}`, line, "type"); return T.u(1); }
    return t;
  };
  for (const r of st.requires) {
    const ok = run(r.fn, `${st.name}.require()`, r.line, θ);
    if (ok !== true && ok !== undefined) err(`${st.name} with ${JSON.stringify(θ)}: ${typeof ok === "string" ? ok : "a requirement is not met"}`, r.line, "require");
  }
  const ports = st.ports.map((p) => ({ name: p.name, dir: p.dir, type: typeOf(p.type, `${st.name}.${p.dir}("${p.name}")`, p.line), line: p.line }));
  const regs = {};
  for (const r of st.regs) {
    const obj = typeof r.value === "function" ? run(r.value, `${st.name}.regs()`, r.line, θ, bctx) : r.value;
    for (const [n, t] of Object.entries(obj || {})) regs[n] = typeOf(t, `${st.name}.regs({ ${n} })`, r.line);
  }
  const lib = {};
  for (const l of st.libs) {
    const obj = typeof l.value === "function" ? run(l.value, `${st.name}.lib()`, l.line, θ, bctx) : l.value;
    if (obj && typeof obj === "object") Object.assign(lib, obj);
  }
  const knobs = st.knobs.map((k) => ({ ...k, type: k.kind === "irq" ? T.pulse : typeOf(k.type, `${st.name}.${k.kind}("${k.name}")`, k.line) }));
  const rams = st.rams.map((r) => ({ ...r, opts: typeof r.opts === "function" ? run(r.opts, `${st.name}.ram()`, r.line, θ) || {} : r.opts }));
  const hints = typeof st.hints === "function" ? run(st.hints, `${st.name}.hint()`, null, θ) : st.hints;
  const pipelined = typeof st.pipelined === "function" ? run(st.pipelined, `${st.name}.pipelined()`, null, θ) : st.pipelined;
  let budget = st.budget;
  if (typeof budget === "function") { const calls = record(budget); budget = Object.fromEntries(calls.map((c) => [c.op, c.args[0]])); }
  let supervise = null;
  if (st.supervise) {
    const calls = run(() => record(st.supervise.fn), `${st.name}.supervise()`, st.supervise.line) || [];
    for (const c of calls) if (c.op === "watchdog" && typeof c.args[1] === "function") c.lam = { fn: c.args[1], src: c.args[1].toString(), line: c.line, col: null };
    supervise = { calls };
  }
  let probe = null;
  if (st.probe) {
    const calls = record(st.probe);
    probe = { signals: [], depth: 1024, keep: "last" };
    for (const c of calls) {
      if (c.op === "signals") probe.signals.push(...c.args.flat());
      else if (c.op === "depth") probe.depth = c.args[0];
      else if (c.op === "keep") probe.keep = c.args[0];
    }
  }
  // what a hardware lambda may name: params, lib, builtins
  const allowed = (n) => n in θ || n in lib || HW_BUILTINS.has(n) || HW_GLOBALS.has(n);
  const captured = new Map(), reported = new Set();
  const owner = (what) => `${st.name}'s ${what}`;
  const prep = (lam, what) => {
    if (!lam) return lam;
    if (lam.parsed !== undefined && lam.checkedFor === stableKey([Object.keys(θ), Object.keys(lib)])) return lam;
    try { lam.parsed = parseLambda(lam.fn); }
    catch (e) {
      lam.parsed = null;
      const at = locate(script, lam.src, lam.line);
      diags.push({ level: "error", code: "syntax", message: `${what}: ${e.message}`, line: at?.line ?? lam.line, col: null, file });
      return lam;
    }
    if (lam.parsed.async) diags.push({ level: "error", code: "lambda", message: `${what} is a hardware lambda; it cannot be async (runtime lambdas go in scenarios, hosts and agents)`, line: lam.line, col: lam.col ?? null, file });
    const at = locate(script, lam.parsed.src, lam.line);
    lam.base = at ? { line: at.line, col: at.col } : { line: lam.line ?? 1, col: 0 };
    const res = checkCaptures(lam, { script, allowed, peek, owner: owner(what), file });
    for (const dg of res.diags) { diags.push(dg); reported.add(dg.name); }
    for (const [k, v] of res.captured) captured.set(k, v);
    lam.checkedFor = stableKey([Object.keys(θ), Object.keys(lib)]);
    return lam;
  };
  const blocks = st.blocks.map((b) => ({ ...b, lam: prep(b.lam, `.${b.kind}(${b.arg != null ? JSON.stringify(b.arg) : ""})`) }));
  const states = st.states.map((s) => ({ ...s, lam: prep(s.lam, `.state("${s.name}")`) }));
  const stages = st.stages.map((s) => ({ ...s, lam: prep(s.lam, `.stage("${s.name}")`) }));
  const asserts = st.asserts.map((a) => ({ ...a, lam: prep(a.lam, `.${a.kind}("${a.name}")`) }));
  if (supervise) for (const c of supervise.calls) if (c.lam) prep(c.lam, ".supervise() watchdog");
  // helpers shipped by .lib(): their own capture check (a helper reading JS it was not shipped with, F-03)
  const helperLams = new Map();
  for (const [name, v] of Object.entries(lib)) {
    if (typeof v !== "function" || /\[native code\]/.test(Function.prototype.toString.call(v)) || v.hardwareBuiltin) continue;
    if ([T.u, T.s, T.vec, T.struct, T.clog2].includes(v)) continue;
    let parsed;
    try { parsed = parseLambda(v); } catch { continue; }
    const at = locate(script, parsed.src);
    const lam = { fn: v, src: parsed.src, parsed, base: at ? { line: at.line, col: at.col } : null, line: at?.line ?? null };
    helperLams.set(v, lam);
    const res = checkCaptures(lam, { script, allowed: (n) => allowed(n), peek, owner: `\`${name}\` (shipped by .lib())`, file });
    for (const dg of res.diags) { diags.push(dg); reported.add(dg.name); }
    for (const [k, x] of res.captured) captured.set(k, x);
  }
  return {
    defName: st.name, defId: st.defId, kind: st.kind, params: θ, domain, ports, regs, lib, knobs, rams, blocks, states, stages, asserts,
    initial: st.initial, step: st.step, encode: st.encode, stall: st.stall, budget, hints, pipelined, supervise, probe, migrate: st.migrate,
    captured, captureReported: reported, helperLams, instances: [],
  };
}

// ---------- compile ----------
function emptyCompiled(base) {
  return {
    ok: false, diags: [], name: null, header: null, design: null, board: null, targets: [], domains: {}, hir: null,
    instances: [], streams: [], pins: [], knobs: [], cells: [], asserts: [], scenarios: [], hosts: [], changes: {}, agents: [],
    groups: [], boot: [], bootBackground: [], regions: [], place: {}, record: null, prove: null, compileCfg: null,
    stages: [], report: {}, emits: [], timings: {}, ...base,
  };
}
const dedupeDiags = (ds) => {
  const seen = new Set();
  return ds.filter((d) => { const k = `${d.level}|${d.code}|${d.line}|${d.col}|${d.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
};

export function compile(script, opts = {}) {
  const t0 = now();
  const file = opts.file || "design.js";
  const diags = [];
  let header = null;
  try { header = parseHeader(script); } catch { header = null; }
  const ev = evaluate(String(script ?? ""), { file, diags });
  const t1 = now();
  if (!ev.design) {
    const out = emptyCompiled({ header, script, file });
    out.diags = dedupeDiags(diags);
    out.timings = { evaluate: t1 - t0, elaborate: 0, front: 0, lower: 0, passes: 0, total: now() - t0 };
    return out;
  }
  return compileDesign(ev.design, { ...opts, script, file, header, peek: ev.peek, diags, t0, tEval: t1 - t0 });
}

// compile an already evaluated Design (the change pipeline uses this with a design that has one module
// replaced or patched; pass the original script so positions still resolve)
export function compileDesign(design, opts = {}) {
  const t0 = opts.t0 ?? now();
  const file = opts.file || "design.js";
  const script = opts.script || "";
  const diags = opts.diags || [];
  const peek = opts.peek || (() => ({ ok: false }));
  const d = design._;
  const out = emptyCompiled({ header: opts.header ?? null, script, file, name: d.name, design });
  let E = null, L = null;
  const tE = now();
  try {
    E = elaborate(design, { script, file, diags, peek, opts });
  } catch (e) {
    diags.push({ level: "error", code: "internal", message: `elaboration failed: ${e.message}`, line: e.line ?? null, file });
    if (opts.debug) throw e;
  }
  const tL = now();
  if (E) {
    try {
      E.debug = !!opts.debug;
      L = lower(E);
    } catch (e) {
      diags.push({ level: "error", code: "internal", message: `lowering failed: ${e.message}`, line: null, file });
      if (opts.debug) throw e;
    }
  }
  const tP = now();
  if (E) {
    const b = E.board;
    out.board = { profile: b.profile, title: b.title, part: b.part, family: b.family, mainHz: E.domains[E.main].hz, resources: b.resources, groups: b.groups, partData: b.partData };
    out.targets = E.targets.map((t) => ({ name: t.name, board: t.board && { profile: t.board.profile, part: t.board.part, family: t.board.family, mainHz: t.board.mainHz, partData: t.board.partData } }));
    out.target = E.target.name;
    out.clocks = Object.fromEntries(Object.entries(E.domains).map(([k, v]) => [k, { ...v }]));
    out.main = E.main;
    out.hir = buildHir([...E.memo.values()]);
    out.hir.memo = { elaborations: E.memo.size, reused: E.memoHits };
    out.hosts = E.hosts.map((h) => ({ name: h.name, over: h.over, every: h.every.map((e) => ({ ms: e.ms, period: e.period, fn: e.fn })), on: h.on, onStart: h.onStart, line: h.line }));
    out.agents = E.agents.map((a) => ({ name: a.name, model: a.model, guidelines: a.guidelines, scope: a.scope, budget: a.budget, on: a.on, line: a.line }));
    out.groups = E.groups.map((g) => ({ name: g.name, children: g.children, strategy: g.strategy, maxResets: g.maxResets, window: g.window, windowMs: g.window ? T.durMs(g.window) : null, escalate: g.escalate, line: g.line }));
  }
  if (L) {
    out.domains = L.domains;
    out.instances = [...L.instances];
    for (const h of out.hosts) out.instances.push({ path: h.name, kind: "host", def: "host", domain: null, params: {}, line: h.line, ports: [], regs: [], provides: [], needs: [], knobs: [], over: h.over });
    for (const a of out.agents) out.instances.push({ path: a.name, kind: "agent", def: "agent", domain: null, params: {}, line: a.line, ports: [], regs: [], provides: [], needs: [], knobs: [], model: a.model });
    out.streams = L.streams;
    out.pins = L.pins;
    out.knobs = L.knobs;
    out.cells = L.cells;
    out.asserts = L.asserts;
  }
  out.scenarios = d.scenarios.map((s) => ({ ...s }));
  const changes = {};
  const walk = (steps) => { for (const st of steps || []) { if (st.op === "apply" && st.args[0] instanceof Change) changes[st.args[0]._.name] = st.args[0]; if (st.steps) walk(st.steps); } };
  for (const s of out.scenarios) walk(s.steps);
  out.changes = changes;
  out.boot = d.boot;
  out.bootBackground = d.bootBackground;
  out.regions = d.regions;
  out.place = d.place;
  out.record = d.record;
  out.prove = d.prove;
  out.compileCfg = d.compileCfg ?? null;
  const timings = { evaluate: opts.tEval ?? 0, elaborate: tL - tE - (E?.tFront ?? 0), front: E?.tFront ?? 0, lower: tP - tL, passes: 0, total: 0 };
  // B's pass pipeline (opts.passes === false keeps the DAG exactly as lowering left it)
  if (L && E && opts.passes !== false) {
    const ctx = {
      name: d.name, domains: out.domains, instances: out.instances, streams: out.streams, cells: out.cells, board: out.board,
      compileCfg: out.compileCfg, diags, hir: out.hir, knobs: out.knobs, asserts: out.asserts, pins: out.pins,
      timings: { front: timings.front, lower: timings.lower, elaborate: timings.elaborate },
      target: { name: E.target.name, family: out.board.family, part: { ...out.board.partData, name: out.board.part }, board: out.board.profile, mainHz: out.board.mainHz },
      targets: out.targets, explore: !!opts.explore,
      recompile: (overrides = {}) => compileDesign(design, { ...opts, diags: [], overrides: { ...(opts.overrides || {}), ...overrides }, explore: false, t0: undefined }),
      scenarios: out.scenarios, prove: out.prove,
    };
    const tp = now();
    try {
      const res = runPipeline(ctx) || {};
      out.stages = res.stages || [];
      out.report = res.report || {};
      out.emits = res.emits || res.report?.emits || [];
      // B's IR levels ({ lower, dag, net }, each { [domain]: Graph }), kept for scenarios at other levels;
      // each level also answers .domains in the compiled shape ({ [domain]: { hz, graph } })
      if (res.levels) {
        for (const lv of Object.values(res.levels)) if (lv && typeof lv === "object" && !lv.domains)
          Object.defineProperty(lv, "domains", { value: Object.fromEntries(Object.entries(lv).map(([d, g]) => [d, { hz: out.domains[d]?.hz ?? g?.hz ?? null, graph: g }])), enumerable: false });
        Object.defineProperty(out, "levels", { value: res.levels, enumerable: false, writable: true });
      }
    } catch (e) {
      diags.push({ level: "error", code: "internal", message: `the pass pipeline failed: ${e.message}`, line: null, file });
      if (opts.debug) throw e;
    }
    timings.passes = now() - tp;
  }
  timings.total = now() - t0;
  out.timings = timings;
  out.diags = dedupeDiags(diags).sort((a, b) => (a.level === b.level ? (a.line ?? 1e9) - (b.line ?? 1e9) : a.level === "error" ? -1 : b.level === "error" ? 1 : a.level === "warn" ? -1 : 1));
  out.ok = !out.diags.some((x) => x.level === "error");
  Object.defineProperty(out, "peek", { value: peek, enumerable: false });
  Object.defineProperty(out, "elab", { value: E, enumerable: false });
  return out;
}
