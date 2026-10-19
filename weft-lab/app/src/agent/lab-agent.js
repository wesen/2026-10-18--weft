// The Lab's architect agent (ARCH §9). Modeled on octavo's: one tool, `eval`, whose code runs in the
// page with a scope that reaches the editor, the compiler, the live simulation, the board, scenarios,
// proofs, the change pipeline and the report. Every step can be reverted (Auto), approved first (Ask),
// or the agent can only look (Read-only).
import { lab, lsGet, lsSet, REFERENCE, GUIDELINES } from "../ui/lab.js";
import { dslScope, evalDsl } from "./scope.js";
import { simTime, simCycle, safe, peek, poke, release, press, toggleSwitch, ledLevels, uart, uartText, lastFrame, instState, streamStats, changeList, stageOf, isWaiting } from "../ui/engine.js";
import { clip, summarize, fmtPs, fmtHz, durPs } from "../ui/fmt.js";
import { typeName } from "../core/types.js";
import { hw, agentHw } from "../ui/hw.js";

export const TIER_LABEL = { quick: "Fast", default: "Balanced", complex: "Deep" };
const HISTORY = 16;
const OUT_MAX = 9000;
const now = () => Date.now();
const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const paint = () => { if (paint.t) return; paint.t = requestAnimationFrame(() => { paint.t = 0; lab.bump("agent"); }); };
const tn = (t) => (t && typeof t === "object" ? safe(() => typeName(t), "?") : String(t ?? "?"));

export const ERRORS = {
  cancelled: "Stopped.",
  not_granted: "Claude is not allowed on this page. Allow it when asked, then try again.",
  rate_limited: "Too many requests or the usage limit is reached. Try again later.",
  prompt_too_large: "This conversation is too long for one request. Start a new chat.",
  refused: "Claude declined this request. Rephrase it.",
  tools_unavailable: "This view cannot run the agent's eval tool.",
  session_expired: "Sign in again, then retry.",
  sampling_disabled: "Claude is not available for this account.",
  empty_completion: "Claude returned nothing. Simplify the request.",
};
const friendly = (e) => ERRORS[e?.code] ?? `Something went wrong (${e?.code ?? e?.message ?? "unknown"}). Try again.`;

// ---------------------------------------------------------------- state
export const agent = {
  settings: { tier: "default", effort: "medium", mode: "auto", ...lsGet("agentSettings", {}) },
  conv: null,
  busy: false,
  ctl: null,
};
const SNAPS = new WeakMap();
const PENDING = new Map();
export const steps = (m) => (m.parts || []).filter((p) => p.type === "tool");
export const canRevert = (part) => SNAPS.has(part);

export function setSetting(k, v) { agent.settings[k] = v; lsSet("agentSettings", agent.settings); lab.bump("agent"); }

export function convs() { return (agent.convs ??= lsGet("convs", [])); }
export function newConv() { agent.conv = { id: newId("c"), title: "New chat", createdAt: now(), updatedAt: now(), messages: [] }; lab.bump("agent"); return agent.conv; }
export function saveConv(c = agent.conv) {
  if (!c || !c.messages.length) return;
  c.updatedAt = now();
  let json = JSON.stringify(c);
  if (json.length > 300000) { for (const m of c.messages) for (const p of m.parts ?? []) if (p.type === "tool" && p.result?.length > 1500) p.result = clip(p.result, 1500); json = JSON.stringify(c); }
  const list = convs(), rec = JSON.parse(json), i = list.findIndex((x) => x.id === c.id);
  if (i >= 0) list[i] = rec; else list.unshift(rec);
  while (list.length > 30) list.pop();
  lsSet("convs", list);
  lab.bump("convs");
}
export function openConv(id) {
  const c = convs().find((x) => x.id === id);
  if (!c) return;
  agent.conv = JSON.parse(JSON.stringify(c));
  for (const m of agent.conv.messages) if (m.pending) { m.pending = false; m.error ??= "Interrupted."; }
  lab.bump("agent");
}
export function deleteConv(id) {
  const list = convs(), i = list.findIndex((x) => x.id === id);
  if (i >= 0) list.splice(i, 1);
  lsSet("convs", list);
  if (agent.conv?.id === id) newConv();
  lab.bump("convs", "agent");
}

// ---------------------------------------------------------------- what the agent sees each turn
const errs = (diags) => (diags || []).filter((d) => d.level === "error").map((d) => (d.line ? `line ${d.line}: ` : "") + (d.code ? `[${d.code}] ` : "") + d.message);
const warns = (diags) => (diags || []).filter((d) => d.level === "warn" || d.level === "warning").map((d) => (d.line ? `line ${d.line}: ` : "") + (d.code ? `[${d.code}] ` : "") + d.message);

