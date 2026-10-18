// The front end (owner A): hardware lambdas are parsed from their source text (fn.toString()) with acorn,
// never called. This file parses them, maps their positions back to the script, finds the names they
// read from outside (the capture check, D2), parses rewrite patterns for the pass library (parseExpr),
// reads the example header, and builds the HIR summary the UI shows.
import * as acorn from "acorn";

const OPTS = { ecmaVersion: "latest", locations: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true };

// ---------- parsing a lambda ----------
// Accepts a function, a { fn, src } record or source text. Returns
// { src, node (the function AST), params, body, exprBody, async, prefix } or throws a SyntaxError with .loc.
const parseCache = new Map();
export function parseLambda(x) {
  const src = typeof x === "string" ? x : typeof x === "function" ? x.toString() : x?.src ?? String(x?.fn);
  if (parseCache.has(src)) return parseCache.get(src);
  let node = null, prefix = 1;
  try {
    node = acorn.parseExpressionAt(`(${src})`, 0, OPTS);
  } catch (e) {
    // method shorthand: `state($) { … }` → wrap in an object literal
    try {
      const obj = acorn.parseExpressionAt(`({${src}})`, 0, OPTS);
      node = obj.properties[0].value;
      prefix = 2;
    } catch {
      throw e;
    }
  }
  if (!/Function/.test(node.type)) {
    const err = new SyntaxError("expected a function");
    err.loc = { line: 1, column: 0 };
    throw err;
  }
  const out = {
    src, node, params: node.params, body: node.body, exprBody: node.body.type !== "BlockStatement",
    async: !!node.async, prefix, name: node.id?.name || null,
  };
  parseCache.set(src, out);
  return out;
}

// where `src` sits in the script: the occurrence nearest at or after hintLine (a call site), else the first
export function locate(script, src, hintLine = null) {
  if (!script || !src) return null;
  const hits = [];
  for (let i = script.indexOf(src); i >= 0 && hits.length < 64; i = script.indexOf(src, i + 1)) hits.push(i);
  if (!hits.length) return null;
  const lineAt = (idx) => { let l = 1; for (let i = 0; i < idx; i++) if (script.charCodeAt(i) === 10) l++; return l; };
  let best = hits[0];
  if (hintLine != null && hits.length > 1) {
    let bestD = Infinity;
    for (const h of hits) {
      const l = lineAt(h), d = l >= hintLine ? l - hintLine : (hintLine - l) * 4;
      if (d < bestD) { bestD = d; best = h; }
    }
  }
  const line = lineAt(best);
  const col = best - (script.lastIndexOf("\n", best - 1) + 1);
  return { index: best, line, col };
}
// a node's position in the script, given where the lambda's source starts (base = { line, col })
export function posOf(parsed, node, base) {
  if (!node?.loc || !base) return { line: base?.line ?? null, col: base?.col != null ? base.col + 1 : null };
  const { line, column } = node.loc.start;
  if (line === 1) return { line: base.line, col: base.col + column - parsed.prefix + 1 };
  return { line: base.line + line - 1, col: column + 1 };
}

