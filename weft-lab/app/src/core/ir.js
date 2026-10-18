// The DAG: one dataflow graph per clock domain (decision D11). Registers are where cycles are cut:
// a `reg` node is a source (its current value Q); its next value is another node, kept in
// `attrs.next`. Pure nodes are hash-consed on (op, args, type, attrs), so structurally equal logic
// exists once (Chapter 10). Every node carries `origin`: the source spans it came from.
import { typeName, constType, evalOp, isBig, wrapTo } from "./types.js";

// opcodes whose nodes are never merged (they have identity: state, ports, side effects)
export const STATEFUL = new Set(["in", "out", "reg", "mem", "memrd", "memwr", "probe", "cell"]);
export const SOURCES = new Set(["in", "reg", "const", "mem", "memrd"]);
// pure combinational opcodes and their arities (-1 = any)
export const PURE = {
  const: 0, add: 2, sub: 2, mul: 2, neg: 1, and: 2, or: 2, xor: 2, not: 1, shl: 2, shr: 2,
  eq: 2, ne: 2, lt: 2, le: 2, gt: 2, ge: 2, land: 2, lor: 2, lnot: 1,
  mux: 3, concat: -1, slice: 1, sext: 1, zext: 1, wrap: 1, sat: 1, rom: 1, field: 1, index: 2, pack: -1,
};

const keyOf = (op, args, type, attrs) => op + "|" + args.join(",") + "|" + typeName(type) + "|" + stableJson(attrs);
function stableJson(o) {
  if (o == null || typeof o !== "object") return typeof o === "bigint" ? o.toString() + "n" : JSON.stringify(o);
  if (Array.isArray(o)) return "[" + o.map(stableJson).join(",") + "]";
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined && k !== "next").sort().map((k) => k + ":" + stableJson(o[k])).join(",") + "}";
}
const mergeOrigins = (a, b) => {
  const out = [...(a || [])];
  for (const o of b || []) if (!out.some((x) => x.line === o.line && x.col === o.col && x.file === o.file)) out.push(o);
  return out.slice(0, 8);
};