function designView(c) {
  if (!c) return null;
  const r = c.report || {};
  return {
    name: c.name, board: c.board ? `${c.board.profile} (${c.board.part})` : null,
    domains: Object.fromEntries(Object.entries(c.domains || {}).map(([n, d]) => [n, `${d.hz ? fmtHz(d.hz) : "?"} · ${safe(() => d.graph.size, "?")} nodes`])),
    instances: (c.instances || []).map((i) => `${i.path} (${i.cell || i.kind}${i.domain ? ", " + i.domain : ""})`).slice(0, 40),
    streams: (c.streams || []).map((s) => `${s.name}: ${s.producer || "?"} → ${(s.consumers || []).join(", ")}${s.depth ? ` [${s.depth} ${s.overflow || ""}]` : ""}${s.cross ? " (cross)" : ""}`).slice(0, 30),
    scenarios: (c.scenarios || []).map((s) => s.name), asserts: (c.asserts || []).length, knobs: (c.knobs || []).map((k) => k.path).slice(0, 20),
    agents: (c.agents || []).map((a) => a.name),
    resources: r.resources ? { luts: r.resources.luts, ffs: r.resources.ffs, brams: r.resources.brams, dsps: r.resources.dsps } : undefined,
    timing: r.timing ? Object.fromEntries(Object.entries(r.timing).map(([d, t]) => [d, t && t.slack != null ? `slack ${(+t.slack).toFixed(2)} ns` : "?"])) : undefined,
  };
}
export function contextSummary() {
  const c = lab.compiled;
  const ctx = {
    example: lab.preset ? `${lab.preset.id} ${lab.preset.title}${lab.preset.mine ? " (mine)" : ""}` : null,
    editor: { lines: lab.script.split("\n").length, saved: lab.script === lab.savedScript, sameAsRunning: lab.script === lab.bootScript, compiles: !!c?.ok, errors: errs(lab.diags).slice(0, 4), warnings: warns(lab.diags).length },
  };
  if (c?.ok || c?.instances?.length) ctx.design = designView(c);
  if (lab.sim) {
    ctx.sim = {
      t: fmtPs(simTime(lab.sim)), running: lab.running, cyclesPerSecond: Math.round(lab.cps), speed: +lab.effSpeed.toPrecision(3),
      ...(lab.script !== lab.bootScript ? { runsOlderDesign: true } : {}),
      recentEvents: lab.events.slice(-6).map((e) => `${fmtPs(e.t)} ${e.kind} ${e.path || e.name || ""}`),
      ...(lab.simError ? { stoppedWith: lab.simError.message } : {}),
    };
  }
  const sc = Object.entries(lab.scen).map(([n, v]) => `${n}: ${v.status}${v.status === "fail" ? " — " + clip(v.result?.message, 100) : ""}`);
  if (sc.length) ctx.scenarios = sc;
  const ch = lab.changes.slice(-3).map((r) => `${r.id} "${r.title}" by ${r.by}: ${stageOf(r)}`);
  if (ch.length) ctx.changes = ch;
  if (lab.proofs?.result?.results?.length) ctx.proofs = lab.proofs.result.results.map((r) => `${r.name}: ${r.status}`);
  if (lab.osThreads.length) ctx.designAgents = lab.osThreads.slice(-3).map((t) => `${t.agent}: ${t.event} (${t.status})`);
  const sel = Object.fromEntries(Object.entries(lab.sel).filter(([, v]) => v != null));
  ctx.view = { tab: lab.ui.right, ...(Object.keys(sel).length ? { selected: sel } : {}) };
  return ctx;
}

const AGENT_SCOPE = [
  ["lab.context()", "the same summary as the [context] block"],
  ["editor.get() · editor.set(text) · editor.edit(find, replace)", "read or change the script in the editor; set/edit recompile and return {ok, errors, warnings}"],
  ["editor.check(text?)", "compile without touching anything: {ok, errors, warnings, instances, streams, domains, scenarios}"],
  ["await editor.boot({ run: \"10ms\" })", "compile the editor's script, start a fresh simulation and run it; returns {ok, t, events, leds, uart}"],
  ["await editor.apply()", "apply the editor's script to the running design as a change (or a state-carrying reboot)"],
  ["compile(script?)", "the Compiled object for a script (default: the editor's): domains, instances, streams, pins, knobs, asserts, scenarios, stages, report. It is large; return small parts of it"],
  ["sim", "the live simulator: sim.time (ps), sim.peek(path), sim.state(instance), sim.stream(name), sim.board, sim.waves, sim.cycle(domain)"],
  ["io.press(btn, { for: \"50ms\" }) · io.hold(btn, down) · io.toggle(sw) · io.set(id, v)", "drive the board: btn:0, btn:up, sw:3 …"],
  ["io.peek(path) · io.poke(path, v) · io.release(path) · io.state(instance) · io.stream(name)", "signals by path (counter.value, a.b[3], a.s.field); poke forces until release"],
  ["io.leds() · io.uart(text, id?) · io.uartText(id?) · io.frame()", "LED levels; send to / read the UART terminal; a summary of the last HDMI frame"],
  ["await io.run(\"10ms\")", "advance simulated time (the page keeps painting); returns the new time"],
  ["scenarios.list() · await scenarios.run(name) · await scenarios.runAll()", "each on a fresh simulation; results with every step"],
  ["report() · ir(domain).print(max) · ir(domain).stats() · ir(domain).node(id)", "the build report (resources, timing with critical path by source line, per module); the DAG of a clock domain"],
  ["passes()", "stages and passes: time, nodes before → after, diagnostics"],
  ["await proofs.run()", "explicit-state model checking of the design's assert/assume/cover"],
  ["verilog() · verilog(path)", "emitted Verilog files: the list, or one file's text"],
  ["await changes.submit(change(\"title\").knob(…)/.patch(…)/.replace(…), opts) · changes.list() · changes.get(id) · changes.approve(id, ok)", "the change pipeline; submit also takes the expression as a string"],
  ["examples.list() · examples.get(id) · await examples.load(id) · examples.save({ asNew })", "the examples F-01 … F-19 and the user's designs (U-NN, kept in this browser)"],
  ["chat.table(rows, title) · chat.propose(script, title) · chat.frame() · chat.show(tab, sel)", "put evidence in the chat; switch the user's view (tabs: board modules graph waves passes report changes proofs)"],
  ["ref.section(name) · ref.all()", "the grammar reference"],
  ["module, fsm, pipeline, design, stream, rom, change, agent, host, group, board, std, u, s, bit, pulse, vec, struct, …", "the same builders as editor scripts"],
  ["log(...) · console.log(...)", "captured and returned with the result"],
];

