import React, { useState } from "react";
import { lab } from "./lab.js";
import { useLab, Btn, Seg, Kv, Code, Meter, cls } from "./common.jsx";
import { safe, natural } from "./engine.js";
import { saveFile } from "./App.jsx";
import * as PASSES from "../core/passes.js";
import { compile } from "../core/compile.js";
import { fmtHz, fmtNs, fmtCount, clip, summarize } from "./fmt.js";

const DELAY = { ice40: "iCE40 LUT4 ≈ 0.6 ns + 0.9 ns routing per level", xc7: "7-series LUT6 ≈ 0.12 ns + 0.45 ns routing per level", ecp5: "ECP5 LUT4 ≈ 0.25 ns + 0.6 ns routing per level" };
const pdv = (pd, ...keys) => { for (const k of keys) if (pd?.[k] != null) return Number(pd[k]); return null; };
const mhz = (f) => (f == null ? "—" : fmtHz(f > 1e4 ? f : f * 1e6));

export function ReportTab() {
  useLab("compiled", "boot", "sel");
  const c = lab.compiled?.ok ? lab.compiled : lab.simCompiled?.ok ? lab.simCompiled : lab.compiled;
  const [file, setFile] = useState(null);
  const [target, setTarget] = useState(null);
  const R0 = c?.report || {};
  const targets = R0.targets && typeof R0.targets === "object" ? Object.keys(R0.targets) : [];
  const R = target && R0.targets?.[target] ? R0.targets[target] : R0;
  const res = R.resources || {};
  const partObj = R.part && typeof R.part === "object" ? R.part : null;
  const partName = partObj ? partObj.part || partObj.name : R.part || c?.board?.part || "?";
  const pd = partObj || c?.board?.partData || {};
  const fam = String(R.family || c?.board?.family || "").toLowerCase();
  const timing = Object.entries(R.timing || {}).filter(([, t]) => t && typeof t === "object");
  const per = Object.entries(R.perModule || {}).sort((a, b) => natural(a[0], b[0]));
  const regs = Array.isArray(R.registers) ? R.registers : [];
  const checks = Array.isArray(R.checks) ? R.checks : [];
  // files with their text come back from runPipeline next to the report (the report itself lists paths and sizes)
  const emits = (Array.isArray(c?.emits) && c.emits.some((e) => e?.files?.some((f) => f.text != null)) ? c.emits : Array.isArray(R.emits) ? R.emits : []).filter((e) => e && Array.isArray(e.files));
  const mems = Array.isArray(R.memories) ? R.memories : [];
  const census = R.netlist?.counts && typeof R.netlist.counts === "object" ? Object.entries(R.netlist.counts) : [];
  const lat = R.latencies && typeof R.latencies === "object" ? Object.entries(R.latencies) : [];
  const vfiles = c?.ok ? lab.verilog() : [];
  const allFiles = [...emits.flatMap((e) => e.files.map((f) => ({ ...f, backend: e.backend }))), ...vfiles.filter((v) => !emits.some((e) => e.files.some((f) => f.path === v.path))).map((f) => ({ ...f, backend: "verilog (emitVerilog)" }))];
  if (!c || (!c.report && !c.ok)) return <div className="stagewrap"><div className="toolbar"><span className="lbl">build report</span></div><p className="empty padded">No report: the design does not compile yet. Fix the errors in the editor.</p></div>;
  const tile = (label, used, avail, extra) => (
    <div className={cls("rtile", avail && used > avail && "bad")}>
      <label>{label}</label>
      <b>{used == null ? "—" : fmtCount(used).replace(" ", "")}</b>
      <span className="of">{avail ? "of " + fmtCount(avail).replace(" ", "") + ` · ${((used / avail) * 100).toFixed(used / avail < 0.1 ? 1 : 0)} %` : extra || ""}</span>
      {avail ? <Meter f={used / avail} bad={used > avail} /> : null}
    </div>
  );
  return (
    <>
      <div className="stagewrap">
        <div className="toolbar">
          {targets.length > 1 ? <Seg label="Target" items={targets.map((t) => [t, t])} value={target || targets[0]} onChange={setTarget} /> : null}
          <span className="lbl"><b>{partName}</b> · {R.family || c?.board?.family || "?"}{R.target?.name ? ` · target ${R.target.name}` : ""} · estimates from the delay model, not a vendor tool</span>
          <span className="sp" />
          <Btn sm onClick={() => saveFile(`${c.name || "design"}-report.json`, safe(() => JSON.stringify({ part: partName, family: R.family, resources: res, perModule: R.perModule, timing: R.timing, memories: mems, registers: regs, checks }, (k, v) => (typeof v === "bigint" ? String(v) : v), 2), "{}"), "the report")}>Download JSON</Btn>
        </div>
        <div className="scroll report">
          <div className="rtiles">
            {tile("LUTs", res.luts, pdv(pd, "luts", "lut"))}
            {tile("FFs", res.ffs, pdv(pd, "ffs", "ff"))}
            {tile("BRAM", res.brams, pdv(pd, "brams", "bram", "bramCount"))}
            {tile("DSP", res.dsps, pdv(pd, "dsps", "dsp"))}
            {tile("CARRY", res.carry, null, "carry cells")}
            {tile("IOs", res.ios, pdv(pd, "ios", "io"))}
          </div>

          <section className="rsec">
            <h3>Timing <span className="dim">· {R.delayModel ? `${R.delayModel.family || fam}: LUT ≈ ${R.delayModel.lutNs} ns + ${R.delayModel.routeNs} ns routing per level` : DELAY[fam] || "per-family delay model"}</span></h3>
            {timing.length ? (
              <table className="rt">
                <thead><tr><th>domain</th><th className="num">clock</th><th className="num">period</th><th className="num">worst path</th><th className="num">slack</th><th className="num">fmax</th><th className="num">levels</th><th>critical path</th></tr></thead>
                <tbody>{timing.map(([d, t]) => (
                  <tr key={d} className={cls("clickable", t.slack < 0 && "badrow", lab.sel.domain === d && "sel")} onClick={() => lab.select({ domain: d })}>
                    <td className="nm">{d}</td><td className="num">{t.hz ? fmtHz(t.hz) : "—"}</td><td className="num">{fmtNs(t.periodNs)}</td><td className="num">{fmtNs(t.worstNs)}</td>
                    <td className={cls("num", t.slack < 0 ? "bad" : "ok")}>{t.slack != null ? (t.slack >= 0 ? "+" : "") + (+t.slack).toFixed(2) + " ns" : "—"}</td>
                    <td className="num">{mhz(t.fmax)}</td><td className="num">{t.levels ?? "—"}</td>
                    <td className="lastmsg">{(t.path || []).length ? `${t.path.length} nodes · from line ${firstLine(t.path) ?? "?"}` : "—"}</td>
                  </tr>
                ))}</tbody>
              </table>
            ) : <p className="note">No timing yet.</p>}
          </section>

          <section className="rsec">
            <h3>Per module</h3>
            {per.length ? (
              <table className="rt">
                <thead><tr><th>instance</th><th className="num">LUTs</th><th className="mcol" /><th className="num">FFs</th><th className="num">BRAM</th><th className="num">DSP</th></tr></thead>
                <tbody>{per.map(([p, r]) => (
                  <tr key={p} className="clickable" onClick={() => { lab.select({ instance: p }); }} onDoubleClick={() => lab.setUI({ right: "modules" })}>
                    <td className="nm">{p}</td><td className="num">{r.luts ?? "—"}</td><td className="mcol"><Meter f={(r.luts || 0) / Math.max(1, res.luts || 1)} /></td><td className="num">{r.ffs ?? "—"}</td><td className="num">{r.brams ?? "—"}</td><td className="num">{r.dsps ?? "—"}</td>
                  </tr>
                ))}</tbody>
              </table>
            ) : <p className="note">No per-module breakdown.</p>}
          </section>

          <section className="rsec">
            <h3>Register map <span className="dim">· knobs, status and irqs behind the bridge</span></h3>
            {regs.length ? (
              <table className="rt">
                <thead><tr><th className="num">addr</th><th>register</th><th>kind</th><th>type</th><th className="num">reset</th><th className="num">min</th><th className="num">max</th></tr></thead>
                <tbody>{regs.map((r, i) => (
                  <tr key={i}><td className="num">{r.addr != null ? "0x" + Number(r.addr).toString(16).padStart(2, "0") : "—"}</td><td className="nm">{r.path || r.name}</td><td>{r.kind}</td><td>{typeof r.type === "object" ? r.type?.k + r.type?.w : r.type || "—"}</td><td className="num">{r.reset ?? "—"}</td><td className="num">{r.min ?? "—"}</td><td className="num">{r.max ?? "—"}</td></tr>
                ))}</tbody>
              </table>
            ) : <p className="note">No runtime registers.</p>}
          </section>

          {mems.length ? (
            <section className="rsec">
              <h3>Memories <span className="dim">· where mem.infer put each memory and table</span></h3>
              <table className="rt">
                <thead><tr><th>memory</th><th>kind</th><th>placed in</th><th className="num">words × width</th><th className="num">BRAM</th><th>primitive</th></tr></thead>
                <tbody>{mems.map((m, i) => (
                  <tr key={i}><td className="nm">{m.path}</td><td>{m.kind || "—"}</td><td>{m.place || "—"}</td><td className="num">{m.words ?? "?"} × {m.width ?? "?"}</td><td className="num">{m.brams || m.sprams ? (m.brams || 0) + (m.sprams ? ` + ${m.sprams} SPRAM` : "") : "0"}</td><td>{m.primitive || "—"}</td></tr>
                ))}</tbody>
              </table>
            </section>
          ) : null}

          {R.explore ? <Explore c={c} ex={R.explore} /> : null}

          {lat.length ? (
            <section className="rsec">
              <h3>Pipelines <span className="dim">· latency the compiler chose</span></h3>
              <div className="chips">{lat.map(([p, l]) => <span key={p} className="chip-s">{p} · {l} cycle{l === 1 ? "" : "s"}</span>)}</div>
            </section>
          ) : null}

          {census.length ? (
            <section className="rsec">
              <h3>Netlist <span className="dim">· estimated technology cells</span></h3>
              <div className="chips">{census.map(([t, n]) => <span key={t} className="chip-s">{t} <b>{n}</b></span>)}</div>
            </section>
          ) : null}

          <section className="rsec">
            <h3>Checks <span className="dim">· your checks on the report, and what the passes reported</span></h3>
            {checks.length ? checks.map((k, i) => {
              const bad = k.ok === false || k.status === "fail" || k.level === "error";
              const warn = k.level === "warn" || k.level === "warning";
              return (
                <div key={i} className={cls("check", bad && "bad", warn && "warn")}>
                  <b>{bad ? "✕" : warn ? "!" : k.kind === "diag" ? "i" : "✓"}</b>
                  <span className="nm">{k.name || k.code || k.pass || "check"}</span>
                  {k.message ? <span className="dim">{k.message}</span> : null}
                  {k.line ? <button type="button" className="link" onClick={() => lab.goto(k.line)}>line {k.line}</button> : null}
                </div>
              );
            }) : <p className="note">No checks. Add <code>c.check(name, r =&gt; true | message)</code> in <code>.compile()</code>.</p>}
          </section>

          <section className="rsec">
            <h3>Emitted files</h3>
            {allFiles.length ? (
              <table className="rt">
                <thead><tr><th>file</th><th>backend</th><th className="num">lines</th><th /></tr></thead>
                <tbody>{allFiles.map((f, i) => (
                  <tr key={i} className={cls("clickable", file?.path === f.path && "sel")} onClick={() => setFile(f)}>
                    <td className="nm">{f.path}</td><td>{f.backend}</td><td className="num">{f.text != null ? String(f.text).split("\n").length : f.bytes != null ? `${f.bytes} B` : "—"}</td>
                    <td><button type="button" className="link" onClick={(e) => { e.stopPropagation(); saveFile(String(f.path).split("/").pop(), String(f.text || ""), f.path); }}>download</button></td>
                  </tr>
                ))}</tbody>
              </table>
            ) : <p className="note">Nothing emitted.</p>}
          </section>
        </div>
      </div>
      <ReportSide c={c} R={R} file={file} />
    </>
  );
}
function firstLine(path) { for (const n of path || []) { const o = (n.origin || [])[0] || n.origin; if (o?.line) return o.line; } return null; }

