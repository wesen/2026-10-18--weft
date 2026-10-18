// Adapters between the Lab UI and the engine in core/. Every call is defensive: the UI must keep
// working (and say what is missing) when a piece of the engine is absent or throws.
import * as BOARDMOD from "../core/boards.js";

const num = (x) => (typeof x === "bigint" ? Number(x) : Number(x) || 0);
export const safe = (f, d = null) => { try { const v = f(); return v === undefined ? d : v; } catch { return d; } };

// ---------------------------------------------------------------- boards
// Fallback profiles (book 1, Chapter 1.5) used to draw the board before the compiler has produced one.
const range = (p, a, b) => Array.from({ length: b - a + 1 }, (_, i) => `${p}:${a + i}`);
const FALLBACK = {
  pico: { profile: "pico", part: "ice40up5k-sg48", family: "ice40", mainHz: 12e6, ids: [...range("led", 0, 2), "btn:user", "uart.tx", "uart.rx", "clk"] },
  dev: { profile: "dev", part: "xc7a35t-1csg324", family: "xc7", mainHz: 100e6, ids: [...range("led", 0, 7), ...range("btn", 0, 3), ...range("sw", 0, 7), "uart.tx", "uart.rx", "hdmi", "audio", "clk"] },
  studio: { profile: "studio", part: "xc7a35t-1csg324", family: "xc7", mainHz: 100e6, ids: [...range("led", 0, 7), "btn:up", "btn:down", "btn:a", "btn:b", "uart.tx", "uart.rx", "hdmi", "audio", "clk"] },
};
const KIND = (id) => {
  const p = id.split(/[:.]/)[0];
  return { led: "led", btn: "button", sw: "switch", uart: "uart", hdmi: "hdmi", audio: "audio", clk: "clock" }[p] || p;
};
export function normBoard(b, script = "") {
  let src = "compiled";
  if (!b) {
    // nothing compiled yet: draw the profile the script names
    const prof = (script.match(/\.board\(\s*["'](\w+)["']/) || [])[1] || (script.match(/board\(\s*["'](\w+)["']\s*\)/) || [])[1] || (/\.part\(/.test(script) ? null : "dev");
    const part = (script.match(/\.part\(\s*["']([\w-]+)["']/) || [])[1] || null;
    const real = prof ? safe(() => BOARDMOD.resolveBoard?.(prof)) || safe(() => BOARDMOD.BOARDS?.[prof]) : safe(() => BOARDMOD.resolveBoard?.({ profile: null, part }));
    if (real) { b = real; src = "profile"; }
    else {
      const f = FALLBACK[prof] || FALLBACK.dev;
      b = { ...f, resources: Object.fromEntries(f.ids.map((id) => [id, { kind: KIND(id) }])) };
      src = "fallback";
    }
  }
  const res = b.resources || b.pins || {};
  const list = Object.entries(res).map(([id, r]) => ({ id, kind: r?.kind ? String(r.kind) : KIND(id), dir: r?.dir, pin: r?.pin }));
  const norm = (k) => (k === "btn" ? "button" : k === "sw" ? "switch" : k);
  for (const r of list) r.kind = norm(r.kind);
  const pick = (k) => list.filter((r) => r.kind === k).sort((a, b) => natural(a.id, b.id));
  const uart = pick("uart");
  return {
    profile: b.profile || null, part: b.part || b.partData?.name || "?", family: b.family || b.partData?.family || "?", title: b.title || "",
    mainHz: num(b.mainHz) || 0, partData: b.partData || null, src,
    leds: pick("led"), buttons: pick("button"), switches: pick("switch"),
    uarts: uart.length ? [...new Set(uart.map((r) => r.id.split(".")[0]))] : [],
    hdmi: list.some((r) => r.kind === "hdmi" || r.kind === "tmds"), audio: list.some((r) => r.kind === "audio" || r.kind === "dac"),
    all: list,
  };
}
export function natural(a, b) { return String(a).localeCompare(String(b), undefined, { numeric: true }); }

// ---------------------------------------------------------------- the simulator
export const simTime = (sim) => (sim ? num(safe(() => (typeof sim.time === "function" ? sim.time() : sim.time), 0)) : 0);
export const simCycle = (sim, d) => (sim ? num(safe(() => sim.cycle?.(d), 0)) : 0);
export function boardApi(sim) { return sim ? safe(() => sim.board) : null; }

export function pinValue(sim, id) {
  const b = boardApi(sim);
  if (!b) return null;
  const pins = safe(() => b.pins);
  if (pins) { const v = pins instanceof Map ? pins.get(id) : pins[id]; if (v != null) return num(v); }
  return null;
}
export function ledLevels(sim, leds) {
  const b = boardApi(sim);
  const out = {};
  if (!b) return out;
  const arr = safe(() => b.leds?.());
  for (const [i, L] of leds.entries()) {
    let v = pinValue(sim, L.id);
    if (v == null && arr) { const n = +String(L.id).split(":")[1]; v = Array.isArray(arr) ? num(arr[Number.isNaN(n) ? i : n]) : num(arr[L.id]); }
    out[L.id] = Math.max(0, Math.min(1, v || 0));
  }
  return out;
}
export function press(sim, id, down) {
  const b = boardApi(sim);
  if (!b) return false;
  try {
    if (down) { if (b.press) b.press(id, { hold: true }); else b.set?.(id, 1); }
    else if (b.release) b.release(id); else b.set?.(id, 0);
    return true;
  } catch (e) { console.warn("press", id, e); return false; }
}
export function tap(sim, id, ms = 50) {
  const b = boardApi(sim);
  try { if (b?.press) { b.press(id, { for: ms + "ms" }); return true; } } catch (e) { console.warn(e); }
  return false;
}
export function toggleSwitch(sim, id) {
  const b = boardApi(sim);
  if (!b) return;
  try { if (b.toggle) b.toggle(id); else b.set?.(id, pinValue(sim, id) ? 0 : 1); } catch (e) { console.warn("toggle", id, e); }
}
export function uart(sim, id) {
  const b = boardApi(sim);
  const u = safe(() => b?.uart?.(id));
  return u || null;
}
export function uartText(sim, id) { return String(safe(() => uart(sim, id)?.text, "") || ""); }
export function lastFrame(sim) {
  const b = boardApi(sim);
  return safe(() => b?.lastFrame?.()) || safe(() => { const f = b?.frames; return f && f.length ? f[f.length - 1] : null; });
}
export function audioSamples(sim) {
  const a = safe(() => boardApi(sim)?.audio);
  if (!a) return null;
  if (Array.isArray(a) || ArrayBuffer.isView(a)) return a;
  if (Array.isArray(a.samples) || ArrayBuffer.isView(a.samples)) return a.samples;
  if (typeof a.recent === "function") return safe(() => a.recent());
  return null;
}
export const instState = (sim, path) => safe(() => sim?.state?.(path));
export const streamStats = (sim, name) => safe(() => sim?.stream?.(name));
export function peek(sim, path) { if (!sim?.peek) throw new Error("this simulator cannot peek yet"); return sim.peek(path); }
export function poke(sim, path, v) { if (!sim?.poke) throw new Error("this simulator cannot poke yet"); sim.poke(path, v); return v; }
export function release(sim, path) { if (!sim?.release) throw new Error("this simulator cannot release yet"); sim.release(path); return "released"; }

// waves: accept the shapes a change-compressed recorder may expose. waveIndex lists the recorded
// signals cheaply; waveData normalizes one signal's changes to [[t, v], …] sorted by time.
function wavesOf(sim) { return safe(() => sim?.waves); }
export function waveIndex(sim, compiled) {
  const W = wavesOf(sim);
  if (!W) return [];
  const meta = (p) => {
    for (const d of Object.values(compiled?.domains || {})) {
      const g = d.graph, id = safe(() => g.names?.get(p));
      if (id != null) { const n = g.node(id); if (n) return { w: n.type?.w || 1, domain: g.domain, kind: n.op }; }
    }
    return { w: 1 };
  };
  let list = [];
  try {
    if (typeof W.index === "function") list = W.index();
    else if (typeof W.signals === "function") list = W.signals();
    else if (Array.isArray(W.signals)) list = W.signals;
    else if (W.signals instanceof Map) list = [...W.signals.entries()].map(([path, x]) => ({ path, ...(x && typeof x === "object" && !Array.isArray(x) ? x : {}) }));
    else if (W instanceof Map) list = [...W.keys()];
    else if (typeof W === "object") list = Object.keys(W).filter((k) => Array.isArray(W[k]) || W[k]?.changes);
  } catch (e) { console.warn("waves", e); }
  return list.map((s) => {
    const path = typeof s === "string" ? s : s.path || s.name;
    const m = meta(path);
    return { path, w: (typeof s === "object" && (s.w || s.width)) || m.w, domain: (typeof s === "object" && s.domain) || m.domain, kind: (typeof s === "object" && s.kind) || m.kind };
  }).filter((s) => s.path);
}
export function waveData(sim, path) {
  // columnar { t: [ps…], v: [value…] }, sorted by time; the simulator's own arrays when it has them (no copy)
  const W = wavesOf(sim);
  if (!W) return EMPTY;
  const direct = safe(() => W.signal?.(path));
  if (direct && Array.isArray(direct.t) && direct.v) return direct;
  let d = null;
  try {
    d = W.series?.(path) ?? W.get?.(path) ?? W.changes?.(path) ?? W.data?.(path)
      ?? (W.signals instanceof Map ? W.signals.get(path) : null) ?? (W instanceof Map ? W.get(path) : null) ?? (Array.isArray(W.signals) ? W.signals.find((s) => s.path === path) : null) ?? W[path];
  } catch { d = null; }
  if (!d) return EMPTY;
  if (!Array.isArray(d)) {
    if (Array.isArray(d.t) && d.v) return d;
    if ((Array.isArray(d.times) || ArrayBuffer.isView(d.times)) && d.values) return { t: Array.from(d.times, num), v: d.values };
    d = d.changes || d.data || d.series || [];
  }
  const t = [], v = [];
  for (const x of d) { if (Array.isArray(x)) { t.push(num(x[0])); v.push(x[1]); } else { t.push(num(x.t ?? x.time)); v.push(x.v ?? x.value); } }
  return { t, v };
}
const EMPTY = { t: [], v: [] };
// index of the last change at or before time t (-1 when none)
export function indexAt(d, t) {
  let lo = 0, hi = d.t.length - 1, best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (d.t[m] <= t) { best = m; lo = m + 1; } else hi = m - 1; }
  return best;
}
export function valueAt(d, t) { const i = indexAt(d, t); return i < 0 ? null : d.v[i]; }


// the change pipeline's records, normalized: C's records are { id, name, status, history[{status,time,note}],
// spec{ops, verify, deploy, rollbackOn}, reason, created, fromAgent, agent, target, region }
export function changeList(pipe) {
  const l = safe(() => (typeof pipe?.list === "function" ? pipe.list() : pipe?.changes), []) || [];
  return (Array.isArray(l) ? l : [...(l.values?.() || [])]).map(normChange);
}
const FAILS = new Set(["rolled-back", "rejected", "failed", "rolling-back"]);
export function normChange(c) {
  if (!c || c.__norm) return c;
  const stage = c.stage || c.status || "proposed";
  let stages = Array.isArray(c.stages) ? c.stages : null;
  if (!stages) {
    const h = (c.history || []).filter((x) => x.status !== "queued" || true);
    stages = h.map((x, i) => {
      const last = i === h.length - 1;
      let st = "done";
      if (FAILS.has(x.status)) st = "fail";
      else if (x.status === "awaiting-approval") st = last ? "wait" : "done";
      else if (last && !["committed"].includes(x.status) && (x.status === "canary" || x.status === "queued")) st = "run";
      return { name: x.status, status: st, t: x.time, note: x.note };
    });
  }
  return {
    __norm: true, raw: c, id: c.id, title: c.title ?? c.name ?? c.id, by: c.by ?? c.agent ?? (c.fromAgent ? "agent" : "you"),
    t: c.t ?? c.created ?? null, stage, stages, waiting: !!c.waiting || stage === "awaiting-approval",
    ops: c.ops || c.spec?.ops || c.change?.ops || [], verifyPlan: c.spec?.verify || [], deploy: c.spec?.deploy || [], rollbackOn: c.rollbackOn || c.spec?.rollbackOn || [],
    reason: c.reason || "", region: c.region || null, target: c.target || null, kind: c.kind || null, knobOnly: !!c.knobOnly,
    verify: c.verify || c.results?.checks || null, diff: c.diff || null,
  };
}
export const isWaiting = (c) => !!(c.waiting || c.stage === "awaiting-approval" || c.status === "awaiting-approval");
export const isFailed = (c) => FAILS.has(c.stage || c.status);
export const stageOf = (c) => (isWaiting(c) ? "waiting for you" : c.stage || c.status || "proposed");
