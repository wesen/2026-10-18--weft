import React, { useEffect, useRef, useState } from "react";
import { lab, GROUP_ORDER, SPEEDS } from "./lab.js";
import { useLab, Btn, Tog, Pill, Tabs, Menu, cls } from "./common.jsx";
import { Ide } from "./Ide.jsx";
import { BoardTab } from "./Board.jsx";
import { ModulesTab } from "./Modules.jsx";
import { GraphTab } from "./Graph.jsx";
import { WavesTab } from "./Waves.jsx";
import { PassesTab } from "./Passes.jsx";
import { ReportTab } from "./Report.jsx";
import { ChangesTab } from "./Changes.jsx";
import { ProofsTab } from "./Proofs.jsx";
import { fmtClock, fmtCount, fmtSpeed } from "./fmt.js";
import { isWaiting, simTime } from "./engine.js";

export function App() {
  useLab("ready", "ui");
  const [w, setW] = useState(() => { try { return +localStorage.getItem("weft-lab:edw") || 540; } catch { return 540; } });
  const drag = useRef(null);
  useEffect(() => {
    const key = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "\\") { e.preventDefault(); lab.setUI({ ide: !lab.ui.ide }); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    const el = document.documentElement;
    if (lab.ui.theme === "auto") el.removeAttribute("data-theme"); else el.setAttribute("data-theme", lab.ui.theme);
    lab.bump("theme");
  }, [lab.ui.theme]);
  const onSplit = (e) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = w;
    const mv = (ev) => setW(Math.max(320, Math.min(window.innerWidth - 420, w0 + ev.clientX - x0)));
    const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); try { localStorage.setItem("weft-lab:edw", String(drag.current)); } catch {} };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };
  drag.current = w;
  if (!lab.ready) return <div id="app"><Header /><div className="boot-screen"><p>{lab.error ? "Could not start: " + lab.error : "Compiling the first design…"}</p></div></div>;
  return (
    <div id="app">
      <Header />
      <div id="work" className={lab.ui.ide ? "" : "noide"} style={{ "--edw": w + "px" }}>
        {lab.ui.ide ? <Ide /> : null}
        {lab.ui.ide ? <div id="split" onPointerDown={onSplit} role="separator" aria-orientation="vertical" /> : null}
        <Workspace />
      </div>
      <Toasts />
    </div>
  );
}

function Toasts() {
  useLab("toast");
  return <div className="toasts" aria-live="polite">{lab.toasts.map((t) => <div key={t.id} className={cls("toast", t.tone)}>{t.text}</div>)}</div>;
}

async function saveFile(name, data, what = "the file") {
  const dl = await window.claude?.use?.("downloads")?.catch?.(() => null);
  if (dl) { try { await dl.save({ filename: name, data }); lab.toast("Saved " + name); } catch { lab.toast("Download was declined", "bad"); } return; }
  try { await navigator.clipboard.writeText(data); lab.toast(`Copied ${what} (downloads are not available here)`); } catch { lab.toast("Downloads are not available here", "bad"); }
}
export { saveFile };

