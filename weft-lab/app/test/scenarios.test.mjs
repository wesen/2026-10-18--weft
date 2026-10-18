// Every example's scenarios on the simulator (owner C): node app/test/scenarios.test.mjs [F-05 …] [--steps] [--limit=60]
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { compile } from "../src/core/compile.js";
import { runScenario } from "../src/core/scenario.js";
import { prove } from "../src/core/formal.js";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "../../examples");
const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith("--"));
const limit = +(args.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 90) * 1000;
const files = readdirSync(dir).filter((f) => /^F-\d+.*\.js$/.test(f)).sort().filter((f) => !only.length || only.some((o) => f.startsWith(o)));
const rows = [];
for (const f of files) {
  const src = readFileSync(join(dir, f), "utf8");
  const c = compile(src, { file: f });
  const recompile = undefined;   // the pipeline defaults to compileDesign with the original script
  for (const sc of c.scenarios || []) {
    const t0 = performance.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), limit);
    let r;
    try { r = await runScenario(c, sc.name, { level: "dag", recompile, signal: ac.signal }); }
    catch (e) { r = { status: "THREW", message: e.stack?.split("\n").slice(0, 3).join(" | "), steps: [] }; }
    clearTimeout(timer);
    const ms = Math.round(performance.now() - t0);
    const row = { ex: f.slice(0, 4), scenario: sc.name.slice(0, 44), status: r.status, sim: `${(r.simTime ?? 0).toFixed(1)} ms`, wall: `${ms} ms`, message: (r.message || "").slice(0, 120) };
    rows.push(row);
    console.log(`${row.ex}  ${row.status.padEnd(5)} ${row.scenario.padEnd(44)} sim ${row.sim.padStart(10)} wall ${row.wall.padStart(8)}  ${r.status !== "pass" ? row.message : ""}`);
    if (args.includes("--steps") || r.status === "fail" || r.status === "THREW") for (const s of r.steps || []) if (args.includes("--steps") || s.ok === false) console.log(`        ${s.ok ? "✓" : s.ok === null ? "·" : "✗"} ${s.label} ${s.note || ""}`);
  }
  if (c.prove) {
    const p = prove(c);
    console.log(`${f.slice(0, 4)}  prove ${p.note}: ${p.results.map((x) => `${x.name}: ${x.status}`).join("; ")}`);
  }
}
const n = (st) => rows.filter((r) => r.status === st).length;
console.log(`\n${rows.length} scenarios: ${n("pass")} pass, ${n("fail")} fail, ${n("skip")} skip, ${n("THREW")} threw`);
