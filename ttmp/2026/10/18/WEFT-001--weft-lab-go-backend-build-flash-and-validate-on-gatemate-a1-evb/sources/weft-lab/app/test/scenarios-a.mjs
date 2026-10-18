// Runs every scenario of every example on C's simulator at level dag (owner A's end-to-end check).
// node app/test/scenarios-a.mjs [F-05] [--steps]
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { compile } from "../src/core/compile.js";
import { runScenario } from "../src/core/scenario.js";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "../../examples");
const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith("--"));
const files = readdirSync(dir).filter((f) => /^F-\d+.*\.js$/.test(f)).sort().filter((f) => !only.length || only.some((o) => f.startsWith(o)));
const rows = [];
for (const f of files) {
  const c = compile(readFileSync(join(dir, f), "utf8"), { file: f });
  for (const sc of c.scenarios) {
    const t0 = performance.now();
    let r;
    try { r = await runScenario(c, sc.name, { level: "dag" }); }
    catch (e) { r = { status: "THREW", message: e.stack?.split("\n").slice(0, 3).join(" | ") }; }
    rows.push({ ex: f.slice(0, 4), scenario: sc.name.slice(0, 44), status: r.status, ms: Math.round(performance.now() - t0), message: (r.message || "").slice(0, 110) });
    if (args.includes("--steps") || r.status === "fail") for (const s of r.steps || []) if (args.includes("--steps") || !s.ok) console.log(`   ${f.slice(0, 4)} ${s.ok ? "✓" : "✗"} ${s.label} ${s.note || ""}`);
  }
}
console.table(rows);
