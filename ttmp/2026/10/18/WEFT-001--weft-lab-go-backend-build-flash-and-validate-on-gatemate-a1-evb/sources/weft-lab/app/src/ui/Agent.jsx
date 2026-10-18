import React, { useEffect, useRef, useState } from "react";
import { lab } from "./lab.js";
import { useLab, Btn, Seg, Code, Menu, cls } from "./common.jsx";
import { highlight } from "./highlight.js";
import { md } from "./md.js";
import { clip, summarize } from "./fmt.js";
import {
  agent, TIER_LABEL, setSetting, send, stop, retry, steps, canRevert, revertFrom, approve,
  convs, newConv, openConv, deleteConv, conversationMarkdown, SUGGESTIONS,
} from "../agent/lab-agent.js";
import { approveLlm, declineLlm, threadTime } from "../agent/os-agents.js";
import { saveFile } from "./App.jsx";

const secs = (ms) => (ms / 1000).toFixed(1) + " s";

export function AgentPanel() {
  useLab("agent", "os", "platform", "agentDraft", "preset");
  const [tab, setTab] = useState("chat");
  const osOpen = lab.osThreads.filter((t) => t.kind === "llm" && (t.status === "ask" || t.status === "thinking")).length;
  useEffect(() => { if (lab.agentDraft != null) setTab("chat"); }, [lab.version("agentDraft")]);
  useEffect(() => { if (osOpen && tab === "history") setTab("os"); }, [osOpen]);
  const conv = agent.conv ?? newConv();
  const exportConv = () => saveFile((conv.title.replace(/[^\w]+/g, "-").toLowerCase() || "conversation") + ".md", conversationMarkdown(conv), "the conversation as Markdown");
  return (
    <div className="agent-panel">
      <div className="agent-head">
        <span className="t">{conv.title}</span>
        <Btn sm onClick={() => { newConv(); setTab("chat"); }} disabled={agent.busy}>New chat</Btn>
        <button type="button" className="ibtn" title="Save this conversation as Markdown" aria-label="Save conversation" onClick={exportConv} disabled={!conv.messages.length}>⤓</button>
      </div>
      <div className="subtabs" role="tablist">
        {[["chat", "Architect"], ["os", "Design agents", lab.osThreads.filter((t) => t.kind === "llm").length], ["history", "History"]].map(([k, l, n]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            {l}{n ? <span className={cls("count", k === "os" && osOpen && "bad")}>{n}</span> : null}
          </button>
        ))}
      </div>
      {tab === "history" ? <History onOpen={() => setTab("chat")} /> : tab === "os" ? <DesignAgents /> : <Chat conv={conv} />}
    </div>
  );
}

