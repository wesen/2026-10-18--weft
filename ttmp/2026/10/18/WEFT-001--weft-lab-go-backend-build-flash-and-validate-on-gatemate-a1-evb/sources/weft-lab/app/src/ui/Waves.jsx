import React, { useEffect, useMemo, useRef, useState } from "react";
import { lab } from "./lab.js";
import { useLab, useFrame, Btn, Seg, Tog, Kv, cls } from "./common.jsx";
import { waveIndex, waveData, valueAt, indexAt, simTime, natural } from "./engine.js";
import { fmtPs, hex, clip } from "./fmt.js";

const ROW = 24, LEFT = 190, TOP = 26;
const WINDOWS = [[1e5, "100 ns"], [1e6, "1 µs"], [1e7, "10 µs"], [1e8, "100 µs"], [1e9, "1 ms"], [1e10, "10 ms"], [1e11, "100 ms"], [1e12, "1 s"]];
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "#1a1a1a";

function defaultPick(index, c) {
  const pref = (s) => (s.kind === "out" ? 0 : s.kind === "reg" ? 1 : s.kind === "in" ? 2 : 3);
  const pins = new Set((c?.pins || []).map((p) => p.instance && `${p.instance}.${p.port}`));
  return [...index].sort((a, b) => (pins.has(b.path) - pins.has(a.path)) || pref(a) - pref(b) || natural(a.path, b.path)).slice(0, 12).map((s) => s.path);
}

