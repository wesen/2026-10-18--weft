// Board-level scenarios (P8 of WEFT-001): hwscenario.js against a fake board session backed by the Lab's own
// simulator, with a USB delay on every input. node --test app/test/hwscenario.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { compile } from "../src/core/compile.js";
import { Sim } from "../src/core/sim.js";
import { runOnBoard, runScenariosOnBoard } from "../src/core/hwscenario.js";

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, "../../examples");
const forBoard = (prefix) => {
  const f = readdirSync(examples).find((x) => x.startsWith(prefix));
  return compile(readFileSync(join(examples, f), "utf8"), { board: "gatemate-a1-evb", file: f });
};

// The session API over a Sim: reset makes a fresh simulator, inputs land `latency` cycles after the call
// (USB), wait runs the simulator to the cycle, and output changes are stamped with the main clock's cycle.
function simBoard(compiled, { latency = 20_000 } = {}) {
  const pins = compiled.pins || [];
  const uniq = (dir) => [...new Set(pins.filter((p) => p.dir === dir && !p.cell).map((p) => p.resource))];
  const outputs = uniq("out").map((resource, index) => ({ resource, index }));
  const inputs = uniq("in").map((resource, index) => ({ resource, index, physical: resource === "btn:0" || resource === "btn:user" }));
  let sim = null, hist = [], epoch = 0;
  const calls = [];
  const cycle = () => Math.round(sim.time / sim.main.period);
  const outsNow = () => Object.fromEntries(outputs.map((o) => [o.resource, sim.board.read(o.resource)]));
  const client = {
    calls,
    session: { mode: "hil", hz: compiled.domains[compiled.main].hz, inputs, outputs },
    async open() { calls.push("open"); return client.session; },
    async close() { calls.push("close"); return { ok: true }; },
    async reset() {
      sim = new Sim(compiled, { seed: 1, waves: false });
      epoch++;
      hist = [];
      sim.runTo(sim.main.period);
      hist.push({ seq: 0, cycle: 1, outs: outsNow() });
      const pin = sim.board._pin.bind(sim.board);
      sim.board._pin = (D, k, v) => {   // during the edge: the level comes with the call, not from read()
        pin(D, k, v);
        const outs = { ...hist.at(-1).outs };
        for (const { res, bit } of D.pinWatch[k].res) if (res in outs) outs[res] = Number((BigInt(v) >> BigInt(bit)) & 1n);
        if (outputs.some((o) => outs[o.resource] !== hist.at(-1).outs[o.resource])) hist.push({ seq: hist.length, cycle: cycle(), outs });
      };
      return { epoch, cycle: 1, outs: hist[0].outs, changes: 1 };
    },
    async set(map) {
      sim.runTo((cycle() + latency) * sim.main.period);
      for (const [r, v] of Object.entries(map)) sim.board.setInput(r, v ?? 0);
      return { ok: true, cycle: cycle() };
    },
    async wait({ cycle: target, epoch: e, since }) {
      assert.equal(e, epoch, "a cursor from another epoch");
      if (cycle() < target) sim.runTo(target * sim.main.period);
      return { reached: true, cycle: Math.max(cycle(), target), epoch, changes: hist.slice(since), cursor: hist.length, lost: 0, gaps: 0 };
    },
  };
  return client;
}

test("F-01 blinks at 2 Hz on the (simulated) board, counted in board cycles", async () => {
  const c = forBoard("F-01");
  const b = simBoard(c);
  const r = await runOnBoard(c, c.scenarios[0], b, { session: b.session });
  assert.equal(r.status, "pass", r.message);
  assert.equal(r.cycles, 11_000_000);
  assert.match(r.steps[1].note, /led:0 toggles = 4/);
});

test("F-05 presses buttons through the bridge: the physical btn:0 and the virtual ones", async () => {
  const c = forBoard("F-05");
  const b = simBoard(c);
  const r = await runOnBoard(c, c.scenarios[0], b, { session: b.session });
  assert.equal(r.status, "pass", `${r.message}\n${r.steps.map((s) => `${s.label} ${s.ok} ${s.note}`).join("\n")}`);
  assert.match(r.steps.find((s) => s.label.startsWith('press("btn:0"')).note, /no chatter on the board/);
});

test("F-02 counts on eight outputs and a virtual switch", async () => {
  const c = forBoard("F-02");
  const b = simBoard(c);
  const results = (await runScenariosOnBoard(c, b, { build: "x" })).results;
  assert.deepEqual(results.map((r) => [r.name, r.status]), [["counts up, then down", "pass"], ["wraps below zero", "skip"]]);
  assert.match(results[1].message, /poke\(\) has no board equivalent/);
  assert.deepEqual(b.calls, ["open", "close"]);
});

test("a wrong expectation fails with the board's value, and the time comes from board cycles", async () => {
  const c = forBoard("F-01");
  const b = simBoard(c);
  const sc = { name: "five", kind: "steps", steps: [{ op: "wait", args: ["1.1s"] }, { op: "expectToggles", args: ["led:0", 5, { within: "100ms" }] }] };
  const r = await runOnBoard(c, sc, b, { session: b.session });
  assert.equal(r.status, "fail");
  assert.match(r.message, /led:0 toggles = 4 \(after 100 ms\)/);
  assert.equal(r.steps[1].time, 1200);
});

test("lost reports fail the scenario; a UART-only scenario skips on the bridge and vice versa", async () => {
  const c = forBoard("F-01");
  const b = simBoard(c);
  const wait = b.wait;
  b.wait = async (o) => ({ ...(await wait(o)), lost: 3 });
  const r = await runOnBoard(c, c.scenarios[0], b, { session: b.session });
  assert.equal(r.status, "fail");
  assert.match(r.message, /HIL overflow: 3 output change/);

  const f16 = forBoard("F-16");
  assert.equal((await runOnBoard(f16, f16.scenarios[0], b, { session: b.session })).status, "skip");
  const f05 = forBoard("F-05");
  const u = await runOnBoard(f05, f05.scenarios[0], b, { session: { mode: "uart" } });
  assert.equal(u.status, "skip");
  assert.match(u.message, /press\(\) needs the HIL bridge/);
});

test("the design's own UART: text out and back, on the host clock", async () => {
  const c = forBoard("F-16");
  let rx = "";
  const client = {
    async uartRead(since, wait) { if (wait) await new Promise((r) => setTimeout(r, 2)); return { text: rx.slice(since), cursor: rx.length }; },
    async uartSend(text) { setTimeout(() => { rx += text.toUpperCase(); }, 4); return { ok: true }; },
  };
  const r = await runOnBoard(c, c.scenarios[0], client, { session: { mode: "uart" } });
  assert.equal(r.status, "pass", r.message);
});