function Chat({ conv }) {
  useLab("agent", "platform", "agentDraft");
  const [draft, setDraft] = useState("");
  const logRef = useRef(null), ta = useRef(null);
  const s = agent.settings, busy = agent.busy, sample = lab.sample;
  useEffect(() => {
    if (lab.agentDraft == null) return;
    setDraft(lab.agentDraft); lab.agentDraft = null;
    requestAnimationFrame(() => { const t = ta.current; if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } });
  }, [lab.version("agentDraft")]);
  useEffect(() => { const el = logRef.current; if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight; });
  const submit = () => {
    if (busy) return stop();
    const t = draft.trim();
    if (!t) return;
    setDraft("");
    send(t);
  };
  const tries = (lab.preset?.tries || []).slice(0, 2).map((x) => `Try this and tell me what happens: ${x}`);
  const sugg = [...tries, ...SUGGESTIONS].slice(0, 5);
  const onLink = (e) => {
    const a = e.target.closest?.("a.lablink");
    if (!a) return;
    e.preventDefault();
    followLabLink(a.getAttribute("href"));
  };
  return (
    <>
      <div className="agent-set">
        <span className="ctl-l">Model</span>
        <Seg sm label="Model" items={[["quick", "Fast"], ["default", "Balanced"], ["complex", "Deep"]]} value={s.tier} onChange={(v) => setSetting("tier", v)} />
        <span className="ctl-l">Thinking</span>
        <div className={cls("seg sm", s.tier === "quick" && "dis")} role="group" aria-label="Thinking">
          {["low", "medium", "high"].map((v) => <button key={v} type="button" aria-pressed={s.effort === v} className={s.effort === v ? "on" : ""} disabled={s.tier === "quick"} onClick={() => setSetting("effort", v)}>{v === "medium" ? "Med" : v[0].toUpperCase() + v.slice(1)}</button>)}
        </div>
        <span className="ctl-l">Run</span>
        <Seg sm label="Run mode" items={[["auto", "Auto", "Steps run at once; you can revert any of them"], ["ask", "Ask", "Every step waits for you"], ["readonly", "Read-only", "The agent can look, compile and run headless scenarios, but change nothing"]]} value={s.mode} onChange={(v) => setSetting("mode", v)} />
      </div>
      {lab.platformReady && !sample ? (
        <div className="agent-off"><b>Claude is not connected here.</b> The architect calls Claude from this page, which works when the Lab is open in Claude. The editor, the board, scenarios, proofs, waves and the REPL in Modules all work without it.</div>
      ) : null}
      <div className="agent-log" ref={logRef} onClick={onLink}>
        {conv.messages.length ? conv.messages.map((m, i) => (m.role === "user" ? <UserMsg key={i} m={m} /> : <AssistantMsg key={i} m={m} i={i} />)) : (
          <div className="agent-empty">
            <p>The architect works on the design with one tool: it writes JavaScript that runs here, against the editor, the compiler, the live simulation, scenarios, proofs and the change pipeline. In <b>Auto</b> every step can be reverted; in <b>Ask</b> each one waits for you.</p>
            <div className="sugg">{sugg.map((x) => <button key={x} type="button" onClick={() => { setDraft(x); ta.current?.focus(); }}>{x}</button>)}</div>
          </div>
        )}
      </div>
      <div className="composer">
        <textarea ref={ta} value={draft} rows={3} placeholder={sample || !lab.platformReady ? "Ask the architect, or describe a circuit to build…" : "Open the Lab in Claude to talk to the architect"} aria-label="Message the architect"
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }} />
        <div className="row">
          <span className="meta">{TIER_LABEL[s.tier]}{s.tier !== "quick" ? ` · ${s.effort} thinking` : ""} · {s.mode === "readonly" ? "read-only" : s.mode} · Enter sends</span>
          <Btn primary={!busy} danger={busy} onClick={submit} disabled={!busy && !draft.trim()}>{busy ? "Stop" : "Send"}</Btn>
        </div>
      </div>
    </>
  );
}

export function followLabLink(href) {
  const m = String(href).match(/^lab:(\w+)\??(.*)$/);
  if (!m) return;
  const q = Object.fromEntries(new URLSearchParams(m[2]));
  switch (m[1]) {
    case "instance": case "module": lab.setUI({ right: "modules" }); lab.select({ instance: q.path || q.name }); break;
    case "change": lab.setUI({ right: "changes" }); lab.select({ change: q.id }); break;
    case "stream": lab.setUI({ right: "graph", graphMode: "modules" }); lab.select({ stream: q.name, node: "s:" + q.name }); break;
    case "node": lab.setUI({ right: "graph", graphMode: "dag" }); lab.select({ domain: q.domain, node: "n" + q.id }); break;
    case "tab": lab.setUI({ right: q.name || "board" }); break;
    case "example": case "preset": lab.load(q.id); break;
    case "line": lab.goto(+q.n); break;
    case "signal": lab.setUI({ right: "waves" }); lab.select({ signal: q.path }); break;
  }
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); lab.toast("Copied"); } catch { lab.toast("Copy is not available here", "bad"); }
}

function UserMsg({ m }) {
  return (
    <div className="msg user">
      <span className="who">you{m.ctx ? " · + context" : ""}</span>
      <div className="body">{m.text}</div>
      <div className="acts"><button type="button" className="link" onClick={() => copy(m.text)}>copy</button></div>
    </div>
  );
}

