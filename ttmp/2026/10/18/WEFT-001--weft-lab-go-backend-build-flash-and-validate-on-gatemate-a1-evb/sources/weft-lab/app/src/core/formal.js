// Explicit-state model checking (owner C) for a module's assert / assume / cover properties.
//
// The state is every register in the cone of influence of the properties (the module's registers plus the
// monitors that past/within/sequence lowered to); the inputs are the `in` nodes in that cone, free over
// their types. Breadth-first search from the reset state visits every reachable state under every input
// combination; a transition whose assumes do not hold is pruned. When the search exhausts the reachable
// states, an assertion that never failed is proved for every depth: that answers both the bounded check
// (.bmc(k)) and induction (.induction()), with no SAT/SMT engine. Results: proved, failed (with a trace),
// covered (with a trace), unreached, vacuous (the assumes leave no transitions), or bounded (budget out).
import { genDomain } from "./sim.js";
import { isBig, wrapTo, range, typeName } from "./types.js";
import { decode } from "./cells.js";

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function prove(compiled, opts = {}) {
  const t0 = now();
  const cfg = { ...(compiled.prove || {}), ...opts };
  const maxStates = cfg.maxStates ?? 200_000, maxMs = cfg.maxMs ?? 5000, maxInputBits = cfg.maxInputBits ?? 16;
  const props = (compiled.asserts || []).filter((a) => !cfg.module || a.module === cfg.module || String(a.path).startsWith(cfg.module));
  const module = cfg.module || props[0]?.module || null;
  const base = { module, method: "explicit-state reachability", engine: cfg.engine || null, bmc: cfg.bmc ?? null, induction: !!cfg.induction };
  if (!props.length) return { ...base, results: [], states: 0, depth: 0, ms: now() - t0, note: `no properties${module ? ` in ${module}` : ""}` };
  const domName = props[0].domain || Object.keys(compiled.domains)[0];
  const g = compiled.domains[domName]?.graph;
  if (!g) return { ...base, results: [], states: 0, depth: 0, ms: now() - t0, note: `no domain ${domName}` };
  const nodes = g.nodes;
  const mine = props.filter((p) => (p.domain || domName) === domName && nodes[p.node]);

  // cone of influence
  const cone = new Set(), stack = mine.map((p) => p.node);
  while (stack.length) {
    const id = stack.pop();
    if (cone.has(id) || !nodes[id]) continue;
    cone.add(id);
    const n = nodes[id];
    for (const a of n.args) stack.push(a);
    if (n.op === "reg" && n.attrs.next != null) stack.push(n.attrs.next);
    if (n.op === "memrd") for (const w of nodes) if (w && w.op === "memwr" && w.args[0] === n.args[0]) stack.push(w.id);
  }
  const regs = [...cone].filter((id) => nodes[id].op === "reg" || nodes[id].op === "memrd").sort((a, b) => a - b);
  const ins = [...cone].filter((id) => nodes[id].op === "in").sort((a, b) => a - b);
  const mems = [...cone].filter((id) => nodes[id].op === "mem");
  if (mems.length) return { ...base, results: mine.map((p) => res(p, "unknown", { note: "memories are outside explicit-state search" })), states: 0, depth: 0, ms: now() - t0 };
  const inBits = ins.reduce((s, id) => s + nodes[id].type.w, 0);
  const sampled = inBits > maxInputBits;
  const nCombos = sampled ? 4096 : 2 ** inBits;

  const code = genDomain(g, {});
  const N = nodes.length;
  const F = new Float64Array(N), B = new Array(N).fill(0n);
  const big = (id) => isBig(nodes[id].type);
  for (const n of nodes) if (n && n.op === "const") { if (big(n.id)) B[n.id] = BigInt(n.attrs.value); else F[n.id] = Number(n.attrs.value); }
  const X = { fm: new Uint8Array(N), fv: new Float64Array(N), bv: new Array(N) };
  const get = (id) => (big(id) ? B[id] : F[id]);
  const set = (id, v) => { if (big(id)) B[id] = BigInt(v); else F[id] = Number(v); };
  const initOf = (n) => { const v = n.attrs.init ?? n.type.initVal ?? 0; return typeof v === "boolean" ? +v : typeof v === "object" ? 0 : wrapTo(v, n.type); };
  // the next value of a state register after comb evaluation
  const nextOf = (id) => {
    const n = nodes[id];
    if (n.op === "reg") { if (n.attrs.next == null) return get(id); const v = get(n.attrs.next); return wrapTo(v, n.type); }
    return get(id);
  };
  const keyOf = (vals) => vals.join(",");
  // input combination k → values (LSB-first across inputs); sampled when the input space is wide
  let rs = 0x9e3779b9;
  const rnd = () => { rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5; return (rs >>> 0) / 4294967296; };
  const inputVals = (k) => {
    const out = [];
    let x = k;
    for (const id of ins) {
      const T = nodes[id].type, w = T.w;
      let raw;
      if (sampled) raw = Math.floor(rnd() * 2 ** Math.min(w, 30));
      else { raw = x % 2 ** w; x = Math.floor(x / 2 ** w); }
      out.push(wrapTo(raw, T));
    }
    return out;
  };
  const combos = sampled ? null : Array.from({ length: nCombos }, (_, k) => inputVals(k));

  const asserts = mine.filter((p) => p.kind === "assert"), assumes = mine.filter((p) => p.kind === "assume"), covers = mine.filter((p) => p.kind === "cover");
  const st = new Map(mine.map((p) => [p, { fail: null, hit: null, holds: 0 }]));
  const init = regs.map((id) => initOf(nodes[id]));
  const seen = new Map([[keyOf(init), { parent: null, input: null, depth: 0, vals: init }]]);
  let frontier = [init], depth = 0, transitions = 0, pruned = 0, out = false;
  const traceTo = (key, lastInput, lastVals) => {
    const path = [];
    let k = key;
    while (k != null) { const e = seen.get(k); path.unshift(e); k = e.parent; }
    const steps = path.map((e, i) => ({ cycle: i, state: named(regs, e.vals), inputs: i + 1 < path.length ? named(ins, path[i + 1].input) : named(ins, lastInput) }));
    void lastVals;
    return steps;
  };
  const named = (ids, vals) => Object.fromEntries((vals || []).map((v, i) => [nodes[ids[i]].attrs.path || `%${ids[i]}`, decode(v, nodes[ids[i]].type)]));
  const allFailed = () => asserts.every((p) => st.get(p).fail) && covers.every((p) => st.get(p).hit);

  search: while (frontier.length) {
    const next = [];
    for (const vals of frontier) {
      const key = keyOf(vals);
      for (let k = 0; k < nCombos; k++) {
        if (seen.size > maxStates || now() - t0 > maxMs) { out = true; break search; }
        regs.forEach((id, i) => set(id, vals[i]));
        const iv = combos ? combos[k] : inputVals(k);
        ins.forEach((id, i) => set(id, iv[i]));
        code.comb(F, B, [], X);
        if (assumes.some((p) => get(p.node) == 0)) { pruned++; continue; }
        transitions++;
        for (const p of asserts) { const s = st.get(p); if (get(p.node) == 0) { if (!s.fail) s.fail = { depth, trace: traceTo(key, iv) }; } else s.holds++; }
        for (const p of covers) { const s = st.get(p); if (get(p.node) != 0 && !s.hit) s.hit = { depth, trace: traceTo(key, iv) }; }
        const nv = regs.map(nextOf);
        const nk = keyOf(nv);
        if (!seen.has(nk)) { seen.set(nk, { parent: key, input: iv, depth: depth + 1, vals: nv }); next.push(nv); }
      }
      if (cfg.stopEarly && allFailed()) break search;
    }
    if (!next.length) break;
    frontier = next;
    depth++;
  }
  const complete = !out;
  const results = mine.map((p) => {
    const s = st.get(p);
    if (p.kind === "assume") return res(p, transitions === 0 ? "vacuous" : "assumed", { note: `pruned ${pruned} of ${pruned + transitions} transitions` });
    if (p.kind === "cover") {
      if (s.hit) return res(p, "covered", { depth: s.hit.depth + 1, trace: s.hit.trace });
      return res(p, complete ? "unreached" : "bounded", { depth });
    }
    if (s.fail) return res(p, "failed", { depth: s.fail.depth + 1, trace: s.fail.trace });
    if (transitions === 0) return res(p, "vacuous", { note: "the assumes allow no transition" });
    return res(p, complete ? "proved" : "bounded", { depth, note: complete ? `all ${seen.size} reachable states, every input` : `no failure in ${depth} cycles (budget)` });
  });
  return {
    ...base, results, states: seen.size, depth, transitions, pruned, complete,
    stateBits: regs.reduce((s, id) => s + nodes[id].type.w, 0), inputBits: inBits, inputsSampled: sampled,
    regs: regs.map((id) => ({ path: nodes[id].attrs.path || `%${id}`, type: typeName(nodes[id].type) })),
    inputs: ins.map((id) => ({ path: nodes[id].attrs.path || `%${id}`, type: typeName(nodes[id].type) })),
    ms: now() - t0,
    note: complete ? `exhaustive: ${seen.size} states, diameter ${depth}${cfg.bmc ? `; covers bmc(${cfg.bmc})` : ""}${cfg.induction ? " and induction" : ""}` : `budget reached at depth ${depth} (${seen.size} states)`,
  };
}
function res(p, status, extra = {}) { return { name: p.name, kind: p.kind, path: p.path, line: p.line, status, ...extra }; }
void range;