// only listed when the Lab runs under weft serve with its hardware API
const HW_SCOPE = ["hw.bundle() · await hw.build({ load, force, seed }) → { id } · await hw.validate({ levels, scenario }) → { id, scenarios } · await hw.job(id, { wait: \"30s\" }) · await hw.load(id, { force }) · await hw.status() · await hw.builds() · await hw.log(id, stage, lines)",
  "the user's real GateMateA1-EVB board through weft serve. hw.bundle() says whether the editor's design can go to the board (or why not). build() compiles it for the board and runs yosys, nextpnr and gmpack in the background (a few seconds for small designs); it returns { id } at once, so call hw.job(id, { wait: \"30s\" }) until state is done or failed. The job holds nextpnr's utilization and fmax per clock next to the Lab's estimate. load: true (or hw.load(id)) writes the bitstream to the FPGA's SRAM; a build that failed timing loads only with force. Never load without the user asking for it. validate() is build() plus the validation ladder: levels (default [\"build\", \"rtl\", \"net\"]) replay each scenario's port changes, recorded from this simulator on a 1 MHz variant of the design, against the emitted RTL (iverilog) and a GateMate netlist; hw.job(id).validation lists one line per level and scenario, with the first mismatching cycle and port when one fails. Netlist runs take tens of seconds for long scenarios: wait in a loop. Scenarios that poke internal signals and designs with several clock domains are skipped; a design with native cells (std.uart, std.debounce) is compared up to its cells, whose hardware cores are tested separately"];

function instructions(conv) {
  const mode = agent.settings.mode;
  const ex = lab.presets.map((p) => `${p.id} ${p.title}`).join(" · ");
  return `[current conversation] ${conv.title} · ${conv.messages.length} messages so far (older ones may be trimmed).
[run mode] ${mode === "auto" ? "Auto: your evals run immediately; the user can revert any step." : mode === "ask" ? "Ask: each eval waits for the user to approve it, so batch work into fewer, clearer steps." : "Read-only: you may read, compile, simulate headless scenarios and explain; anything that changes the editor, the board, the running design or saved designs throws ReadOnlyError."}

${GUIDELINES}

You have exactly one tool, eval. Its code runs in the page as the body of an async function (use await; finish with \`return value\`). In scope:
${[...AGENT_SCOPE, ...(hw.available ? [HW_SCOPE] : [])].map(([a, b]) => `- ${a}: ${b}`).join("\n")}
The returned value comes back as YAML (a string verbatim), cut near 9,000 characters: return small, specific data, never whole graphs, traces or sources unless asked.
Each user message starts with a [context] block only when it changed. It does not include the script: read it with editor.get().
Times in the simulator are picoseconds. Links you write may use lab:line?n=12, lab:instance?path=counter, lab:tab?name=waves, lab:example?id=F-05, lab:change?id=c1.

# The grammar (same API as editor scripts)
${REFERENCE}

# Examples the user can load
${ex}`;
}

function turnsFor(text, conv, upto) {
  const win = conv.messages.slice(0, upto).slice(-HISTORY);
  const hist = [];
  for (const m of win) {
    if (m.role === "user") hist.push({ role: "user", content: (m.ctx ? `[context]\n${m.ctx}\n\n` : "") + m.text });
    else {
      let c = m.text || "";
      for (const p of steps(m)) c += `\n[eval]\n${clip(p.code, 1500)}\n→ ${p.status}:\n${clip(p.result ?? "", 900)}` + (p.reverted ? "\n[the user reverted this step and everything after it]" : "");
      if (m.error) c += `\n[error: ${m.error}]`;
      if (c.trim()) hist.push({ role: "assistant", content: clip(c, 12000) });
    }
  }
  while (hist.length && hist[0].role !== "user") hist.shift();
  const ctx = JSON.stringify(contextSummary());
  const last = [...win].reverse().find((m) => m.role === "user" && m.ctx);
  const changed = !last || last.ctx !== ctx;
  const head = changed ? `[context]\n${ctx}` : "[context unchanged since your last message; ask lab.context() for more]";
  let turns = [{ role: "user", content: instructions(conv) }, ...hist, { role: "user", content: `${head}\n\n[user message]\n${text}` }];
  const bytes = () => turns.reduce((a, t) => a + t.content.length, 0);
  while (bytes() > 230000 && turns.length > 3) turns.splice(1, 1);
  const merged = [];
  for (const t of turns) { const prev = merged[merged.length - 1]; if (prev && prev.role === t.role) prev.content += "\n\n" + t.content; else merged.push({ ...t }); }
  return { turns: merged, ctx: changed ? ctx : null };
}

