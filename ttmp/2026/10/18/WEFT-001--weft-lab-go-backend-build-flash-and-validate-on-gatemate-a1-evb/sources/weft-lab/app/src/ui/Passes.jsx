import React, { useState } from "react";
import { lab } from "./lab.js";
import { useLab, Btn, Seg, Kv, Code, cls } from "./common.jsx";
import { safe } from "./engine.js";
import { fmtMsReal, clip, summarize } from "./fmt.js";

const snapText = (s) => {
  if (!s) return null;
  if (typeof s === "string") return s;
  if (typeof s.text === "string") return s.text;
  if (typeof s === "object") return Object.entries(s).map(([k, v]) => `// ${k}\n${typeof v === "string" ? v : v?.text ?? summarize(v, 4000)}`).join("\n\n");
  return String(s);
};
const levelOf = (st) => st.level || "";

export function PassesTab() {
  useLab("compiled", "boot", "sel");
  const c = lab.compiled?.stages?.length || !lab.simCompiled ? lab.compiled : lab.simCompiled;
  const [view, setView] = useState("stages");
  const stages = c?.stages || [];
  const doms = Object.keys(c?.domains || {});
  const [dom, setDom] = useState(null);
  const d = doms.includes(dom) ? dom : doms[0];
  const tm = c?.timings || {};
  const sel = lab.sel.pass;
  const totalPassMs = stages.reduce((a, s) => a + (s.passes || []).reduce((b, p) => b + (p.ms || 0), 0), 0);
  const maxNodes = Math.max(1, ...stages.flatMap((s) => (s.passes || []).flatMap((p) => [p.nodesBefore || 0, p.nodesAfter || 0])));
  const plan = c?.report?.explainPlan ?? c?.report?.plan ?? c?.explainPlan ?? null;
  return (
    <>
      <div className="stagewrap">
        <div className="toolbar">
          <Seg label="View" items={[["stages", "Stages"], ["ir", "IR now"], ["plan", "Plan"], ["hir", "HIR"]]} value={view} onChange={setView} />
          {view === "ir" && doms.length > 1 ? <Seg label="Domain" items={doms.map((x) => [x, x])} value={d} onChange={setDom} sm /> : null}
          <span className="sp" />
          <span className="lbl">compiled in <b>{fmtMsReal(c?.ms ?? tm.total)}</b>{tm.front != null ? ` · front ${fmtMsReal(tm.front)}` : ""}{tm.lower != null ? ` · lower ${fmtMsReal(tm.lower)}` : ""}{totalPassMs ? ` · passes ${fmtMsReal(totalPassMs)}` : ""}</span>
        </div>
        <div className="scroll">
          {view === "stages" ? (
            stages.length ? (
              <table className="rt passes">
                <thead><tr><th>stage · pass</th><th className="num">ms</th><th className="num">nodes before</th><th className="num">after</th><th className="mcol" /><th className="num">diags</th><th>note</th></tr></thead>
                <tbody>
                  {stages.map((st, si) => (
                    <React.Fragment key={si}>
                      <tr className="stagerow"><td colSpan={7}><b>{st.name}</b><span className="dim"> {levelOf(st)}{st.ms != null ? ` · ${(+st.ms).toFixed(st.ms < 1 ? 2 : 1)} ms` : ""}{st.note ? ` · ${st.note}` : st.fixpoint ? ` · fixpoint ${st.iterations ?? ""}` : ""}</span>{st.snapshot ? <button type="button" className="link" onClick={() => lab.select({ pass: `${si}:snap` })}> snapshot</button> : null}{st.inspect ? <button type="button" className="link" onClick={() => lab.select({ pass: `${si}:inspect` })}> inspection</button> : null}</td></tr>
                      {(st.passes || []).map((p, pi) => {
                        const key = `${si}:${pi}`;
                        const nd = (p.diags || []).length, bad = (p.diags || []).some((x) => x.level === "error");
                        const delta = p.nodesAfter != null && p.nodesBefore != null ? p.nodesAfter - p.nodesBefore : null;
                        return (
                          <tr key={key} className={cls("clickable", sel === key && "sel", bad && "badrow")} onClick={() => lab.select({ pass: key })}>
                            <td className="nm pass">{p.name}</td>
                            <td className="num">{p.ms != null ? p.ms.toFixed(p.ms < 1 ? 2 : 1) : "—"}</td>
                            <td className="num">{p.nodesBefore ?? "—"}</td>
                            <td className={cls("num", delta < 0 && "ok")}>{p.nodesAfter ?? "—"}{delta ? <small> {delta > 0 ? "+" : ""}{delta}</small> : null}</td>
                            <td className="mcol"><div className="meter two"><i style={{ width: ((p.nodesAfter ?? p.nodesBefore ?? 0) / maxNodes) * 100 + "%" }} /></div></td>
                            <td className={cls("num", bad && "bad")}>{nd || ""}</td>
                            <td className="lastmsg">{clip(p.note || (p.diags || [])[0]?.message || "", 90)}</td>
                          </tr>
                        );
                      })}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            ) : <p className="empty padded">{c?.ok === false ? "No stages: the design did not get as far as the pass pipeline. Fix the errors in the editor." : "The pass pipeline reported no stages."}</p>
          ) : null}
          {view === "ir" ? (d && c.domains[d]?.graph ? <IrNow G={c.domains[d].graph} d={d} hz={c.domains[d].hz} /> : <p className="empty padded">No DAG yet.</p>) : null}
          {view === "plan" ? (plan ? <Code text={typeof plan === "string" ? plan : Array.isArray(plan) ? plan.join("\n") : summarize(plan, 20000)} /> : stages.length ? <Code text={stages.map((s) => `${s.name}${s.level ? " [" + s.level + "]" : ""}\n${(s.passes || []).map((p) => "  " + p.name).join("\n")}`).join("\n")} /> : <p className="empty padded">No plan.</p>) : null}
          {view === "hir" ? (c?.hir ? <Code text={clip(safe(() => JSON.stringify(c.hir, (k, v) => (typeof v === "bigint" ? v + "n" : typeof v === "function" ? "ƒ" : v), 1), "(not serializable)"), 60000)} /> : <p className="empty padded">No HIR.</p>) : null}
        </div>
      </div>
      <PassSide c={c} stages={stages} />
    </>
  );
}

function IrNow({ G, d, hz }) {
  const st = safe(() => G.stats(), { nodes: 0, ops: {} });
  return (
    <div className="irnow">
      <div className="toolbar sub"><span className="lbl"><b>{d}</b>{hz ? ` · ${(hz / 1e6).toFixed(3)} MHz` : ""} · {st.nodes} nodes · {st.regs} registers · {st.inputs} inputs · {st.outputs} outputs · hash {safe(() => G.hash(), "—")}</span></div>
      <Code text={safe(() => G.print({ max: 800 }), "")} />
    </div>
  );
}

function PassSide({ c, stages }) {
  useLab("sel");
  const key = lab.sel.pass;
  const [si, pi] = key ? String(key).split(":") : [];
  const st = key ? stages[+si] : null;
  const p0 = st && pi !== "snap" && pi !== "inspect" ? st.passes?.[+pi] : null;
  if (!st || (pi !== "snap" && pi !== "inspect" && !p0)) {
    const diags = (c?.diags || []).filter((d) => d.code && !["capture"].includes("x"));
    return (
      <div className="side"><div className="block"><header><h2>Passes</h2></header>
        <p className="note">Hardware lambdas are parsed into HIR, flattened into one DAG per clock domain, optimized to a fixpoint, mapped onto the part, then placed and routed (estimated here). Every node keeps the source text it came from through every pass. Click a pass to see what it did.</p>
        <Kv rows={[["stages", stages.length], ["passes", stages.reduce((a, s) => a + (s.passes || []).length, 0)], ["diagnostics", diags.length]]} />
      </div></div>
    );
  }
  if (pi === "snap" || pi === "inspect") return <div className="side wide"><div className="block"><header><h2>{st.name}</h2><span className="sp" /><span className="sub">{pi === "snap" ? "snapshot" + (st.snapshot?.level ? " · " + st.snapshot.level : "") : "inspection"}</span></header><Code text={snapText(pi === "snap" ? st.snapshot : st.inspect)} /></div></div>;
  const p = st.passes?.[+pi];
  if (!p) return null;
  return (
    <div className="side">
      <div className="block"><header><h2>{p.name}</h2><span className="sp" /><span className="sub">{st.name}{st.level ? " · " + st.level : ""}</span></header>
        <Kv rows={[["time", p.ms != null ? p.ms.toFixed(2) + " ms" : "—"], ["nodes", `${p.nodesBefore ?? "—"} → ${p.nodesAfter ?? "—"}`], p.changed != null ? ["changed the IR", p.changed ? "yes" : "no"] : null, p.reused ? ["reused", "from the stage cache"] : null, p.note ? ["note", p.note] : null]} />
      </div>
      <div className="block"><header><h2>Diagnostics</h2><span className="sp" /><span className="sub">{(p.diags || []).length}</span></header>
        {(p.diags || []).length ? p.diags.map((d, i) => (
          <button key={i} type="button" className={cls("diag", d.level === "error" && "bad")} onClick={() => d.line && lab.goto(d.line)}>
            <b>{d.level === "error" ? "✕" : d.level === "info" ? "i" : "!"}</b>{d.line ? <span className="ln">line {d.line}</span> : null}<span>{d.message}</span>
          </button>
        )) : <p className="note">None.</p>}
      </div>
      {p.snapshot || p.inspect ? <div className="block"><header><h2>{p.inspect ? "Inspection" : "Snapshot"}</h2></header><Code text={snapText(p.snapshot || p.inspect)} max={360} /></div> : null}
    </div>
  );
}
