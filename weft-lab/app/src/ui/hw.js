// The hardware backend of `weft serve` (guide §6.9, API §6.12): toolchain and board status, builds with
// their live logs, loads. The Lab runs anywhere; where /api/hw/status does not answer (claude.ai, a plain
// file host) `hw.available` stays false and the Hardware tab is hidden.
import { lab } from "./lab.js";
import { compile } from "../core/compile.js";
import { buildBundle, HwError } from "../core/hardware.js";
import { vectors } from "../core/vectors.js";

export const HW_BOARD = "gatemate-a1-evb";
const LOG_MAX = 3000;
const ACTIVE = new Set(["queued", "synth", "pnr", "pack", "validate", "load"]);

export class HwApiError extends Error {
  constructor(code, message, status) { super(message); this.name = "HwApiError"; this.code = code; this.status = status; }
}

class Hardware {
  constructor() {
    this.available = false;
    this.status = null;
    this.builds = [];
    this.current = null;   // the build the tab shows
    this.job = null;       // its view, kept current by the event stream
    this.logs = [];        // { stage, line }
    this.refusal = null;   // the last bundle refusal: { code, message, details }
    this.seed = 1;
    this.es = null;
    this.raf = 0;
  }

  async api(method, path, body) {
    const r = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const json = (r.headers.get("content-type") || "").includes("json");
    const data = json ? await r.json().catch(() => null) : await r.text();
    if (!r.ok) throw new HwApiError(data?.error?.code || "http_" + r.status, data?.error?.message || `HTTP ${r.status}`, r.status);
    return data;
  }

  // ---------- status and the build list ----------
  async probe() {
    try { this.status = await this.api("GET", "/api/hw/status?detect=0"); this.available = true; }
    catch { this.available = false; }
    this.bump();
    if (this.available) { this.refreshBuilds().catch(() => {}); this.refreshStatus().catch(() => {}); }
    return this.available;
  }
  async refreshStatus() { this.status = await this.api("GET", "/api/hw/status"); this.bump(); return this.status; }
  async refreshBuilds() { this.builds = await this.api("GET", "/api/hw/builds"); this.bump(); return this.builds; }

  // ---------- builds ----------
  // compile for the board and make the bundle; throws HwError with a named reason when it cannot go to hardware
  bundle(script = lab.script) {
    const file = lab.preset?.file || "design.js";
    return buildBundle(compile(script, { board: HW_BOARD, file }), { source: { file } });
  }
  async build({ load = false, force = false, seed = this.seed, script } = {}) {
    let bundle;
    try { bundle = this.bundle(script); }
    catch (e) {
      if (e instanceof HwError) { this.refusal = { code: e.code, message: e.message, details: e.details }; this.bump(); }
      throw e;
    }
    this.refusal = null;
    const { id } = await this.api("POST", "/api/hw/builds", { bundle, seed, load, force });
    this.select(id);
    this.refreshBuilds().catch(() => {});
    return { id };
  }
  // build the editor's design and run the validation ladder on it: L0 (the build), L1 (RTL) and L2 (netlist)
  // co-simulate against vectors recorded here, on a variant whose main clock is cosimHz
  async validate({ levels = ["build", "rtl", "net"], scenario = null, cosimHz, load = false, force = false, seed = this.seed, script = lab.script } = {}) {
    let bundle, vec;
    try {
      bundle = this.bundle(script);
      vec = await vectors(script, { file: lab.preset?.file || "design.js", board: HW_BOARD, scenario, ...(cosimHz ? { cosimHz } : {}) });
    } catch (e) {
      if (e instanceof HwError) { this.refusal = { code: e.code, message: e.message, details: e.details }; this.bump(); }
      throw e;
    }
    this.refusal = null;
    const { id } = await this.api("POST", "/api/hw/builds", { bundle, seed, load, force, validate: levels, vectors: vec });
    this.select(id);
    this.refreshBuilds().catch(() => {});
    return { id, scenarios: vec.scenarios.map((s) => s.skip ? `${s.name}: skipped (${s.skip})` : `${s.name}: ${s.cycles} cycles, ${s.changes.length} changes`), ...(vec.skip ? { skip: vec.skip } : {}) };
  }
  async load(id = this.current, { force = false } = {}) {
    if (!id) throw new Error("no build to load: build first");
    await this.api("POST", `/api/hw/builds/${encodeURIComponent(id)}/load`, { force });
    if (id !== this.current) this.select(id);
    return { id };
  }
  get(id = this.current, { wait } = {}) {
    if (!id) throw new Error("no build yet");
    return this.api("GET", `/api/hw/builds/${encodeURIComponent(id)}${wait ? "?wait=" + encodeURIComponent(wait) : ""}`);
  }
  fileURL(name, id = this.current) { return `/api/hw/builds/${encodeURIComponent(id)}/files/${name.split("/").map(encodeURIComponent).join("/")}`; }
  get busy() { return !!this.job && ACTIVE.has(this.job.state); }

