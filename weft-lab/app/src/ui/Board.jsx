import React, { useEffect, useRef, useState } from "react";
import { lab } from "./lab.js";
import { useLab, useFrame, Btn, Tog, Seg, cls } from "./common.jsx";
import { ledLevels, press, toggleSwitch, pinValue, uartText, uart, lastFrame, audioSamples, instState, simCycle, simTime, safe } from "./engine.js";
import { fmtHz, fmtCount, fmtSpeed, fmtPs, fmtNs, summarize, clip } from "./fmt.js";

// keyboard bindings per board button
const KEYS = { "btn:0": "1", "btn:1": "2", "btn:2": "3", "btn:3": "4", "btn:up": "ArrowUp", "btn:down": "ArrowDown", "btn:a": "z", "btn:b": "x", "btn:user": " " };
const KEYHINT = { "1": "1", "2": "2", "3": "3", "4": "4", ArrowUp: "↑", ArrowDown: "↓", z: "Z", x: "X", " ": "␣" };
const short = (id) => String(id).split(":")[1] ?? id;

export function BoardTab() {
  useLab("boot", "ui", "compiled");
  const B = lab.board;
  const down = useRef(new Set());
  useEffect(() => {
    const typing = (e) => /input|textarea|select/i.test(e.target?.tagName || "") || e.target?.isContentEditable;
    const idFor = (e) => B.buttons.find((b) => KEYS[b.id] && (KEYS[b.id] === e.key || KEYS[b.id] === e.key.toLowerCase?.()))?.id;
    const kd = (e) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const id = idFor(e);
      if (!id || !lab.sim) return;
      e.preventDefault();
      if (down.current.has(id)) return;
      down.current.add(id);
      press(lab.sim, id, true);
      lab.bump("pins");
    };
    const ku = (e) => {
      const id = idFor(e);
      if (!id || !down.current.has(id)) return;
      down.current.delete(id);
      if (lab.sim) press(lab.sim, id, false);
      lab.bump("pins");
    };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => { window.removeEventListener("keydown", kd); window.removeEventListener("keyup", ku); };
  }, [B.profile, B.buttons.map((b) => b.id).join()]);
  const c = lab.simCompiled || lab.compiled;
  const targets = c?.targets || [];
  return (
    <>
      <div className="stagewrap">
        <div className="toolbar">
          {targets.length > 1 ? <span className="lbl">targets: {targets.map((t) => t.name).join(" · ")}</span> : null}
          <Tog on={lab.ui.parts} onClick={() => lab.setUI({ parts: !lab.ui.parts })}>Modules</Tog>
          <Tog on={lab.ui.tiles} onClick={() => lab.setUI({ tiles: !lab.ui.tiles })}>Title block</Tog>
          <span className="sp" />
          <span className="lbl">{c?.name || lab.preset?.title} · {B.profile || "no board"} · {B.part}{B.src !== "compiled" ? " · the profile the script names" : ""}</span>
        </div>
        <div id="stage" className={cls("machine-stage", lab.ui.tiles && "tiles", lab.ui.parts && "parts")}>
          <div className="devices">
            <div className={cls("dev fpga", B.profile || "bare")}>
              {!lab.sim ? <NotRunning /> : null}
              <FpgaBoard B={B} down={down} />
              <Attachments B={B} />
            </div>
          </div>
          {lab.ui.parts ? <ModulesFloat /> : null}
          {lab.ui.tiles ? <TitleBlock /> : null}
          <Watching />
        </div>
        <div className="hint">
          {B.buttons.length ? <span><b>Click</b> or hold a button · <b>{B.buttons.map((b) => KEYHINT[KEYS[b.id]]).filter(Boolean).join(" ")}</b> on the keyboard</span> : null}
          {B.switches.length ? <span><b>Click</b> a switch to flip it</span> : null}
          {B.uarts.length ? <span><b>Type</b> into the terminal to send over the UART</span> : null}
        </div>
      </div>
      <BoardSide B={B} down={down} />
    </>
  );
}

