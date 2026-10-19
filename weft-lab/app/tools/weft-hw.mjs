#!/usr/bin/env node
// Headless hardware emitter for the Go side (`weft emit`, `weft build`): compiles a Weft script for a board
// and prints its hardware bundle (weft.hw-bundle/v1) as JSON.
//
//   node tools/weft-hw.mjs bundle <script.js> [--board gatemate-a1-evb] [--out bundle.json]
//   node tools/weft-hw.mjs vectors <script.js> [--board …] [--scenario name] [--cosim-hz 1e6] [--out vectors.json]
//   node tools/weft-hw.mjs board <script.js> --url http://127.0.0.1:8088 --build <id> [--scenario name] [--force]
//
// vectors runs the design's scenarios on a co-simulation variant (main clock at --cosim-hz) and prints the
// port changes for weft validate (weft.vectors/v1, see src/core/vectors.js).
//
// board opens a board session on a build through the hardware API at --url, runs the design's portable
// scenarios on the board (src/core/hwscenario.js), closes the session and prints { session, results }. Each
// step goes to stderr as it finishes.
//
// Exit codes: 0 bundle written; 2 the design cannot go to hardware (stderr: {"error":{code,message,details}});
// 1 usage or internal error.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { compile } from "../src/core/compile.js";
import { buildBundle, HwError } from "../src/core/hardware.js";
import { vectors, DEFAULT_COSIM_HZ } from "../src/core/vectors.js";
import { runScenariosOnBoard, httpBoard } from "../src/core/hwscenario.js";

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { cmd, board: "gatemate-a1-evb", out: null, scenario: null, cosimHz: DEFAULT_COSIM_HZ, url: null, build: null, force: false, files: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--board") opts.board = rest[++i];
    else if (a === "--out") opts.out = rest[++i];
    else if (a === "--scenario") opts.scenario = rest[++i];
    else if (a === "--cosim-hz") opts.cosimHz = Number(rest[++i]);
    else if (a === "--url") opts.url = rest[++i];
    else if (a === "--build") opts.build = rest[++i];
    else if (a === "--force") opts.force = true;
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else opts.files.push(a);
  }
  return opts;
}

function fail(code, message, details = []) {
  process.stderr.write(JSON.stringify({ error: { code, message, details } }) + "\n");
  process.exit(2);
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
  if (!["bundle", "vectors", "board"].includes(opts.cmd) || opts.files.length !== 1 || !(opts.cosimHz > 0) || (opts.cmd === "board" && (!opts.url || !opts.build))) {
    console.error("usage: weft-hw.mjs bundle|vectors|board <script.js> [--board gatemate-a1-evb] [--scenario name] [--cosim-hz 1e6] [--url URL --build ID [--force]] [--out file.json]");
    process.exit(1);
  }
  const path = opts.files[0];
  const script = readFileSync(path, "utf8");
  const file = basename(path);
  let result;
  try {
    if (opts.cmd === "vectors") result = await vectors(script, { file, board: opts.board, cosimHz: opts.cosimHz, scenario: opts.scenario });
    else if (opts.cmd === "board") {
      const compiled = compile(script, { board: opts.board, file });
      if (compiled.diags.some((d) => d.level === "error")) throw new HwError("compile", `${file} does not compile for ${opts.board}`);
      const onStep = (s) => process.stderr.write(`  ${s.ok === false ? "FAIL" : "ok  "} ${s.label}${s.note ? ` — ${s.note}` : ""} (${+s.time.toFixed(3)} ms)\n`);
      const onResult = (r) => process.stderr.write(`${r.status} ${JSON.stringify(r.name)}${r.message ? `: ${r.message}` : ""}\n`);
      result = await runScenariosOnBoard(compiled, httpBoard(opts.url), { build: opts.build, force: opts.force, scenario: opts.scenario, onStep, onResult });
    }
    else result = buildBundle(compile(script, { board: opts.board, file }), { source: { file, sha256: createHash("sha256").update(script).digest("hex") } });
  } catch (e) {
    if (e instanceof HwError) fail(e.code, e.message, e.details);
    if (e.status) fail(e.code || "board", e.message);   // the hardware API refused (no session, board busy, …)
    throw e;
  }
  const text = JSON.stringify(result, null, opts.cmd === "bundle" ? 2 : 0) + "\n";
  if (opts.out) writeFileSync(opts.out, text);
  else process.stdout.write(text);
}

main().catch((e) => { console.error(e?.stack || e); process.exit(1); });
