import React, { useEffect, useMemo, useRef, useState } from "react";
import { lab, REFERENCE, GUIDELINES } from "./lab.js";
import { useLab, Tabs, Btn, cls } from "./common.jsx";
import { highlightLines } from "./highlight.js";
import { AgentPanel } from "./Agent.jsx";
import { fmtMsReal, fmtPs } from "./fmt.js";

export function Ide() {
  useLab("ui", "os", "agent");
  const asks = lab.osThreads.filter((t) => t.kind === "llm" && t.status === "ask").length;
  const tab = lab.ui.left;
  return (
    <div className="pane" id="left">
      <Tabs value={tab} onChange={(v) => lab.setUI({ left: v })} items={[["code", "Code"], ["agent", "Agent", asks || null, asks > 0], ["reference", "Reference"]]}
        right={<>
          <button type="button" className="tabact" onClick={() => lab.boot()} title="Compile the editor's definition and start a fresh simulation (⌘B)">Boot</button>
          <button type="button" className="tabact strong" onClick={() => lab.apply()} title="Apply your edits to the running design as a change (⌘↵)">Apply ▸</button>
        </>} />
      {tab === "code" ? <CodePane /> : tab === "agent" ? <AgentPanel /> : <Reference />}
    </div>
  );
}

function CodePane() {
  useLab("code", "diags", "scen", "preset", "compiled");
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  const lines = lab.script.split("\n").length;
  const errs = lab.diags.filter((d) => d.level === "error"), warns = lab.diags.filter((d) => d.level === "warn" || d.level === "warning"), infos = lab.diags.filter((d) => d.level === "info");
  const c = lab.compiled;
  const mods = (c?.instances || []).filter((i) => i.kind !== "agent" && i.kind !== "host").length;
  const list = [...errs, ...warns, ...infos];
  const shown = all ? list : list.slice(0, 5);
  return (
    <div className="srcpane">
      <Editor />
      {list.length ? (
        <div className="diags">
          {shown.map((d, i) => (
            <button key={i} type="button" className={cls("diag", d.level === "error" && "bad", d.level === "info" && "info")} onClick={() => d.line && lab.goto(d.line)} title={d.code ? "code: " + d.code : ""}>
              <b>{d.level === "error" ? "✕" : d.level === "info" ? "i" : "!"}</b>{d.line ? <span className="ln">line {d.line}</span> : null}{d.code ? <span className="dcode">{d.code}</span> : null}<span>{d.message}</span>
            </button>
          ))}
          {list.length > 5 ? <button type="button" className="link more" onClick={() => setAll(!all)}>{all ? "fewer" : `and ${list.length - 5} more`}</button> : null}
        </div>
      ) : null}
      <Scenarios open={open} setOpen={setOpen} />
      <div className="ed-foot">
        <span><b>{lines}</b> lines</span><span>·</span><span><b>{mods}</b> modules</span>
        {c?.streams ? <><span>·</span><span><b>{c.streams.length}</b> streams</span></> : null}
        {c?.domains ? <><span>·</span><span><b>{Object.keys(c.domains).length}</b> domain{Object.keys(c.domains).length === 1 ? "" : "s"}</span></> : null}
        <span>·</span><span>compiled in <b>{fmtMsReal(lab.compileMs)}</b></span>
        <span className="sp" />
        {errs.length ? <span className="bad">{errs.length} error{errs.length > 1 ? "s" : ""}</span> : warns.length ? <span>{warns.length} warning{warns.length > 1 ? "s" : ""}</span> : <span>{lab.script !== lab.savedScript ? "edited" : "saved"}{lab.dirty && lab.sim ? " · not applied" : ""}</span>}
      </div>
    </div>
  );
}

function Editor() {
  useLab("code", "diags", "gotoLine");
  const ta = useRef(null), pre = useRef(null), gut = useRef(null);
  const hl = useMemo(() => highlightLines(lab.script), [lab.script]);
  const errLines = new Set(lab.diags.filter((d) => d.level === "error" && d.line).map((d) => d.line));
  const warnLines = new Set(lab.diags.filter((d) => (d.level === "warn" || d.level === "warning") && d.line).map((d) => d.line));
  useEffect(() => {
    const t = ta.current;
    if (!t || !lab.gotoLine) return;
    const lines = lab.script.split("\n");
    const ln = Math.min(lines.length, lab.gotoLine);
    const pos = lines.slice(0, ln - 1).join("\n").length + (ln > 1 ? 1 : 0);
    t.focus({ preventScroll: true }); t.setSelectionRange(pos, pos + (lines[ln - 1] || "").length);
    t.scrollTop = Math.max(0, (ln - 6) * 18);
    lab.gotoLine = null;
    sync();
  }, [lab.version("gotoLine")]);
  const sync = () => {
    const t = ta.current;
    if (!t) return;
    if (pre.current) pre.current.style.transform = `translate(${-t.scrollLeft}px, ${-t.scrollTop}px)`;
    if (gut.current) gut.current.style.transform = `translateY(${-t.scrollTop}px)`;
  };
  const onKey = (e) => {
    const t = e.currentTarget;
    if (e.key === "Tab") {
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value } = t;
      lab.setScript(value.slice(0, a) + "  " + value.slice(b));
      requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2));
    } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); lab.apply(); }
    else if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) { e.preventDefault(); lab.savePreset(); }
    else if ((e.metaKey || e.ctrlKey) && (e.key === "b" || e.key === "B")) { e.preventDefault(); lab.boot(); }
  };
  useEffect(sync);
  return (
    <div className="ed">
      <div className="gutter"><div className="gutter-in" ref={gut}>{hl.map((_, i) => <div key={i} className={errLines.has(i + 1) ? "err" : warnLines.has(i + 1) ? "warn" : ""}>{i + 1}</div>)}</div></div>
      <div className="code">
        <pre ref={pre} aria-hidden="true">{hl.map((h, i) => <div key={i} className={errLines.has(i + 1) ? "ln-err" : warnLines.has(i + 1) ? "ln-warn" : ""} dangerouslySetInnerHTML={{ __html: h || " " }} />)}</pre>
        <textarea ref={ta} value={lab.script} spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-label="Definition" onChange={(e) => lab.setScript(e.target.value)} onScroll={sync} onKeyDown={onKey} />
      </div>
    </div>
  );
}

