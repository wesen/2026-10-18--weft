// The Lab: owns the editor text, the compiled design, the running simulation, scenarios, proofs,
// changes, saving, and the bridge that lets agent() components call Claude. React components read from
// it and subscribe to named channels (ARCH §8).
import { compile } from "../core/compile.js";
import * as COMPILE from "../core/compile.js";
import { Sim } from "../core/sim.js";
import { runScenario as runScenarioCore } from "../core/scenario.js";
import { ChangePipeline } from "../core/changes.js";
import { prove as proveCore } from "../core/formal.js";
import { emitVerilog } from "../core/verilog.js";
import { startHosts } from "../core/host.js";
import { EXAMPLES } from "../examples.gen.js";
import { REFERENCE, GUIDELINES } from "../docs.gen.js";
import { normBoard, simTime, simCycle, safe, changeList, isWaiting, isFailed } from "./engine.js";
import { clip, summarize, fmtPs } from "./fmt.js";

const LS = "weft-lab:";
export const lsGet = (k, d) => { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
export const lsSet = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch {} };

export const GROUP_ORDER = ["Basics", "Components", "Time", "Verification", "Runtime", "Compiler", "Live change", "Agents", "Whole designs", "Mine"];
export const SPEEDS = [1e-6, 1e-5, 1e-4, 1e-3, 0.01, 0.1, 1, Infinity];