function ReportSide({ c, R, file }) {
  useLab("sel");
  if (file) return (
    <div className="side wide"><div className="block"><header><h2>{String(file.path).split("/").pop()}</h2><span className="sp" /><button type="button" className="link" onClick={() => saveFile(String(file.path).split("/").pop(), String(file.text || ""), file.path)}>download</button></header>
      <Code text={clip(String(file.text || ""), 200000)} /></div></div>
  );
  const d = lab.sel.domain && R.timing?.[lab.sel.domain] ? lab.sel.domain : Object.keys(R.timing || {})[0];
  const t = d ? R.timing[d] : null;
  return (
    <div className="side">
      <div className="block"><header><h2>Critical path</h2><span className="sp" /><span className="sub">{d || "—"}</span></header>
        {t ? <>
          <Kv rows={[["clock", t.hz ? fmtHz(t.hz) : "—"], ["slack", t.slack != null ? (+t.slack).toFixed(2) + " ns" : "—", t.slack < 0], ["fmax", mhz(t.fmax)], ["levels", t.levels ?? "—"]]} />
          <ol className="cpath">{(t.path || []).map((n, i) => {
            const o = (Array.isArray(n.origin) ? n.origin[0] : n.origin) || {};
            return <li key={i}><b>{n.op}</b>{n.id != null ? <span className="dim"> %{n.id}</span> : null}{n.width ? <span className="dim"> {n.width}b</span> : null}{n.delay != null ? <span className="dim"> {(+n.delay).toFixed(2)} ns</span> : null}
              {o.line ? <> · <button type="button" className="link" onClick={() => lab.goto(o.line)}>line {o.line}</button></> : null}
              {o.src ? <code>{clip(o.src, 90)}</code> : null}
              {n.id != null ? <button type="button" className="link node" onClick={() => { lab.setUI({ right: "graph", graphMode: "dag" }); lab.select({ domain: d, node: "n" + n.id }); }}>in the DAG</button> : null}
            </li>;
          })}</ol>
          {t.slack < 0 ? <p className="note bad">Negative slack: the path from the source lines above is too slow for the clock. Pipelining the stream path (<code>.pipelined()</code>), a narrower type or a ROM instead of logic are the usual fixes.</p> : null}
        </> : <p className="note">No timing data.</p>}
      </div>
    </div>
  );
}