function Scenarios({ open, setOpen }) {
  useLab("scen", "diags", "compiled");
  const list = lab.scenarioList();
  const [exp, setExp] = useState(null);
  const count = (st) => list.filter((s) => lab.scen[s.name]?.status === st).length;
  const pass = count("pass"), fail = count("fail"), skip = count("skip");
  return (
    <div className={cls("params scen", !open && "closed")}>
      <header>
        <button type="button" className="linkhd" onClick={() => setOpen(!open)} aria-expanded={open}><h2>Scenarios</h2></button>
        <span className="count">{list.length}</span>
        {pass ? <span className="ok">{pass} pass</span> : null}{fail ? <span className="bad">{fail} fail</span> : null}{skip ? <span className="dim">{skip} skipped</span> : null}
        <span className="sp" />
        {list.length ? <Btn sm onClick={() => lab.runAll()}>Run all</Btn> : null}
      </header>
      {open ? (list.length ? list.map((s) => {
        const st = lab.scen[s.name];
        const bad = st?.status === "fail";
        const steps = st?.steps || [];
        return (
          <div key={s.name} className={cls("srow", bad && "bad")}>
            <div className="srow-h">
              <button type="button" className="linkhd" onClick={() => setExp(exp === s.name ? null : s.name)} title={s.kind === "tb" ? "an async testbench" : `${(s.steps || []).length} recorded steps`}>{s.name}</button>
              {s.kind === "tb" ? <span className="tag">tb</span> : null}
              <span className="sp" />
              <span className="st">{st?.status === "running" ? "running…" : st?.status === "pass" ? "✓" : bad ? "✕" : st?.status === "skip" ? "skipped" : ""}{st?.result?.simTime != null && st.status !== "running" ? <small> {fmtPs(st.result.simTime * 1e9)}</small> : null}</span>
              <Btn sm onClick={() => lab.runScenario(s.name)} disabled={st?.status === "running"} title="Run on a fresh simulation, as fast as it goes">Run</Btn>
              <Btn sm onClick={() => lab.watchScenario(s.name)} disabled={st?.status === "running"} title="Reset the board and run it here, so you can watch">Watch</Btn>
            </div>
            {bad || st?.status === "skip" ? <div className={cls("srow-msg", !bad && "dim")}>{st.result?.message}</div> : null}
            {(exp === s.name || st?.status === "running") ? (
              steps.length ? <ol className="steps">{steps.map((r, i) => <li key={i} className={r.ok === false ? "bad" : r.ok == null || r.skip || r.status === "skip" ? "dim" : ""}><b>{r.ok === false ? "✕" : r.ok == null || r.skip || r.status === "skip" ? "–" : "✓"}</b> <code>{r.label}</code>{r.time != null ? <span className="t"> {fmtPs(r.time * 1e9)}</span> : null}{r.note || r.message ? <span> {r.note || r.message}</span> : null}</li>)}</ol>
                : <ol className="steps dim">{(s.steps || []).map((x, i) => <li key={i}><b>·</b> <code>{x.op}({(x.args || []).map(argText).join(", ")})</code>{x.line ? <button type="button" className="link" onClick={() => lab.goto(x.line)}> line {x.line}</button> : null}</li>)}{s.kind === "tb" ? <li>an async testbench: run it to see its steps</li> : null}</ol>
            ) : null}
          </div>
        );
      }) : <p className="empty padded">{lab.compiled?.ok === false && !lab.compiled?.scenarios ? "Scenarios appear when the design compiles." : <>No scenarios. Add <code>.scenario(name, sc =&gt; sc…)</code> to the design.</>}</p>) : null}
    </div>
  );
}
function argText(a) {
  if (typeof a === "function") return "ƒ";
  if (typeof a === "string") return JSON.stringify(a);
  if (a && typeof a === "object") { try { return JSON.stringify(a).slice(0, 40); } catch { return "{…}"; } }
  return String(a);
}

function Reference() {
  const [q, setQ] = useState("");
  const parts = REFERENCE.split(/\n(?=## )/);
  const ql = q.trim().toLowerCase();
  const filt = (txt) => {
    if (!ql) return txt;
    return txt.split("\n").filter((l, i, a) => l.toLowerCase().includes(ql) || (a[i - 1] || "").toLowerCase().includes(ql) && /^\s{6}/.test(l)).join("\n");
  };
  return (
    <div className="scroll refwrap">
      <div className="toolbar"><input className="filter" placeholder="Filter the reference (e.g. knob, cdc, expectStream)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter the reference" /></div>
      <div className="ref">
        <h3>Weft · the grammar</h3>
        {parts.map((p, i) => {
          if (!p.startsWith("## ")) return <div key={i}>{filt(p)}</div>;
          const nl = p.indexOf("\n");
          const body = filt(p.slice(nl + 1));
          if (ql && !body.trim()) return null;
          return <React.Fragment key={i}><h3>{p.slice(3, nl)}</h3><div>{body}</div></React.Fragment>;
        })}
        {!ql ? <><h3>The agent's guidelines</h3><div>{GUIDELINES}</div></> : null}
      </div>
    </div>
  );
}
