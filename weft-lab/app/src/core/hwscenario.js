// Portable scenarios on the real board (L3, guide §6.10): the recorded steps of a "steps" scenario, run
// against a board session (weft serve's /api/hw/board/session, §6.12) instead of a Sim.
//
//   runOnBoard(compiled, scenario, client, { session, onStep }) →
//     Promise<{ name, status: "pass"|"fail"|"skip", steps: [{ label, ok, note, time }], message, ms, cycles }>
//   runScenariosOnBoard(compiled, client, { build, force, scenario, onResult }) → Promise<{ session, results }>
//   httpBoard(base, { fetch }) → a client for the session API
//
// With the HIL bridge (session mode "hil"), time is the board's own cycle count: wait("1.1s") waits for
// 11,000,000 cycles at 10 MHz; an input takes effect at the cycle the bridge acknowledges; an expectation
// reads the output history up to a cycle, which is complete because the bridge reports in cycle order. Each
// scenario starts with the bridge's reset, so the design starts from its reset state at cycle 0, as in the
// simulator. A lost report (queue overflow, or a line lost on USB) fails the scenario: toggle counts could
// otherwise be wrong.
//
// When the design itself uses the UART (mode "uart"), only wait, uart and expectUart can run. Time is then the
// host's clock, so each expectUart gets USB_SLACK_MS on top of its `within`.
import { psOf } from "./cells.js";
import { expandResources } from "./boards.js";
import { PORTABLE_STEPS } from "./hardware.js";
import { label, match, fmtVal } from "./scenario.js";

export const USB_SLACK_MS = 25;
const UART_STEPS = new Set(["wait", "uart", "expectUart"]);
const ps = (d) => (typeof d === "number" ? d * 1e9 : psOf(d));   // numbers are ms in scenario arguments
const short = (v) => { const s = fmtVal(v); return s.length > 80 ? s.slice(0, 77) + "…" : s; };
const fmtMs = (ms) => (ms >= 1000 ? `${+(ms / 1000).toFixed(3)} s` : `${+ms.toFixed(3)} ms`);

class Stop extends Error {}

export async function runOnBoard(compiled, scenario, client, opts = {}) {
  const t0 = Date.now();
  const steps = [];
  let status = "pass", message = "";
  const done = (st = status, msg = message, cycles = 0) => ({ name: scenario.name, status: st, steps, message: msg, ms: Date.now() - t0, cycles });
  if (scenario.kind !== "steps") return done("skip", `a ${scenario.kind} scenario runs in the simulator only`);
  const other = (scenario.steps || []).find((s) => !PORTABLE_STEPS.has(s.op));
  if (other) return done("skip", `step ${other.op}() has no board equivalent`);
  if (!scenario.steps?.length) return done("skip", "no steps");
  const session = opts.session;
  if (session.mode === "none") return done("skip", "this build has no HIL bridge and its design does not use the UART, so nothing on the board can be observed (build with hil)");
  if (session.mode === "uart") {
    const bad = scenario.steps.find((s) => !UART_STEPS.has(s.op));
    if (bad) return done("skip", `step ${bad.op}() needs the HIL bridge, and this design uses the board's UART itself`);
  } else {
    const bad = scenario.steps.find((s) => s.op === "uart" || s.op === "expectUart");
    if (bad) return done("skip", `step ${bad.op}(): the HIL bridge owns the board's UART`);
  }
  const record = (op, args, ok, note, time) => {
    const step = { label: label(op, args), ok, note: note || "", time };
    steps.push(step);
    if (ok === false && status !== "fail") { status = "fail"; message = `${step.label}: ${step.note}`; }
    opts.onStep?.(step, steps.length - 1);
  };
  const expand = (spec) => expandResources(spec, compiled.board);
  const runner = session.mode === "uart" ? uartRunner(client) : hilRunner(client, session, expand);
  try {
    await runner.start();
    for (const s of scenario.steps) {
      let r;
      try { r = await runner.op(s.op, s.args || []); }
      catch (e) { if (e instanceof Stop) { record(s.op, s.args, false, e.message, runner.time()); break; } throw e; }
      record(s.op, s.args, r.ok, r.note, runner.time());
      if (r.ok === false) break;
    }
    if (status === "pass") await runner.finish?.();
  } catch (e) {
    if (e instanceof Stop) { status = "fail"; message ||= e.message; }
    else { status = "fail"; message = `board: ${e.message}`; }
  }
  return done(status, message, runner.cycles());
}

