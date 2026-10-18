// agent() components inside designs (F-18's closer, F-19's mechanic). When the event they listen to
// fires — "timing.failed" after a build, an escalation from a reset group, any simulator event — their
// runtime lambda runs with a ctx whose llm calls Claude through the same `sample` capability, after the
// user lets it ("Let it think"), and whose changes.submit puts the proposal into the change pipeline.
import { lab, REFERENCE } from "../ui/lab.js";
import { evalDsl } from "./scope.js";
import { clip, summarize, fmtPs } from "../ui/fmt.js";

let seq = 0;
const spent = new Map(); // agent name → proposals this boot

function refSections(names) {
  return REFERENCE.split(/\n(?=## )/).filter((p) => names.some((n) => p.startsWith("## " + n))).join("\n\n");
}

const handlersFor = (c, event) => (c?.agents || []).flatMap((a) => (a.on || []).filter((h) => h.event === event || (event === "escalation" && h.event === "escalate") || (event === "escalate" && h.event === "escalation")).map((h) => ({ a, h })));

// after a boot: did the build fail timing?
export function designAgentsBooted(c) {
  spent.clear();
  const list = handlersFor(c, "timing.failed");
  if (!list.length) return;
  const failures = Array.isArray(c.report?.failures) ? c.report.failures.filter((f) => f.event === "timing.failed")
    : Object.entries(c.report?.timing || {}).filter(([, t]) => t && t.slack < 0).map(([domain, t]) => ({ domain, target: t.hz ? `${(t.hz / 1e6).toFixed(0)} MHz` : "the clock", slack: +(+t.slack).toFixed(3), path: (t.path || []).map((n) => ({ op: n.op, width: n.width, origin: n.origin })), resources: c.report.resources ? { luts: c.report.resources.luts, ffs: c.report.resources.ffs, dsps: c.report.resources.dsps } : null }));
  for (const d of failures) for (const { a, h } of list) fire(a, h, "timing.failed", d, c);
}
export function simEvent(kind, ev, c) {
  for (const { a, h } of handlersFor(c, kind)) fire(a, h, kind, ev, c);
}

function fire(a, h, event, data, c) {
  const budget = a.budget?.proposals ?? Infinity;
  if ((spent.get(a.name) || 0) >= budget) return;
  const ctx = makeCtx(a, event, data, c);
  const fn = typeof h.fn === "function" ? h.fn : null;
  const run = fn ? Promise.resolve().then(() => fn(ctx, data)) : ctx.llm.propose({ goal: `Handle ${event}`, evidence: data }).then((p) => ctx.changes.submit(p, { approve: "you" }));
  run.catch((e) => { lab.osThreads.push({ kind: "note", id: ++seq, agent: a.name, event, status: "error", note: e?.message || String(e) }); lab.bump("os", "agent"); });
}

function makeCtx(a, event, data, c) {
  const ask = (kind, o) => new Promise((resolve, reject) => {
    const th = { kind: "llm", id: ++seq, agent: a.name, model: a.model, guidelines: a.guidelines, event, req: { kind, o }, data, status: "ask", text: "", t: Date.now(), resolve, reject, c };
    lab.osThreads.push(th);
    lab.bump("os", "agent");
    lab.toast(`${a.name} wants to ${kind === "propose" ? "propose a change" : "ask Claude"} (${event})`, "bad");
  });
  return {
    agent: a.name, event,
    llm: { propose: (o) => ask("propose", o), ask: (o) => ask("ask", o), decide: (o) => ask("decide", o) },
    changes: {
      submit: async (proposal, opts = {}) => {
        spent.set(a.name, (spent.get(a.name) || 0) + 1);
        const o = { ...opts };
        if (typeof o.verify === "function" || typeof o.approve === "string") o.by = a.name;
        return lab.submitChange(proposal, { by: a.name, fromAgent: true, agent: a.name, ...o });
      },
    },
    log: (...m) => lab.event({ kind: "agent", text: `${a.name}: ${m.map((x) => (typeof x === "string" ? x : summarize(x, 200))).join(" ")}` }),
    design: { name: c.name, script: lab.bootScript },
  };
}

function prompt(th) {
  const { req, c } = th;
  const o = req.o || {};
  const inst = (c.instances || []).filter((i) => i.kind !== "agent" && i.kind !== "host").map((i) => `- ${i.path} (${i.cell || i.kind}, ${i.domain || "?"}${i.provides?.length ? ", provides " + i.provides.join(", ") : ""}${i.needs?.length ? ", needs " + i.needs.join(", ") : ""})`).join("\n");
  const head = `You are "${th.agent}", an agent() component taking part in a Weft FPGA design. Weft is a JavaScript API: builder lambdas run at build time, hardware lambdas ($ => …) are parsed into a dataflow DAG and never called, runtime lambdas run beside the board. What you propose goes through the change pipeline (lint, verification, build, canary) and waits for the user's approval.
${th.guidelines ? "\nYour guidelines:\n" + th.guidelines + "\n" : ""}
The design "${c.name}" on ${c.board?.profile || "?"} (${c.board?.part || "?"}). Instances:
${inst}

The design's source:
${clip(lab.bootScript, 9000)}
`;
  if (req.kind === "decide") return `${head}\nDecide one thing now. Data:\n${clip(JSON.stringify(o, null, 1), 6000)}\n\nReply with only JSON: {"knob": "<knob path>", "to": <new value>, "why": "<one plain sentence>"}, or null when nothing should change.`;
  if (req.kind === "ask") return `${head}\n${typeof o === "string" ? o : clip(JSON.stringify(o, null, 1), 8000)}\n\nAnswer briefly.`;
  return `${head}
The event: ${th.event}
Goal: ${o.goal || "(none given)"}
Evidence:
${clip(summarize(o.evidence ?? th.data, 9000), 9000)}

Reply with ONE JavaScript expression and nothing else: no prose, no code fence. A change:
  change("short title").knob("<module.knob>", value)
  change("short title").patch("<module>", { lib: { NAME: value } })
  change("short title").replace("<module>", module("<same name>").needs(…).provides(…).on("<stream>", ($, x) => { … }))
Rules: keep ports, pins, clocks and stream types the same. Hardware lambdas see only $, their arguments, the prelude (u s bit wrap sat …) and names given with .lib(). Make the smallest change that works.

Grammar (excerpt):
${refSections(["Grammar · Modules", "Grammar · Scenarios", "Grammar · Types"])}`;
}

export async function approveLlm(th) {
  if (!lab.sample) {
    th.status = "error"; th.note = "Claude is not available in this view. Open the Lab in Claude to let design agents think.";
    th.reject?.(new Error(th.note));
    lab.bump("os", "agent");
    return;
  }
  th.status = "thinking";
  th.ctl = new AbortController();
  lab.bump("os", "agent");
  try {
    if (th.req.kind === "decide") {
      const v = await lab.sample.json(prompt(th), { signal: th.ctl.signal, modelTier: "default", cache: false });
      th.text = JSON.stringify(v); th.status = "done"; th.resolve(v);
    } else {
      const r = await lab.sample(prompt(th), { signal: th.ctl.signal, modelTier: "default", cache: false, onText: ({ text }) => { th.text = text; lab.bump("os"); } });
      th.text = r.text;
      if (th.req.kind === "propose") {
        try { const ch = evalDsl(r.text); th.status = "done"; th.resolve(ch); }
        catch (e) { th.status = "error"; th.note = "The proposal is not a valid change: " + e.message; th.reject(new Error(th.note)); }
      } else { th.status = "done"; th.resolve(r.text); }
    }
  } catch (e) {
    th.status = "error";
    th.text = e?.text || th.text || "";
    th.note = e?.code === "cancelled" ? "Stopped." : e?.code === "not_granted" ? "Claude was not allowed for this page." : e?.code === "rate_limited" ? "Too many requests; try again later." : e?.message || String(e);
    th.reject?.(new Error(th.note));
  }
  lab.bump("os", "agent", "changes");
}
export function declineLlm(th) {
  th.status = "declined";
  th.reject?.(new Error("the user declined"));
  lab.bump("os", "agent");
}
export const threadTime = (th) => (th.data?.time != null ? fmtPs(th.data.time) : new Date(th.t).toLocaleTimeString());
