// Scenario runner (owner C): recorder steps and async testbenches on a fresh Sim (ARCH §6).
// `runScenario(compiled, name, { level = "dag", onStep, onSim, sample, recompile, seed, waves })`
//   → Promise<{ status: "pass"|"fail"|"skip", steps: [{ label, ok, note, time, line }], message, simTime (ms), ms }>
import { Sim } from "./sim.js";
import { decode, encode, randomOf, psOf, mulberry32 } from "./cells.js";
import { startHosts } from "./host.js";
import { ChangePipeline } from "./changes.js";

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const ps = (d) => (typeof d === "number" ? d * 1e9 : psOf(d));   // numbers are ms in scenario arguments
const fmtT = (p) => (p >= 1e12 ? `${+(p / 1e12).toFixed(3)} s` : p >= 1e9 ? `${+(p / 1e9).toFixed(3)} ms` : p >= 1e6 ? `${+(p / 1e6).toFixed(3)} µs` : `${+(p / 1e3).toFixed(1)} ns`);
const NEEDS_CLAUDE = "needs Claude";

export function fmtVal(v, depth = 0) {
  if (typeof v === "function") { const s = v.toString().replace(/\s+/g, " "); return s.length > 60 ? s.slice(0, 57) + "…" : s; }
  if (typeof v === "string") return JSON.stringify(v.length > 40 ? v.slice(0, 37) + "…" : v);
  if (typeof v === "bigint") return v.toString() + "n";
  if (v instanceof RegExp) return String(v);
  if (Array.isArray(v)) return depth > 1 ? "[…]" : `[${v.slice(0, 8).map((x) => fmtVal(x, depth + 1)).join(", ")}${v.length > 8 ? `, … ${v.length}` : ""}]`;
  if (v && typeof v === "object") {
    if (v.name && (v.kind === "change" || v.__change || typeof v.knob === "function")) return `change(${JSON.stringify(v.name)})`;
    if (depth > 1) return "{…}";
    return `{ ${Object.entries(v).slice(0, 6).map(([k, x]) => `${k}: ${fmtVal(x, depth + 1)}`).join(", ")} }`;
  }
  return String(v);
}
export function label(op, args = []) { return `${op}(${args.map((a) => fmtVal(a)).join(", ")})`; }

// numbers and BigInts compare by value; arrays elementwise; an expected object matches its keys
export function match(actual, expected) {
  if (typeof expected === "function") { try { return !!expected(actual); } catch { return false; } }
  if (expected instanceof RegExp) return expected.test(String(actual));
  return deepEq(actual, expected);
}
function deepEq(a, b) {
  if ((typeof a === "bigint" || typeof b === "bigint") && (typeof a === "number" || typeof a === "bigint") && (typeof b === "number" || typeof b === "bigint")) {
    try { return BigInt(a) === BigInt(b); } catch { return false; }
  }
  if (typeof b === "boolean" && typeof a === "number") return a === (b ? 1 : 0);
  if (Array.isArray(b)) return Array.isArray(a) && a.length === b.length && b.every((x, i) => deepEq(a[i], x));
  if (b && typeof b === "object") return a && typeof a === "object" && Object.keys(b).every((k) => deepEq(a[k], b[k]));
  return a === b;
}
function short(v) { const s = fmtVal(v); return s.length > 80 ? s.slice(0, 77) + "…" : s; }

// the recorder used for repeat(n, s => s.…) bodies and by tests: every method records { op, args }
export function recorder() {
  const steps = [];
  const r = new Proxy({}, { get: (_, op) => (op === "steps" ? steps : op === "then" ? undefined : (...args) => { steps.push({ op, args }); return r; }) });
  return r;
}

export function compiledAt(compiled, level) {
  if (!level || level === "dag") return { c: compiled, note: null };
  const lv = compiled.levels?.[level];
  if (lv?.domains) return { c: { ...compiled, domains: lv.domains }, note: null };
  if (level === "hir" && compiled.levels?.lower?.domains) return { c: { ...compiled, domains: compiled.levels.lower.domains }, note: "hir simulated as the graph lowering produced, before any pass" };
  const st = (compiled.stages || []).filter((s) => s.level === level && s.snapshot?.domains).at(-1);
  if (st) return { c: { ...compiled, domains: st.snapshot.domains }, note: null };
  return { c: compiled, note: `no ${level} snapshot: simulated at the dag level` };
}

