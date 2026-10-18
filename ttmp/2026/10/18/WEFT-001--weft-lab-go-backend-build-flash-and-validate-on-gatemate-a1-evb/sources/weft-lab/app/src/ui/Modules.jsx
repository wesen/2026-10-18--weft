import React, { useEffect, useRef, useState } from "react";
import { lab } from "./lab.js";
import { useLab, Btn, Seg, Kv, Code, Spark, cls } from "./common.jsx";
import { instState, streamStats, peek, poke, release, safe, simTime } from "./engine.js";
import { typeName } from "../core/types.js";
import { fmtVal, fmtPs, durPs, summarize, clip } from "./fmt.js";

const tn = (t) => (t && typeof t === "object" ? safe(() => typeName(t), "?") : t ? String(t) : "—");

export function ModulesTab() {
  useLab("frame", "sel", "boot", "compiled");
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const c = lab.simCompiled || lab.compiled;
  let list = c?.instances || [];
  if (filter === "modules") list = list.filter((i) => i.kind === "module" || i.kind === "fsm" || i.kind === "pipeline");
  if (filter === "cells") list = list.filter((i) => i.kind === "cell");
  if (filter === "runtime") list = list.filter((i) => i.kind === "agent" || i.kind === "host");
  if (q) list = list.filter((i) => i.path.includes(q) || String(i.def || "").includes(q));
  const sel = (c?.instances || []).find((i) => i.path === lab.sel.instance) || null;
  if (!c?.instances?.length) {
    return <div className="page col"><div className="toolbar"><span className="lbl">instances of the compiled design</span></div><p className="empty padded">{lab.compiled?.ok === false ? "Nothing compiled yet: fix the errors in the editor (see Code) and the instances appear here." : "No instances."}</p></div>;
  }
  const streamsOf = (i) => (c.streams || []).filter((s) => s.producer === i.path || (s.consumers || []).includes(i.path));
  return (
    <div className="page col">
      <div className="toolbar">
        <Seg label="Filter" items={[["all", "All"], ["modules", "Modules"], ["cells", "Cells"], ["runtime", "Hosts · agents"]]} value={filter} onChange={setFilter} />
        <input className="filter" placeholder="filter instances" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter instances" />
        <span className="sp" />
        <span className="lbl">click a row to inspect · the REPL pokes and peeks the live simulation</span>
      </div>
      <div className="split-v">
        <div className="scroll tablewrap">
          <table className="rt worlds">
            <thead><tr><th>instance</th><th>kind</th><th>domain</th><th className="num">regs</th><th className="num">ports</th><th>streams</th><th className="num">fired</th><th className="num">dropped</th><th>state</th></tr></thead>
            <tbody>
              {list.map((i) => {
                const st = lab.sim ? instState(lab.sim, i.path) : null;
                const ss = streamsOf(i).filter((s) => s.producer === i.path).map((s) => streamStats(lab.sim, s.name)).filter(Boolean);
                const fired = ss.reduce((a, s) => a + (Number(s.fired) || 0), 0), dropped = ss.reduce((a, s) => a + (Number(s.dropped) || 0), 0);
                return (
                  <tr key={i.path} className={cls("clickable", lab.sel.instance === i.path && "sel", dropped > 0 && "warnrow")} onClick={() => lab.select({ instance: i.path })}>
                    <td className="nm">{i.path}{i.def && i.def !== i.path && i.def !== i.cell && i.def !== i.kind ? <span className="tag dim">{i.def}</span> : null}{i.cell ? <span className="tag">{i.cell}</span> : null}</td>
                    <td>{i.kind}</td>
                    <td>{i.domain || "—"}</td>
                    <td className="num">{(i.regs || []).length}</td>
                    <td className="num">{(i.ports || []).length}</td>
                    <td className="lastmsg">{[...(i.provides || []).map((s) => "→ " + s), ...(i.needs || []).map((s) => "← " + s)].join("  ") || "—"}</td>
                    <td className="num">{ss.length ? fired : "—"}</td>
                    <td className={cls("num", dropped > 0 && "bad")}>{ss.length ? dropped : "—"}</td>
                    <td className="lastmsg">{st ? summarize(st, 60) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {sel ? <Detail i={sel} c={c} /> : <p className="empty padded">Pick an instance to see its registers live, its ports, streams and source, and to poke it.</p>}
      </div>
    </div>
  );
}

function Detail({ i, c }) {
  useLab("frame");
  const [tab, setTab] = useState("state");
  const hist = useRef(new Map());
  const st = lab.sim ? instState(lab.sim, i.path) : null;
  const streams = (c.streams || []).filter((s) => s.producer === i.path || (s.consumers || []).includes(i.path));
  const knobs = (c.knobs || []).filter((k) => k.module === i.path || String(k.path).startsWith(i.path + "."));
  const asserts = (c.asserts || []).filter((a) => a.module === i.path || String(a.path).startsWith(i.path + "."));
  const fails = lab.events.filter((e) => e.kind === "assert" && String(e.path || "").startsWith(i.path));
  // keep a short history of numeric registers for sparklines
  if (st && typeof st === "object") for (const [k, v] of Object.entries(st)) { if (typeof v !== "number") continue; const h = hist.current.get(k) || []; h.push(v); if (h.length > 80) h.shift(); hist.current.set(k, h); }
  const srcLines = lab.bootScript.split("\n");
  const from = Math.max(0, (i.line || 1) - 1);
  let to = from + 1;
  if (i.line) { let depth = 0; for (let k = from; k < Math.min(srcLines.length, from + 80); k++) { const l = srcLines[k]; depth += (l.match(/[({[]/g) || []).length - (l.match(/[)}\]]/g) || []).length; to = k + 1; if (k > from && depth <= 0 && /;\s*(\/\/.*)?$|^\s*$/.test(l)) break; } }
  return (
    <div className="detail">
      <div className="detail-h">
        <h2>{i.path}</h2>
        <span className="sub">{i.kind}{i.cell ? " · " + i.cell : ""} · {i.domain || "—"} domain{i.def && i.def !== i.path ? ` · from ${i.def}` : ""}{i.states?.length ? ` · ${i.states.length} states` : ""}{i.line ? " · " : ""}{i.line ? <button type="button" className="link" onClick={() => lab.goto(i.line)}>line {i.line}</button> : null}</span>
      </div>
      <div className="dtabs">
        {[["state", "Registers"], ["ports", `Ports ${(i.ports || []).length}`], ["streams", `Streams ${streams.length}`], ["knobs", `Knobs ${knobs.length}`], ["asserts", `Asserts ${asserts.length}${fails.length ? " · " + fails.length + " failed" : ""}`], ["source", "Source"], ["params", "Params"]].map(([v, l]) => (
          <button key={v} type="button" className={tab === v ? "on" : ""} onClick={() => setTab(v)}>{l}</button>
        ))}
      </div>
      <div className="dbody">
        {tab === "state" ? (
          st && typeof st === "object" && Object.keys(st).length ? (
            <table className="rt regs"><thead><tr><th>register</th><th>type</th><th className="num">value</th><th>recent</th></tr></thead><tbody>
              {Object.entries(st).map(([k, v]) => {
                const r = (i.regs || []).find((x) => x.name === k);
                return <tr key={k}><td className="nm">{k}</td><td>{tn(r?.type)}</td><td className="num">{fmtVal(v, r?.type?.w)}</td><td className="mcol">{hist.current.get(k)?.length > 2 ? <Spark values={normalize(hist.current.get(k))} h={18} /> : null}</td></tr>;
              })}
            </tbody></table>
          ) : <p className="empty">{lab.sim ? (i.regs || []).length ? "The simulator does not report this instance's state yet." : "No registers." : "Not running."}{(i.regs || []).length ? <><br />{(i.regs || []).map((r) => `${r.name}: ${tn(r.type)}`).join(" · ")}</> : null}</p>
        ) : null}
        {tab === "ports" ? (
          (i.ports || []).length ? <table className="rt"><thead><tr><th>port</th><th>dir</th><th>type</th><th className="num">now</th><th>pin</th></tr></thead><tbody>
            {i.ports.map((p) => {
              const v = lab.sim ? safe(() => peek(lab.sim, `${i.path}.${p.name}`)) : null;
              const pin = (c.pins || []).filter((x) => x.instance === i.path && x.port === p.name).map((x) => x.resource);
              return <tr key={p.name}><td className="nm">{p.name}</td><td>{p.dir}</td><td>{tn(p.type)}</td><td className="num">{fmtVal(v)}</td><td>{pin.length ? pin.length > 3 ? `${pin[0]} … ${pin[pin.length - 1]}` : pin.join(", ") : "—"}</td></tr>;
            })}
          </tbody></table> : <p className="empty">No ports.</p>
        ) : null}
        {tab === "streams" ? (
          streams.length ? <table className="rt"><thead><tr><th>stream</th><th>type</th><th>role</th><th className="num">depth</th><th>overflow</th><th className="num">fired</th><th className="num">dropped</th><th>last beats</th></tr></thead><tbody>
            {streams.map((s) => {
              const ss = streamStats(lab.sim, s.name) || {};
              return <tr key={s.name} className="clickable" onClick={() => { lab.select({ stream: s.name, node: "s:" + s.name }); lab.setUI({ right: "graph", graphMode: "modules" }); }}>
                <td className="nm">{s.name}{s.cross ? <span className="tag">cross {s.cross.from}→{s.cross.to}</span> : null}</td><td>{tn(s.type)}</td><td>{s.producer === i.path ? "provides" : "needs"}</td>
                <td className="num">{s.depth ?? "—"}</td><td>{s.overflow || "—"}</td><td className="num">{ss.fired ?? "—"}</td><td className={cls("num", ss.dropped > 0 && "bad")}>{ss.dropped ?? "—"}</td>
                <td className="lastmsg">{ss.last ? summarize(ss.last.slice?.(-6) ?? ss.last, 50) : "—"}</td></tr>;
            })}
          </tbody></table> : <p className="empty">This instance neither provides nor needs a stream.</p>
        ) : null}
        {tab === "knobs" ? (
          knobs.length ? <table className="rt"><thead><tr><th>register</th><th>kind</th><th>type</th><th className="num">reset</th><th className="num">min</th><th className="num">max</th><th className="num">addr</th><th className="num">now</th></tr></thead><tbody>
            {knobs.map((k) => { const v = safe(() => (k.kind === "status" ? lab.sim?.status?.(k.path) : lab.sim?.knob?.(k.path)?.get?.())); return <tr key={k.path}><td className="nm">{k.name || k.path}</td><td>{k.kind}</td><td>{tn(k.type)}</td><td className="num">{k.reset ?? "—"}</td><td className="num">{k.min ?? "—"}</td><td className="num">{k.max ?? "—"}</td><td className="num">{k.addr != null ? "0x" + Number(k.addr).toString(16) : "—"}</td><td className="num">{fmtVal(v)}</td></tr>; })}
          </tbody></table> : <p className="empty">No knobs, status registers or irqs.</p>
        ) : null}
        {tab === "asserts" ? (
          asserts.length ? <>
            <table className="rt"><thead><tr><th>property</th><th>kind</th><th>line</th><th className="num">failures in this run</th></tr></thead><tbody>
              {asserts.map((a) => { const n = fails.filter((e) => e.path === a.path || e.name === a.name).length; return <tr key={a.path} className={n ? "badrow" : ""}><td className="nm">{a.name}</td><td>{a.kind}</td><td>{a.line ? <button type="button" className="link" onClick={() => lab.goto(a.line)}>{a.line}</button> : "—"}</td><td className={cls("num", n && "bad")}>{n}</td></tr>; })}
            </tbody></table>
            <div className="ctlrow"><Btn sm onClick={() => lab.setUI({ right: "proofs" })}>Prove them</Btn></div>
          </> : <p className="empty">No properties on this instance.</p>
        ) : null}
        {tab === "source" ? (i.line ? <Code text={srcLines.slice(from, to).join("\n")} /> : <p className="empty">{i.kind === "cell" ? "A native cell from std: its behaviour is in the simulator, its interface in std.js." : "No source line recorded."}</p>) : null}
        {tab === "params" ? <Code text={safeJson(i.params) || "// no parameters"} /> : null}
      </div>
      <Repl i={i} />
    </div>
  );
}
const normalize = (a) => { const lo = Math.min(...a); return a.map((x) => x - lo + 1e-6); };
const safeJson = (o) => { try { return JSON.stringify(o ?? null, (k, v) => (typeof v === "bigint" ? v.toString() + "n" : typeof v === "function" ? "ƒ" : v), 2); } catch { return String(o); } };

// a REPL beside the live simulation: peek, poke, release, step and run, or any JS with `sim`
function Repl({ i }) {
  const [hist, setHist] = useState([]);
  const [code, setCode] = useState(() => `peek("${i.path}.${(i.regs?.[0]?.name) || (i.ports?.[0]?.name) || "?"}")`);
  const logRef = useRef(null);
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [hist.length]);
  useEffect(() => { setCode(`peek("${i.path}.${(i.regs?.[0]?.name) || (i.ports?.[0]?.name) || "?"}")`); }, [i.path]);
  const run = async () => {
    const sim = lab.sim;
    if (!code.trim()) return;
    const entry = { code, out: "…", ok: true };
    setHist((h) => [...h.slice(-40), entry]);
    try {
      if (!sim) throw new Error("not running; boot the design first");
      const scope = {
        sim, $: i.path,
        peek: (p) => peek(sim, rel(p, i)), poke: (p, v) => { poke(sim, rel(p, i), v); lab.bump("frame"); return v; }, release: (p) => release(sim, rel(p, i)),
        state: (p = i.path) => instState(sim, p),
        step: (n = 1, d) => { sim.step(n, d || i.domain || lab.mainDomain); lab.bump("frame"); return fmtPs(simTime(sim)); },
        run: (d = "1ms") => { sim.runFor(durPs(d)); lab.bump("frame"); return fmtPs(simTime(sim)); },
        stream: (n) => sim.stream?.(n), knob: (p) => sim.knob?.(p), board: sim.board,
      };
      const names = Object.keys(scope);
      const body = /\breturn\b|;|\n/.test(code) ? code : `return (${code});`;
      const v = await new Function(...names, `"use strict"; return (async () => { ${body} })();`)(...names.map((n) => scope[n]));
      entry.out = v === undefined ? "undefined" : typeof v === "string" ? v : safeJson(v);
    } catch (e) { entry.ok = false; entry.out = "✕ " + (e?.message || e); }
    setHist((h) => [...h]);
  };
  return (
    <div className="repl">
      <div className="repl-h"><b>REPL</b><span className="note">peek · poke (forces until release) · release · step(n) · run("1ms") · state() · stream(name) · knob(path) · sim — names are relative to {i.path}</span></div>
      <div className="repl-log" ref={logRef}>{hist.map((h, k) => <div key={k}><span className="pr">{i.path} ›</span> <code>{h.code}</code><pre className={h.ok ? "" : "bad"}>{clip(h.out, 3000)}</pre></div>)}</div>
      <div className="sendev"><span className="pr">{i.path} ›</span><input value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} aria-label="REPL" spellCheck={false} /><Btn sm onClick={run}>Run</Btn></div>
    </div>
  );
}
// "count" → "counter.count" when it names nothing global
function rel(p, i) { p = String(p); return p.includes(".") || p.includes(":") ? p : `${i.path}.${p}`; }