// --------------------------------------------------------------------------------------- the HIL bridge
function hilRunner(client, session, expand) {
  const hz = session.hz;
  const cyc = (p) => Math.round((p * hz) / 1e12);
  const outputs = new Set(session.outputs.map((p) => p.resource));
  const drives = new Set(session.inputs.map((p) => p.resource));
  const hist = [];      // [{ cycle, outs }], in cycle order
  const inputs = {};    // the HIL values the scenario set
  let epoch = 0, cursor = 0, known = 0, start = 0, now = 0;

  const check = (w) => {
    if (w.lost) throw new Stop(`HIL overflow: ${w.lost} output change(s) lost (the board's outputs changed faster than the bridge reports, about 500 a second)`);
    if (w.gaps) throw new Stop(`${w.gaps} HIL report line(s) lost between the board and the host`);
  };
  const advance = async (target) => {
    while (known < target) {
      const w = await client.wait({ cycle: target, epoch, since: cursor, timeout: "20s" });
      hist.push(...(w.changes || []));
      cursor = w.cursor;
      known = Math.max(known, w.cycle);
      check(w);
    }
  };
  // the outputs as they were at cycle t
  const stateAt = (t) => {
    let lo = 0, hi = hist.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (hist[mid].cycle <= t) lo = mid; else hi = mid - 1; }
    return hist[lo].outs;
  };
  const read = (r, t) => {
    if (outputs.has(r)) return stateAt(t)[r] ?? 0;
    if (drives.has(r)) return inputs[r] ?? 0;
    throw new Stop(`${r} is neither an output the bridge reports nor an input it drives`);
  };
  const value = (spec, t) => expand(spec).reduce((acc, r, i) => acc + (read(r, t) ? 2 ** i : 0), 0);
  const toggles = (r, t) => {
    if (!outputs.has(r)) throw new Stop(`${r} is not an output the bridge reports`);
    let n = 0;
    for (let i = 1; i < hist.length && hist[i].cycle <= t; i++) if (hist[i].cycle > start && hist[i].outs[r] !== hist[i - 1].outs[r]) n++;
    return n;
  };
  const set = async (map) => {
    for (const r of Object.keys(map)) if (!drives.has(r)) throw new Stop(`${r} is not an input the HIL bridge drives`);
    const r = await client.set(map);
    for (const [k, v] of Object.entries(map)) inputs[k] = v ?? 0;
    now = Math.max(now, r.cycle);
  };
  // check get() at now; with `within`, at every change up to now + within (the value can only change there)
  const expectVal = async (get, exp, o, what) => {
    const within = o && o.within != null ? cyc(ps(o.within)) : 0;
    await advance(now);
    let v = get(now);
    if (match(v, exp)) return { ok: true, note: `${what} = ${short(v)}` };
    if (within <= 0) return { ok: false, note: `${what} = ${short(v)}` };
    const end = now + within;
    await advance(end);
    for (const h of hist) {
      if (h.cycle <= now || h.cycle > end) continue;
      v = get(h.cycle);
      if (match(v, exp)) { now = h.cycle; return { ok: true, note: `${what} = ${short(v)}` }; }
    }
    now = end;
    return { ok: false, note: `${what} = ${short(get(end))} (after ${fmtMs((within / hz) * 1000)})` };
  };

  return {
    time: () => ((now - start) / hz) * 1000,
    cycles: () => now - start,
    async start() {
      const r = await client.reset();
      epoch = r.epoch;
      const w = await client.wait({ cycle: r.cycle, epoch, since: 0, timeout: "5s" });
      hist.push(...(w.changes || []));
      cursor = w.cursor;
      known = w.cycle;
      check(w);
      if (!hist.length) throw new Error("the bridge reported no outputs after the reset");
      start = now = hist[0].cycle;
    },
    async op(op, a) {
      switch (op) {
        case "wait": { const target = now + cyc(ps(a[0])); await advance(target); now = target; return { ok: true }; }
        case "press": {
          const o = a[1] || {}, rs = expand(a[0]);
          await set(Object.fromEntries(rs.map((r) => [r, 1])));
          const note = o.bounce ? `no chatter on the board (${o.bounce} bounce asked): each input change is one UART command` : "";
          if (o.hold || o.for === Infinity) return { ok: true, note };
          const t = now + cyc(ps(o.for ?? "50ms"));
          await advance(t);
          now = t;
          await set(Object.fromEntries(rs.map((r) => [r, 0])));
          return { ok: true, note };
        }
        case "release": await set(Object.fromEntries(expand(a[0]).map((r) => [r, 0]))); return { ok: true };
        case "toggle": await set(Object.fromEntries(expand(a[0]).map((r) => [r, inputs[r] ? 0 : 1]))); return { ok: true };
        case "set": {
          const rs = expand(a[0]), v = a[1];
          const map = rs.length === 1 ? { [rs[0]]: v ? 1 : 0 } : Object.fromEntries(rs.map((r, i) => [r, Math.floor(Number(v) / 2 ** i) % 2]));
          await set(map);
          return { ok: true };
        }
        case "expectPins": return expectVal((t) => value(a[0], t), a[1], a[2], a[0]);
        case "expectToggles": return expectVal((t) => toggles(a[0], t), a[1], a[2], `${a[0]} toggles`);
        default: throw new Stop(`step ${op}() has no board equivalent`);
      }
    },
  };
}