function NotRunning() {
  useLab("diags", "boot");
  const errs = lab.diags.filter((d) => d.level === "error");
  return (
    <div className="notrun">
      <b>{lab.simError ? "The simulation stopped" : "Not running"}</b>
      <span>{lab.simError ? clip(lab.simError.message, 200) : errs.length ? `${errs.length} error${errs.length > 1 ? "s" : ""} in the definition: ${clip(errs[0].message, 140)}` : "Boot the definition to start the simulation."}</span>
      <div className="row">{errs.length ? <Btn sm onClick={() => lab.goto(errs[0].line)}>Show the error</Btn> : null}<Btn sm primary onClick={() => lab.boot()}>Boot</Btn></div>
    </div>
  );
}

function Watching() {
  useLab("scen", "run");
  if (!lab.watching) return null;
  const st = lab.scen[lab.watching];
  const last = st?.steps?.[st.steps.length - 1];
  return <div className="ovl-box watching"><b>watching “{lab.watching}”</b><span>{st?.steps?.length || 0} steps{last ? " · " + clip(last.label, 60) : ""}</span></div>;
}

// ---------------------------------------------------------------- the board itself
function Led({ id, v, color }) {
  return (
    <span className="ledcell" title={`${id} = ${v > 0.5 ? 1 : v > 0 ? v.toFixed(2) : 0}`}>
      <span className={cls("led", v > 0.02 && "on", color)} style={{ opacity: 0.22 + Math.min(1, v) * 0.78 }} />
      <span className="tiny">{short(id)}</span>
    </span>
  );
}

function Key({ id, label, round, down }) {
  const [hold, setHold] = useState(false);
  useLab("pins", "frame");
  const lit = hold || down?.current?.has(id) || pinValue(lab.sim, id) > 0;
  const up = () => { if (!hold) return; setHold(false); if (lab.sim) press(lab.sim, id, false); lab.bump("pins"); };
  return (
    <button type="button" className={cls("hk", round && "round", lit && "down")} aria-label={id} title={id}
      onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture?.(e.pointerId); setHold(true); if (lab.sim) press(lab.sim, id, true); lab.bump("pins"); }}
      onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up}>{label ?? short(id)}</button>
  );
}

function Switch({ id }) {
  useLab("pins", "frame");
  const on = pinValue(lab.sim, id) > 0;
  return (
    <button type="button" className={cls("swt", on && "on")} aria-pressed={on} aria-label={id} title={`${id} = ${on ? 1 : 0}`}
      onClick={() => { if (lab.sim) { toggleSwitch(lab.sim, id); lab.bump("pins"); } }}>
      <i /><span className="tiny">{short(id)}</span>
    </button>
  );
}

