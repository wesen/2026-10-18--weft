import React, { useState } from "react";
import { lab } from "./lab.js";
import { useLab, Btn, Seg, Kv, Code, cls } from "./common.jsx";
import { isWaiting, isFailed, stageOf, safe } from "./engine.js";
import { dslScope } from "../agent/scope.js";
import { fmtPs, summarize, clip } from "./fmt.js";

export const STAGES = ["proposed", "checked", "verified", "built", "canary", "committed"];
const TERMINAL = new Set(["committed", "rolled-back", "rejected", "failed"]);
const stagesOf = (rec) => (Array.isArray(rec.stages) ? rec.stages : rec.history || []);
const whenOf = (rec) => rec.t ?? rec.time ?? rec.at ?? rec.proposedAt ?? null;
const opsOf = (rec) => rec.ops || rec.change?.ops || rec.change?.steps || [];
const callText = (c) => (typeof c === "string" ? c : `${c.op}(${(c.args || []).map((a) => (typeof a === "string" ? a : a && typeof a === "object" ? summarize(a, 40) : String(a))).join(", ")})`);

export function ChangesTab() {
  useLab("changes", "frame", "sel", "boot");
  const [filter, setFilter] = useState("all");
  const all = lab.changes;
  let list = [...all].reverse();
  if (filter === "open") list = list.filter((c) => !TERMINAL.has(c.stage || c.status));
  if (filter === "failed") list = list.filter(isFailed);
  if (filter === "agents") list = list.filter((c) => c.by && c.by !== "you" && c.by !== "editor" && c.by !== "scenario");
  const sel = all.find((c) => c.id === lab.sel.change) || list[0] || null;
  return (
    <>
      <div className="stagewrap">
        <div className="toolbar">
          <Seg label="Show" items={[["all", "All"], ["open", "In flight"], ["failed", "Rolled back"], ["agents", "By agents"]]} value={filter} onChange={setFilter} />
          <Btn sm onClick={() => lab.apply()} disabled={!lab.sim} title="Submit the editor's definition as a change to the running design">Apply the editor ▸</Btn>
          <span className="sp" />
          <span className="lbl">proposed → checked → verified → built → canary → committed, or rolled back</span>
        </div>
        <div className="scroll">
          {!lab.pipeline ? <p className="empty padded">The change pipeline is not running: {lab.sim ? "the engine did not provide one." : "boot a design first."}</p> : list.length ? (
            <table className="rt changes">
              <thead><tr><th>id</th><th>change</th><th>by</th><th>at</th><th>pipeline</th><th>stage</th></tr></thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id} className={cls("clickable", sel?.id === c.id && "sel", isFailed(c) && "badrow")} onClick={() => lab.select({ change: c.id })}>
                    <td className="nm">{c.id}</td>
                    <td>{c.title}{c.kind ? <span className="tag dim">{c.kind}</span> : null}</td>
                    <td>{c.by || "—"}</td>
                    <td className="num">{whenOf(c) != null ? fmtPs(whenOf(c)) : "—"}</td>
                    <td><Pips rec={c} /></td>
                    <td className={cls((isFailed(c) || isWaiting(c)) && "bad")}>{stageOf(c)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty padded">
              <p>No changes yet. Edit the design and press <b>Apply ▸</b>, turn a knob as a change below, or ask the agent. A knob-only change is a register write and commits at once; anything else is linted, verified, built for its region and canaried before it commits, and rolls back if an assert trips.</p>
            </div>
          )}
        </div>
      </div>
      <ChangeSide rec={sel} />
    </>
  );
}

export function Pips({ rec }) {
  const st = stagesOf(rec);
  const stage = rec.stage || rec.status;
  const has = (n) => st.find((x) => x.name === n);
  const firstMissing = STAGES.find((n) => !has(n));
  return (
    <span className="pips">
      {STAGES.map((n) => {
        const s = has(n);
        let status = s ? (s.status === "ok" ? "done" : s.status || "done") : "todo";
        if (!s && stage === "committed") status = "skip";
        if (!s && (stage === "rejected" || stage === "failed")) status = n === firstMissing ? "fail" : "skip";
        if (!s && rec.waiting && n === firstMissing) status = "wait";
        if (n === "canary" && (stage === "rolling-back" || stage === "rolled-back")) status = "fail";
        if (n === stage && stage !== "committed" && s) status = "run";
        if (n === "committed" && stage === "committed") status = "done";
        return <i key={n} className={cls("pip", status)} title={n + (s?.note ? ": " + s.note : "")} />;
      })}
      {stage === "rolled-back" || stage === "rolling-back" ? <b className="bad">↶</b> : null}
    </span>
  );
}