export function WavesTab() {
  useLab("boot", "run", "sel", "frame");
  const sim = lab.sim;
  const c = lab.simCompiled;
  const [userSpan, setSpan] = useState(null);
  const [end, setEnd] = useState(0);      // 0 = follow the simulation
  const [cursor, setCursor] = useState(null);
  const [radix, setRadix] = useState("hex");
  const [picked, setPicked] = useState(null);
  const cv = useRef(null), wrap = useRef(null);
  const idxRef = useRef({ t: 0, list: [] });
  const cache = useRef(new Map());
  const now = performance.now();
  if (sim && now - idxRef.current.t > 1000) idxRef.current = { t: now, list: waveIndex(sim, c), sim };
  const index = idxRef.current.sim === sim ? idxRef.current.list : [];
  useEffect(() => { setPicked(null); setCursor(null); setEnd(0); setSpan(null); cache.current.clear(); }, [sim]);
  const shown = (picked || defaultPick(index, c)).filter((p) => index.some((s) => s.path === p));
  const meta = new Map(index.map((s) => [s.path, s]));
  const data = (p) => waveData(sim, p);
  // until the user picks a window: one that shows a few changes of the typical shown signal
  const autoRef = useRef({ sim: null, span: null });
  if (!userSpan && sim && (autoRef.current.sim !== sim || !autoRef.current.span)) {
    const iv = shown.map((p) => { const d = data(p); const n = d.t.length; return n >= 3 ? (d.t[n - 1] - d.t[Math.max(0, n - 5)]) / Math.min(4, n - 1) : null; }).filter((x) => x > 0).sort((a, b) => a - b);
    if (iv.length) { const want = iv[Math.floor(iv.length / 2)] * 6; autoRef.current = { sim, span: (WINDOWS.find(([v]) => v >= want) || WINDOWS[WINDOWS.length - 1])[0] }; }
  }
  const span = userSpan || autoRef.current.span || 1e9;
  useFrame(() => draw());
  function draw() {
    const el = wrap.current, can = cv.current;
    if (!el || !can) return;
    const W = el.clientWidth, H = Math.max(el.clientHeight, TOP + shown.length * ROW + 30);
    const dpr = window.devicePixelRatio || 1;
    if (can.width !== W * dpr || can.height !== H * dpr) { can.width = W * dpr; can.height = H * dpr; can.style.width = W + "px"; can.style.height = H + "px"; }
    const g = can.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ink = css("--ink"), ink2 = css("--ink-2"), rule = css("--rule"), acc = css("--accent"), bg = css("--bg"), fill = css("--fill");
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const t1 = end || simTime(sim), t0 = Math.max(0, t1 - span);
    const X = (t) => LEFT + ((t - t0) / (t1 - t0 || 1)) * (W - LEFT - 14);
    // time axis
    g.font = "10px Arial"; g.lineWidth = 1;
    let step = 1;
    outer: for (let e = 0; e < 15; e++) for (const m of [1, 2, 5]) { step = m * 10 ** e; if ((t1 - t0 || span) / step <= 8) break outer; }
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      const x = X(t);
      g.strokeStyle = rule; g.beginPath(); g.moveTo(x + 0.5, TOP - 6); g.lineTo(x + 0.5, H); g.stroke();
      g.fillStyle = ink2; g.fillText(fmtAxis(t, step), x + 3, TOP - 10);
    }
    // events: asserts as red ticks on the axis
    for (const e of lab.events) {
      if (e.t < t0 || e.t > t1) continue;
      const x = X(e.t);
      g.fillStyle = e.kind === "assert" ? acc : ink2;
      g.fillRect(x - 1, TOP - 7, 2, 7);
    }
    shown.forEach((p, i) => {
      const y = TOP + i * ROW;
      const m = meta.get(p) || { w: 1 };
      g.strokeStyle = rule; g.beginPath(); g.moveTo(0, y + ROW - 0.5); g.lineTo(W, y + ROW - 0.5); g.stroke();
      g.fillStyle = lab.sel.signal === p ? acc : ink; g.font = (lab.sel.signal === p ? "700 " : "400 ") + "11px Arial";
      const name = p.length > 26 ? "…" + p.slice(-25) : p;
      g.fillText(name, 10, y + 15);
      g.fillStyle = ink2; g.font = "9px Arial";
      g.fillText(m.w > 1 ? `[${m.w}]` : "", LEFT - 30, y + 15);
      const d = data(p);
      const n = d.t.length;
      if (!n) return;
      const tEnd = Math.min(t1, simTime(sim));
      const k0 = Math.max(0, indexAt(d, t0));
      const hiY = y + 5, loY = y + ROW - 6, midY = (hiY + loY) / 2;
      g.strokeStyle = ink; g.lineWidth = 1.2;
      if (m.w <= 1) {
        g.beginPath();
        let prevV = d.t[k0] <= t0 ? Number(d.v[k0]) : null;
        if (prevV != null) g.moveTo(LEFT, prevV ? hiY : loY);
        let lastX = -1;
        for (let j = d.t[k0] <= t0 ? k0 + 1 : k0; j < n && d.t[j] <= t1; j++) {
          const x = X(d.t[j]), v = Number(d.v[j]);
          if (prevV == null) { g.moveTo(x, v ? hiY : loY); prevV = v; continue; }
          if (x - lastX < 0.5 && j + 1 < n && d.t[j + 1] <= t1) { prevV = v; continue; }   // sub-pixel toggles: draw the envelope
          g.lineTo(x, prevV ? hiY : loY); g.lineTo(x, v ? hiY : loY);
          lastX = x; prevV = v;
        }
        if (prevV != null) g.lineTo(X(tEnd), prevV ? hiY : loY);
        g.stroke();
      } else {
        g.font = "10px Arial";
        let lastXb = -1;
        for (let j = k0; j < n && d.t[j] <= t1; j++) {
          const a = Math.max(t0, d.t[j]), b = j + 1 < n ? Math.min(t1, d.t[j + 1]) : tEnd;
          if (b < t0) continue;
          const xa = X(a), xb = X(b);
          if (xb - xa < 1.5) { if (xa - lastXb >= 1) { g.beginPath(); g.moveTo(xa, hiY); g.lineTo(xa, loY); g.stroke(); lastXb = xa; } continue; }
          const sl = Math.min(3, (xb - xa) / 2);
          g.beginPath(); g.moveTo(xa, midY); g.lineTo(xa + sl, hiY); g.lineTo(xb - sl, hiY); g.lineTo(xb, midY); g.lineTo(xb - sl, loY); g.lineTo(xa + sl, loY); g.closePath();
          g.fillStyle = fill; g.fill(); g.stroke();
          const txt = fmt(d.v[j], m.w, radix);
          if (xb - xa > txt.length * 6 + 6) { g.fillStyle = ink; g.fillText(txt, xa + sl + 2, midY + 3.5); }
          lastXb = xb;
        }
      }
    });
    if (cursor != null && cursor >= t0 && cursor <= t1) {
      const x = X(cursor);
      g.strokeStyle = acc; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, TOP - 14); g.lineTo(x, H); g.stroke();
      const lbl = fmtPs(cursor);
      g.fillStyle = acc; g.fillRect(x - 34, 2, 68, 13); g.fillStyle = "#fff"; g.font = "10px Arial"; g.textAlign = "center"; g.fillText(lbl, x, 12); g.textAlign = "left";
    }
    wrap.current._X = { t0, t1, W };
  }
  const onClick = (e) => {
    const r = cv.current.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const st = wrap.current?._X;
    if (!st) return;
    if (x < LEFT) { const i = Math.floor((y - TOP) / ROW); if (shown[i]) lab.select({ signal: shown[i] }); return; }
    setCursor(st.t0 + ((x - LEFT) / (st.W - LEFT - 14)) * (st.t1 - st.t0));
  };
  const onWheel = (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const i = WINDOWS.findIndex((w) => w[0] === span);
    const ni = Math.max(0, Math.min(WINDOWS.length - 1, i + (e.deltaY > 0 ? 1 : -1)));
    setSpan(WINDOWS[ni][0]);
  };
  if (!sim) return <div className="stagewrap"><div className="toolbar"><span className="lbl">waveforms of the running simulation</span></div><p className="empty padded">Not running. Boot a design that compiles to record waves.</p></div>;
  const tNow = simTime(sim);
  const pan = (f) => { lab.pause(); setEnd(Math.max(span, Math.min(tNow, (end || tNow) + f * span))); };
  const zoom = (d) => { const i = WINDOWS.findIndex((w) => w[0] === span); setSpan(WINDOWS[Math.max(0, Math.min(WINDOWS.length - 1, i + d))][0]); };
  return (
    <>
      <div className="stagewrap">
        <div className="toolbar">
          <Btn sm onClick={() => pan(-0.5)} title="Earlier">◀</Btn>
          <Btn sm on={!end && lab.running} onClick={() => { if (end || !lab.running) { setEnd(0); lab.play(); } else { lab.pause(); setEnd(tNow); } }}>{!end && lab.running ? "❚❚" : "▶ live"}</Btn>
          <Btn sm onClick={() => pan(0.5)} title="Later">▶</Btn>
          <Btn sm onClick={() => zoom(-1)} title="Zoom in">+</Btn>
          <Btn sm onClick={() => zoom(1)} title="Zoom out">−</Btn>
          <Seg label="Window" items={WINDOWS.filter((w, i) => i % 1 === 0).map(([v, l]) => [v, l])} value={span} onChange={setSpan} sm />
          <Seg label="Radix" items={[["hex", "hex"], ["dec", "dec"], ["bin", "bin"]]} value={radix} onChange={setRadix} sm />
          <span className="sp" />
          <span className="lbl"><b>{fmtPs(end || tNow)}</b> · {index.length} signals recorded</span>
        </div>
        <div className="diagram timeline waves" ref={wrap} onWheel={onWheel}>
          {index.length ? <canvas ref={cv} onClick={onClick} /> : <p className="empty padded">{sim.waves ? "No signals recorded yet: run the simulation." : "This simulator does not record waves yet."}</p>}
        </div>
        <div className="hint"><b>Click</b> to place the cursor · <b>click a name</b> to select it · <b>⌘ wheel</b> zooms · red ticks are failed asserts</div>
      </div>
      <WaveSide index={index} shown={shown} setPicked={setPicked} cursor={cursor} data={data} radix={radix} />
    </>
  );
}

