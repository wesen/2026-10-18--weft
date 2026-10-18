#!/usr/bin/env node
// Headless hardware emitter for the Go side (`weft emit`, `weft build`): compiles a Weft script for a board
// and prints its hardware bundle (weft.hw-bundle/v1) as JSON.
//
//   node tools/weft-hw.mjs bundle <script.js> [--board gatemate-a1-evb] [--out bundle.json]
//
// Exit codes: 0 bundle written; 2 the design cannot go to hardware (stderr: {"error":{code,message,details}});
// 1 usage or internal error.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { compile } from "../src/core/compile.js";
import { buildBundle, HwError } from "../src/core/hardware.js";

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { cmd, board: "gatemate-a1-evb", out: null, files: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--board") opts.board = rest[++i];
    else if (a === "--out") opts.out = rest[++i];
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else opts.files.push(a);
  }
  return opts;
}

function fail(code, message, details = []) {
  process.stderr.write(JSON.stringify({ error: { code, message, details } }) + "\n");
  process.exit(2);
}

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
  if (opts.cmd !== "bundle" || opts.files.length !== 1) {
    console.error("usage: weft-hw.mjs bundle <script.js> [--board gatemate-a1-evb] [--out bundle.json]");
    process.exit(1);
  }
  const path = opts.files[0];
  const script = readFileSync(path, "utf8");
  const file = basename(path);
  const compiled = compile(script, { board: opts.board, file });
  let bundle;
  try {
    bundle = buildBundle(compiled, { source: { file, sha256: createHash("sha256").update(script).digest("hex") } });
  } catch (e) {
    if (e instanceof HwError) fail(e.code, e.message, e.details);
    throw e;
  }
  const text = JSON.stringify(bundle, null, 2) + "\n";
  if (opts.out) writeFileSync(opts.out, text);
  else process.stdout.write(text);
}

main();