function interleave(text, parts, msg) {
  const out = [];
  let pos = 0;
  [...parts].sort((a, b) => a.at - b.at).forEach((p, i) => {
    const seg = text.slice(pos, Math.max(pos, p.at));
    if (seg.trim()) out.push(<div key={"t" + i} className="md" dangerouslySetInnerHTML={{ __html: md(seg) }} />);
    pos = Math.max(pos, p.at);
    out.push(p.type === "tool" ? <ToolCard key={"p" + i} part={p} msg={msg} /> : <Part key={"p" + i} p={p} />);
  });
  const rest = text.slice(pos);
  if (rest.trim()) out.push(<div key="tend" className="md" dangerouslySetInnerHTML={{ __html: md(rest) }} />);
  return out;
}

function AssistantMsg({ m, i }) {
  const [rmenu, setRmenu] = useState(false);
  const st = steps(m);
  let body;
  if (m.pending || !st.length) body = interleave(m.text, m.parts || [], m);
  else {
    const cut = Math.max(...st.map((p) => p.at));
    const final = m.text.slice(cut);
    if (!final.trim()) body = interleave(m.text, m.parts, m);
    else {
      const failed = st.filter((p) => p.status === "err").length;
      body = (
        <>
          <details className="fold"><summary>Worked through {st.length} step{st.length === 1 ? "" : "s"} · {secs(m.usage?.ms ?? 0)}{failed ? ` · ${failed} failed` : ""}</summary>{interleave(m.text.slice(0, cut), st, m)}</details>
          {(m.parts || []).filter((p) => p.type !== "tool").map((p, k) => <Part key={"v" + k} p={p} />)}
          <div className="md" dangerouslySetInnerHTML={{ __html: md(final) }} />
        </>
      );
    }
  }
  const firstUndo = st.find((p) => canRevert(p) && !p.reverted);
  return (
    <div className={cls("msg agent", m.error && !m.text && "error")}>
      <span className="who">architect{m.pending ? " · working" : ""}</span>
      {m.pending && !m.text && !(m.parts || []).length ? <div className="thinking">thinking…</div> : null}
      {body}
      {m.error ? <div className="res bad">{m.error}</div> : null}
      {m.truncated ? <div className="res bad">The answer was cut short. Ask for less at a time.</div> : null}
      {m.pending ? null : (
        <div className="acts">
          <button type="button" className="link" onClick={() => copy(m.text)}>copy</button>
          <span className="rel">
            <button type="button" className="link" onClick={() => setRmenu(!rmenu)} aria-haspopup="menu" aria-expanded={rmenu}>retry…</button>
            <Menu open={rmenu} onClose={() => setRmenu(false)} className="retry">
              <div className="mh">Answer again with</div>
              {[["Same settings", null], ["Fast", { tier: "quick" }], ["Balanced", { tier: "default" }], ["Deep", { tier: "complex", effort: "high" }], ["Read-only", { mode: "readonly" }]].map(([l, o]) => (
                <button key={l} type="button" disabled={agent.busy} onClick={() => { setRmenu(false); retry(i, o); }}>{l}</button>
              ))}
            </Menu>
          </span>
          {firstUndo ? <button type="button" className="link strong" onClick={() => revertFrom(m, firstUndo)}>undo this answer</button> : null}
          <span className="usage">{TIER_LABEL[m.tierApplied ?? m.tier] ?? m.tier}{m.tier !== "quick" ? ` · ${m.effort}` : ""} · {m.mode} · {st.length} eval{st.length === 1 ? "" : "s"}{m.usage ? ` · ${secs(m.usage.ms)}` : ""}</span>
        </div>
      )}
    </div>
  );
}