// ---------------------------------------------------------------- sending
export async function send(text) {
  if (agent.busy) return stop();
  text = String(text ?? "").trim();
  if (!text) return;
  return sendCore(text);
}
export function stop() { agent.ctl?.abort(); }

export async function sendCore(text, { reuse = null, override = null } = {}) {
  const sample = lab.sample;
  const conv = agent.conv ?? newConv();
  if (!conv.messages.length && conv.title === "New chat") conv.title = clip(text, 60);
  const upto = reuse ?? conv.messages.length;
  const { turns, ctx } = turnsFor(text, conv, upto);
  if (reuse == null) conv.messages.push({ role: "user", text, ctx, at: now() });
  else { conv.messages[reuse].ctx = ctx; conv.messages.splice(reuse + 1); }
  const st = { ...agent.settings, ...override };
  const msg = { role: "assistant", text: "", parts: [], pending: true, at: now(), tier: st.tier, effort: st.effort, mode: st.mode };
  conv.messages.push(msg);
  agent.busy = true;
  paint();
  if (!sample) {
    msg.pending = false;
    msg.error = "Claude is not available in this view. Open the Lab in Claude to use the architect. The editor, the board, scenarios, proofs and the REPL in Modules all work by hand.";
    agent.busy = false; paint();
    return;
  }
  agent.ctl = new AbortController();
  try {
    const r = await sample(turns, {
      signal: agent.ctl.signal, modelTier: st.tier, ...(st.tier !== "quick" ? { effort: st.effort } : {}), cache: false,
      onText: ({ text: t }) => { msg.text = t; paint(); },
      tools: [evalTool(msg)],
    });
    Object.assign(msg, { text: r.text, truncated: r.truncated, tierApplied: r.modelTierApplied });
  } catch (e) {
    msg.error = e?.code === "cancelled" ? "Stopped." : friendly(e);
    if (e?.code === "refused") msg.text = ""; else if (e?.text != null) msg.text = e.text;
  } finally {
    msg.pending = false;
    msg.doneAt = now();
    msg.usage = { evals: steps(msg).length, ms: msg.doneAt - msg.at };
    agent.busy = false;
    agent.ctl = null;
    paint();
    saveConv(conv);
  }
}
export function retry(i, override) {
  const conv = agent.conv;
  const k = conv.messages[i]?.role === "user" ? i : i - 1;
  const um = conv.messages[k];
  if (!um || um.role !== "user" || agent.busy) return;
  sendCore(um.text, { reuse: k, override });
}

// ---------------------------------------------------------------- the eval tool
const evalTool = (msg) => ({
  name: "eval",
  description: "Run JavaScript in the Weft Lab page as the body of an async function. Scope: lab, editor, compile, sim, io, scenarios, report, ir, passes, proofs, verilog, changes, examples, chat, ref, hw (the real board, under weft serve), log, console and the Weft DSL builders. Returns \"ok\" plus a YAML summary of the returned value (a string comes back verbatim) and captured logs, cut near 9,000 characters; or \"error\" with the message and line.",
  inputSchema: { type: "object", properties: { code: { type: "string", description: "JavaScript statements; use await; end with return <small value>" } }, required: ["code"] },
  execute: (input, c) => runEval(String(input?.code ?? ""), c?.signal, msg),
});

export async function runEval(code, signal, msg) {
  const part = { type: "tool", code, status: "run", at: msg.text.length, t0: now() };
  msg.parts.push(part);
  paint();
  const mode = msg.mode ?? agent.settings.mode;
  if (mode === "ask" && !msg.approveAll) {
    const d = await askApproval(part, signal);
    if (d === "deny") return finish(part, false, yaml({ declined: true }), "", "The user declined this step.");
    if (d === "all") msg.approveAll = true;
  }
  if (mode !== "readonly") SNAPS.set(part, snapshot());
  const logs = [];
  const scope = makeAgentScope({ mode, onPart: (p) => { msg.parts.push({ ...p, at: msg.text.length }); paint(); }, log: (s) => logs.push(String(s)) });
  const names = Object.keys(scope).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
  let ok = true, out, lang = "yaml";
  try {
    const res = await new Function(...names, `"use strict";\nreturn (async () => {\n${code}\n})();\n//# sourceURL=agent-eval.js`)(...names.map((n) => scope[n]));
    if (res === undefined) out = "# returned undefined";
    else if (typeof res === "string") { out = res; lang = "text"; }
    else out = yaml(res);
  } catch (e) {
    ok = false;
    const line = lineOf(e);
    out = yaml({ error: `${e?.name ?? "Error"}: ${e?.message ?? e}`, ...(line ? { line } : {}) });
  }
  lab.bump("code", "boot", "frame", "changes", "scen", "sel", "ui", "proofs");
  if (signal?.aborted) { finish(part, ok, out, logs.join("\n"), null, lang); throw new Error("stopped"); }
  return finish(part, ok, out, logs.join("\n"), null, lang);
}
function lineOf(e) { const m = String(e?.stack || "").match(/agent-eval\.js:(\d+)/); return m ? Math.max(1, +m[1] - 4) : null; }
function finish(part, ok, out, logs, note, lang = "yaml") {
  if (out.length > OUT_MAX) out = out.slice(0, OUT_MAX) + `\n# … cut: ${out.length - OUT_MAX} more characters`;
  Object.assign(part, { status: ok ? "ok" : "err", ms: now() - part.t0, result: out, lang, logs: clip(logs, 6000) });
  paint();
  return `${ok ? "ok" : "error"}\n${note ? note + "\n" : ""}${out}${part.logs ? `\n# logs\n${part.logs}` : ""}`.slice(0, 20000);
}
function askApproval(part, signal) {
  part.status = "ask"; paint();
  return new Promise((resolve) => {
    PENDING.set(part, (d) => { PENDING.delete(part); part.status = "run"; paint(); resolve(d); });
    signal?.addEventListener("abort", () => PENDING.get(part)?.("deny"), { once: true });
  });
}
export function approve(part, choice) { PENDING.get(part)?.(choice); }

