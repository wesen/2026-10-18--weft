import React from "react";
import { lab } from "./lab.js";
import { useLab, Btn, Kv, Code, cls } from "./common.jsx";
import { fmtMsReal, fmtPs, fmtVal, summarize, clip } from "./fmt.js";

const GOOD = new Set(["proved", "pass", "covered", "holds", "ok"]);
const BAD = new Set(["failed", "fail", "violated", "counterexample"]);
const mark = (s) => (GOOD.has(s) ? "✓" : BAD.has(s) ? "✕" : s === "running" ? "…" : "–");

export function ProofsTab() {
  useLab("proofs", "compiled", "boot", "events", "sel");
  const c = lab.compiled?.ok ? lab.compiled : lab.simCompiled || lab.compiled;
  const P = lab.proofs;
  const results = P?.result?.results || [];
  const asserts = c?.asserts || [];
  const cfg = c?.prove;
  const sel = results.find((r, i) => (r.name || i) === lab.sel.proof) || results.find((r) => BAD.has(r.status)) || null;
  const fails = (a) => lab.events.filter((e) => e.kind === "assert" && (e.path === a.path || (e.name === a.name && (!e.path || String(e.path).startsWith(a.module || ""))))).length;
  return (
    <>
      <div className="stagewrap">
        <div className="toolbar">
          <Btn primary sm onClick={() => lab.prove()} disabled={!c?.ok || P?.status === "running"}>{P?.status === "running" ? "Proving…" : "Prove"}</Btn>
          <span className="lbl">{cfg ? `module ${cfg.module || "all"}${cfg.bmc ? ` · bmc ${cfg.bmc}` : ""}${cfg.induction ? " · induction" : ""}${cfg.engine ? ` · asked for ${cfg.engine}` : ""}` : asserts.length ? "no .prove() config: every assertion, explicit-state search" : "no properties"}</span>
          <span className="sp" />
          <span className="lbl">explicit-state model checking over all inputs, within a state budget</span>
        </div>
        <div className="scroll">
          {P?.status === "error" ? <p className="empty padded bad">The prover stopped: {P.message}</p> : null}
          {results.length ? (
            <table className="rt proofs">
              <thead><tr><th /><th>property</th><th>kind</th><th>module</th><th>status</th><th className="num">depth</th><th className="num">states</th><th>note</th></tr></thead>
              <tbody>{results.map((r, i) => (
                <tr key={i} className={cls("clickable", BAD.has(r.status) && "badrow", sel === r && "sel")} onClick={() => lab.select({ proof: r.name || i })}>
                  <td className={BAD.has(r.status) ? "bad" : GOOD.has(r.status) ? "ok" : "dim"}><b>{mark(r.status)}</b></td>
                  <td className="nm">{r.name}</td><td>{r.kind}</td><td>{r.module || "—"}</td>
                  <td className={cls(BAD.has(r.status) && "bad")}>{r.status}</td>
                  <td className="num">{r.depth ?? "—"}</td><td className="num">{r.states ?? r.explored ?? "—"}</td>
                  <td className="lastmsg">{clip(r.note || r.message || "", 80)}</td>
                </tr>
              ))}</tbody>
            </table>
          ) : <p className="empty padded">{P?.status === "running" ? "Searching the reachable states…" : !c?.ok ? "The design does not compile yet." : asserts.length ? <>Press <b>Prove</b> to check the {asserts.length} propert{asserts.length === 1 ? "y" : "ies"} below for every input sequence, not just the scenarios.</> : <>No properties. Add <code>.assert(name, $ =&gt; …)</code>, <code>.assume()</code> or <code>.cover()</code> to a module.</>}</p>}
          {P?.result?.note ? <p className="note padded">{P.result.note}</p> : null}
          {asserts.length ? (
            <section className="rsec">
              <h3>Properties in the live simulation <span className="dim">· checked on every cycle</span></h3>
              <table className="rt">
                <thead><tr><th>property</th><th>kind</th><th>module</th><th>domain</th><th>line</th><th className="num">failures so far</th></tr></thead>
                <tbody>{asserts.map((a, i) => { const n = fails(a); return (
                  <tr key={i} className={n ? "badrow" : ""}><td className="nm">{a.name}</td><td>{a.kind}</td><td>{a.module || "—"}</td><td>{a.domain || "—"}</td>
                    <td>{a.line ? <button type="button" className="link" onClick={() => lab.goto(a.line)}>{a.line}</button> : "—"}</td><td className={cls("num", n && "bad")}>{lab.sim ? n : "—"}</td></tr>
                ); })}</tbody>
              </table>
            </section>
          ) : null}
        </div>
      </div>
      <ProofSide r={sel} P={P} />
    </>
  );
}