function FpgaBoard({ B, down }) {
  useLab("frame");
  const lv = ledLevels(lab.sim, B.leds);
  const pd = B.partData || {};
  const leds = [...B.leds].reverse();      // led:7 on the left, like silk-screen order
  const switches = [...B.switches].reverse();
  const c = lab.simCompiled || lab.compiled;
  return (
    <div className="fboard">
      <div className="conns">
        {B.uarts.length ? <span className="conn">USB · UART</span> : null}
        {B.hdmi ? <span className="conn wide">HDMI</span> : null}
        {B.audio ? <span className="conn jack"><i />audio</span> : null}
        <span className="sp" />
        <span className="pwr"><span className={cls("led sm", lab.sim && "on")} style={{ opacity: lab.sim ? 1 : 0.25 }} /> <span className="tiny">pwr</span></span>
        <span className={cls("pwr", lab.sim && !lab.simError ? "" : "dim")}><span className={cls("led sm", "done", lab.sim && !lab.simError && "on")} /> <span className="tiny">done</span></span>
      </div>
      <div className="fmain">
        <div className="chipcol">
          <div className="chip fpga" title={B.part}>
            <span className="pins t" /><span className="pins b" /><span className="pins l" /><span className="pins r" />
            <b>{(B.family || "fpga").toUpperCase()}</b>
            <small>{B.part}</small>
            <small>{pd.luts ? fmtCount(pd.luts).replace(" ", "") + " LUTs" : ""}</small>
          </div>
          <div className="osc"><span>{B.mainHz ? fmtHz(B.mainHz) : "clk"}</span></div>
          {c?.domains && Object.keys(c.domains).length > 1 ? <div className="pll"><span>PLL</span><small>{Object.entries(c.domains).filter(([, d]) => d.hz).map(([n, d]) => `${n} ${fmtHz(d.hz)}`).join(" · ")}</small></div> : null}
        </div>
        <div className="iocol">
          {leds.length ? <div className="ledrow-b">{leds.map((L) => <Led key={L.id} id={L.id} v={lv[L.id] || 0} />)}</div> : null}
          {switches.length ? <div className="swrow">{switches.map((s) => <Switch key={s.id} id={s.id} />)}</div> : null}
          {!B.leds.length && !B.switches.length && !B.buttons.length ? <p className="note bare">No board: the design's ports are the top level. Poke and peek them in Modules, watch them in Waves.</p> : null}
          {B.buttons.length ? (() => {
            const ORDER = ["up", "left", "right", "down"];
            const dirs = B.buttons.filter((b) => /:(up|down|left|right)$/.test(b.id)).sort((a, b) => ORDER.indexOf(short(a.id)) - ORDER.indexOf(short(b.id)));
            const acts = B.buttons.filter((b) => !dirs.includes(b));
            const cell = (b) => <span key={b.id} className="btncell"><Key id={b.id} round label={dirs.length && KEYHINT[KEYS[b.id]] ? KEYHINT[KEYS[b.id]] : ""} down={down} /><span className="tiny">{short(b.id)}</span></span>;
            return dirs.length ? (
              <div className="btnrow gamepad"><div className="dirs">{dirs.map(cell)}</div><div className="acts">{acts.map(cell)}</div></div>
            ) : <div className="btnrow">{B.buttons.map(cell)}</div>;
          })() : null}
        </div>
      </div>
      <div className="silk"><span>{B.profile || B.part}</span><span>{B.title ? clip(B.title.split(" — ")[1] || "weft lab · virtual board", 70) : "weft lab · virtual board"}</span></div>
    </div>
  );
}

function Attachments({ B }) {
  if (!B.hdmi && !B.audio && !B.uarts.length) return null;
  return (
    <div className="attach">
      {B.hdmi ? <Monitor /> : null}
      <div className="attach-col">
        {B.audio ? <Scope /> : null}
        {B.uarts.length ? <SerialMini id={B.uarts[0]} /> : null}
      </div>
    </div>
  );
}

function Monitor() {
  const ref = useRef(null), off = useRef(null), last = useRef(null);
  useLab("theme");
  const [info, setInfo] = useState(null);
  useFrame(() => {
    const cv = ref.current;
    if (!cv) return;
    const f = lab.sim ? lastFrame(lab.sim) : null;
    const key = f ? (f.time ?? 0) + ":" + f.w : "none";
    if (last.current === key && cv.dataset.w === String(cv.clientWidth)) return;
    last.current = key;
    cv.dataset.w = String(cv.clientWidth);
    const g = cv.getContext("2d");
    if (!f || !f.data) {
      cv.width = 640; cv.height = 480;
      g.fillStyle = "#0b0b0b"; g.fillRect(0, 0, 640, 480);
      g.fillStyle = "#5a5a5a"; g.font = "700 22px Arial"; g.textAlign = "center";
      g.fillText(lab.sim ? "NO SIGNAL" : "OFF", 320, 248);
      setInfo(null);
      return;
    }
    if (cv.width !== f.w || cv.height !== f.h) { cv.width = f.w; cv.height = f.h; }
    try {
      const img = new ImageData(new Uint8ClampedArray(f.data.buffer || f.data, f.data.byteOffset || 0, f.w * f.h * 4), f.w, f.h);
      g.putImageData(img, 0, 0);
    } catch (e) { g.fillStyle = "#300"; g.fillRect(0, 0, cv.width, cv.height); }
    setInfo(`${f.w}×${f.h} · frame at ${fmtPs(f.time)}`);
  });
  return (
    <div className="monitor">
      <div className="bezel"><canvas ref={ref} className="screen hdmi" aria-label="HDMI output" /></div>
      <div className="mlabel">hdmi{info ? " · " + info : ""}</div>
    </div>
  );
}

function Scope() {
  const ref = useRef(null);
  useLab("theme");
  useFrame(() => {
    const cv = ref.current;
    if (!cv) return;
    const W = cv.clientWidth || 240, H = cv.clientHeight || 64, dpr = window.devicePixelRatio || 1;
    if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const st = getComputedStyle(document.documentElement);
    g.fillStyle = st.getPropertyValue("--bg").trim() || "#fff"; g.fillRect(0, 0, W, H);
    g.strokeStyle = st.getPropertyValue("--rule").trim() || "#ddd"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, H / 2 + 0.5); g.lineTo(W, H / 2 + 0.5); g.stroke();
    const s = lab.sim ? audioSamples(lab.sim) : null;
    if (!s || !s.length) { g.fillStyle = st.getPropertyValue("--ink-2").trim(); g.font = "10px Arial"; g.fillText("silent", 6, 12); return; }
    const n = Math.min(s.length, 600), start = s.length - n;
    const val = (x) => Number(x != null && typeof x === "object" ? x.v ?? x.value ?? 0 : x) || 0;
    let peak = 1;
    for (let i = start; i < s.length; i++) peak = Math.max(peak, Math.abs(val(s[i])));
    const scale = peak > 2 ? Math.max(peak, 2048) : 1;
    g.strokeStyle = st.getPropertyValue("--ink").trim(); g.lineWidth = 1.2;
    g.beginPath();
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * W, y = H / 2 - (val(s[start + i]) / scale) * (H / 2 - 3); i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke();
  });
  return <div className="scope"><canvas ref={ref} aria-label="Audio output" /><span className="mlabel">audio · sigma-delta, filtered</span></div>;
}