// ---------------------------------------------------------------- snapshots and revert
function snapshot() {
  return {
    script: lab.script, presetId: lab.preset?.id, savedScript: lab.savedScript, bootScript: lab.bootScript,
    mine: JSON.parse(JSON.stringify(lab.mine)), running: lab.running, sim: lab.sim, simSnap: safe(() => lab.sim?.snapshot?.()),
  };
}
async function restore(snap) {
  lab.mine = snap.mine; lsSet("mine", lab.mine);
  const p = lab.presets.find((x) => x.id === snap.presetId);
  if (p) lab.preset = p;
  lab.script = snap.script; lab.savedScript = snap.savedScript;
  lab.recompile();
  lab.bump("code", "preset");
  if (lab.sim !== snap.sim || lab.bootScript !== snap.bootScript) await lab.boot({ script: snap.bootScript, quiet: true });
  if (snap.simSnap && lab.sim?.restore) safe(() => lab.sim.restore(snap.simSnap));
  if (snap.running) lab.play(); else lab.pause();
  lab.bump("frame", "boot");
}
export async function revertFrom(msg, part) {
  const st = steps(msg), i = st.indexOf(part), snap = SNAPS.get(part);
  if (!snap) return lab.toast("This step has no snapshot (it ran in Read-only mode or before a reload).", "bad");
  await restore(snap);
  for (const p of st.slice(i)) p.reverted = true;
  lab.toast(i === 0 ? "Undid this answer" : `Reverted to before step ${i + 1}`);
  paint();
  saveConv();
}

// ---------------------------------------------------------------- the scope
class ReadOnlyError extends Error { constructor(what) { super(`${what} changes the design or the board; the agent is in Read-only mode`); this.name = "ReadOnlyError"; } }
const RO = (obj, keys, label) => { const o = { ...obj }; for (const k of keys) o[k] = () => { throw new ReadOnlyError(`${label}.${k}`); }; return o; };

// advance simulated time ourselves, yielding so the page can paint
export async function runSim(ps, { realMs = 25000 } = {}) {
  const sim = lab.sim;
  if (!sim) throw new Error("not running; editor.boot() first");
  if (typeof sim.runFor !== "function") throw new Error("this simulator cannot run for a duration yet");
  const was = lab.running;
  lab.pause();
  const end = simTime(sim) + ps, t0 = performance.now();
  let rate = lab.psPerMs || 1e5;
  while (lab.sim === sim && simTime(sim) < end && performance.now() - t0 < realMs) {
    const chunk = Math.max(1000, Math.min(end - simTime(sim), rate * 30));
    const a = performance.now(), b = simTime(sim);
    sim.runFor(chunk);
    const ms = performance.now() - a;
    if (ms > 1) rate = 0.6 * rate + 0.4 * ((simTime(sim) - b) / ms); else rate *= 2;
    lab.bump("frame");
    await new Promise((r) => setTimeout(r, 0));
  }
  if (was) lab.play();
  lab.bump("frame", "events");
  return fmtPs(simTime(sim));
}
function frameSummary() {
  const f = lab.sim ? lastFrame(lab.sim) : null;
  if (!f || !f.data) return { frame: "none yet (no HDMI output, or not enough simulated time for a frame)" };
  const counts = new Map();
  const d = f.data;
  for (let i = 0; i < d.length; i += 4 * 7) { const k = `#${((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]).toString(16).padStart(6, "0")}`; counts.set(k, (counts.get(k) || 0) + 1); }
  const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
  return { w: f.w, h: f.h, at: fmtPs(f.time), colors: Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => [k, (100 * v / total).toFixed(1) + "%"])) };
}