// a counterexample: rows are cycles, columns are signals
function normTrace(tr) {
  if (!tr) return null;
  if (Array.isArray(tr)) {
    const rows = tr.map((x, i) => (x && typeof x === "object" ? { cycle: x.cycle ?? i, ...(x.signals || x.values || x.state || x) } : { cycle: i, value: x }));
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => k !== "cycle" && k !== "signals")))];
    return { rows, cols };
  }
  if (typeof tr === "object") {
    const cols = Object.keys(tr).filter((k) => Array.isArray(tr[k]));
    const n = Math.max(0, ...cols.map((k) => tr[k].length));
    return { rows: Array.from({ length: n }, (_, i) => ({ cycle: i, ...Object.fromEntries(cols.map((k) => [k, tr[k][i]])) })), cols };
  }
  return null;
}

function ProofSide({ r, P }) {
  if (!r) return (
    <div className="side"><div className="block"><header><h2>Proofs</h2></header>
      <p className="note">The same <code>.assert()</code> lambdas are checked on every simulated cycle, proved here by searching every reachable state of the module under every input, and can be built into hardware as monitors. A failed proof comes with the shortest trace that breaks it.</p>
      {P?.ms != null ? <Kv rows={[["last run", fmtMsReal(P.ms)], ["results", (P.result?.results || []).length]]} /> : null}
    </div></div>
  );
  const T = normTrace(r.trace || r.counterexample || r.witness);
  return (
    <div className="side wide">
      <div className="block"><header><h2>{r.name}</h2><span className="sp" /><span className={cls("sub", BAD.has(r.status) && "bad")}>{r.kind} · {r.status}</span></header>
        <Kv rows={[["module", r.module || "—"], ["depth", r.depth ?? "—"], ["states", r.states ?? r.explored ?? "—"], r.ms != null ? ["time", fmtMsReal(r.ms)] : null, r.note || r.message ? ["note", r.note || r.message] : null]} />
      </div>
      {T ? (
        <div className="block"><header><h2>{BAD.has(r.status) ? "Counterexample" : r.kind === "cover" ? "Witness" : "Trace"}</h2><span className="sp" /><span className="sub">{T.rows.length} cycles</span></header>
          <div className="tablewrap"><table className="rt trace">
            <thead><tr><th className="num">cycle</th>{T.cols.map((k) => <th key={k}>{k}</th>)}</tr></thead>
            <tbody>{T.rows.map((row, i) => <tr key={i} className={i === T.rows.length - 1 && BAD.has(r.status) ? "badrow" : ""}><td className="num">{row.cycle}</td>{T.cols.map((k) => { const v = row[k]; const bit = v === 0 || v === 1 || v === true || v === false; return <td key={k} className={cls("num", bit && "bitcell", bit && (v === 1 || v === true) && "hi")}>{bit ? (v === 1 || v === true ? "1" : "0") : fmtVal(v)}</td>; })}</tr>)}</tbody>
          </table></div>
        </div>
      ) : r.trace ? <div className="block"><Code text={summarize(r.trace, 6000)} /></div> : null}
    </div>
  );
}