function SerialMini({ id }) {
  useLab("frame");
  const text = lab.sim ? uartText(lab.sim, id) : "";
  const lines = text.split("\n").slice(-9);
  return <pre className="serialmini">{text ? lines.join("\n") : `${id} · nothing received`}</pre>;
}

// ---------------------------------------------------------------- overlays
function ModulesFloat() {
  useLab("frame", "sel", "boot");
  const c = lab.simCompiled || lab.compiled;
  const prev = useRef(new Map());
  const inst = (c?.instances || []).filter((i) => i.kind !== "agent" && i.kind !== "host");
  const busy = new Map();
  for (const i of inst.slice(0, 40)) {
    const s = lab.sim ? safe(() => JSON.stringify(instState(lab.sim, i.path), (k, v) => (typeof v === "bigint" ? String(v) : v))) : null;
    busy.set(i.path, s != null && prev.current.get(i.path) != null && prev.current.get(i.path) !== s);
    prev.current.set(i.path, s);
  }
  const shown = inst.slice(0, 16);
  return (
    <div className="ovl-box" id="parts">
      <div className="hd"><span>Modules</span><span>{inst.length}</span></div>
      {shown.length ? shown.map((i) => (
        <div key={i.path} className={cls("row", lab.sel.instance === i.path && "sel", i.kind === "cell" && "hw")} onClick={() => lab.select({ instance: i.path })} onDoubleClick={() => { lab.select({ instance: i.path }); lab.setUI({ right: "modules" }); }}>
          <i className={cls("eye", busy.get(i.path) && "on")} />
          <span className="nm">{i.path}</span>
          <span className="sz">{i.cell || i.kind}{i.domain && i.domain !== lab.mainDomain ? " · " + i.domain : ""}</span>
        </div>
      )) : <div className="row hw"><i className="eye" /><span className="nm">none yet</span><span className="sz">compile first</span></div>}
      {inst.length > shown.length ? <div className="row hw"><i className="eye" /><span className="nm">+ {inst.length - shown.length} more</span><span className="sz">see Modules</span></div> : null}
    </div>
  );
}