export async function runScenario(compiled, name, opts = {}) {
  const t0 = now();
  const scs = compiled?.scenarios || [];
  const sc = typeof name === "object" && name ? name : scs.find((s) => s.name === name) ?? (typeof name === "number" ? scs[name] : null);
  const done = (status, steps, message, sim) => ({ status, steps, message, simTime: sim ? sim.time / 1e9 : 0, ms: now() - t0 });
  if (!sc) return done("fail", [], `no scenario named ${name}`);
  if (!compiled.domains || !Object.keys(compiled.domains).length) return done("fail", [], compiled.ok === false ? "the design does not compile" : "nothing to simulate");
  const { c, note } = compiledAt(compiled, opts.level);
  let sim;
  try { sim = new Sim(c, { seed: opts.seed ?? 1, waves: opts.waves ?? false }); } catch (e) { return done("fail", [], `cannot simulate: ${e.message}`); }
  try { opts.onSim?.(sim); } catch { /* the UI's business */ }
  const run = new Runner(compiled, sim, opts);
  if (note) run.steps.push({ label: `level ${opts.level}`, ok: true, note, time: 0 });
  try {
    if (sc.kind === "tb" || typeof sc.fn === "function") await run.testbench(sc.fn);
    else await run.runSteps(sc.steps || []);
  } catch (e) {
    if (e && e.skip) { run.status = run.status === "fail" ? "fail" : "skip"; run.message ||= e.message; }
    else { run.status = "fail"; run.message ||= e?.message || String(e); run.steps.push({ label: "error", ok: false, note: e?.message || String(e), time: sim.time / 1e9 }); }
  } finally {
    run.stop();
  }
  if (run.status === "pass" && run.steps.some((s) => s.ok === false)) run.status = "fail";
  return done(run.status, run.steps, run.message || (run.status === "pass" ? `${run.steps.length} steps passed` : ""), sim);
}