export function parseHeader(text) {
  const head = String(text).match(/^\s*\/\*\*\s*([A-Z]-\d+)?\s*([^\n]*)\n([\s\S]*?)\*\//);
  const f = {};
  let cur = null;
  for (const raw of (head?.[3] || "").split("\n")) {
    const l = raw.replace(/^\s*\*\s?/, "");
    const m = l.match(/^\s*(group|about|shows|watch|try)\s{2,}(.*)$/);
    if (m) { cur = m[1]; f[cur] = m[2].trim(); } else if (cur && l.trim()) f[cur] += " " + l.trim();
  }
  return {
    id: head?.[1] || null, title: (head?.[2] || "Untitled").trim() || "Untitled", group: f.group || "Mine", about: f.about || "",
    shows: (f.shows || "").split("·").map((s) => s.trim()).filter(Boolean), watch: f.watch || "",
    tries: (f.try || "").split("|").map((s) => s.trim()).filter(Boolean),
  };
}

class Lab {
  constructor() {
    this.ver = {};
    this.subs = new Map();
    this.builtins = EXAMPLES.map((p) => ({ ...p, builtin: true }));
    this.mine = lsGet("mine", []);
    this.preset = null;
    this.script = "";
    this.savedScript = "";
    this.compiled = null;
    this.compileMs = 0;
    this.diags = [];
    this.sim = null;            // the running simulation
    this.simCompiled = null;    // the design it runs (the editor may differ)
    this.bootScript = "";
    this.simError = null;
    this.hosts = null;
    this.pipeline = null;
    this.running = true;
    this.speed = lsGet("speed", 1);
    this.effSpeed = 0;
    this.cps = 0;
    this.psPerMs = 0;
    this.events = [];           // assert / irq / uart / frame / drop / reset, newest last
    this.sel = { instance: null, stream: null, node: null, domain: null, change: null, signal: null, pass: null, proof: null };
    const phone = typeof matchMedia === "function" && matchMedia("(max-width: 640px)").matches;
    this.ui = { left: "code", right: "board", ide: lsGet("ide", !phone), theme: lsGet("theme", "auto"), graphMode: "modules", tiles: true, parts: true };
    this.scen = {};
    this.proofs = null;
    this.verilogCache = null;
    this.toasts = [];
    this.osThreads = [];
    this.sample = null;
    this.platformReady = false;
    this.ready = false;
    this.error = null;
    this.frameT = 0;
    this.watching = null;
    this.gotoLine = null;
    this.agentDraft = null;
  }

  // ---------- subscriptions ----------
  on(ch, fn) { if (!this.subs.has(ch)) this.subs.set(ch, new Set()); this.subs.get(ch).add(fn); return () => this.subs.get(ch).delete(fn); }
  bump(...chs) { for (const c of chs) { this.ver[c] = (this.ver[c] || 0) + 1; for (const f of [...(this.subs.get(c) || [])]) f(); } }
  version(ch) { return this.ver[ch] || 0; }
  toast(text, tone = "") { const id = Math.random(); this.toasts.push({ id, text, tone }); if (this.toasts.length > 4) this.toasts.shift(); this.bump("toast"); setTimeout(() => { this.toasts = this.toasts.filter((t) => t.id !== id); this.bump("toast"); }, 3600); }
  setUI(patch) { Object.assign(this.ui, patch); if ("ide" in patch) lsSet("ide", this.ui.ide); if ("theme" in patch) lsSet("theme", this.ui.theme); this.bump("ui"); }
  select(patch) { Object.assign(this.sel, patch); this.bump("sel"); }
  goto(line) { if (!line) return; this.setUI({ ide: true, left: "code" }); this.gotoLine = line; this.bump("gotoLine"); }

  get presets() { return [...this.builtins, ...this.mine.map((p) => ({ ...p, mine: true }))]; }
  get board() { return normBoard(this.simCompiled?.board || this.compiled?.board, this.bootScript || this.script); }
  get mainDomain() { const c = this.simCompiled || this.compiled; const ds = Object.keys(c?.domains || {}); return ds.includes("sys") ? "sys" : ds[0] || "sys"; }
  get changes() { return changeList(this.pipeline); }

  // ---------- startup ----------
  async start() {
    const last = lsGet("last", null);
    const draft = lsGet("draft", null);
    let id = last && this.presets.some((p) => p.id === last) ? last : null;
    if (!id) id = this.runs("F-19") ? "F-19" : "F-05";
    await this.load(id, { draft: draft && draft.id === id && draft.script !== this.presets.find((p) => p.id === id)?.text ? draft.script : null });
    this.ready = true;
    this.bump("ready");
    this.loop();
  }
  // does an example compile and simulate a few cycles?
  runs(id) {
    const p = this.presets.find((x) => x.id === id);
    if (!p) return false;
    try {
      const c = compile(p.text, { file: p.file });
      if (!c?.ok) return false;
      const s = new Sim(c, { seed: 1, waves: false });
      if (typeof s.runFor !== "function" && typeof s.advance !== "function") return false;
      if (s.runFor) s.runFor(1e6);
      return true;
    } catch { return false; }
  }

  async load(id, { draft = null, boot = true } = {}) {
    const p = this.presets.find((x) => x.id === id);
    if (!p) return this.toast(`No example ${id}`, "bad");
    this.preset = p;
    this.script = draft ?? p.text;
    this.savedScript = p.text;
    this.scen = {};
    this.proofs = null;
    lsSet("last", id);
    this.recompile();
    this.bump("preset", "code", "scen", "proofs");
    if (boot) await this.boot({ quiet: true, replace: true });
  }

  setScript(text) {
    this.script = text;
    lsSet("draft", { id: this.preset?.id, script: text });
    clearTimeout(this._ct);
    this._ct = setTimeout(() => this.recompile(), 250);
    this.bump("code");
  }
  compileText(text = this.script) {
    const t0 = performance.now();
    let c;
    try { c = compile(text, { file: this.preset?.file || "design.js" }); }
    catch (e) { c = { ok: false, diags: [{ level: "error", code: "internal", message: "The compiler threw: " + (e?.message || e) }] }; console.error(e); }
    if (!c || typeof c !== "object") c = { ok: false, diags: [{ level: "error", code: "internal", message: "The compiler returned nothing" }] };
    c.diags = Array.isArray(c.diags) ? c.diags : [];
    c.ms = performance.now() - t0;
    return c;
  }
  recompile() {
    clearTimeout(this._ct);
    this.compiled = this.compileText(this.script);
    this.compileMs = this.compiled.ms;
    this.diags = this.compiled.diags;
    this.verilogCache = null;
    this.bump("diags", "compiled");
  }
  get dirty() { return this.script !== this.bootScript; }

  // ---------- the simulation ----------
  async boot({ script = this.script, quiet = false, replace = false } = {}) {
    if (script === this.script) this.recompile();
    const c = script === this.script ? this.compiled : this.compileText(script);
    if (!c.ok) {
      if (!quiet) this.toast("The definition has errors; the board keeps running the last good design.", "bad");
      // a newly loaded example that does not compile replaces the old board with its errors
      if (!this.sim || replace) { this.stopSim(); this.simCompiled = c; this.bootScript = script; this.bump("boot", "frame", "changes"); }
      return false;
    }
    this.busy = true;
    try {
      this.stopSim();
      const sim = new Sim(c, { seed: 1, waves: true });
      this.sim = sim;
      this.simCompiled = c;
      this.bootScript = script;
      this.simError = null;
      this.events = [];
      this.psPerMs = 0;
      this.cps = 0; this.effSpeed = 0;
      this._meas = null;
      this.osThreads = this.osThreads.filter((t) => t.kind === "note");
      this.attachSim(sim, c);
      this.hosts = safe(() => startHosts(c, sim, { log: (m) => this.event({ kind: "host", text: String(m) }) }));
      this.pipeline = this.makePipeline(c, sim);
      this.sel = { ...this.sel, instance: null, node: null, change: null };
      if (!quiet) this.toast(`Booted ${c.name || "the design"} on ${this.board.profile}: ${(c.instances || []).length} instances`);
      import("../agent/os-agents.js").then((m) => m.designAgentsBooted?.(c)).catch(() => {});
    } catch (e) {
      console.error(e);
      this.simError = e;
      this.sim = null;
      this.simCompiled = c;
      this.bootScript = script;
      if (!quiet) this.toast("Could not start the simulation: " + (e?.message || e), "bad");
      return false;
    } finally { this.busy = false; this.bump("boot", "run", "frame", "changes", "sel", "agent"); }
    return true;
  }
  stopSim() {
    try { this.hosts?.stop?.(); } catch {}
    try { this.pipeline?.stop?.(); } catch {}
    this.hosts = null; this.pipeline = null; this.sim = null; this.simError = null; this.events = [];
    this.cps = 0; this.effSpeed = 0; this._meas = null;
  }
  attachSim(sim, c) {
    if (typeof sim.on !== "function") return;
    const agentEvents = new Set((c?.agents || []).flatMap((a) => (a.on || []).map((h) => h.event)));
    for (const kind of ["assert", "irq", "frame", "drop", "reset", "hang", "escalate", "escalation", "cover", "log", "knob", "reload", "restore", "change"]) {
      try {
        sim.on(kind, (ev) => {
          if (this.sim !== sim) return;
          if (kind === "frame") { this._frames = (this._frames || 0) + 1; return; }
          if (kind === "reload" || kind === "restore") { this.bump("boot", "frame"); return; }
          if (kind === "knob") return;
          if (kind === "change") { this.event({ kind, name: ev?.name, text: `${ev?.status}${ev?.note ? ": " + ev.note : ""}` }); this.bump("changes"); return; }
          this.event({ kind, ...(ev && typeof ev === "object" ? ev : { value: ev }) });
          if (kind === "assert") this.throttledToast(`assert ${ev?.name || ev?.path || ""} failed at ${fmtPs(ev?.time ?? simTime(sim))}`, "bad");
          if (agentEvents.has(kind) || (kind === "escalation" && agentEvents.has("escalate")) || (kind === "escalate" && agentEvents.has("escalation"))) import("../agent/os-agents.js").then((m) => m.simEvent?.(kind, ev, c)).catch(() => {});
        });
      } catch {}
    }
  }
  // record an event; repeats of the same kind and subject within 100 ms of real time are merged (×n)
  event(ev) {
    const now = performance.now();
    const key = ev.kind + "|" + (ev.path || ev.name || ev.stream || ev.instance || "");
    const last = this.events[this.events.length - 1];
    if (last && last.key === key && now - last.real < 100 && ev.kind !== "log") { last.n = (last.n || 1) + 1; last.t = simTime(this.sim); }
    else {
      this.events.push({ t: simTime(this.sim), ...ev, key, real: now });
      if (this.events.length > 600) this.events.splice(0, this.events.length - 500);
    }
    if (!this._evRaf) this._evRaf = requestAnimationFrame(() => { this._evRaf = 0; this.bump("events"); });
  }
  throttledToast(text, tone) { const now = performance.now(); if (now - (this._tt || 0) < 1500) return; this._tt = now; this.toast(text, tone); }

  // what the change pipeline calls to build a candidate: an edited Design builder, or script text
  recompileFor(c) {
    const file = this.preset?.file || "design.js", script = c === this.compiled ? this.script : this.bootScript;
    return (x) => (typeof x === "string" ? this.compileText(x) : typeof COMPILE.compileDesign === "function" ? COMPILE.compileDesign(x, { script, file }) : this.compileText(script));
  }
  makePipeline(c, sim) {
    try {
      const file = this.preset?.file || "design.js";
      const p = new ChangePipeline({
        compiled: c, sim, sample: this.sample, record: c.record || null,
        // patch/replace hand us an edited Design builder; plain text recompiles the script
        recompile: this.recompileFor(c),
        onChange: (rec) => {
          if (p.current && p.current !== this.simCompiled && this.pipeline === p) this.simCompiled = p.current;
          if (rec?.status === "awaiting-approval") this.toast(`“${rec.name}” waits for your approval (Changes)`, "bad");
          if (rec?.status === "rolled-back") this.toast(`“${rec.name}” rolled back: ${rec.reason}`, "bad");
          if (rec?.status === "committed") this.toast(`“${rec.name}” committed`);
          this.bump("changes", "boot");
        },
      });
      return p;
    } catch (e) { console.warn("change pipeline", e); return null; }
  }

  // the editor's text as a change to the running design (ARCH §8 `apply`)
  async apply() {
    if (!this.sim) return this.boot();
    this.recompile();
    if (!this.compiled.ok) { this.toast("Fix the errors first; nothing was applied.", "bad"); return false; }
    if (this.script === this.bootScript) { this.toast("The running design already matches the editor."); return true; }
    const p = this.pipeline, cand = this.compiled, sim = this.sim;
    const fn = p && (p.applyScript || p.submitScript || p.applySource);
    if (fn) {
      try { const r = await fn.call(p, this.script, { by: "you", compiled: cand }); this.bootScript = this.script; this.bump("changes", "boot"); return r ?? true; }
      catch (e) { this.toast("The change pipeline refused it: " + e.message, "bad"); return false; }
    }
    // the pipeline works on module ops; an editor edit becomes a whole-design change with a 1 s canary
    // that rolls back if an assert trips (it reuses the pipeline's canary and rollback)
    if (p && typeof p._canary === "function" && typeof p._to === "function") {
      if (p.active) { this.toast(`“${p.active.name}” is still in flight; apply again when it settles`, "bad"); return false; }
      const errs = cand.diags.filter((d) => d.level === "warn" || d.level === "warning").length;
      const rec = {
        id: "e" + (++this._applyN || (this._applyN = 1)), name: "apply the editor", spec: { name: "apply the editor", ops: [], verify: [{ op: "lint", args: [] }], deploy: [{ op: "canary", args: ["1s"] }], rollbackOn: ["assert"] },
        kind: "edit", knobOnly: false, status: "proposed", history: [{ status: "proposed", time: sim.time, note: "from the editor" }], reason: "", created: sim.time,
        fromAgent: false, agent: "you", target: null, checks: [], before: p.current, after: cand,
      };
      p.changes.push(rec);
      try {
        p._to(rec, "checked", `${Object.keys(cand.domains || {}).length} domain(s), ${(cand.instances || []).length} instances`);
        p._to(rec, "verified", `lint: ${errs} warning${errs === 1 ? "" : "s"}`);
        p._to(rec, "built", "full rebuild (estimate)");
        p.active = rec;
        p._canary(rec, cand);
        this.simCompiled = cand;
        this.bootScript = this.script;
        this.toast("Applied as a change: a 1 s canary, rolled back if an assert trips");
      } catch (e) { p.active = null; p._to?.(rec, "rejected", e.message); this.toast("Apply failed: " + e.message, "bad"); }
      this.bump("changes", "boot", "frame");
      return true;
    }
    // no pipeline: swap the design in place, carrying registers and memories by path
    const t = simTime(sim);
    if (typeof sim.reload === "function") {
      try {
        sim.reload(cand);
        this.simCompiled = cand;
        this.bootScript = this.script;
        this.toast(`Swapped the editor's design in at ${fmtPs(t)}; registers carried where paths and widths match`);
        this.bump("boot", "frame", "changes");
        return true;
      } catch (e) { this.toast("Could not swap the design in: " + e.message, "bad"); return false; }
    }
    const ok = await this.boot({ quiet: true });
    this.toast(ok ? `Rebooted with the editor's design` : "Apply failed", ok ? "" : "bad");
    return ok;
  }
  // submit a change builder (from the agent or a design agent) to the pipeline
  async submitChange(change, opts = {}) {
    const p = this.pipeline;
    if (!p || typeof p.submit !== "function") throw new Error("the change pipeline is not available yet");
    const r = await p.submit(change, { note: `by ${opts.by || "you"}`, ...(opts.fromAgent ? { fromAgent: true, agent: opts.agent || opts.by } : {}), ...opts });
    this.bump("changes");
    return r;
  }
  approveChange(id, ok = true) {
    const p = this.pipeline;
    try {
      if (ok && p?.approve) p.approve(id, true);
      else if (!ok && p?.reject) p.reject(id);
      else if (p?.approve) p.approve(id, ok);
      else throw new Error("no approve() on the pipeline");
      this.toast(`${ok ? "Approved" : "Rejected"} ${id}`);
    } catch (e) { this.toast(e.message, "bad"); }
    this.bump("changes");
  }

  // the real-time driver: advance the simulation on every animation frame
  loop() {
    let last = performance.now();
    const frame = (now) => {
      const dt = Math.min(100, now - last);
      last = now;
      const sim = this.sim;
      if (sim && this.running && !this.busy && !this.simError && !this.watching) {
        try { this.advance(sim, dt); this.pipeline?.poll?.(); }
        catch (e) { console.error(e); this.simError = e; this.running = false; this.toast("The simulation stopped: " + (e?.message || e), "bad"); this.bump("run"); }
      }
      if (now - this.frameT > 90) { this.frameT = now; this.measure(now); this.bump("frame"); }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
  advance(sim, dtMs) {
    if (typeof sim.advance === "function") { this.lastAdvance = sim.advance(dtMs, isFinite(this.speed) ? this.speed : 1e9); return; }
    if (typeof sim.runFor !== "function") return;
    const want = dtMs * 1e9 * (isFinite(this.speed) ? this.speed : 1e9);
    const budget = 12;
    const cap = this.psPerMs ? this.psPerMs * budget : 2e5;
    const ps = Math.max(1000, Math.min(want, cap));
    const t0 = performance.now(), before = simTime(sim);
    sim.runFor(ps);
    const ms = performance.now() - t0, got = simTime(sim) - before;
    if (ms > 1) this.psPerMs = this.psPerMs ? 0.7 * this.psPerMs + 0.3 * (got / ms) : got / ms;
    else this.psPerMs = Math.min(1e15, (this.psPerMs || 2e4) * 1.6);
  }
  measure(now) {
    const sim = this.sim;
    if (!sim) return;
    const t = simTime(sim), cyc = simCycle(sim, this.mainDomain);
    const m = this._meas;
    if (!m) { this._meas = { now, t, cyc }; return; }
    const dt = (now - m.now) / 1000;
    if (dt < 0.4) return;
    // effective rates: simulated seconds and main-domain cycles per real second, as the user sees them
    const eff = (t - m.t) / 1e12 / dt;
    const cps = (cyc - m.cyc) / dt;
    this.effSpeed = this.running ? eff : 0;
    this.cps = this.running ? cps : 0;
    this.throughput = safe(() => sim.stats?.cyclesPerSecond, 0);
    this._meas = { now, t, cyc };
    this.bump("stats");
  }
  play() { if (this.simError) { this.toast("The simulation stopped with an error; Reset to start again.", "bad"); return; } this.running = true; this._meas = null; this.bump("run"); }
  pause() { this.running = false; this.bump("run"); }
  step(ps = 1e9) {
    const sim = this.sim;
    if (!sim) return;
    this.running = false;
    try { if (sim.runFor) sim.runFor(ps); else if (sim.step) sim.step(1); this.pipeline?.poll?.(); } catch (e) { this.toast(e.message, "bad"); }
    this.bump("run", "frame");
  }
  stepCycles(n = 1) {
    const sim = this.sim;
    if (!sim?.step) return this.step(1e6);
    this.running = false;
    try { sim.step(n, this.mainDomain); } catch (e) { this.toast(e.message, "bad"); }
    this.bump("run", "frame");
  }
  setSpeed(s) { this.speed = s; lsSet("speed", isFinite(s) ? s : 1e9); this._meas = null; this.bump("run"); }
  reset() { return this.boot({ script: this.bootScript || this.script, quiet: true }).then((ok) => { if (ok) this.toast("Reset: a fresh simulation of the running design"); }); }

  // ---------- scenarios ----------
  scenarioList(c = this.compiled) { return (c?.scenarios || []).map((s) => ({ name: s.name, kind: s.kind, steps: s.steps, line: s.line, opts: s.opts })); }
  async runScenario(name, { live = false } = {}) {
    const c = this.compiled?.ok ? this.compiled : this.simCompiled;
    if (!c) return { status: "skip", message: "nothing compiled" };
    this.scen[name] = { status: "running", steps: [], live };
    this.bump("scen");
    let r;
    try {
      r = await runScenarioCore(c, name, {
        level: "dag", recompile: this.recompileFor(c),
        ...(this.sample ? { sample: this.sample } : {}),
        onStep: (s) => { this.scen[name].steps.push(s); this.bump("scen"); if (live) this.bump("frame"); },
      });
    } catch (e) { r = { status: "fail", message: "The scenario runner threw: " + (e?.message || e), steps: this.scen[name].steps }; }
    r = r || { status: "skip", message: "no result" };
    this.scen[name] = { status: r.status || (r.ok ? "pass" : "fail"), result: r, steps: r.steps?.length ? r.steps : this.scen[name].steps, live };
    this.bump("scen");
    return r;
  }
  async runAll() { for (const s of this.scenarioList()) await this.runScenario(s.name); }
  // run a scenario on a simulation the board shows: the runner hands us its fresh Sim (opts.onSim)
  async watchScenario(name) {
    const c = this.compiled?.ok ? this.compiled : this.simCompiled;
    if (!c?.ok) { this.toast("The design has errors; fix them to watch a scenario.", "bad"); return; }
    this.setUI({ right: "board" });
    this.watching = name;
    this.running = false;
    this.scen[name] = { status: "running", steps: [], live: true };
    this.bump("run", "scen");
    let got = false, r;
    try {
      r = await runScenarioCore(c, name, {
        level: "dag", waves: true, recompile: this.recompileFor(c),
        ...(this.sample ? { sample: this.sample } : {}),
        onSim: (s) => {
          got = true;
          this.stopSim();
          this.sim = s; this.simCompiled = c; this.bootScript = this.script; this.simError = null; this.events = []; this._meas = null;
          this.attachSim(s, c);
          this.pipeline = s.pipeline || null;
          this.bump("boot", "frame", "changes");
        },
        onStep: (st) => { this.scen[name].steps.push(st); this.bump("scen", "frame"); },
      });
    } catch (e) { r = { status: "fail", message: "The scenario runner threw: " + (e?.message || e), steps: this.scen[name].steps }; }
    r = r || { status: "skip", message: "no result" };
    this.scen[name] = { status: r.status || (r.ok ? "pass" : "fail"), result: r, steps: r.steps?.length ? r.steps : this.scen[name].steps, live: true };
    this.watching = null;
    if (got) this.toast(`“${name}” ${this.scen[name].status === "pass" ? "passed" : this.scen[name].status}: the board shows where it ended; Reset to start fresh`, this.scen[name].status === "fail" ? "bad" : "");
    this.bump("run", "frame", "scen", "boot");
    return r;
  }

  // ---------- proofs ----------
  async prove() {
    const c = this.compiled?.ok ? this.compiled : this.simCompiled;
    if (!c) return;
    this.proofs = { status: "running", t0: performance.now() };
    this.bump("proofs");
    await new Promise((r) => setTimeout(r, 30));
    try {
      const r = await proveCore(c, c.prove || {});
      this.proofs = { status: "done", result: r || { results: [] }, ms: performance.now() - this.proofs.t0 };
    } catch (e) { this.proofs = { status: "error", message: e?.message || String(e) }; }
    this.bump("proofs");
    return this.proofs;
  }

  // ---------- Verilog ----------
  verilog() {
    const c = this.compiled?.ok ? this.compiled : this.simCompiled;
    if (!c?.ok) return [];
    if (this.verilogCache?.c === c) return this.verilogCache.files;
    let files = [];
    try { files = emitVerilog(c) || []; } catch (e) { files = [{ path: "error.txt", text: "The Verilog emitter threw: " + e.message }]; }
    this.verilogCache = { c, files };
    return files;
  }

  // ---------- examples you keep ----------
  savePreset({ asNew = false } = {}) {
    const meta = parseHeader(this.script);
    let id = this.preset?.mine && !asNew ? this.preset.id : null;
    if (!id) id = this.nextId();
    let text = this.script;
    if (!/^\s*\/\*\*/.test(text)) text = `/** ${id} ${meta.title === "Untitled" ? "My design" : meta.title}\n *  group  Mine\n *  about  \n */\n` + text;
    else text = text.replace(/\/\*\*\s*([A-Z]-\d+)?/, `/** ${id}`).replace(/(\*\s+group\s{2,})[^\n]*/, "$1Mine");
    const entry = { id, ...parseHeader(text), group: "Mine", text, file: id + ".js" };
    this.mine = this.mine.filter((p) => p.id !== id).concat(entry);
    lsSet("mine", this.mine);
    this.preset = { ...entry, mine: true };
    this.script = text; this.savedScript = text;
    lsSet("last", id);
    lsSet("draft", null);
    this.bump("preset", "code");
    this.toast(`Saved as ${id} in My designs (this browser)`);
    return id;
  }
  nextId() { const n = this.mine.reduce((m, p) => Math.max(m, +String(p.id).replace(/\D/g, "") || 0), 0) + 1; return "U-" + String(n).padStart(2, "0"); }
  deletePreset(id) { this.mine = this.mine.filter((p) => p.id !== id); lsSet("mine", this.mine); this.bump("preset"); }
  newPresetFromText(text) {
    const id = this.nextId();
    text = /^\s*\/\*\*/.test(text) ? text.replace(/\/\*\*\s*([A-Z]-\d+)?/, `/** ${id}`) : `/** ${id} New design\n *  group  Mine\n */\n` + text;
    const entry = { id, ...parseHeader(text), group: "Mine", text, file: id + ".js" };
    this.mine.push(entry);
    lsSet("mine", this.mine);
    this.bump("preset");
    return id;
  }

  // ---------- summaries for the header, tiles and agent ----------
  summary() {
    const c = this.simCompiled || this.compiled;
    const ch = this.changes;
    return {
      modules: (c?.instances || []).filter((i) => i.kind !== "agent" && i.kind !== "host").length,
      cps: this.cps, eff: this.effSpeed, t: simTime(this.sim),
      failing: Object.values(this.scen).filter((s) => s.status === "fail").length,
      waiting: ch.filter(isWaiting).length,
      failed: ch.filter(isFailed).length,
      asks: this.osThreads.filter((t) => t.kind === "llm" && t.status === "ask").length,
      errors: this.diags.filter((d) => d.level === "error").length,
    };
  }
}

export const lab = new Lab();
if (typeof window !== "undefined") window.__weftLab = lab;
export { REFERENCE, GUIDELINES, clip, summarize };