function Header() {
  useLab("preset", "ui", "stats", "run", "scen", "changes", "os", "code", "diags", "boot");
  const [menu, setMenu] = useState(false);
  const [save, setSave] = useState(false);
  const s = lab.summary();
  const p = lab.preset;
  const fileRef = useRef(null);
  const groups = GROUP_ORDER.map((g) => [g, lab.presets.filter((x) => (g === "Mine" ? x.mine : x.group === g && !x.mine))]).filter(([, l]) => l.length);
  const slug = () => (p?.id || "design") + "-" + (p?.title || "design").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const downloadJs = () => { setSave(false); saveFile(slug() + ".js", lab.script, "the script"); };
  const downloadV = () => {
    setSave(false);
    const files = lab.verilog();
    if (!files.length) return lab.toast(lab.compiled?.ok ? "The Verilog emitter produced nothing yet" : "Fix the errors first; Verilog comes from a compiled design", "bad");
    const text = files.map((f) => (files.length > 1 ? `// ===== ${f.path} =====\n` : "") + f.text).join("\n\n");
    saveFile(slug() + ".v", text, "the Verilog");
  };
  const importFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const id = lab.newPresetFromText(await f.text());
    setMenu(false);
    lab.load(id);
  };
  return (
    <header className="bar">
      <div className="brand">Weft Lab <i>definition → DAG → board</i></div>
      <div className="proj">
        <button type="button" className="projbtn" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu}>
          <span className="pcode">{p?.id}</span><span className="ptitle">{p?.title || "…"}</span><span className="caret">▾</span>
        </button>
        <Menu open={menu} onClose={() => setMenu(false)} className="presets">
          {groups.map(([g, list]) => (
            <React.Fragment key={g}>
              <div className="grp">{g}</div>
              {list.map((x) => (
                <button key={x.id} type="button" className={x.id === p?.id ? "on" : ""} onClick={() => { setMenu(false); lab.load(x.id); }}>
                  <span className="code">{x.id}</span><span className="t">{x.title}</span><small>{x.about}</small>
                </button>
              ))}
            </React.Fragment>
          ))}
          <hr />
          <button type="button" onClick={() => { setMenu(false); lab.setUI({ ide: true, left: "agent" }); lab.agentDraft = "Design a new circuit for the dev board: "; lab.bump("agentDraft"); }}><b>New design with the agent…</b><small>describe a circuit; the architect writes, compiles and tests it</small></button>
          <button type="button" onClick={() => { setMenu(false); lab.savePreset({ asNew: true }); }}>Duplicate {p?.id} into My designs<small>start from the current definition</small></button>
          <button type="button" onClick={() => fileRef.current?.click()}>Import from file…<small>a .js Weft script</small></button>
          <input ref={fileRef} type="file" accept=".js,.txt,text/javascript" hidden onChange={importFile} />
        </Menu>
      </div>
      <span className="sp" />
      <span className="kbdhint">⌘\</span>
      <Tog on={lab.ui.ide} onClick={() => lab.setUI({ ide: !lab.ui.ide })} title="Show or hide the IDE (⌘\)">IDE</Tog>
      <Pill big={s.modules} small={lab.sim ? `modules · ${s.cps ? fmtCount(s.cps) + " cycles/s" : lab.running ? "starting" : "paused"}` : s.errors ? "modules · not running" : "modules"} bad={!!lab.simError} onClick={() => lab.setUI({ right: "modules" })} title="Instances and simulation speed" />
      {s.errors ? <Pill big={s.errors} small={"error" + (s.errors > 1 ? "s" : "") + " in the editor"} bad onClick={() => lab.setUI({ ide: true, left: "code" })} /> : null}
      {s.failing ? <Pill big={s.failing} small="scenario failing" bad onClick={() => lab.setUI({ ide: true, left: "code" })} /> : null}
      {s.waiting ? <Pill big={s.waiting} small="change waiting for you" bad onClick={() => lab.setUI({ right: "changes" })} /> : null}
      {s.asks ? <Pill big={s.asks} small="agent wants Claude" bad onClick={() => lab.setUI({ ide: true, left: "agent" })} /> : null}
      <div className="proj">
        <Btn primary onClick={() => setSave(!save)}><span className="long">Save ▾</span><span className="short">Save ▾</span></Btn>
        <Menu open={save} onClose={() => setSave(false)} right>
          <button type="button" onClick={() => { setSave(false); lab.savePreset(); }}>{p?.mine ? `Save ${p.id}` : "Save to My designs"}<small>kept in this browser</small></button>
          <button type="button" onClick={() => { setSave(false); lab.savePreset({ asNew: true }); }}>Save as a new design</button>
          <button type="button" onClick={downloadJs}>Download .js<small>the Weft script</small></button>
          <button type="button" onClick={downloadV}>Download Verilog<small>emitted from the DAGs</small></button>
          {p?.mine ? <button type="button" onClick={() => { setSave(false); lab.deletePreset(p.id); lab.load("F-05"); }}>Delete {p.id}</button> : null}
        </Menu>
      </div>
      <button type="button" className="ibtn" title="Theme" aria-label="Switch theme" onClick={() => lab.setUI({ theme: lab.ui.theme === "auto" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "light" : "dark") : lab.ui.theme === "dark" ? "light" : "dark" })}>◐</button>
    </header>
  );
}

const RIGHT = [["board", "Board"], ["modules", "Modules"], ["graph", "Graph"], ["waves", "Waves"], ["passes", "Passes"], ["report", "Report"], ["changes", "Changes"], ["proofs", "Proofs"]];

function Workspace() {
  useLab("ui", "changes", "proofs", "boot", "compiled");
  const ch = lab.changes;
  const waiting = ch.filter(isWaiting).length;
  const c = lab.simCompiled || lab.compiled;
  const pr = lab.proofs?.result?.results || [];
  const prBad = pr.filter((r) => r.status === "failed" || r.status === "fail").length;
  const tab = lab.ui.right;
  const counts = { modules: c?.instances?.length, changes: waiting || ch.length, proofs: prBad || (c?.asserts?.length ?? 0) };
  return (
    <div className="pane" id="right">
      <Tabs value={tab} onChange={(v) => lab.setUI({ right: v })}
        items={RIGHT.map(([v, l]) => [v, l, counts[v], (v === "changes" && waiting > 0) || (v === "proofs" && prBad > 0)])} right={<RunControls />} />
      <div className="tabbody">
        {tab === "board" ? <BoardTab /> : tab === "modules" ? <ModulesTab /> : tab === "graph" ? <GraphTab /> : tab === "waves" ? <WavesTab />
          : tab === "passes" ? <PassesTab /> : tab === "report" ? <ReportTab /> : tab === "changes" ? <ChangesTab /> : <ProofsTab />}
      </div>
    </div>
  );
}

export function RunControls() {
  useLab("run", "frame", "stats", "boot");
  const sim = lab.sim;
  const slow = !!sim && lab.running && isFinite(lab.speed) && lab.effSpeed > 0 && lab.effSpeed < lab.speed * 0.8;
  return (
    <div className="runctl">
      <span className="clock" title="Simulated time">{sim ? fmtClock(simTime(sim)) : "—"}{slow ? <em> {fmtSpeed(lab.effSpeed)}</em> : null}</span>
      <button type="button" className="ibtn" onClick={() => (lab.running ? lab.pause() : lab.play())} disabled={!sim} title={lab.running ? "Pause" : "Run"} aria-label={lab.running ? "Pause" : "Run"}>{lab.running ? "❚❚" : "▶"}</button>
      <button type="button" className="ibtn" onClick={() => lab.step(1e9)} disabled={!sim} title="Step 1 ms of simulated time" aria-label="Step">⇥</button>
      <select value={isFinite(lab.speed) ? lab.speed : "max"} onChange={(e) => lab.setSpeed(e.target.value === "max" ? Infinity : +e.target.value)} aria-label="Speed" title="Simulated seconds per real second">
        {SPEEDS.map((s) => <option key={String(s)} value={isFinite(s) ? s : "max"}>{fmtSpeed(s)}</option>)}
      </select>
    </div>
  );
}