// ---------- names: bindings and free variables ----------
export function patternNames(p, out = []) {
  if (!p) return out;
  switch (p.type) {
    case "Identifier": out.push(p.name); break;
    case "ObjectPattern": for (const q of p.properties) patternNames(q.type === "RestElement" ? q.argument : q.value, out); break;
    case "ArrayPattern": for (const q of p.elements) patternNames(q, out); break;
    case "AssignmentPattern": patternNames(p.left, out); break;
    case "RestElement": patternNames(p.argument, out); break;
  }
  return out;
}
function hoist(stmts, names, { fnLevel = false } = {}) {
  for (const s of stmts) {
    if (s.type === "VariableDeclaration" && (s.kind !== "var" || fnLevel)) for (const d of s.declarations) patternNames(d.id, names);
    else if (s.type === "FunctionDeclaration" && s.id) names.push(s.id.name);
    else if (s.type === "ClassDeclaration" && s.id) names.push(s.id.name);
    if (fnLevel) collectVars(s, names);
  }
}
function collectVars(n, names) { // `var` anywhere in a function body
  if (!n || typeof n !== "object") return;
  if (/Function/.test(n.type)) return;
  if (n.type === "VariableDeclaration" && n.kind === "var") for (const d of n.declarations) patternNames(d.id, names);
  for (const k in n) { const v = n[k]; if (k === "loc") continue; if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === "string" && collectVars(c, names)); else if (v && typeof v.type === "string") collectVars(v, names); }
}
// free identifier references of a function node: [{ name, node }]
export function freeVars(fnNode) {
  const free = [];
  const has = (scope, name) => { for (let s = scope; s; s = s.parent) if (s.names.has(name)) return true; return false; };
  const mk = (parent, names = []) => ({ parent, names: new Set(names) });
  const ref = (node, scope) => { if (!has(scope, node.name)) free.push({ name: node.name, node }); };
  const walkPatternDefaults = (p, scope) => {
    if (!p) return;
    if (p.type === "AssignmentPattern") { walk(p.right, scope); walkPatternDefaults(p.left, scope); }
    else if (p.type === "ObjectPattern") for (const q of p.properties) { if (q.computed) walk(q.key, scope); walkPatternDefaults(q.type === "RestElement" ? q.argument : q.value, scope); }
    else if (p.type === "ArrayPattern") for (const q of p.elements) walkPatternDefaults(q, scope);
  };
  const fn = (node, scope) => {
    const names = [];
    for (const p of node.params) patternNames(p, names);
    if (node.type === "FunctionExpression" && node.id) names.push(node.id.name);
    names.push("arguments", "this");
    const s = mk(scope, names);
    for (const p of node.params) walkPatternDefaults(p, s);
    if (node.body.type === "BlockStatement") {
      const inner = [];
      hoist(node.body.body, inner, { fnLevel: true });
      const bs = mk(s, inner);
      for (const st of node.body.body) walk(st, bs);
    } else walk(node.body, s);
  };
  const walk = (node, scope) => {
    if (!node || typeof node.type !== "string") return;
    switch (node.type) {
      case "Identifier": ref(node, scope); return;
      case "ArrowFunctionExpression": case "FunctionExpression": fn(node, scope); return;
      case "FunctionDeclaration": fn(node, scope); return;
      case "BlockStatement": { const names = []; hoist(node.body, names); const s = mk(scope, names); for (const st of node.body) walk(st, s); return; }
      case "VariableDeclaration": for (const d of node.declarations) { walkPatternDefaults(d.id, scope); walk(d.init, scope); } return;
      case "ForStatement": { const names = []; if (node.init?.type === "VariableDeclaration") hoist([node.init], names); const s = mk(scope, names); walk(node.init, s); walk(node.test, s); walk(node.update, s); walk(node.body, s); return; }
      case "ForOfStatement": case "ForInStatement": { const names = []; if (node.left.type === "VariableDeclaration") hoist([node.left], names); const s = mk(scope, names); if (node.left.type !== "VariableDeclaration") walk(node.left, s); walk(node.right, scope); walk(node.body, s); return; }
      case "CatchClause": { const s = mk(scope, patternNames(node.param)); walk(node.body, s); return; }
      case "MemberExpression": walk(node.object, scope); if (node.computed) walk(node.property, scope); return;
      case "Property": if (node.computed) walk(node.key, scope); walk(node.value, scope); return;
      case "MethodDefinition": case "PropertyDefinition": if (node.computed) walk(node.key, scope); walk(node.value, scope); return;
      case "LabeledStatement": walk(node.body, scope); return;
      case "BreakStatement": case "ContinueStatement": return;
      case "ClassDeclaration": case "ClassExpression": walk(node.superClass, scope); walk(node.body, scope); return;
      default:
        for (const k in node) {
          if (k === "loc" || k === "type" || k === "start" || k === "end") continue;
          const v = node[k];
          if (Array.isArray(v)) for (const c of v) walk(c, scope);
          else if (v && typeof v.type === "string") walk(v, scope);
        }
    }
  };
  fn(fnNode, null);
  return free;
}

