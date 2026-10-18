// formal.js and the tb runner on a hand-built F-11 arbiter (owner C)
import { Graph } from "../src/core/ir.js";
import { u, s, bit } from "../src/core/types.js";
import { prove } from "../src/core/formal.js";
import { runScenario } from "../src/core/scenario.js";

let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log("FAIL", msg); } };

export function arbiter({ broken = false } = {}) {
  const g = new Graph("sys", 100e6), M = { module: "arbiter" };
  const req = g.input("arbiter.req", u(4), { src: "port" });
  const last = g.reg("arbiter.last", u(2), { ...M, name: "last" });
  const one4 = g.const(1, u(4));
  const bitOf = (v, i) => g.add("slice", [g.add("shr", [v, i], u(4))], bit, { lo: 0, hi: 0 });
  let grant = g.const(0, u(4));
  for (let k = 4; k >= 1; k--) {
    const i = g.add("wrap", [g.add("add", [last, g.const(k)], u(4))], u(2));
    const sh = g.add("wrap", [g.add("shl", [one4, i], u(7))], u(4));
    grant = g.add("mux", [bitOf(req, i), sh, grant], u(4));
    if (broken && k === 2) break;   // a bug: drop the lowest-priority candidates
  }
  g.output("arbiter.grant", grant);
  let nl = last;
  for (let i = 0; i < 4; i++) nl = g.add("mux", [bitOf(grant, g.const(i, u(2))), g.const(i, u(2)), nl], u(2));
  g.setNext(last, nl);
  const req0 = bitOf(req, g.const(0, u(2))), g0 = bitOf(grant, g.const(0, u(2)));
  // assume: a request waits for its grant
  const pr = g.reg("arbiter.__past0", bit, M), pg = g.reg("arbiter.__past1", bit, M);
  g.setNext(pr, req0); g.setNext(pg, g0);
  const assume = g.add("lor", [g.add("lnot", [g.add("land", [pr, g.add("lnot", [pg], bit)], bit)], bit), req0], bit);
  // assert: at most one grant; grants go to requesters; served within 4 cycles
  const one = g.add("eq", [g.add("and", [grant, g.add("sub", [grant, g.const(1, bit)], s(5))], s(5)), g.const(0, bit)], bit);
  const toReq = g.add("eq", [g.add("and", [grant, g.add("not", [req], u(4))], u(4)), g.const(0, bit)], bit);
  const wait = g.reg("arbiter.__within0", u(3), M);
  const pending = g.add("land", [req0, g.add("lnot", [g0], bit)], bit);
  g.setNext(wait, g.add("mux", [pending, g.add("sat", [g.add("add", [wait, g.const(1, bit)], u(4))], u(3)), g.const(0, u(3))], u(3)));
  const within = g.add("lt", [wait, g.const(4)], bit);
  // cover: grants 1, 2, 4, 8 in a row
  const seq = g.reg("arbiter.__seq0", u(2), M);
  const is = (v) => g.add("eq", [grant, g.const(v, u(4))], bit);
  const s1 = g.add("mux", [is(1), g.const(1, u(2)), g.const(0, u(2))], u(2));
  const s2 = g.add("mux", [g.add("land", [g.add("eq", [seq, g.const(1, u(2))], bit), is(2)], bit), g.const(2, u(2)), s1], u(2));
  const s3 = g.add("mux", [g.add("land", [g.add("eq", [seq, g.const(2, u(2))], bit), is(4)], bit), g.const(3, u(2)), s2], u(2));
  g.setNext(seq, s3);
  const cover = g.add("land", [g.add("eq", [seq, g.const(3, u(2))], bit), is(8)], bit);
  const A = (name, kind, node) => ({ path: "arbiter", name, kind, module: "arbiter", domain: "sys", node, line: 1 });
  return {
    ok: true, diags: [], name: "arbiter", board: { profile: null, mainHz: 100e6, resources: {} },
    domains: { sys: { hz: 100e6, graph: g } },
    instances: [{ path: "arbiter", kind: "module", regs: [{ name: "last", type: u(2), path: "arbiter.last" }] }],
    streams: [], pins: [], knobs: [], cells: [], groups: [], hosts: [],
    asserts: [A("a request waits for its grant", "assume", assume), A("at most one grant", "assert", one), A("grants go to requesters", "assert", toReq), A("served within N cycles", "assert", within), A("every port served in turn", "cover", cover)],
    prove: { module: "arbiter", bmc: 24, induction: true, engine: "smt" },
    scenarios: [{ name: "fair under random load", kind: "tb", fn: async (tb) => {
      const served = [0, 0, 0, 0];
      let rq = 0, gr = 0;
      for (let t = 0; t < 10_000; t++) {
        rq = (rq & ~gr) | tb.random.int(0, 15);
        await tb.poke("arbiter.req", rq);
        await tb.step();
        gr = await tb.peek("arbiter.grant");
        if (gr) served[Math.log2(gr)]++;
      }
      tb.expect(Math.min(...served) > 2000, `shares: ${served}`);
      tb.expectCoverage("all");
    } }],
  };
}

{
  const r = prove(arbiter());
  const by = Object.fromEntries(r.results.map((x) => [x.name, x.status]));
  console.log(`prove: ${r.note}, ${r.transitions} transitions, ${r.ms.toFixed(0)} ms`);
  for (const x of r.results) console.log(`  ${x.kind.padEnd(6)} ${x.status.padEnd(9)} ${x.name}${x.depth != null ? ` (depth ${x.depth})` : ""}`);
  ok(by["at most one grant"] === "proved" && by["grants go to requesters"] === "proved" && by["served within N cycles"] === "proved", "three assertions proved");
  ok(by["every port served in turn"] === "covered", "cover hit");
  ok(r.complete, "search complete");
  const bad = prove(arbiter({ broken: true }));
  const f = bad.results.find((x) => x.status === "failed");
  ok(f && f.trace?.length > 0, "a broken arbiter fails with a trace");
  console.log(`  broken: ${bad.results.map((x) => `${x.name}: ${x.status}`).join("; ")}`);
}
{
  const res = await runScenario(arbiter(), "fair under random load");
  ok(res.status === "pass", "tb scenario: " + res.status + " " + res.message + " " + JSON.stringify(res.steps));
  console.log(`tb: ${res.status} in ${res.ms.toFixed(0)} ms — ${res.steps.map((s) => `${s.label} ${s.ok ? "✓" : "✗"} ${s.note}`).join(" | ")}`);
}
console.log(fails ? `formal: ${fails} FAILED` : "formal ok");
process.exit(fails ? 1 : 0);