function ChangeSide({ rec }) {
  useLab("changes", "frame");
  if (!rec) return (
    <div className="side">
      <div className="block"><header><h2>Changes</h2></header><p className="note">Select a change to see its stages, what it touches, its verification and its diff.</p></div>
      <KnobChange />
    </div>
  );
  const st = stagesOf(rec);
  const results = rec.verify || rec.results?.checks || rec.results?.verify || rec.checks || [];
  const resList = Array.isArray(results) ? results : Object.entries(results).map(([name, v]) => ({ name, ...(typeof v === "object" ? v : { ok: !!v }) }));
  return (
    <div className="side">
      <div className="block">
        <header><h2>{rec.id}</h2><span className="sp" /><span className={cls("sub", isFailed(rec) && "bad")}>{stageOf(rec)}</span></header>
        <p className="ctitle">{rec.title}</p>
        <Kv rows={[["by", rec.by || "—"], whenOf(rec) != null ? ["proposed", fmtPs(whenOf(rec))] : null, rec.target ? ["touches", rec.target] : null, rec.region ? ["region", rec.region] : null,
          rec.verifyPlan?.length ? ["verify", rec.verifyPlan.map(callText).join(" · ")] : null, rec.deploy?.length ? ["deploy", rec.deploy.map(callText).join(" · ")] : null,
          rec.rollbackOn?.length ? ["rolls back on", [].concat(rec.rollbackOn).join(", ")] : null, rec.knobOnly ? ["kind", "a register write: no rebuild"] : null, rec.reason ? ["last note", rec.reason, isFailed(rec)] : null]} />
        {isWaiting(rec) ? (
          <div className="ask">
            <p><b>This change waits for your approval.</b> It passed every check before this step.</p>
            <div className="row"><Btn primary onClick={() => lab.approveChange(rec.id, true)}>Approve</Btn><Btn danger onClick={() => lab.approveChange(rec.id, false)}>Reject</Btn></div>
          </div>
        ) : null}
        {(rec.stage || rec.status) === "committed" && lab.pipeline?.revert ? <Btn onClick={() => { try { lab.pipeline.revert(rec.id); lab.toast(`Reverting ${rec.id}`); lab.bump("changes"); } catch (e) { lab.toast(e.message, "bad"); } }}>Revert this change</Btn> : null}
      </div>
      <div className="block">
        <header><h2>Stages</h2></header>
        <ol className="pipe">
          {st.length ? st.map((s, i) => (
            <li key={i} className={cls(s.status, (s.name === "rolled-back" || s.name === "rejected" || s.status === "fail") && "fail")}>
              <b>{s.status === "done" || s.status === "ok" ? "✓" : s.status === "fail" ? "✕" : s.status === "wait" ? "…" : s.status === "run" ? "▸" : s.status === "skip" ? "–" : "·"}</b>
              <span className="nm">{s.name}</span>
              <span className="t">{s.t != null ? fmtPs(s.t) : ""}</span>
              {s.note ? <span className="note">{s.note}</span> : null}
            </li>
          )) : <li><span className="note">no stage history recorded</span></li>}
        </ol>
      </div>
      {resList.length ? (
        <div className="block"><header><h2>Verification</h2></header>
          <table className="rt"><tbody>{resList.map((r, i) => <tr key={i} className={r.ok === false || r.status === "fail" ? "badrow" : ""}><td><b>{r.ok === false || r.status === "fail" ? "✕" : r.status === "skip" ? "–" : "✓"}</b></td><td className="nm">{r.name || r.step}</td><td className="lastmsg">{clip(r.note || r.message || "", 120)}</td></tr>)}</tbody></table>
        </div>
      ) : null}
      <div className="block">
        <header><h2>What it changes</h2><span className="sp" /><span className="sub">{opsOf(rec).length} op{opsOf(rec).length === 1 ? "" : "s"}</span></header>
        {opsOf(rec).length ? opsOf(rec).map((o, i) => <OpView key={i} o={o} rec={rec} />) : <p className="note">{rec.diff ? "" : "No operations recorded."}</p>}
        {Array.isArray(rec.diff) ? rec.diff.map((d, i) => <div key={i}><div className="oplbl">{d.label || d.path}</div><Diff a={d.before || ""} b={d.after || ""} /></div>) : typeof rec.diff === "string" ? <pre className="diff">{rec.diff}</pre> : null}
      </div>
      <KnobChange />
    </div>
  );
}