const pdv = (pd, ...keys) => { for (const k of keys) if (pd?.[k] != null) return Number(pd[k]); return null; };
function TitleBlock() {
  useLab("frame", "scen", "changes", "stats", "boot");
  const c = lab.simCompiled || lab.compiled;
  const B = lab.board;
  const r = c?.report || {};
  const res = r.resources || {};
  const pd = B.partData || c?.board?.partData || {};
  const tm = r.timing?.[lab.mainDomain] || Object.values(r.timing || {})[0];
  const scen = Object.values(lab.scen);
  const ch = lab.changes;
  const committed = ch.filter((x) => (x.stage || x.status) === "committed").length, rolled = ch.filter((x) => (x.stage || x.status) === "rolled-back").length;
  const of = (used, avail) => (used == null ? "—" : `${fmtCount(used).replace(" ", "")}${avail ? " / " + fmtCount(avail).replace(" ", "") : ""}`);
  const doms = Object.entries(c?.domains || {});
  return (
    <div className="ovl-box" id="title">
      <div className="big"><label>SYSTEM</label><b>{c?.name || "—"}</b></div>
      <div><label>ID</label><b>{lab.preset?.id}</b></div>
      <div><label>BOARD · PART</label><b>{B.profile ? B.profile + " · " : ""}{B.part}</b></div>
      <div><label>CLOCKS</label><b>{doms.length ? doms.map(([n, d]) => `${n} ${d.hz ? fmtHz(d.hz) : "?"}`).join(" · ") : B.mainHz ? fmtHz(B.mainHz) : "—"}</b></div>
      <div><label>LUTs</label><b>{of(res.luts, pdv(pd, "luts", "lut", "LUTs"))}</b></div>
      <div><label>FFs</label><b>{of(res.ffs, pdv(pd, "ffs", "ff", "FFs"))}</b></div>
      <div><label>BRAM</label><b>{of(res.brams, pdv(pd, "brams", "bram", "bramCount"))}</b></div>
      <div><label>DSP</label><b>{of(res.dsps, pdv(pd, "dsps", "dsp", "DSPs"))}</b></div>
      <div className={tm && tm.slack < 0 ? "bad" : ""}><label>FMAX · SLACK</label><b>{tm ? `${tm.fmax ? fmtHz(tm.fmax > 1e4 ? tm.fmax : tm.fmax * 1e6) : "—"} · ${tm.slack != null ? (tm.slack >= 0 ? "+" : "") + (+tm.slack).toFixed(2) + " ns" : "—"}` : "—"}</b></div>
      <div className={scen.some((s) => s.status === "fail") ? "bad" : ""}><label>SCENARIOS</label><b>{scen.length ? `${scen.filter((s) => s.status === "pass").length} pass · ${scen.filter((s) => s.status === "fail").length} fail` : `${(c?.scenarios || []).length} not run`}</b></div>
      <div className={rolled ? "bad" : ""}><label>CHANGES</label><b>{ch.length ? `${committed} in${rolled ? ` · ${rolled} rolled back` : ""}` : "none"}</b></div>
      <div><label>SIM</label><b>{lab.sim ? `${lab.cps ? fmtCount(lab.cps).replace(" ", "") + " cyc/s" : lab.running ? "…" : "paused"}${lab.effSpeed ? " · " + fmtSpeed(lab.effSpeed) : ""}` : "stopped"}</b></div>
    </div>
  );
}