export function makeAgentScope({ mode = "auto", onPart = () => {}, log = () => {} } = {}) {
  const need = () => { if (!lab.sim) throw new Error("not running; editor.boot() first"); return lab.sim; };
  const LAB = { context: () => contextSummary() };
  let editor = {
    get: () => lab.script,
    set(text) {
      if (typeof text !== "string") throw new TypeError("editor.set(text) takes the whole script as a string");
      lab.setScript(text); lab.recompile();
      return { ok: lab.compiled.ok, errors: errs(lab.diags), warnings: warns(lab.diags) };
    },
    edit(find, replace) {
      const s = lab.script, i = s.indexOf(find);
      if (i < 0) throw new Error("editor.edit: the text to find is not in the editor (copy it exactly from editor.get())");
      if (s.indexOf(find, i + 1) >= 0) throw new Error("editor.edit: the text to find occurs more than once; include more context");
      return editor.set(s.slice(0, i) + replace + s.slice(i + find.length));
    },
    check(text = lab.script) {
      const r = lab.compileText(text);
      return { ok: r.ok, errors: errs(r.diags), warnings: warns(r.diags), ...(r.instances ? { instances: r.instances.map((i) => i.path), streams: (r.streams || []).map((s) => s.name), domains: Object.keys(r.domains || {}), scenarios: (r.scenarios || []).map((s) => s.name) } : {}) };
    },
    async boot({ run = "10ms" } = {}) {
      const ok = await lab.boot({ quiet: true });
      if (!ok) return { ok: false, errors: errs(lab.diags), warnings: warns(lab.diags), ...(lab.simError ? { simulator: lab.simError.message } : {}) };
      if (run) await runSim(durPs(run));
      const B = lab.board;
      return { ok: true, t: fmtPs(simTime(lab.sim)), instances: (lab.simCompiled.instances || []).length, warnings: warns(lab.diags), events: lab.events.slice(-10).map((e) => `${fmtPs(e.t)} ${e.kind} ${e.path || e.name || ""}`), leds: B.leds.length ? ledBits(B) : undefined, uart: B.uarts.length ? clip(uartText(lab.sim, B.uarts[0]), 400) : undefined, scenarios: (lab.simCompiled.scenarios || []).map((s) => s.name) };
    },
    async apply() { const r = await lab.apply(); return { applied: !!r, changes: lab.changes.slice(-2).map(changeView) }; },
  };
  const ledBits = (B) => { const lv = ledLevels(lab.sim, B.leds); return [...B.leds].reverse().map((L) => (lv[L.id] > 0.5 ? 1 : 0)).join(""); };
  let io = {
    press(id, { for: f = "50ms" } = {}) { const sim = need(); const b = sim.board; if (b?.press) b.press(id, { for: f }); else { press(sim, id, true); setTimeout(() => press(sim, id, false), 0); } lab.bump("pins"); return "ok"; },
    hold(id, down = true) { press(need(), id, !!down); lab.bump("pins"); return down ? "held" : "released"; },
    toggle(id) { toggleSwitch(need(), id); lab.bump("pins"); return "ok"; },
    set(id, v) { need().board?.set?.(id, v); lab.bump("pins"); return "ok"; },
    peek: (p) => peek(need(), p), poke: (p, v) => poke(need(), p, v), release: (p) => release(need(), p),
    state: (i) => instState(need(), i), stream: (n) => streamStats(need(), n),
    leds: () => ledBits(lab.board), uart(text, id = lab.board.uarts[0]) { const u = uart(need(), id); if (!u?.send) throw new Error(`no UART ${id}`); u.send(text); return "sent"; },
    uartText: (id = lab.board.uarts[0]) => uartText(need(), id), frame: () => frameSummary(),
    run: (d = "10ms") => runSim(durPs(d)),
  };
  const compileFn = (script = lab.script) => lab.compileText(script);
  const scenarios = {
    list: () => lab.scenarioList().map((s) => s.name),
    async run(name) {
      const r = await lab.runScenario(name);
      return { status: r.status, ...(r.status !== "pass" ? { message: r.message } : {}), simTime: r.simTime != null ? fmtPs(r.simTime * 1e9) : undefined, steps: (r.steps || []).map((x) => `${x.ok === false ? "✕" : x.ok == null ? "–" : "✓"} ${x.label}${x.note || x.message ? " — " + (x.note || x.message) : ""}`) };
    },
    async runAll() { const out = {}; for (const s of lab.scenarioList()) { const r = await lab.runScenario(s.name); out[s.name] = r.status === "pass" ? "pass" : `${r.status}: ${r.message || ""}`; } return out; },
  };
  const report = () => {
    const c = lab.compiled?.ok ? lab.compiled : lab.simCompiled;
    const r = c?.report;
    if (!r) return { report: "none (the design does not compile)" };
    return {
      part: r.part?.name ?? r.part, family: r.family, resources: r.resources ? { luts: r.resources.luts, ffs: r.resources.ffs, brams: r.resources.brams, dsps: r.resources.dsps, carry: r.resources.carry, ios: r.resources.ios } : null,
      timing: Object.fromEntries(Object.entries(r.timing || {}).map(([d, t]) => [d, { hz: t.hz, slack: t.slack, fmax: t.fmax, levels: t.levels, path: (t.path || []).slice(0, 12).map((n) => `%${n.id} ${n.op}${(n.origin?.[0] || n.origin)?.line ? " line " + (n.origin?.[0] || n.origin).line : ""}`) }])),
      perModule: r.perModule, checks: r.checks, registers: (r.registers || []).length,
    };
  };
  const ir = (domain) => {
    const c = lab.compiled?.ok ? lab.compiled : lab.simCompiled;
    const ds = Object.keys(c?.domains || {});
    const G = c?.domains?.[domain || ds[0]]?.graph;
    if (!G) throw new Error(`no domain "${domain}" (there are: ${ds.join(", ") || "none"})`);
    return {
      domain: G.domain, print: (max = 120) => G.print({ max }), stats: () => G.stats(), hash: () => G.hash(),
      node: (id) => { const n = G.node(id); return n ? { id: n.id, op: n.op, args: n.args, type: tn(n.type), attrs: n.attrs, origin: n.origin, users: G.users(id) } : null; },
      users: (id) => G.users(id), byOp: (op) => G.byOp(op).map((n) => n.id), graph: G,
    };
  };
  const passes = () => {
    const c = lab.compiled;
    return (c?.stages || []).map((s) => ({ stage: s.name, level: s.level, passes: (s.passes || []).map((p) => `${p.name}: ${p.ms != null ? p.ms.toFixed(1) + " ms" : ""} ${p.nodesBefore ?? "?"}→${p.nodesAfter ?? "?"}${(p.diags || []).length ? ` · ${p.diags.length} diags` : ""}${p.note ? " · " + p.note : ""}`) }));
  };
  const proofs = { async run() { const r = await lab.prove(); return r.status === "done" ? (r.result.results || []).map((x) => ({ name: x.name, kind: x.kind, status: x.status, depth: x.depth, ...(x.trace ? { trace: summarize(x.trace, 800) } : {}) })) : r; } };
  const verilog = (path) => { const files = lab.verilog(); if (path) { const f = files.find((x) => x.path === path || x.path.endsWith(path)); if (!f) throw new Error(`no file ${path}`); return f.text; } return files.map((f) => `${f.path} (${f.text.split("\n").length} lines)`); };
  const changeView = (rec) => rec && ({ id: rec.id, title: rec.title, by: rec.by, stage: stageOf(rec), stages: (rec.stages || []).map((s) => `${s.name}: ${s.status}${s.note ? " (" + s.note + ")" : ""}`), ...(rec.reason ? { reason: rec.reason } : {}) });
  let changes = {
    async submit(ch, opts = {}) {
      if (typeof ch === "string") ch = evalDsl(ch);
      const r = await lab.submitChange(ch, { by: "architect", ...opts });
      const id = r?.id ?? r;
      for (let k = 0; k < 200; k++) { const rec = lab.changes.find((x) => x.id === id); if (!rec || ["committed", "rolled-back", "rejected", "failed"].includes(rec.stage) || isWaiting(rec)) break; lab.pipeline?.poll?.(); if (lab.sim) await runSim(5e8, { realMs: 400 }); else await new Promise((res) => setTimeout(res, 50)); }
      return changeView(lab.changes.find((x) => x.id === id)) || { submitted: true, result: summarize(r, 300) };
    },
    list: () => lab.changes.map((r) => `${r.id} "${r.title}" by ${r.by}: ${stageOf(r)}`),
    get: (id) => changeView(lab.changes.find((r) => r.id === id)),
    approve(id, ok = true) { lab.approveChange(id, ok); return "ok"; },
  };
  let examples = {
    list: () => lab.presets.map((p) => `${p.id} ${p.title} [${p.group}]`),
    get: (id) => { const p = lab.presets.find((x) => x.id === id); if (!p) throw new Error(`no example ${id}`); return p.text; },
    async load(id) { await lab.load(id); return contextSummary(); },
    save({ asNew = false } = {}) { const id = lab.savePreset({ asNew }); return { id, title: lab.preset.title }; },
  };
  const chat = {
    table(rows, title) { const list = Array.isArray(rows) ? rows : Object.entries(rows).map(([k, v]) => ({ key: k, value: v })); onPart({ type: "table", title, rows: JSON.parse(JSON.stringify(list.slice(0, 200), (k, v) => (typeof v === "bigint" ? String(v) : v))), total: list.length }); return `shown ${Math.min(200, list.length)} rows`; },
    propose(script, title = "Proposed design") { const r = lab.compileText(script); onPart({ type: "proposal", title, code: script, ok: r.ok, errors: errs(r.diags).slice(0, 3) }); return r.ok ? "shown to the user" : { shown: true, errors: errs(r.diags) }; },
    frame(title) {
      const f = lab.sim ? lastFrame(lab.sim) : null;
      if (!f?.data) throw new Error("no HDMI frame yet");
      const cv = document.createElement("canvas"); cv.width = f.w; cv.height = f.h;
      cv.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(f.data), f.w, f.h), 0, 0);
      onPart({ type: "frame", title: title || `hdmi at ${fmtPs(f.time)}`, src: cv.toDataURL("image/png"), w: f.w, h: f.h });
      return "shown";
    },
    show(tab, sel = {}) { lab.setUI({ right: tab }); if (Object.keys(sel).length) lab.select(sel); return "ok"; },
  };
  const ref = {
    all: () => REFERENCE,
    section(name) {
      const parts = REFERENCE.split(/\n(?=## )/);
      const p = parts.find((x) => x.toLowerCase().includes(String(name).toLowerCase()));
      if (!p) throw new Error(`no section like "${name}"; sections: ${parts.map((x) => x.split("\n")[0]).join(" · ")}`);
      return p;
    },
  };
  if (mode === "readonly") {
    editor = RO(editor, ["set", "edit", "boot", "apply"], "editor");
    io = RO(io, ["press", "hold", "toggle", "set", "poke", "release", "uart", "run"], "io");
    changes = RO(changes, ["submit", "approve"], "changes");
    examples = RO(examples, ["load", "save"], "examples");
  }
  const fmtArgs = (a) => a.map((x) => (typeof x === "string" ? x : summarize(x, 400))).join(" ");
  const consoleObj = { log: (...a) => log(fmtArgs(a)), info: (...a) => log(fmtArgs(a)), warn: (...a) => log("warn: " + fmtArgs(a)), error: (...a) => log("error: " + fmtArgs(a)) };
  return {
    ...dslScope(), lab: LAB, editor, compile: compileFn, get sim() { return lab.sim; }, io, scenarios, report, ir, passes, proofs, verilog, changes, examples, chat, ref,
    hw: agentHw({ readonly: mode === "readonly" }),
    log: (...a) => log(fmtArgs(a)), console: consoleObj,
  };
}

// ---------------------------------------------------------------- YAML for results
function plain(v, depth = 6, seen = new WeakSet()) {
  if (v == null || typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "bigint") return String(v) + "n";
  if (typeof v === "function") return `[function ${v.name || ""}]`.replace(" ]", "]");
  if (typeof v !== "object") return String(v);
  if (seen.has(v)) return "[circular]";
  if (depth <= 0) return Array.isArray(v) ? `[${v.length} items]` : "{…}";
  seen.add(v);
  if (typeof v.k === "string" && Number.isInteger(v.w)) return safe(() => typeName(v), "type");
  if (v.nodes && typeof v.print === "function") return `[Graph ${v.domain}: ${safe(() => v.size, "?")} nodes]`;
  if (v instanceof Map) return Object.fromEntries([...v.entries()].slice(0, 100).map(([k, x]) => [String(k), plain(x, depth - 1, seen)]));
  if (v instanceof Set) return [...v].slice(0, 100).map((x) => plain(x, depth - 1, seen));
  if (v instanceof Error) return { error: `${v.name}: ${v.message}` };
  if (ArrayBuffer.isView(v)) return `[${v.constructor.name} ${v.length}]`;
  if (Array.isArray(v)) { const a = v.slice(0, 200).map((x) => plain(x, depth - 1, seen)); if (v.length > 200) a.push(`… ${v.length - 200} more`); return a; }
  const o = {};
  for (const k of Object.keys(v).slice(0, 120)) o[k] = plain(v[k], depth - 1, seen);
  return o;
}
function scalar(v) {
  if (v == null) return "null";
  if (typeof v === "string") return /^[\w./@#:+-][\w ./@#:+,()%-]*$/.test(v) && !/^(true|false|null|yes|no|[\d.+-]+)$/i.test(v) && !/[:#]\s|\s$/.test(v) ? v : JSON.stringify(v);
  return String(v);
}
function toYAML(v, indent = 0) {
  const pad = " ".repeat(indent);
  if (v == null || typeof v !== "object") {
    if (typeof v === "string" && v.includes("\n")) return "|\n" + v.split("\n").map((l) => pad + "  " + l).join("\n");
    return scalar(v);
  }
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    if (v.every((x) => x === null || typeof x !== "object") && v.map(scalar).join(", ").length < 80 && !v.some((x) => typeof x === "string" && x.includes("\n"))) return `[${v.map(scalar).join(", ")}]`;
    return "\n" + v.map((x) => {
      if (x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).length) { const body = toYAML(x, indent + 2).replace(/^\n/, ""); return pad + "- " + body.slice(indent + 2); }
      return pad + "- " + toYAML(x, indent + 2);
    }).join("\n");
  }
  const keys = Object.keys(v);
  if (!keys.length) return "{}";
  return "\n" + keys.map((k) => { const kk = /^[\w$.#@-]+$/.test(k) ? k : JSON.stringify(k); const val = toYAML(v[k], indent + 2); return `${pad}${kk}:${val.startsWith("\n") ? val : " " + val}`; }).join("\n");
}
export const yaml = (v) => toYAML(plain(v)).replace(/^\n/, "");

// ---------------------------------------------------------------- export a conversation
export function conversationMarkdown(conv) {
  return conv.messages.map((m) => (m.role === "user" ? `## You\n\n${m.text}` : `## Architect\n\n${m.text}${steps(m).map((s) => `\n\n\`\`\`js\n${s.code}\n\`\`\`\n\n\`\`\`yaml\n${s.result ?? ""}\n\`\`\``).join("")}`)).join("\n\n");
}

export const SUGGESTIONS = [
  "What does this design do, and what should I try first?",
  "Why is the critical path where it is? Follow it back to the source.",
  "Run every scenario and explain any failure.",
  "Design a new circuit for the dev board: ",
];