function OpView({ o }) {
  const op = o.op || o.kind || "op";
  const target = o.path || o.module || o.target || o.name || "";
  const val = o.value ?? o.v;
  const fnSrc = (f) => (typeof f === "function" ? f.toString() : f?.src || null);
  if (op === "knob") return <div className="op"><div className="ophd"><b>knob</b> {target} → {String(val)}</div>{o.prev != null ? <p className="note">was {String(o.prev)} · a register write, no bitstream</p> : <p className="note">a register write, no bitstream</p>}</div>;
  if (op === "replace") {
    const m = o.module?._ || o.with?._ || null;
    const parts = m ? Object.entries(m).flatMap(([k, v]) => (typeof v === "function" ? [`.${k}: ${v.toString()}`] : Array.isArray(v) ? v.filter((x) => x && (typeof x.fn === "function" || x.src)).map((x) => `.${k}(${x.event || x.name || ""}): ${x.src || x.fn.toString()}`) : v && typeof v === "object" && (v.src || typeof v.fn === "function") ? [`.${k}: ${v.src || v.fn.toString()}`] : [])) : [];
    const src = parts.length ? parts.join("\n\n") : fnSrc(o.with?.src) || o.with?.source || o.src || (o.module ? `module("${m?.name || o.target}")` : "");
    return <div className="op"><div className="ophd"><b>replace</b> {target}<span className="sp" /><span className="sub">same name and ports; state migrated</span></div>{src ? <Code text={String(src)} max={240} /> : null}</div>;
  }
  if (op === "patch") {
    const p = o.patch || o.with || {};
    return <div className="op"><div className="ophd"><b>patch</b> {target}<span className="sp" /><span className="sub">re-elaborates one module</span></div><Code text={safe(() => JSON.stringify(p, (k, v) => (typeof v === "function" ? v.toString() : typeof v === "bigint" ? String(v) : v), 1), String(p))} max={220} /></div>;
  }
  return <div className="op"><div className="ophd"><b>{op}</b> {target}</div><Code text={summarize(o, 400)} /></div>;
}

// a small line diff (LCS) for source text
export function Diff({ a, b }) {
  const A = String(a).split("\n"), B = String(b).split("\n");
  if (A.length * B.length > 40000) return <Code text={b} max={240} />;
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { out.push([" ", A[i]]); i++; j++; }
    else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) { out.push(["+", B[j]]); j++; }
    else { out.push(["-", A[i]]); i++; }
  }
  return <pre className="diff">{out.map(([s, t], x) => <div key={x} className={s === "+" ? "add" : s === "-" ? "del" : ""}><i>{s}</i>{t || " "}</div>)}</pre>;
}

// turn a runtime knob as a change: the smallest change there is
function KnobChange() {
  useLab("boot");
  const knobs = (lab.simCompiled?.knobs || []).filter((k) => k.kind === "knob");
  const [path, setPath] = useState("");
  const [v, setV] = useState("");
  if (!knobs.length || !lab.pipeline) return null;
  const k = knobs.find((x) => x.path === path) || knobs[0];
  const submit = async () => {
    const scope = dslScope();
    if (!scope?.change) return lab.toast("The change() builder is not available yet", "bad");
    try {
      const ch = scope.change(`${k.path} = ${v}`).knob(k.path, +v);
      await lab.submitChange(ch, { by: "you" });
      lab.toast(`Submitted ${k.path} = ${v}`);
    } catch (e) { lab.toast(e.message, "bad"); }
  };
  return (
    <div className="block"><header><h2>Turn a knob</h2><span className="sp" /><span className="sub">as a change</span></header>
      <div className="sendev">
        <select value={k.path} onChange={(e) => setPath(e.target.value)} aria-label="Knob">{knobs.map((x) => <option key={x.path} value={x.path}>{x.path}</option>)}</select>
        <input value={v} onChange={(e) => setV(e.target.value)} placeholder={`${k.min ?? 0}…${k.max ?? "max"}`} aria-label="Value" onKeyDown={(e) => e.key === "Enter" && submit()} />
        <Btn sm onClick={submit} disabled={v === "" || isNaN(+v)}>Submit</Btn>
      </div>
      <p className="note">Bounds are enforced in hardware: a write outside [{k.min ?? 0}, {k.max ?? "max"}] is clamped.</p>
    </div>
  );
}