// ---------------------------------------------------------------- the side panel: virtual I/O
function BoardSide({ B, down }) {
  useLab("frame", "run", "boot");
  const c = lab.simCompiled || lab.compiled;
  const doms = Object.entries(c?.domains || {});
  return (
    <div className="side">
      <div className="block"><header><h2>{c?.name || "design"}</h2><span className="sp" /><span className="sub">virtual I/O · {B.profile || B.part}</span></header>
        <div className="ctlrow">
          <Btn sm onClick={() => (lab.running ? lab.pause() : lab.play())} disabled={!lab.sim}>{lab.running ? "❚❚ Pause" : "▶ Run"}</Btn>
          <Btn sm onClick={() => lab.step(1e9)} disabled={!lab.sim} title="Run 1 ms of simulated time">1 ms</Btn>
          <Btn sm onClick={() => lab.stepCycles(1)} disabled={!lab.sim} title={`One edge of ${lab.mainDomain}`}>1 cycle</Btn>
          <span className="sp" />
          <Btn sm onClick={() => lab.reset()} title="A fresh simulation of the running design">↻ Reset</Btn>
        </div>
        <div className="lanes doms">
          {doms.length ? doms.map(([n, d]) => (
            <div key={n} className={cls("lane", lab.running && lab.sim && "busy")}><span>{n}</span><b>{d.hz ? fmtHz(d.hz) : "?"} · {fmtCount(simCycle(lab.sim, n))} cycles</b></div>
          )) : <div className="lane"><span>clock</span><b>{B.mainHz ? fmtHz(B.mainHz) : "—"}</b></div>}
          {lab.sim ? <div className="lane"><span>speed</span><b>{lab.cps ? fmtCount(lab.cps) + " cycles/s" : "—"} · {fmtSpeed(lab.effSpeed)} real time</b></div> : null}
        </div>
      </div>
      {B.buttons.length ? (
        <div className="io-block">
          <div className="io-hd"><b>buttons</b><span>{bound(c, B.buttons)}</span></div>
          <div className="keys">{B.buttons.map((b) => <Key key={b.id} id={b.id} down={down} label={<>{short(b.id)}<kbd>{KEYHINT[KEYS[b.id]] || ""}</kbd></>} />)}</div>
        </div>
      ) : null}
      {B.switches.length ? (
        <div className="io-block">
          <div className="io-hd"><b>switches</b><span>{bound(c, B.switches)}</span></div>
          <div className="swrow side-sw">{B.switches.map((s) => <Switch key={s.id} id={s.id} />)}</div>
        </div>
      ) : null}
      {B.leds.length ? <LedReadout B={B} /> : null}
      <Knobs />
      {B.uarts.map((u) => <Terminal key={u} id={u} />)}
      <Events />
    </div>
  );
}
function bound(c, list) {
  const ids = new Set(list.map((x) => x.id));
  const who = new Set((c?.pins || []).filter((p) => ids.has(p.resource)).map((p) => p.instance).filter(Boolean));
  return who.size ? [...who].join(", ") : "unbound";
}

function LedReadout({ B }) {
  useLab("frame");
  const lv = ledLevels(lab.sim, B.leds);
  const bits = [...B.leds].reverse().map((L) => ((lv[L.id] || 0) > 0.5 ? "1" : "0")).join("");
  const v = parseInt(bits || "0", 2);
  const c = lab.simCompiled || lab.compiled;
  return (
    <div className="io-block">
      <div className="io-hd"><b>leds</b><span>{bound(c, B.leds)}</span></div>
      <div className="io-val"><code>{bits}</code><span className="dim"> = {v} · 0x{v.toString(16).padStart(Math.ceil(B.leds.length / 4), "0")}</span></div>
    </div>
  );
}

