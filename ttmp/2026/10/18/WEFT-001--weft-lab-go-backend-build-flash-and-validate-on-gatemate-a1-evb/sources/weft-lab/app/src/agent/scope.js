// The DSL builders the editor scripts see (A's makeScope), shared by the agent's eval tool, design
// agents and the UI's "turn a knob as a change" form.
import { makeScope } from "../core/dsl.js";
import { makeStd } from "../core/std.js";

let cached = null;
export function dslScope() {
  if (cached) return cached;
  try { cached = makeScope(makeStd()) || {}; } catch (e) { console.warn("makeScope", e); cached = {}; }
  return cached;
}
// evaluate an expression with the DSL in scope (a change builder from Claude, for example)
export function evalDsl(expr) {
  const s = dslScope();
  const names = Object.keys(s).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
  const body = String(expr).trim().replace(/^```\w*\s*|```\s*$/g, "").replace(/;\s*$/, "");
  return new Function(...names, `"use strict"; return (${body});`)(...names.map((n) => s[n]));
}