export class Graph {
  constructor(domain = "sys", hz = null) {
    this.domain = domain;
    this.hz = hz;
    this.nodes = [];          // id → node (null once removed)
    this.table = new Map();   // hash-cons key → id
    this.names = new Map();   // "path.name" → id, for in/out/reg/probe/mem
    this._users = null;
  }
  get size() { return this.nodes.filter(Boolean).length; }
  node(id) { return this.nodes[id]; }
  // add a node; pure nodes are hash-consed
  add(op, args = [], type, attrs = {}, origin = null) {
    if (!type) throw new Error(`node ${op} needs a type`);
    for (const a of args) if (!Number.isInteger(a) || !this.nodes[a]) throw new Error(`node ${op}: bad argument ${a}`);
    const orig = origin ? (Array.isArray(origin) ? origin : [origin]) : [];
    if (!STATEFUL.has(op)) {
      const k = keyOf(op, args, type, attrs);
      const hit = this.table.get(k);
      if (hit != null && this.nodes[hit]) {
        const n = this.nodes[hit];
        n.origin = mergeOrigins(n.origin, orig);
        return hit;
      }
      const id = this.nodes.length;
      this.nodes.push({ id, op, args: args.slice(), type, attrs: { ...attrs }, origin: orig, domain: this.domain });
      this.table.set(k, id);
      this._users = null;
      return id;
    }
    const id = this.nodes.length;
    this.nodes.push({ id, op, args: args.slice(), type, attrs: { ...attrs }, origin: orig, domain: this.domain });
    if (attrs.path) this.names.set(attrs.path, id);
    this._users = null;
    return id;
  }
  const(value, type = null, origin = null) {
    const T = type || constType(value);
    return this.add("const", [], T, { value: typeof value === "bigint" ? value : isBig(T) ? BigInt(value) : value }, origin);
  }
  input(path, type, attrs = {}, origin = null) { return this.add("in", [], type, { path, ...attrs }, origin); }
  output(path, src, attrs = {}, origin = null) { return this.add("out", [src], this.nodes[src].type, { path, ...attrs }, origin); }
  reg(path, type, attrs = {}, origin = null) {
    return this.add("reg", [], type, { path, init: attrs.init ?? (isBig(type) ? 0n : 0), next: null, ...attrs }, origin);
  }
  setNext(regId, nextId) {
    const r = this.nodes[regId];
    if (!r || r.op !== "reg") throw new Error("setNext on a non-register");
    r.attrs.next = nextId;
    this._users = null;
  }
  // users: who reads each node (registers' next counts as a use)
  users(id) {
    if (!this._users) {
      const u = this.nodes.map(() => []);
      for (const n of this.nodes) {
        if (!n) continue;
        for (const a of n.args) u[a].push(n.id);
        if (n.op === "reg" && n.attrs.next != null) u[n.attrs.next].push(n.id);
      }
      this._users = u;
    }
    return this._users[id] || [];
  }
  // replace every use of `from` with `to` (and re-hash users lazily on the next pass)
  replace(from, to) {
    if (from === to) return;
    for (const n of this.nodes) {
      if (!n) continue;
      for (let i = 0; i < n.args.length; i++) if (n.args[i] === from) n.args[i] = to;
      if (n.op === "reg" && n.attrs.next === from) n.attrs.next = to;
    }
    const f = this.nodes[from], t = this.nodes[to];
    if (f && t) t.origin = mergeOrigins(t.origin, f.origin);
    this.rehash();
  }
  remove(id) { this.nodes[id] = null; this._users = null; }
  rehash() {
    this.table.clear();
    for (const n of this.nodes) if (n && !STATEFUL.has(n.op)) {
      const k = keyOf(n.op, n.args, n.type, n.attrs);
      if (!this.table.has(k)) this.table.set(k, n.id);
    }
    this._users = null;
  }
  live() { return this.nodes.filter(Boolean); }
  byOp(op) { return this.live().filter((n) => n.op === op); }
  count(op) { return this.byOp(op).length; }
  // topological order of every live node: sources first; registers' next edges are not ordering edges
  topo() {
    const order = [], state = new Map();
    const visit = (id) => {
      const st = state.get(id);
      if (st === 2) return;
      if (st === 1) throw Object.assign(new Error(`combinational loop through node %${id}`), { code: "comb-loop", node: id });
      state.set(id, 1);
      const n = this.nodes[id];
      for (const a of n.args) visit(a);
      state.set(id, 2);
      order.push(id);
    };
    for (const n of this.live()) visit(n.id);
    return order;
  }
  // structural invariants (D10): types, arities, registers driven, acyclic between registers
  verify() {
    const diags = [];
    for (const n of this.live()) {
      if (!n.type || !Number.isInteger(n.type.w)) diags.push({ code: "ir", node: n.id, message: `%${n.id} ${n.op} has no type` });
      const ar = PURE[n.op];
      if (ar != null && ar >= 0 && n.args.length !== ar) diags.push({ code: "ir", node: n.id, message: `%${n.id} ${n.op} has ${n.args.length} operands, expected ${ar}` });
      for (const a of n.args) if (!this.nodes[a]) diags.push({ code: "ir", node: n.id, message: `%${n.id} reads a removed node %${a}` });
      if (n.op === "reg" && n.attrs.next == null) diags.push({ code: "ir", node: n.id, level: "warn", message: `register ${n.attrs.path} has no next value` });
    }
    try { this.topo(); } catch (e) { diags.push({ code: "comb-loop", node: e.node, message: e.message }); }
    return diags;
  }
  // constant evaluation of a pure node whose operands are constants
  fold(id) {
    const n = this.nodes[id];
    if (!n || !(n.op in PURE) || n.op === "const") return null;
    const vals = n.args.map((a) => this.nodes[a]);
    if (vals.some((v) => v.op !== "const")) return null;
    try { return evalOp(n.op, n.type, vals.map((v) => v.attrs.value), n.attrs); } catch { return null; }
  }
  // printed form used in the books: %n = op args : type ← origin
  print({ max = 400 } = {}) {
    const lines = [];
    for (const n of this.live().slice(0, max)) {
      let rhs;
      if (n.op === "const") rhs = `const ${String(n.attrs.value)}`;
      else if (n.op === "in" || n.op === "reg" || n.op === "mem") rhs = `${n.op} ${n.attrs.path}`;
      else rhs = `${n.op} ${n.args.map((a) => "%" + a).join(", ")}${attrText(n)}`;
      const o = n.origin?.[0];
      lines.push(`%${n.id} = ${rhs} : ${typeName(n.type)}${o?.src ? `   ← ${o.src}` : ""}`);
      if (n.op === "reg" && n.attrs.next != null) lines.push(`%${n.id}.next = %${n.attrs.next}`);
    }
    if (this.live().length > max) lines.push(`… ${this.live().length - max} more nodes`);
    return lines.join("\n");
  }
  stats() {
    const ops = {};
    for (const n of this.live()) ops[n.op] = (ops[n.op] || 0) + 1;
    return { nodes: this.size, regs: ops.reg || 0, inputs: ops.in || 0, outputs: ops.out || 0, ops };
  }
  // content hash: changes when any node, type or attribute changes (R10, finding 16)
  hash() {
    let h = 2166136261 >>> 0;
    const mix = (s) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } };
    for (const n of this.live()) mix(`${n.id}:${n.op}:${n.args.join(",")}:${typeName(n.type)}:${stableJson(n.attrs)}:${n.attrs.next ?? ""};`);
    return h.toString(16).padStart(8, "0");
  }
  clone() {
    const g = new Graph(this.domain, this.hz);
    g.nodes = this.nodes.map((n) => (n ? { ...n, args: n.args.slice(), attrs: { ...n.attrs }, origin: (n.origin || []).slice() } : null));
    g.names = new Map(this.names);
    g.rehash();
    return g;
  }
}
function attrText(n) {
  const a = n.attrs;
  if (n.op === "slice") return ` [${a.hi}:${a.lo}]`;
  if (n.op === "field") return ` .${a.name}`;
  if (n.op === "out") return ` → ${a.path}`;
  if (n.op === "rom") return ` [${a.table?.length ?? "?"} entries]`;
  return "";
}

// fold a value into a constant node when possible (helper for passes)
export function constNode(g, value, type, origin) { return g.const(wrapTo(value, type), type, origin); }