function ToolCard({ part, msg }) {
  useLab("agent");
  const first = (part.code.split("\n").find((l) => l.trim() && !l.trim().startsWith("//")) ?? "").trim();
  const [open, setOpen] = useState(part.status === "ask");
  const ref = useRef(null);
  useEffect(() => { if (part.status === "ask") { setOpen(true); requestAnimationFrame(() => ref.current?.scrollIntoView({ block: "nearest" })); } }, [part.status]);
  const idx = steps(msg).indexOf(part);
  return (
    <details ref={ref} className={cls("tool", part.status, part.reverted && "reverted")} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="dot" />
        <span className="nm">eval</span>
        <span className="first" dangerouslySetInnerHTML={{ __html: highlight(first.slice(0, 120)) }} />
        <span className="ms">{part.status === "run" ? "running" : part.status === "ask" ? "waiting for you" : part.ms != null ? part.ms + " ms" : ""}{part.reverted ? " · reverted" : ""}</span>
      </summary>
      <div className="tb">
        <pre className="src hl" dangerouslySetInnerHTML={{ __html: highlight(part.code) }} />
        {part.status === "ask" ? (
          <div className="row">
            <span className="ctl-l">Run this step?</span>
            <Btn sm primary onClick={() => approve(part, "run")}>Run</Btn>
            <Btn sm onClick={() => approve(part, "all")}>Run all in this answer</Btn>
            <Btn sm danger onClick={() => approve(part, "deny")}>Decline</Btn>
          </div>
        ) : null}
        {part.result != null ? <pre className={cls("res", part.status === "err" && "bad")}>{part.result}</pre> : null}
        {part.logs ? <pre className="res logs">{part.logs}</pre> : null}
        {canRevert(part) && !part.reverted && part.status !== "run" && part.status !== "ask" && !msg.pending ? (
          <div className="row"><button type="button" className="link" onClick={() => revertFrom(msg, part)}>revert to before step {idx + 1}</button></div>
        ) : null}
      </div>
    </details>
  );
}

function Part({ p }) {
  switch (p.type) {
    case "table": {
      const cols = [...new Set(p.rows.flatMap((r) => (r && typeof r === "object" ? Object.keys(r) : ["value"])))].slice(0, 10);
      return (
        <div className="part">
          {p.title ? <div className="ptitle">{p.title}{p.total > p.rows.length ? ` · first ${p.rows.length} of ${p.total}` : ""}</div> : null}
          <div className="ptable"><table className="rt"><thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>{p.rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c}>{fmtCell(r && typeof r === "object" ? r[c] : r)}</td>)}</tr>)}</tbody></table></div>
        </div>
      );
    }
    case "frame":
      return <div className="part"><div className="ptitle">{p.title}</div><div className="pscreen" style={{ aspectRatio: `${p.w} / ${p.h}` }}><img src={p.src} alt={p.title} /></div></div>;
    case "proposal":
      return (
        <div className="part prop">
          <div className="ptitle">{p.title}{p.ok ? "" : " · does not compile"}</div>
          {p.errors?.length ? <div className="res bad">{p.errors.join("\n")}</div> : null}
          <pre className="src hl snip" dangerouslySetInnerHTML={{ __html: highlight(clip(p.code, 4000)) }} />
          <div className="row">
            <Btn sm onClick={() => { lab.setScript(p.code); lab.recompile(); lab.setUI({ ide: true, left: "code" }); }}>Open in editor</Btn>
            <Btn sm primary onClick={async () => { lab.setScript(p.code); await lab.boot(); }}>Open and boot</Btn>
            <Btn sm onClick={() => copy(p.code)}>Copy</Btn>
          </div>
        </div>
      );
    default: return null;
  }
}
const fmtCell = (v) => (v == null ? "" : typeof v === "object" ? clip(JSON.stringify(v), 120) : String(v));

function History({ onOpen }) {
  useLab("convs", "agent");
  const [q, setQ] = useState("");
  const [armed, setArmed] = useState(null);
  const list = convs().filter((c) => !q || c.title.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="hist">
      <p className="note">Conversations are kept in this browser only.</p>
      <div className="toolbar"><input className="filter" placeholder="Filter conversations" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter conversations" /><Btn sm onClick={() => { newConv(); onOpen(); }}>New chat</Btn></div>
      <div className="scroll">
        {list.length ? list.map((c) => (
          <div key={c.id} className={cls("hrow", c.id === agent.conv?.id && "on")} onClick={() => { openConv(c.id); onOpen(); }}>
            <span className="hmain"><b>{c.title}</b><span className="sub">{c.messages.length} messages · {c.messages.reduce((a, m) => a + steps(m).length, 0)} evals · {new Date(c.updatedAt).toLocaleString()}</span></span>
            <button type="button" className={cls("link", armed === c.id && "bad")} onClick={(e) => { e.stopPropagation(); if (armed === c.id) { deleteConv(c.id); setArmed(null); } else setArmed(c.id); }}>{armed === c.id ? "delete?" : "delete"}</button>
          </div>
        )) : <p className="empty padded">No saved conversations yet. They appear here after the first answer.</p>}
      </div>
    </div>
  );
}