// ------------------------------------------------------------------------- the design's own UART
function uartRunner(client) {
  const t0 = Date.now();
  let text = "", off = 0;
  const cursor = {};
  const pull = async (wait) => { const r = await client.uartRead(off, wait); text += r.text; off = r.cursor; };
  return {
    time: () => Date.now() - t0,
    cycles: () => 0,
    async start() { const r = await client.uartRead(0); off = r.cursor; },  // only what the design sends from now on
    async op(op, a) {
      switch (op) {
        case "wait": await new Promise((r) => setTimeout(r, ps(a[0]) / 1e9)); return { ok: true, note: "host clock" };
        case "uart": await client.uartSend(a[1]); return { ok: true, note: `${a[1].length} bytes` };
        case "expectUart": {
          const [id, want, o = {}] = a;
          const from = cursor[id] ?? 0;
          const within = (o.within != null ? ps(o.within) : ps("10ms")) / 1e9 + USB_SLACK_MS;
          const end = Date.now() + within;
          for (;;) {
            const at = text.indexOf(want, from);
            if (at >= 0) { cursor[id] = at + want.length; return { ok: true, note: `after ${Date.now() - t0} ms on the host clock` }; }
            const left = end - Date.now();
            if (left <= 0) return { ok: false, note: `received ${JSON.stringify(text.slice(from).slice(-40))} (within ${fmtMs(within)}, host clock, ${USB_SLACK_MS} ms of it for USB)` };
            await pull(`${Math.ceil(Math.min(left, 1000))}ms`);
          }
        }
        default: throw new Stop(`step ${op}() needs the HIL bridge`);
      }
    },
  };
}

// --------------------------------------------------------------------------------- whole designs
// Open a session on `build`, run the design's scenarios (or the one named), close the session. With
// opts.session (a session already open on the build), run in it and leave it open.
export async function runScenariosOnBoard(compiled, client, opts = {}) {
  const scs = (compiled.scenarios || []).filter((s) => !opts.scenario || s.name === opts.scenario);
  if (opts.scenario && !scs.length) throw new Error(`no scenario named ${JSON.stringify(opts.scenario)}`);
  const own = !opts.session;
  const session = opts.session || await client.open(opts.build, !!opts.force);
  const results = [];
  try {
    for (const sc of scs) {
      opts.onStart?.(sc);
      const r = await runOnBoard(compiled, sc, client, { session, onStep: opts.onStep });
      results.push(r);
      opts.onResult?.(r);
    }
  } finally {
    if (own) await client.close().catch(() => {});
  }
  return { session, results };
}

export function httpBoard(base = "", { fetch: f = globalThis.fetch } = {}) {
  const call = async (method, path, body) => {
    const res = await f(`${base}/api/hw/board/session${path}`, {
      method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data?.error?.message || `HTTP ${res.status}`);
      e.code = data?.error?.code;
      e.status = res.status;
      throw e;
    }
    return data;
  };
  return {
    open: (build, force = false) => call("POST", "", { build, force }),
    get: () => call("GET", ""),
    close: () => call("DELETE", ""),
    reset: () => call("POST", "/reset"),
    set: (set) => call("POST", "/inputs", { set }),
    wait: (o) => call("POST", "/wait", o),
    uartSend: (text) => call("POST", "/uart", { text }),
    uartRead: (since, wait) => call("GET", `/uart?since=${since}${wait ? `&wait=${encodeURIComponent(wait)}` : ""}`),
  };
}