// design-space exploration (F-15): the knob grid recompiled point by point, the Pareto front kept
function Explore({ c, ex }) {
  const [state, setState] = useState(ex.points ? "done" : "idle");
  const [, force] = useState(0);
  const run = () => {
    if (typeof PASSES.runExplore !== "function") return lab.toast("Exploration is not available in this build", "bad");
    setState("running");
    setTimeout(() => {
      try {
        PASSES.runExplore(ex, (overrides) => compile(lab.script, { file: lab.preset?.file, overrides, knobs: overrides, explore: false }));
        setState("done");
      } catch (e) { lab.toast("Exploration stopped: " + e.message, "bad"); setState("idle"); }
      force((x) => x + 1);
    }, 30);
  };
  const pts = ex.points || [];
  const keys = [...new Set(pts.flatMap((p) => Object.keys(p.metrics || {})))].filter((k) => pts.some((p) => typeof p.metrics?.[k] === "number"));
  const knobs = (ex.spec?.knobs || []).map((k) => k.path);
  const [kx, ky] = keys;
  const W = 420, H = 200, P = 34;
  const xs = pts.filter((p) => p.metrics && kx && ky).map((p) => [Number(p.metrics[kx]), Number(p.metrics[ky]), p]);
  const lo = (i) => Math.min(...xs.map((q) => q[i])), hi = (i) => Math.max(...xs.map((q) => q[i]));
  const X = (v) => P + ((v - lo(0)) / (hi(0) - lo(0) || 1)) * (W - P - 10), Y = (v) => H - P + 6 - ((v - lo(1)) / (hi(1) - lo(1) || 1)) * (H - P - 4);
  return (
    <section className="rsec">
      <h3>Explore <span className="dim">· {knobs.length} build-time knob{knobs.length === 1 ? "" : "s"}: {knobs.join(", ") || "—"}</span></h3>
      <div className="ctlrow">
        <Btn sm primary onClick={run} disabled={state === "running"}>{state === "running" ? "Exploring…" : pts.length ? "Explore again" : "Run the exploration"}</Btn>
        <span className="dim">{pts.length ? `${pts.length} points · ${pts.filter((p) => p.kept).length} kept · ${pts.filter((p) => p.pareto).length} on the front` : "every point is a recompile; the IR cache makes the later ones partial"}</span>
      </div>
      {xs.length > 1 ? (
        <svg className="scatter" width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMinYMin meet">
          <line x1={P} y1={H - P + 6} x2={W - 6} y2={H - P + 6} className="ax" /><line x1={P} y1={6} x2={P} y2={H - P + 6} className="ax" />
          <text x={W - 8} y={H - 8} className="axl" textAnchor="end">{kx} →</text><text x={4} y={14} className="axl">{ky}</text>
          {xs.map(([a, b, p], i) => <circle key={i} cx={X(a)} cy={Y(b)} r={p.pareto ? 4 : 3} className={p.pareto ? "front" : p.kept ? "kept" : "out"}><title>{knobs.map((k) => `${k}=${p.overrides[k]}`).join(" ")} · {kx} {a} · {ky} {b}</title></circle>)}
        </svg>
      ) : null}
      {pts.length ? (
        <table className="rt">
          <thead><tr>{knobs.map((k) => <th key={k}>{k}</th>)}{keys.map((k) => <th key={k} className="num">{k}</th>)}<th /></tr></thead>
          <tbody>{pts.map((p, i) => <tr key={i} className={p.pareto ? "sel" : p.kept ? "" : "dimrow"}>{knobs.map((k) => <td key={k}>{String(p.overrides[k])}</td>)}{keys.map((k) => <td key={k} className="num">{p.metrics?.[k] ?? "—"}</td>)}<td>{p.pareto ? "◆ front" : p.error ? clip(p.error, 40) : p.kept ? "" : "out"}</td></tr>)}</tbody>
        </table>
      ) : null}
    </section>
  );
}
