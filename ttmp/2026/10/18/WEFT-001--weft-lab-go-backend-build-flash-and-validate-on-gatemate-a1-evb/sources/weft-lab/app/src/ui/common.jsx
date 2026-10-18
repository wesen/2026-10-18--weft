import React, { useEffect, useReducer, useRef, useState } from "react";
import { lab } from "./lab.js";
import { highlight } from "./highlight.js";

export function useLab(...chs) {
  const [, force] = useReducer((x) => x + 1, 0);
  const seen = chs.map((c) => lab.version(c)).join(",");
  useEffect(() => {
    const offs = chs.map((c) => lab.on(c, force));
    // a bump between this render and the subscription would otherwise be missed
    if (chs.map((c) => lab.version(c)).join(",") !== seen) force();
    return () => offs.forEach((f) => f());
  }, [chs.join(",")]);
  return lab;
}

export const cls = (...a) => a.filter(Boolean).join(" ");

export function Btn({ children, onClick, primary, danger, sm, on, disabled, title, ...rest }) {
  return <button type="button" className={cls("btn", primary && "primary", danger && "danger", sm && "sm", on && "on")} onClick={onClick} disabled={disabled} title={title} {...rest}>{children}</button>;
}
export function Seg({ items, value, onChange, label, sm }) {
  return (
    <div className={cls("seg", sm && "sm")} role="group" aria-label={label}>
      {items.map((it) => {
        const [v, l, t] = Array.isArray(it) ? it : [it, it];
        return <button key={v} type="button" className={value === v ? "on" : ""} aria-pressed={value === v} onClick={() => onChange(v)} title={t}>{l}</button>;
      })}
    </div>
  );
}
export function Tog({ on, onClick, children, title }) {
  return <button type="button" className={cls("tog", on && "on")} aria-pressed={!!on} onClick={onClick} title={title}>{children}</button>;
}
export function Pill({ big, small, bad, busy, onClick, title }) {
  return <button type="button" className={cls("pill", bad && "bad", busy && "busy")} onClick={onClick} title={title}><b>{big}</b>{small ? <span>{small}</span> : null}</button>;
}
export function Tabs({ items, value, onChange, right }) {
  return (
    <div className="ptabs" role="tablist">
      {items.map(([v, l, count, bad]) => (
        <button key={v} type="button" role="tab" aria-selected={value === v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>
          {l}{count != null && count !== 0 ? <span className={cls("count", bad && "bad")}>{count}</span> : null}
        </button>
      ))}
      <span className="sp" />
      {right}
    </div>
  );
}
export function Kv({ rows }) {
  return (
    <dl className="kv">
      {rows.filter(Boolean).map(([k, v, bad], i) => (
        <React.Fragment key={i}><dt>{k}</dt><dd className={bad ? "bad" : ""}>{v}</dd></React.Fragment>
      ))}
    </dl>
  );
}
export function Meter({ f, bad }) {
  return <div className={cls("meter", bad && "bad")}><i style={{ width: Math.max(0, Math.min(1, f || 0)) * 100 + "%" }} /></div>;
}
export function Code({ text, className, max }) {
  return <pre className={cls("src hl", className)} style={max ? { maxHeight: max } : null} dangerouslySetInnerHTML={{ __html: highlight(String(text ?? "")) }} />;
}
export function Spark({ values, w = 240, h = 40, bad }) {
  if (!values || values.length < 2) return <svg className="spark" width="100%" height={h} viewBox={`0 0 ${w} ${h}`} />;
  const max = Math.max(1e-9, ...values);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (w - 4) + 2, h - 3 - (v / max) * (h - 6)]);
  const d = "M" + pts.map((p) => p.map((x) => x.toFixed(1)).join(",")).join(" L");
  const last = pts[pts.length - 1];
  return (
    <svg className={cls("spark", bad && "bad")} width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={d + ` L${last[0]},${h} L${pts[0][0]},${h} Z`} className="area" />
      <path d={d} className="line" />
      <circle cx={last[0]} cy={last[1]} r="2.5" className="dot" />
    </svg>
  );
}

export function Menu({ open, onClose, children, right, className }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const off = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const esc = (e) => { if (e.key === "Escape") onClose(); };
    setTimeout(() => document.addEventListener("pointerdown", off), 0);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", off); document.removeEventListener("keydown", esc); };
  }, [open]);
  if (!open) return null;
  return <div ref={ref} className={cls("menu", right && "right", className)} role="menu">{children}</div>;
}

export function Empty({ children }) { return <p className="empty padded">{children}</p>; }

export const stateLabel = (W) => (W.status === "idle" ? "waiting" : W.status === "busy" ? "running" : W.status);
export const isBad = (W) => W.status === "restarting" || W.status === "stopped";

export function useInterval(fn, ms) {
  const r = useRef(fn);
  r.current = fn;
  useEffect(() => { const id = setInterval(() => r.current(), ms); return () => clearInterval(id); }, [ms]);
}
export function useFrame(cb) {
  const r = useRef(cb);
  r.current = cb;
  useEffect(() => { let id; const f = () => { r.current(); id = requestAnimationFrame(f); }; id = requestAnimationFrame(f); return () => cancelAnimationFrame(id); }, []);
}
export function useStateRef(v) { const [s, set] = useState(v); return [s, set]; }