// axis labels with as many decimals as the tick step needs
function fmtAxis(t, step) {
  const units = [[1e12, "s"], [1e9, "ms"], [1e6, "µs"], [1e3, "ns"], [1, "ps"]];
  const [scale, unit] = units.find(([sc]) => t >= sc) || units[units.length - 1];
  const dec = Math.max(0, Math.min(9, Math.ceil(-Math.log10(step / scale) - 1e-9)));
  return (t / scale).toFixed(dec) + " " + unit;
}
function fmt(v, w, radix) {
  if (v == null) return "x";
  if (typeof v === "object" && !(typeof v === "bigint")) return clip(JSON.stringify(v), 16);
  if (radix === "dec") return String(v);
  if (radix === "bin") return BigInt.asUintN(Math.max(1, w), BigInt(typeof v === "bigint" ? v : Math.trunc(Number(v)))).toString(2).padStart(Math.min(w, 32), "0");
  return hex(v, w);
}

function WaveSide({ index, shown, setPicked, cursor, data, radix }) {
  useLab("frame", "sel");
  const [q, setQ] = useState("");
  const set = new Set(shown);
  const list = index.filter((s) => !q || s.path.includes(q)).slice(0, 400);
  const toggle = (p) => setPicked(set.has(p) ? shown.filter((x) => x !== p) : [...shown, p]);
  const t = cursor ?? simTime(lab.sim);
  return (
    <div className="side">
      <div className="block"><header><h2>{cursor != null ? "At the cursor" : "Now"}</h2><span className="sp" /><span className="sub">{fmtPs(t)}</span></header>
        <Kv rows={shown.map((p) => { const s = index.find((x) => x.path === p); const v = valueAt(data(p), t); return [p, v == null ? "—" : `${fmt(v, s?.w || 1, radix)}${radix !== "dec" && s?.w > 1 ? "  (" + String(v) + ")" : ""}`]; })} />
      </div>
      <div className="block"><header><h2>Signals</h2><span className="sp" /><span className="sub">{shown.length} of {index.length}</span></header>
        <div className="sendev"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter signals" aria-label="Filter signals" /></div>
        <div className="ctlrow"><Btn sm onClick={() => setPicked(null)}>Defaults</Btn><Btn sm onClick={() => setPicked(list.slice(0, 40).map((s) => s.path))}>Show the filtered</Btn><Btn sm onClick={() => setPicked([])}>None</Btn></div>
        <div className="picker">
          {list.map((s) => (
            <label key={s.path} className={cls("pick", set.has(s.path) && "on")}>
              <input type="checkbox" checked={set.has(s.path)} onChange={() => toggle(s.path)} />
              <span className="nm">{s.path}</span><span className="dim">{s.kind || ""}{s.w > 1 ? ` ${s.w}b` : ""}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