  // ---------- the event stream of the shown build ----------
  select(id) {
    if (this.es) { this.es.close(); this.es = null; }
    this.current = id; this.job = null; this.logs = [];
    this.bump();
    if (!id) return;
    const es = new EventSource(`/api/hw/builds/${encodeURIComponent(id)}/events`);
    es.onmessage = (m) => { if (this.es === es) { try { this.onEvent(JSON.parse(m.data)); } catch (e) { console.warn("hw event", e); } } };
    this.es = es;
  }
  onEvent(ev) {
    const j = this.job;
    switch (ev.type) {
      case "snapshot": this.job = ev.job; this.logs = []; break;
      case "state": if (j) { j.state = ev.state; if (ev.state === "validate") j.validation = []; } break;
      case "stage": {
        if (!j) break;
        const st = { name: ev.name, state: ev.state, ms: ev.ms, summary: ev.summary };
        const i = (j.stages ||= []).findIndex((s) => s.name === ev.name);
        if (i >= 0) j.stages[i] = { ...j.stages[i], ...st }; else j.stages.push(st);
        break;
      }
      case "log":
        this.logs.push({ stage: ev.stage, line: ev.line ?? "" });   // the server omits empty lines' text
        if (this.logs.length > LOG_MAX) this.logs.splice(0, this.logs.length - LOG_MAX);
        break;
      case "report": if (j) { j.report = ev.report; j.ok = ev.report.ok; j.timingOk = ev.report.timingOk; } break;
      case "validation": if (j) (j.validation ||= []).push(ev.result); break;
      case "done": {
        const id = this.current;
        this.get(id).then((v) => { if (this.current === id) { this.job = v; this.bump(); } }).catch(() => {});
        this.refreshBuilds().catch(() => {});
        if (j) lab.toast(doneText(j, ev), ev.ok && !ev.error ? "" : "bad");
        break;
      }
    }
    // log lines arrive in bursts; repaint at most once per frame
    if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.bump(); });
  }
  bump() { lab.bump("hw"); }
}

function doneText(j, ev) {
  if (ev.error) return `${j.design}: ${ev.error}`;
  if (!ev.ok) return `${j.design}: the build failed`;
  const loaded = (j.stages || []).find((s) => s.name === "load");
  return loaded?.state === "done" ? `${j.design} is on the board` : `${j.design} built${j.timingOk === false ? ", but it failed timing" : ""}`;
}

// what the agent's eval scope sees as `hw` (lab-agent.js)
export function agentHw({ readonly = false } = {}) {
  const need = () => { if (!hw.available) throw new Error("no hardware backend: the Lab is not running under weft serve"); };
  const view = (v) => v && ({
    id: v.id, design: v.design, state: v.state, ok: v.ok, timingOk: v.timingOk,
    stages: (v.stages || []).map((s) => `${s.name}: ${s.state}${s.ms ? ` ${(s.ms / 1000).toFixed(1)} s` : ""}${s.summary ? " — " + s.summary : ""}`),
    ...(v.report ? { utilization: pick(v.report.utilization, ["CPE_LT", "CPE_FF", "RAM_HALF", "IOSEL", "PLL"]), clocks: (v.report.clocks || []).map((c) => `${c.name}: ${c.fmaxMHz} MHz (${c.pass ? "PASS" : "FAIL"} at ${c.targetMHz} MHz)`), plls: v.report.plls } : {}),
    ...(v.estimate ? { estimate: { luts: v.estimate.resources?.luts, ffs: v.estimate.resources?.ffs, fmaxMHz: v.estimate.fmaxMHz } } : {}),
    ...(v.validation?.length ? { validation: v.validation.map((r) => `${r.level}${r.scenario ? ` "${r.scenario}"` : ""}: ${r.status}${r.message ? " — " + r.message : ""}`) } : {}),
    ...(v.loaded ? { loaded: v.loaded } : {}), ...(v.error ? { error: v.error } : {}),
  });
  const RO = (what) => () => { throw Object.assign(new Error(`hw.${what} changes the board; the agent is in Read-only mode`), { name: "ReadOnlyError" }); };
  const api = {
    get available() { return hw.available; },
    async status() { need(); return hw.refreshStatus(); },
    async builds() { need(); return (await hw.refreshBuilds()).slice(0, 20).map((b) => `${b.id} ${b.state}${b.ok ? (b.timingOk ? "" : " (timing failed)") : " (no bitstream)"}${b.loaded?.ok ? " · loaded" : ""}`); },
    get current() { return hw.current; },
    bundle(script) {
      try { const b = hw.bundle(script); return { ok: true, design: b.design, ports: b.ports.map((p) => p.name), clocks: b.clocks.map((c) => `${c.domain} ${c.hz} Hz (${c.kind})`), scenarios: b.scenarios.map((s) => `${s.name}${s.portable ? "" : " (simulation only)"}`) }; }
      catch (e) { if (e instanceof HwError) return { ok: false, code: e.code, message: e.message }; throw e; }
    },
    async build(opts = {}) {
      need();
      if (readonly && opts.load) return RO("build({ load: true })")();
      try { return await hw.build(opts); }
      catch (e) { if (e instanceof HwError) return { refused: e.code, message: e.message }; throw e; }
    },
    async job(id = hw.current, { wait } = {}) { need(); return view(await hw.get(id, { wait })); },
    load: readonly ? RO("load") : async (id = hw.current, opts = {}) => { need(); return hw.load(id, opts); },
    async validate(opts = {}) {
      need();
      if (readonly && opts.load) return RO("validate({ load: true })")();
      try { return await hw.validate(opts); }
      catch (e) { if (e instanceof HwError) return { refused: e.code, message: e.message }; throw e; }
    },
    async log(id = hw.current, stage = "pnr", lines = 40) {
      need();
      const r = await fetch(hw.fileURL(stage + ".log", id));
      if (!r.ok) throw new Error(`no ${stage}.log for ${id}`);
      return (await r.text()).trimEnd().split("\n").slice(-lines).join("\n");
    },
  };
  return api;
}

const pick = (o, keys) => (o ? Object.fromEntries(keys.filter((k) => o[k]).map((k) => [k, `${o[k][0]}/${o[k][1]}`])) : undefined);

export const hw = new Hardware();
lab.hw = hw;
