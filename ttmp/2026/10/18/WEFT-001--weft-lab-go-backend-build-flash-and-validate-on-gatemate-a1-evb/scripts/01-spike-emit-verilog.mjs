// Spike: compile a Weft example in Node and write its emitted Verilog to an output directory.
// usage: node 01-spike-emit-verilog.mjs <example.js> <outdir> [board]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
const app = resolve(import.meta.dirname, "../../../../../../weft-lab/app/src/core");
const { compile } = await import(app + "/compile.js");
const { emitVerilog } = await import(app + "/verilog.js");
const [file, out, board] = process.argv.slice(2);
const c = compile(readFileSync(file, "utf8"), { file, ...(board ? { board } : {}) });
for (const d of c.diags) if (d.level !== "info") console.error(`${d.level} ${d.code} ${d.line ?? "?"}:${d.col ?? "?"} ${d.message}`);
mkdirSync(out, { recursive: true });
const files = emitVerilog(c);
for (const f of files) writeFileSync(`${out}/${f.path}`, f.text);
console.log(JSON.stringify({ ok: c.ok, board: c.board?.profile, hz: c.board?.mainHz, domains: Object.fromEntries(Object.entries(c.domains).map(([k, v]) => [k, v.hz])), pins: c.pins.map((p) => ({ r: p.resource, dir: p.dir, bit: p.bit })), cells: c.cells.map((x) => x.kind), files: files.map((f) => f.path + (f.top ? " (top)" : "")) }, null, 1));
