// Compiles every example and prints a table: ok, errors, domains, nodes, regs (owner A).
// node app/test/compile.test.mjs [F-03] [--print] [--diags] [--debug]
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { compile } from "../src/core/compile.js";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "../../examples");
const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith("--"));
const files = readdirSync(dir).filter((f) => /^F-\d+.*\.js$/.test(f)).sort().filter((f) => !only.length || only.some((o) => f.startsWith(o)));
const rows = [];
let failures = 0;
for (const f of files) {
  const src = readFileSync(join(dir, f), "utf8");
  const t0 = performance.now();
  let c;
  try { c = compile(src, { file: f, debug: args.includes("--debug"), passes: !args.includes("--raw") }); }
  catch (e) { console.log(`${f}: THREW ${e.stack}`); failures++; continue; }
  const ms = performance.now() - t0;
  const errors = c.diags.filter((d) => d.level === "error");
  const warns = c.diags.filter((d) => d.level === "warn");
  const doms = Object.entries(c.domains).map(([n, d]) => { const st = d.graph.stats(); return `${n}:${st.nodes}/${st.regs}`; }).join(" ");
  const nodes = Object.values(c.domains).reduce((a, d) => a + d.graph.size, 0);
  const regs = Object.values(c.domains).reduce((a, d) => a + d.graph.count("reg"), 0);
  const verify = Object.values(c.domains).flatMap((d) => d.graph.verify().filter((x) => x.level !== "warn"));
  const expectedErr = f.startsWith("F-03") ? errors.every((e) => e.code === "capture") && errors.length > 0 : errors.length === 0;
  if (!expectedErr || verify.length) failures++;
  rows.push({ file: f.replace(/\.js$/, ""), ok: c.ok ? "ok" : f.startsWith("F-03") && expectedErr ? "capture ✓" : "ERR", errors: errors.length, warns: warns.length, domains: doms, nodes, regs, insts: c.instances.length, streams: c.streams.length, verify: verify.length, ms: Math.round(ms) });
  if (args.includes("--diags") || !expectedErr) for (const d of c.diags) if (d.level !== "info" && (args.includes("--diags") || d.level === "error")) console.log(`  ${f}:${d.line ?? "?"}:${d.col ?? "?"} ${d.level} [${d.code}] ${d.message}`);
  for (const v of verify.slice(0, 5)) console.log(`  ${f}: verify ${v.code} ${v.message}`);
  if (args.includes("--print")) for (const [n, d] of Object.entries(c.domains)) console.log(`--- ${f} ${n} @ ${d.hz} Hz\n${d.graph.print({ max: 300 })}`);
}
console.table(rows);
console.log(failures ? `${failures} example(s) failed` : "all examples compile as expected");
process.exitCode = failures ? 1 : 0;