function Knobs() {
  useLab("frame", "boot");
  const c = lab.simCompiled;
  const knobs = (c?.knobs || []).slice(0, 24);
  if (!knobs.length || !lab.sim) return null;
  return (
    <div className="io-block">
      <div className="io-hd"><b>registers</b><span>knobs, status and irqs over the bridge</span></div>
      {knobs.map((k) => <KnobRow key={k.path} k={k} />)}
    </div>
  );
}
function KnobRow({ k }) {
  const h = safe(() => lab.sim.knob?.(k.path));
  const v = safe(() => (k.kind === "status" ? lab.sim.status?.(k.path) ?? h?.get?.() : h?.get?.()));
  const irqs = k.kind === "irq" ? lab.events.filter((e) => e.kind === "irq" && (e.path === k.path || e.name === k.name)).length : 0;
  const lo = k.min ?? 0, hi = k.max ?? (k.type?.w ? 2 ** Math.min(k.type.w, 16) - 1 : 255);
  return (
    <div className="knobrow">
      <span className="kn">{k.path}</span>
      {k.kind === "knob" ? (
        <>
          <input type="range" min={lo} max={hi} step={1} value={Number(v ?? k.reset ?? lo)} aria-label={k.path} onChange={(e) => { try { h?.set?.(+e.target.value); lab.bump("frame"); } catch (er) { lab.toast(er.message, "bad"); } }} />
          <b className="kv">{v == null ? "—" : String(v)}</b>
        </>
      ) : k.kind === "irq" ? <b className="kv">{irqs} fired</b> : <b className="kv">{v == null ? "—" : String(v)}</b>}
      <span className="kk">{k.kind}{k.addr != null ? " @" + Number(k.addr).toString(16).padStart(2, "0") : ""}</span>
    </div>
  );
}

function Terminal({ id }) {
  useLab("frame");
  const ref = useRef(null);
  const [text, setText] = useState("");
  const [crlf, setCrlf] = useState(true);
  const rx = lab.sim ? uartText(lab.sim, id) : "";
  useEffect(() => { const el = ref.current; if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 60) el.scrollTop = el.scrollHeight; });
  const send = () => {
    const u = lab.sim ? uart(lab.sim, id) : null;
    if (!u?.send) return lab.toast("This UART cannot be driven from here yet", "bad");
    try { u.send(text + (crlf ? "\r\n" : "")); setText(""); } catch (e) { lab.toast(e.message, "bad"); }
  };
  return (
    <div className="io-block console">
      <div className="io-hd"><b>{id} terminal</b><span>{rx.length} bytes received</span></div>
      <div className="con term" ref={ref}>{rx ? rx : <span className="dim">nothing yet</span>}</div>
      <div className="sendev">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="type and press Enter" aria-label="Send over UART" spellCheck={false} />
        <Tog on={crlf} onClick={() => setCrlf(!crlf)} title="Append CR LF">↵</Tog>
        <Btn sm onClick={send}>Send</Btn>
      </div>
    </div>
  );
}

function Events() {
  useLab("events", "boot");
  const ev = lab.events.slice(-80);
  const ref = useRef(null);
  useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; });
  return (
    <div className="io-block console">
      <div className="io-hd"><b>events</b><span>asserts · irqs · drops · resets · hosts</span></div>
      <div className="con" ref={ref}>
        {ev.length ? ev.map((e, i) => (
          <span key={i} className={cls("l", (e.kind === "assert" || e.kind === "escalate" || e.kind === "escalation") && "error", (e.kind === "drop" || e.kind === "reset") && "warn")}>
            <span className="ts">{fmtPs(e.t)}</span><b>{e.kind}</b> {e.path || e.name || e.stream || e.instance || ""} {e.text ? clip(e.text, 160) : e.value != null ? summarize(e.value, 60) : ""}{e.n > 1 ? <span className="n"> ×{e.n}</span> : null}
          </span>
        )) : <span className="l dim">none yet</span>}
      </div>
    </div>
  );
}