// ---------- agent() components inside the running design ----------
function DesignAgents() {
  useLab("os", "agent", "boot");
  const c = lab.simCompiled || lab.compiled;
  const agents = c?.agents || [];
  const list = [...lab.osThreads].reverse();
  return (
    <div className="osagents scroll">
      <p className="note">Designs can contain <code>agent()</code> components. When their event fires (<code>timing.failed</code> after a build, an escalation from a reset group), their runtime lambda runs and may ask Claude for a change through <code>ctx.llm</code>. Each call waits for you here; what they propose still goes through the change pipeline and waits for approval in Changes.</p>
      {agents.length ? (
        <div className="osth">
          <div className="osh"><b>In this design</b><span className="sp" /><span className="t">{agents.length}</span></div>
          {agents.map((a) => <div key={a.name} className="row"><b>{a.name}</b><span className="sub">{a.model || "claude"} · on {(a.on || []).map((h) => h.event).join(", ") || "—"}{a.budget?.proposals != null ? ` · ${a.budget.proposals} proposals per ${a.budget.per || "build"}` : ""}</span></div>)}
        </div>
      ) : null}
      {list.length ? list.map((th) => (th.kind === "note" ? <div key={"n" + th.id} className="osth err"><div className="osh"><b>{th.agent}</b> on {th.event}<span className="sp" /></div><div className="res bad">{th.note}</div></div> : <LlmThread key={"l" + th.id} th={th} />)) : (
        <p className="empty padded">{agents.length ? "Nothing has fired yet." : "This design has no agents. Load F-18 (a timing closer) or F-19 (a mechanic on call)."}</p>
      )}
    </div>
  );
}

function LlmThread({ th }) {
  useLab("os");
  const o = th.req.o || {};
  const goal = o.goal || (typeof o === "string" ? o : "");
  return (
    <div className={cls("osth", th.status === "ask" && "asking", th.status === "error" && "err")}>
      <div className="osh"><b>{th.agent}</b> wants to {th.req.kind === "propose" ? "propose a change" : th.req.kind === "decide" ? "decide" : "ask"}<span className="sp" /><span className="t">{th.event} · {threadTime(th)}</span></div>
      {goal ? <p className="goal">{clip(goal, 300)}</p> : null}
      {o.evidence || th.data ? <details className="res"><summary>what it sends</summary><Code text={clip(summarize(o.evidence ?? th.data, 6000), 6000)} max={200} /></details> : null}
      {th.status === "ask" ? (
        <div className="row">
          <Btn sm primary onClick={() => approveLlm(th)}>Let it think</Btn>
          <Btn sm onClick={() => declineLlm(th)}>Decline</Btn>
          <span className="sub">one call to Claude ({th.model || "default"} model)</span>
        </div>
      ) : null}
      {th.status === "thinking" ? <div className="row"><span className="thinking">thinking…</span><span className="sp" /><Btn sm onClick={() => th.ctl?.abort()}>Stop</Btn></div> : null}
      {th.text ? <pre className="src hl ans" dangerouslySetInnerHTML={{ __html: highlight(clip(th.text, 6000)) }} /> : null}
      {th.status === "done" ? <p className="sub">answered · {th.req.kind === "propose" ? "the proposal goes to the change pipeline; see Changes" : "the agent has the answer"}</p> : null}
      {th.status === "declined" ? <p className="sub">declined; the agent got an error and stops</p> : null}
      {th.note ? <div className="res bad">{th.note}</div> : null}
    </div>
  );
}