export class Runner {
  constructor(compiled, sim, opts = {}) {
    this.c = compiled; this.sim = sim; this.opts = opts;
    this.steps = []; this.status = "pass"; this.message = "";
    this.cursor = { uart: {}, irq: {}, pull: {} };
    this.hosts = [];
    this.pipe = null; this.lastBuild = null;
    this._yield = now();
    this.rnd = mulberry32((opts.seed ?? 1) * 40503 + 17);
  }
  stop() { for (const h of this.hosts) h.stop(); this.pipe?.stop?.(); }
  async yield() {
    if (now() - this._yield > 25) { await new Promise((r) => setTimeout(r, 0)); this._yield = now(); }
    else await null;
    if (this.opts.signal?.aborted) throw new Error("stopped");
  }
  // run for `p` ps in slices, letting host lambdas and the change pipeline act between them
  async wait(p) {
    const sim = this.sim, end = sim.time + p;
    const slice = Math.min(1e9, Math.max(p / 64, sim.main.period * 256));
    while (sim.time < end) {
      sim.runTo(Math.min(end, sim.time + slice));
      this.pipe?.poll();
      await this.yield();
    }
  }
  // poll check() until it returns true or `within` ps pass; check returns true or a note
  async poll(within, check) {
    let r = check();
    if (r === true || within <= 0) return r;
    const sim = this.sim, end = sim.time + within;
    const slice = Math.min(5e8, Math.max(within / 400, sim.main.period * 16));
    while (sim.time < end) {
      sim.runTo(Math.min(end, sim.time + slice));
      this.pipe?.poll();
      r = check();
      if (r === true) return r;
      await this.yield();
    }
    return typeof r === "string" ? `${r} (after ${fmtT(within)})` : `not within ${fmtT(within)}`;
  }
  record(lbl, ok, note = "", line) {
    const last = this.steps.at(-1);
    const step = { label: lbl, ok, note, time: this.sim.time / 1e9, line };
    this.steps.push(step);
    if (ok === false && this.status !== "fail") { this.status = "fail"; this.message = `${lbl}: ${note}`; }
    this.opts.onStep?.(step, this.steps.length - 1, this.sim);
    void last;
    return step;
  }
  pipeline() {
    if (!this.pipe) this.pipe = new ChangePipeline({ compiled: this.c, sim: this.sim, recompile: this.opts.recompile, sample: this.opts.sample, record: this.c.record, onChange: (ch) => this.opts.onChange?.(ch) });
    return this.pipe;
  }
  async runSteps(steps) {
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      let res;
      try { res = await this.op(st.op, st.args || [], st); }
      catch (e) {
        if (e && e.skip) {
          this.record(label(st.op, st.args), null, NEEDS_CLAUDE, st.line);
          for (const rest of steps.slice(i + 1)) this.steps.push({ label: label(rest.op, rest.args), ok: null, note: "skipped", time: this.sim.time / 1e9, line: rest.line });
          this.status = this.status === "fail" ? "fail" : "skip";
          this.message ||= `${label(st.op, st.args)} ${NEEDS_CLAUDE}`;
          return;
        }
        res = { ok: false, note: e?.message || String(e) };
      }
      if (res === undefined) continue;
      this.record(label(st.op, st.args), res.ok, res.note || "", st.line);
      if (res.ok === false) {
        for (const rest of steps.slice(i + 1)) this.steps.push({ label: label(rest.op, rest.args), ok: null, note: "not run", time: this.sim.time / 1e9, line: rest.line });
        return;
      }
    }
  }
  needsClaude() { if (!this.opts.agentRuntime?.propose) throw Object.assign(new Error(NEEDS_CLAUDE), { skip: true }); }

  // one recorder step → { ok, note } (ok: true | false | null for skipped)
  async op(op, a, st = {}) {
    const sim = this.sim, b = sim.board;
    const within = (o, dflt = 0) => (o && o.within != null ? ps(o.within) : dflt);
    const expectVal = async (get, exp, o, what) => {
      let last;
      const r = await this.poll(within(o), () => { try { last = get(); } catch (e) { return e.message; } return match(last, exp) ? true : `${what} = ${short(last)}`; });
      return r === true ? { ok: true, note: `${what} = ${short(last)}` } : { ok: false, note: r };
    };
    switch (op) {
      case "wait": await this.wait(ps(a[0])); return { ok: true };
      case "step": {
        if (typeof a[0] === "string" && isNaN(+a[0])) { await this.wait(ps(a[0])); return { ok: true }; }
        const n = a[0] ?? 1, D = sim.dom[a[1]] || sim.main;
        const target = sim.cycle(D.name) + n;
        while (sim.cycle(D.name) < target) { sim.runTo(Math.min(target, sim.cycle(D.name) + 200_000) * D.period); this.pipe?.poll(); await this.yield(); }
        return { ok: true, note: `cycle ${sim.cycle(D.name)}` };
      }
      case "poke": sim.poke(a[0], a[1]); return { ok: true };
      case "release": if (sim.resolve(a[0])) sim.release(a[0]); else b.release(a[0], a[1]); return { ok: true };
      case "press": { const hold = b.press(a[0], a[1] || {}); if (hold) await this.wait(hold); return { ok: true }; }
      case "toggle": b.toggle(a[0]); return { ok: true };
      case "set": b.set(a[0], a[1]); return { ok: true };
      case "uart": b.uart(a[0]).send(a[1], a[2] || {}); return { ok: true, note: `${a[1].length} bytes` };
      case "feed": {
        const [name, data, o = {}] = a;
        const beats = data === "random" ? Array.from({ length: o.beats ?? 100 }, () => sim.random(name)) : typeof data === "function" ? Array.from({ length: o.beats ?? 100 }, (_, i) => data(i, this.rnd)) : (Array.isArray(data) ? data : [data]);
        const raw = data === "random";
        const drv = sim.source(name, raw ? beats.map((v) => decode(v, sim.streams.get(name).type)) : beats, { rate: o.rate, keep: o.repeat });
        return { ok: true, note: `${beats.length} beats queued` + (drv ? "" : "") };
      }
      case "throttle": sim.sink(a[0], { ready: a[1]?.ready ?? 1 }); return { ok: true };
      case "write": { const kept = sim.knob(a[0]).set(a[1]); return { ok: true, note: kept !== a[1] ? `kept ${kept}` : "" }; }
      case "run": {
        const h = startHosts(this.c, sim, { only: a[0], runner: this });
        this.hosts.push(h);
        await this.yield();
        return { ok: h.count > 0, note: h.count ? `${a[0]} started` : `no host named ${a[0]}` };
      }
      case "apply": { const ch = this.pipeline().submit(a[0]); return { ok: true, note: ch ? ch.status : "" }; }
      case "approve": {
        let p = this.pipe?.pendingApproval();
        if (!p) {
          // an escalation is waiting for its agent: ask the agent runtime for the proposal now
          const esc = sim.escalations.at(-1);
          if (esc && esc.agent) p = await this.propose(esc.agent, { kind: "escalation", ...esc });
        }
        if (p) { this.pipe.approve(p.id); return { ok: true, note: `${p.name}${p.agent ? ` from ${p.agent}` : ""}` }; }
        return { ok: false, note: "nothing awaits approval" };
      }
      case "build": { this.lastBuild = this.build(); return { ok: true, note: `timing ${this.lastBuild.timing}` }; }
      case "hang": sim.hang(a[0]); return { ok: true };
      case "repeat": {
        const [n, body] = a;
        const r = recorder();
        if (typeof body === "function") body(r);
        for (let i = 0; i < n; i++) for (const s of r.steps) { const res = await this.op(s.op, s.args); if (res && res.ok === false) return { ok: false, note: `round ${i + 1}: ${label(s.op, s.args)}: ${res.note}` }; }
        return { ok: true, note: `${n} × ${r.steps.length} steps` };
      }
      case "expect": {
        const [fn, o] = a;
        const r = await this.poll(within(o), () => { try { return fn(sim) ? true : "false"; } catch (e) { return e.message; } });
        return { ok: r === true, note: r === true ? "" : r };
      }
      case "expectPins": return expectVal(() => b.value(a[0]), a[1], a[2], a[0]);
      case "expectSignal": return expectVal(() => sim.peek(a[0]), a[1], a[2], a[0]);
      case "expectState": return expectVal(() => sim.state(a[0]), a[1], a[2], a[0]);
      case "expectKnob": return expectVal(() => sim.knob(a[0]).get(), a[1], a[2], a[0]);
      case "expectDropped": return expectVal(() => sim.stream(a[0]).dropped, a[1], a[2], `${a[0]} dropped`);
      case "expectResets": return expectVal(() => sim.resets[a[0]] || 0, a[1], a[2], `${a[0]} resets`);
      case "expectToggles": return expectVal(() => b.toggles[a[0]] || 0, a[1], a[2], `${a[0]} toggles`);
      case "expectStream": {
        const [name, pred, o = {}] = a;
        let ys = [];
        const r = await this.poll(within(o), () => {
          const s = sim.stream(name);
          ys = o.last ? s.tail(o.last) : s.last;
          return match(ys, pred) ? true : `${ys.length} beats, last ${short(ys.slice(-4))}`;
        });
        return r === true ? { ok: true, note: `${ys.length} beats` } : { ok: false, note: r };
      }
      case "expectUart": {
        const [id, text, o = {}] = a;
        const term = b.uart(id), key = `${id}@${o.baud ?? ""}`;
        const from = this.cursor.uart[key] ?? 0;
        const r = await this.poll(within(o, ps("10ms")), () => {
          const t = term.textAt(o.baud);
          const at = t.indexOf(text, from);
          if (at >= 0) { this.cursor.uart[key] = at + text.length; return true; }
          return `received ${JSON.stringify(t.slice(from).slice(-40))}`;
        });
        return r === true ? { ok: true, note: `at ${fmtT(sim.time)}` } : { ok: false, note: r };
      }
      case "expectFrame": {
        const [, pred, o = {}] = a;
        let f = null;
        const r = await this.poll(within(o), () => { f = b.lastFrame(); if (!f) return "no frame yet"; try { return pred(f) ? true : "the frame does not match"; } catch (e) { return e.message; } });
        return r === true ? { ok: true, note: `frame ${f.index} at ${fmtT(f.time)}` } : { ok: false, note: r };
      }
      case "expectIrq": {
        const [path, o = {}] = a;
        const from = this.cursor.irq[path] ?? 0;
        const want = o.count ?? 1;
        const r = await this.poll(within(o), () => {
          const n = sim.irqLog.filter((e, i) => i >= from && e.path === path).length;
          return n >= want ? true : `${n} interrupts`;
        });
        if (r === true) this.cursor.irq[path] = sim.irqLog.length;
        return r === true ? { ok: true, note: `at ${fmtT(sim.time)}` } : { ok: false, note: r };
      }
      case "expectChange": {
        const [nm, status, o = {}] = a;
        const pipe = this.pipeline();
        let ch = null;
        const r = await this.poll(within(o, ps("5s")), () => {
          ch = pipe.find(nm);
          if (!ch) return `no change ${fmtVal(nm)}`;
          if (ch.status === status) return true;
          if (pipe.isFinal(ch.status)) return `${ch.name} ${ch.status}${ch.reason ? `: ${ch.reason}` : ""}`;
          return `${ch.name} is ${ch.status}`;
        });
        if (r !== true && ch && ch.needsClaude) this.needsClaude();
        return r === true ? { ok: true, note: `${ch.name} ${status}` } : { ok: false, note: r };
      }
      case "expectBuild": {
        const [kind, status] = a;
        const bld = (this.lastBuild = this.build());   // the running design's build: a committed change rebuilt it
        if (kind === "timing" && status === "met" && bld.timing !== "met" && this.pipe?.changes.some((c) => c.fromAgent)) this.needsClaude();
        const got = bld[kind] ?? "unknown";
        return { ok: match(got, status), note: `${kind} ${got}${bld.detail ? ` (${bld.detail})` : ""}` };
      }
      case "expectProposal": {
        const [agent] = a;
        const p = this.pipe?.changes.find((c) => c.fromAgent && (!agent || c.agent === agent)) || await this.propose(agent, { kind: "build", build: this.lastBuild });
        return p ? { ok: true, note: `${p.name} from ${p.agent}` } : { ok: false, note: `${agent} proposed nothing` };
      }
      case "expectEscalation": {
        const [group, agent, o] = a;
        const r = await this.poll(within(typeof agent === "object" ? agent : o, ps("1s")), () => sim.escalations.some((e) => e.group === group && (!agent || typeof agent !== "string" || e.agent === agent)) ? true : `${sim.escalations.length} escalations`);
        return r === true ? { ok: true, note: `${group} → ${agent}` } : { ok: false, note: r };
      }
      default: return { ok: false, note: `unknown step ${op}` };
    }
  }
  // ask the agent runtime (the Lab's architect, via Claude) for a change; without one the step needs Claude
  async propose(agent, trigger) {
    const rt = this.opts.agentRuntime;
    if (!rt?.propose) this.needsClaude();
    const pipe = this.pipeline();
    const change = await rt.propose({ agent, trigger, compiled: pipe.current, sim: this.sim, pipeline: pipe });
    if (!change) return null;
    return pipe.submit(change, { fromAgent: true, agent });
  }
  // the build an example asks for: timing met/failed from the report (an estimate)
  build() {
    const rep = this.pipe?.current?.report || this.c.report || {};
    const t = rep.timing || {};
    const doms = Object.entries(t).filter(([, v]) => v && typeof v === "object" && "slack" in v);
    const worst = doms.reduce((m, [d, v]) => (v.slack < m.slack ? { d, slack: v.slack } : m), { d: null, slack: Infinity });
    return { timing: worst.slack >= 0 ? "met" : "failed", detail: worst.d ? `${worst.d} slack ${+worst.slack.toFixed(2)} ns` : "no timing report", resources: rep.resources };
  }

  // ---------- async testbenches (book 2, Appendix B)
  async testbench(fn) {
    const tb = this.makeTb();
    await fn(tb);
    const agg = this._agg;
    if (agg) this.flushAgg();
  }
  flushAgg() { const a = this._agg; this._agg = null; if (a) this.record(a.count > 1 ? `${a.op} × ${a.count}` : a.label, true, a.note); }
  expectStep(op, ok, lbl, note) {
    if (ok) {
      if (this._agg && this._agg.op === op) { this._agg.count++; return true; }
      this.flushAgg(); this._agg = { op, count: 1, label: lbl, note }; return true;
    }
    this.flushAgg();
    this.record(lbl, false, note);
    return false;
  }
  makeTb() {
    const sim = this.sim, b = sim.board, R = this, rnd = this.rnd;
    const until = async (cond, timeout, what) => {
      const r = await this.poll(timeout, () => (cond() ? true : what()));
      if (r !== true) throw new Error(r);
    };
    return {
      sim, board: b,
      random: {
        int: (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1)),
        bit: () => (rnd() < 0.5 ? 1 : 0),
        float: () => rnd(),
        pick: (xs) => xs[Math.floor(rnd() * xs.length)],
        of: (T) => randomOf(T, rnd),
      },
      get time() { return sim.time / 1e9; },
      wait: (d) => R.wait(ps(d)),
      run: (d) => R.wait(ps(d)),
      step: async (n = 1, domain) => { sim.step(n, domain); },
      poke: async (p, v) => { sim.poke(p, v); },
      release: async (p) => { sim.release(p); },
      peek: (p) => sim.peek(p),
      state: (i) => sim.state(i),
      set: async (res, v) => { b.set(res, v); },
      toggle: async (res) => { b.toggle(res); },
      press: async (res, o = {}) => { const h = b.press(res, o); if (h) await R.wait(h); },
      read: (res) => b.value(res),
      knob: (p) => sim.knob(p),
      uart: (id) => b.uart(id),
      log: (...xs) => sim.log(...xs),
      // the fraction of `over` that a pin was high
      measure: async (res, o = {}) => {
        const span = ps(o.over ?? "1ms"), t0 = sim.time;
        let level = b.read(res), last = t0, high = 0;
        const off = sim.on("*", () => {});
        const hook = (D, k, v) => {
          const w = D.pinWatch[k]?.res.find((x) => x.res === res);
          if (!w) return;
          const lv = typeof v === "bigint" ? Number((v >> BigInt(w.bit)) & 1n) : Math.floor(v / 2 ** w.bit) & 1;
          if (lv !== level) { if (level) high += sim.time - last; last = sim.time; level = lv; }
        };
        const orig = b._pin.bind(b);
        b._pin = (D, k, v) => { hook(D, k, v); orig(D, k, v); };
        try { await R.wait(span); } finally { b._pin = orig; off(); }
        if (level) high += sim.time - last;
        return high / (sim.time - t0);
      },
      push: async (name, beats, o = {}) => {
        const drv = sim.source(name, Array.isArray(beats) ? beats : [beats]);
        await until(() => drv.done || drv.q.length === 0, ps(o.timeout ?? "100ms"), () => `push ${name}: ${drv.sent} of ${beats.length} beats taken`);
      },
      pull: async (name, n = 1, o = {}) => {
        const st = sim.streams.get(name);
        if (!st) throw new Error(`no stream named ${name}`);
        const from = R.cursor.pull[name] ?? 0;
        if (o.ready != null) sim.sink(name, { ready: o.ready });
        await until(() => st.fired - from >= n, ps(o.timeout ?? "100ms"), () => `pull ${name}: ${st.fired - from} of ${n} beats`);
        R.cursor.pull[name] = from + n;
        return sim.beats(st, from, from + n).map((v) => decode(v, st.type));
      },
      expect: (cond, msg = "expect") => R.expectStep("expect:" + msg, !!cond, typeof msg === "string" ? msg : "expect", ""),
      expectEqual: (got, want, msg = "") => R.expectStep("expectEqual", match(got, want), `expectEqual(${msg})`.replace("()", ""), `${short(got)} vs ${short(want)}`),
      expectCoverage: (which = "all") => {
        const cov = sim.coverage();
        const names = which === "all" ? cov.map((c) => c.name) : [].concat(which);
        const missed = cov.filter((c) => names.includes(c.name) && !c.hits).map((c) => c.name);
        R.flushAgg();
        R.record(`expectCoverage(${fmtVal(which)})`, missed.length === 0 && cov.length > 0, cov.length === 0 ? "no cover properties" : missed.length ? `not hit: ${missed.join(", ")}` : `${cov.length} covered`);
      },
      encode, decode,
    };
  }
}

// run one scenario at each IR level it names (F-14, F-16); when a level fails and the compile kept graph
// snapshots per stage (`stages[].snapshot.domains`), name the first stage whose graph makes it fail
export async function runAcrossLevels(compiled, name, opts = {}) {
  const sc = (compiled.scenarios || []).find((s) => s.name === name);
  const levels = opts.levels || sc?.opts?.levels || ["dag"];
  const results = {};
  for (const level of levels) results[level] = await runScenario(compiled, name, { ...opts, level });
  let culprit = null;
  if (Object.values(results).some((r) => r.status === "fail")) {
    for (const st of (compiled.stages || []).filter((s) => s.snapshot?.domains)) {
      const r = await runScenario({ ...compiled, domains: st.snapshot.domains }, name, { ...opts, level: "dag" });
      if (r.status === "fail") { culprit = st.name; break; }
    }
  }
  const statuses = Object.values(results).map((r) => r.status);
  return { status: statuses.includes("fail") ? "fail" : statuses.every((s) => s === "skip") ? "skip" : "pass", results, culprit };
}