// globals a hardware lambda may name without shipping them
export const HW_GLOBALS = new Set(["Math", "Number", "Infinity", "NaN", "undefined", "Boolean"]);
export const HW_BUILTINS = new Set(["wrap", "sat", "past", "within", "sequence", "u", "s", "bit", "pulse", "vec", "struct", "clog2"]);

// The capture check (D2). `allowed(name)` says whether a free name is in reach (params, lib, builtins).
// `peek(name)` returns { ok, value } for the script's own bindings, so the check can follow a captured
// helper into its body and name what it reads in turn. Returns { diags, captured: Map(name → value) }.
export function checkCaptures(lam, { script, allowed, peek, owner, file }) {
  const diags = [], captured = new Map();
  let parsed;
  try { parsed = parseLambda(lam); } catch { return { diags, captured }; }
  const base = lam.base || locate(script, parsed.src, lam.line);
  const seen = new Set();
  const visit = (p, b, via) => {
    for (const { name, node } of freeVars(p.node)) {
      if (allowed(name) || seen.has(name)) continue;
      seen.add(name);
      const at = posOf(p, node, b);
      const v = peek ? peek(name) : { ok: false };
      const what = v.ok && typeof v.value === "function" ? "calls" : "reads";
      const msg = via
        ? `${via} ${what === "calls" ? "calls" : "reads"} the JS binding \`${name}\`, which the hardware cannot see either: ship it too, .lib({ ${[...seen].filter((n) => !allowed(n)).join(", ")} })`
        : `${owner || "this hardware lambda"} ${what} the JS binding \`${name}\`. Hardware lambdas are parsed, never called, so they cannot see JS variables: ship it with .lib({ ${name} })`;
      diags.push({ level: "error", code: "capture", message: msg, line: at.line, col: at.col, file, name });
      if (v.ok) {
        captured.set(name, v.value);
        if (typeof v.value === "function") {
          try {
            const q = parseLambda(v.value);
            visit(q, locate(script, q.src), `\`${name}\``);
          } catch { /* native or unparsable: nothing to follow */ }
        }
      }
    }
  };
  visit(parsed, base, null);
  // a single combined hint on the first diagnostic: everything that must be shipped together
  if (diags.length > 1) diags[0].message += ` — and \`${diags[0].name}\` reads ${diags.slice(1).map((d) => `\`${d.name}\``).join(", ")}, so the fix is .lib({ ${diags.map((d) => d.name).reverse().join(", ")} })`;
  return { diags, captured };
}

// ---------- rewrite patterns for the pass library (B) ----------
// parseExpr(x => x * k) → { params: ["x", "k"], body: Expr, src }. Expr is a small tree:
//   { k: "var", name } | { k: "const", value } | { k: "bin", op, a, b } | { k: "un", op, a } |
//   { k: "mux", c, a, b } | { k: "call", name, args } | { k: "member", obj, prop, computed }
// Operators use the DAG opcode names (add sub mul and or xor shl shr eq ne lt le gt ge land lor; neg not lnot).
export const BIN_OPS = { "+": "add", "-": "sub", "*": "mul", "&": "and", "|": "or", "^": "xor", "<<": "shl", ">>": "shr", ">>>": "shr", "==": "eq", "===": "eq", "!=": "ne", "!==": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge", "&&": "land", "||": "lor" };
export const UN_OPS = { "-": "neg", "~": "not", "!": "lnot" };
export function parseExpr(x) {
  let params = [], bodyNode, src = typeof x === "function" ? x.toString() : String(x);
  let fnNode = null;
  try { fnNode = parseLambda(src).node; } catch { fnNode = null; }
  if (fnNode) {
    params = fnNode.params.map((p) => patternNames(p)).flat();
    bodyNode = fnNode.body;
    if (bodyNode.type === "BlockStatement") {
      const ret = bodyNode.body.find((s) => s.type === "ReturnStatement");
      if (!ret) throw new SyntaxError("a pattern lambda must return an expression");
      bodyNode = ret.argument;
    }
  } else bodyNode = acorn.parseExpressionAt(src, 0, OPTS);
  const conv = (n) => {
    switch (n.type) {
      case "Identifier": return { k: "var", name: n.name };
      case "Literal": return { k: "const", value: typeof n.value === "boolean" ? (n.value ? 1 : 0) : n.bigint ? BigInt(n.bigint) : n.value };
      case "BinaryExpression": case "LogicalExpression":
        if (!BIN_OPS[n.operator]) throw new SyntaxError(`operator ${n.operator} is not a hardware operator`);
        return { k: "bin", op: BIN_OPS[n.operator], a: conv(n.left), b: conv(n.right) };
      case "UnaryExpression":
        if (n.operator === "+") return conv(n.argument);
        if (!UN_OPS[n.operator]) throw new SyntaxError(`operator ${n.operator} is not a hardware operator`);
        return { k: "un", op: UN_OPS[n.operator], a: conv(n.argument) };
      case "ConditionalExpression": return { k: "mux", c: conv(n.test), a: conv(n.consequent), b: conv(n.alternate) };
      case "CallExpression": return { k: "call", name: n.callee.type === "Identifier" ? n.callee.name : null, callee: n.callee.type === "Identifier" ? null : conv(n.callee), args: n.arguments.map(conv) };
      case "MemberExpression": return { k: "member", obj: conv(n.object), prop: n.computed ? conv(n.property) : n.property.name, computed: n.computed };
      case "ChainExpression": return conv(n.expression);
      default: throw new SyntaxError(`${n.type} is not allowed in a pattern`);
    }
  };
  return { params, body: conv(bodyNode), src };
}

// ---------- the example header ----------
// /** F-01 Blinky\n *  group Basics\n *  about …\n *  shows …\n *  watch …\n *  try a | b */
export function parseHeader(script) {
  const m = String(script || "").match(/^\s*\/\*\*([\s\S]*?)\*\//);
  if (!m) return null;
  const lines = m[1].split("\n").map((l) => l.replace(/^\s*\*?\s?/, "").replace(/\s+$/, ""));
  const first = lines.shift().trim();
  const hm = first.match(/^([A-Z]+-\d+)\s+(.*)$/);
  const h = { id: hm ? hm[1] : null, title: hm ? hm[2] : first, group: "", about: "", shows: "", watch: "", tries: [] };
  let field = null;
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    const fm = l.match(/^(group|about|shows|watch|try)\s+(.*)$/);
    if (fm) { field = fm[1]; h[field === "try" ? "tryText" : field] = fm[2]; }
    else if (field) { const k = field === "try" ? "tryText" : field; h[k] = (h[k] ? h[k] + " " : "") + l; }
  }
  h.tries = (h.tryText || "").split("|").map((t) => t.trim()).filter(Boolean);
  delete h.tryText;
  return h;
}

// syntax check of the whole script (the body of a function): null or { message, line, col }
export function syntaxCheck(script) {
  try {
    acorn.parse(script, { ...OPTS, sourceType: "script" });
    return null;
  } catch (e) {
    return { message: e.message.replace(/\s*\(\d+:\d+\)$/, ""), line: e.loc?.line ?? null, col: e.loc ? e.loc.column + 1 : null };
  }
}
// names declared at the top level of the script (they shadow scope names)
export function topLevelNames(script) {
  try {
    const ast = acorn.parse(script, { ...OPTS, sourceType: "script" });
    const names = [];
    hoist(ast.body, names, { fnLevel: true });
    return names;
  } catch { return []; }
}

// ---------- HIR: what the front end hands to lowering, as JSON the UI can show ----------
// One entry per elaborated definition (D3 memo), listing ports, registers and the hardware lambdas with
// their source position and the names each reads from the module's reach.
export function buildHir(elabs) {
  return {
    level: "hir",
    defs: elabs.map((e) => ({
      key: e.key, def: e.defName, kind: e.kind, params: e.params, domain: e.domain, instances: e.instances,
      ports: e.ports.map((p) => ({ name: p.name, dir: p.dir, type: String(p.type) })),
      regs: Object.entries(e.regs).map(([n, t]) => ({ name: n, type: String(t) })),
      lib: Object.keys(e.lib),
      blocks: e.blocks.map((b) => ({ kind: b.kind, arg: b.arg ?? null, line: b.lam.base?.line ?? b.lam.line, src: b.lam.src.length > 400 ? b.lam.src.slice(0, 400) + " …" : b.lam.src })),
    })),
  };
}
