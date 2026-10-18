import React, { useEffect, useMemo, useRef, useState } from "react";
import { lab } from "./lab.js";
import { useLab, Btn, Seg, Tog, Kv, Spark, Code, cls } from "./common.jsx";
import { streamStats, safe, peek } from "./engine.js";
import { typeName } from "../core/types.js";
import { fmtVal, fmtHz, summarize, clip } from "./fmt.js";

const tn = (t) => (t && typeof t === "object" ? safe(() => typeName(t), "?") : t ? String(t) : "—");
const DAG_MAX = 260;

// compress ["led:0", "led:1", …, "led:7"] → "led:0..7"
function rangeLabel(ids) {
  const by = new Map();
  for (const id of ids) { const [p, n] = String(id).split(":"); if (n != null && /^\d+$/.test(n)) { if (!by.has(p)) by.set(p, []); by.get(p).push(+n); } else by.set(id, null); }
  const out = [];
  for (const [p, ns] of by) {
    if (!ns) { out.push(p); continue; }
    ns.sort((a, b) => a - b);
    let a = ns[0], prev = a;
    for (let i = 1; i <= ns.length; i++) { if (ns[i] === prev + 1) { prev = ns[i]; continue; } out.push(a === prev ? `${p}:${a}` : `${p}:${a}..${prev}`); a = prev = ns[i]; }
  }
  return out.join(", ");
}

const IN_CELLS = new Set(["debounce", "uart-rx", "bridge-uart", "video-timing"]);
const COLNAMES = ["BOARD IN", "INPUT CELLS", "MODULES", "FSM · PIPELINES · CROSSINGS", "OUTPUT CELLS", "BOARD OUT", "HOST · AGENTS"];

function modulesGraph(c) {
  const nodes = new Map(), edges = [];
  const add = (id, o) => { if (!nodes.has(id)) nodes.set(id, { id, ...o }); return nodes.get(id); };
  const colOf = (i) => {
    if (i.kind === "agent" || i.kind === "host") return 6;
    if (i.kind === "cell") return i.cell === "xfifo" ? 3 : IN_CELLS.has(i.cell) ? 1 : 4;
    if (i.kind === "fsm" || i.kind === "pipeline") return 3;
    return 2;
  };
  for (const i of c.instances || []) add("i:" + i.path, { col: colOf(i), label: i.path, sub: `${i.cell || i.kind}${i.domain ? " · " + i.domain : ""}`, kind: i.kind === "cell" ? "cell" : i.kind === "agent" ? "agent" : i.kind === "host" ? "host" : "module", inst: i });
  // pins, grouped per instance port
  const groups = new Map();
  for (const p of c.pins || []) {
    if (!p.instance) continue;
    const k = `${p.dir}|${p.instance}|${p.port}`;
    if (!groups.has(k)) groups.set(k, { dir: p.dir, inst: p.instance, port: p.port, res: [] });
    groups.get(k).res.push(p.resource);
  }
  for (const [k, g] of groups) {
    const label = rangeLabel(g.res);
    const id = "p:" + k;
    add(id, { col: g.dir === "in" ? 0 : 5, label, sub: `${g.dir === "in" ? "input" : "output"} · ${g.port}`, kind: "pin" });
    if (g.dir === "in") edges.push({ from: id, to: "i:" + g.inst, label: "" });
    else edges.push({ from: "i:" + g.inst, to: id, label: "" });
  }
  for (const s of c.streams || []) {
    for (const to of s.consumers || []) if (s.producer) edges.push({ from: "i:" + s.producer, to: "i:" + to, label: s.name, stream: s, kind: s.cross ? "cross" : "" });
    if (!s.producer && (s.consumers || []).length) { add("s:" + s.name, { col: 1, label: s.name, sub: "fed by scenarios", kind: "pin" }); for (const to of s.consumers) edges.push({ from: "s:" + s.name, to: "i:" + to, label: "", stream: s }); }
  }
  for (const h of c.hosts || []) if (h.over && nodes.has("i:" + h.over)) edges.push({ from: "i:" + h.name, to: "i:" + h.over, label: "registers", kind: "dash" });
  return { nodes: [...nodes.values()], edges: edges.filter((e) => nodes.has(e.from) && nodes.has(e.to)) };
}

function dagGraph(g) {
  const nodes = [], edges = [];
  const live = g.live();
  const depth = new Map();
  const isSrc = (n) => n.op === "in" || n.op === "reg" || n.op === "const" || n.op === "mem";
  let order;
  try { order = g.topo(); } catch { order = live.map((n) => n.id); }
  for (const id of order) {
    const n = g.node(id);
    if (!n) continue;
    depth.set(id, isSrc(n) ? 0 : 1 + Math.max(0, ...n.args.map((a) => depth.get(a) ?? 0)));
  }
  let max = 0;
  for (const v of depth.values()) max = Math.max(max, v);
  for (const n of live) {
    let col = depth.get(n.id) ?? 0;
    if (n.op === "out" || n.op === "memwr" || n.op === "probe") col = max + 1;
    const path = n.attrs?.path ? String(n.attrs.path) : "";
    const label = `%${n.id} ${n.op}${n.op === "const" ? " " + clip(String(n.attrs.value), 10) : ""}`;
    nodes.push({ id: "n" + n.id, nid: n.id, col, label, sub: `${tn(n.type)}${path ? " · " + path : ""}`, kind: n.op === "reg" ? "reg" : n.op === "in" ? "pin" : n.op === "out" ? "pin" : n.op === "const" ? "const" : n.op.startsWith("mem") || n.op === "rom" ? "mem" : "op", bad: false });
    n.args.forEach((a, k) => edges.push({ from: "n" + a, to: "n" + n.id, label: "" }));
    if (n.op === "reg" && n.attrs.next != null) edges.push({ from: "n" + n.attrs.next, to: "n" + n.id, label: "next", kind: "dot" });
  }
  return { nodes, edges };
}

function layout(g, width, NW, NH, RG) {
  const cols = [...new Set(g.nodes.map((n) => n.col))].sort((a, b) => a - b);
  const byCol = cols.map((c) => g.nodes.filter((n) => n.col === c));
  const idx = new Map();
  byCol.forEach((list) => list.forEach((n, i) => idx.set(n.id, i)));
  const preds = new Map();
  for (const e of g.edges) { if (!preds.has(e.to)) preds.set(e.to, []); preds.get(e.to).push(e.from); }
  for (let pass = 0; pass < 4; pass++) {
    byCol.forEach((list, ci) => {
      if (ci === 0) return;
      const bc = (n) => { const ps = (preds.get(n.id) || []).map((x) => idx.get(x)).filter((x) => x != null); return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : idx.get(n.id); };
      list.sort((a, b) => bc(a) - bc(b));
      list.forEach((n, i) => idx.set(n.id, i));
    });
  }
  const gap = Math.max(NW + 44, (width - 40 - NW) / Math.max(1, cols.length - 1));
  const pos = new Map();
  let h = 0;
  byCol.forEach((list, ci) => list.forEach((n, i) => { pos.set(n.id, { x: 20 + ci * gap, y: 40 + i * (NH + RG) }); h = Math.max(h, 40 + (i + 1) * (NH + RG)); }));
  return { pos, w: Math.max(width, 40 + (cols.length - 1) * gap + NW), h: h + 30, cols, gap };
}

export function GraphTab() {
  useLab("frame", "sel", "boot", "ui", "compiled");
  const ref = useRef(null);
  const [w, setW] = useState(900);
  const [flow, setFlow] = useState(true);
  useEffect(() => { const el = ref.current; if (!el) return; const ro = new ResizeObserver(() => setW(el.clientWidth)); ro.observe(el); return () => ro.disconnect(); }, []);
  const c = lab.simCompiled?.ok ? lab.simCompiled : lab.compiled;
  const doms = Object.keys(c?.domains || {});
  const mode = lab.ui.graphMode === "dag" && doms.length ? "dag" : "modules";
  const dom = doms.includes(lab.sel.domain) ? lab.sel.domain : doms[0];
  const G = c?.domains?.[dom]?.graph;
  const big = mode === "dag" && G && G.size > DAG_MAX;
  const g = useMemo(() => {
    if (!c) return { nodes: [], edges: [] };
    if (mode === "dag") return G && !big ? dagGraph(G) : { nodes: [], edges: [] };
    return modulesGraph(c);
  }, [c, mode, dom, big]);
  const NW = mode === "dag" ? 120 : 150, NH = mode === "dag" ? 32 : 40, RG = mode === "dag" ? 12 : 18;
  const L = layout(g, w, NW, NH, RG);
  const sel = lab.sel.node;
  return (
    <>
      <div className="stagewrap">
        <div className="toolbar">
          <Seg label="View" items={[["modules", "Modules · streams"], ["dag", "DAG"]]} value={mode} onChange={(v) => lab.setUI({ graphMode: v })} />
          {mode === "dag" && doms.length > 1 ? <Seg label="Domain" items={doms.map((d) => [d, d])} value={dom} onChange={(v) => lab.select({ domain: v, node: null })} /> : null}
          {mode === "modules" ? <Tog on={flow} onClick={() => setFlow(!flow)}>Stream counts</Tog> : null}
          <span className="sp" />
          <span className="lbl">{mode === "dag" && G ? `${dom} · ${G.size} nodes · ${G.count("reg")} registers${c.domains[dom].hz ? " · " + fmtHz(c.domains[dom].hz) : ""}` : `${g.nodes.length} nodes · ${g.edges.length} edges`}</span>
        </div>
        <div className="diagram" ref={ref}>
          {!c?.instances?.length && !G ? <p className="empty padded">{lab.compiled?.ok === false ? "The graph appears when the design compiles. Fix the errors in the editor." : "Nothing to draw."}</p> : big ? <BigDag G={G} dom={dom} /> : (
            <svg width={L.w} height={L.h} className={cls("graph", mode)}>
              {mode === "modules" ? COLNAMES.map((t, i) => (L.cols.includes(i) ? <text key={i} x={20 + L.cols.indexOf(i) * L.gap} y={22} className="colhd">{t}</text> : null)) : L.cols.map((cI, k) => <text key={k} x={20 + k * L.gap} y={22} className="colhd">{k === 0 ? "SOURCES · REGISTERS" : k === L.cols.length - 1 ? "OUTPUTS" : "LEVEL " + cI}</text>)}
              {g.edges.map((e, i) => {
                const a = L.pos.get(e.from), b = L.pos.get(e.to);
                if (!a || !b) return null;
                const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2;
                const back = x2 <= x1;
                const d = back ? `M${x1},${y1} C ${x1 + 50},${y1 + 50} ${x2 - 50},${y2 + 50} ${x2},${y2}` : `M${x1},${y1} C ${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`;
                const mx = (x1 + x2) / 2, my = back ? Math.max(y1, y2) + 38 : (y1 + y2) / 2;
                const ss = e.stream && flow && lab.sim ? streamStats(lab.sim, e.stream.name) : null;
                const selE = e.stream && sel === "s:" + e.stream.name;
                const bad = ss && Number(ss.dropped) > 0;
                const lbl = e.label ? e.label + (ss ? ` · ${ss.fired ?? 0}${bad ? " / " + ss.dropped + " dropped" : ""}` : "") : "";
                return (
                  <g key={i} className={cls("edge", e.kind, bad && "bad", selE && "sel", (sel === e.from || sel === e.to) && "hl")} onClick={() => e.stream && lab.select({ node: "s:" + e.stream.name, stream: e.stream.name })}>
                    <path d={d} />
                    <path d={`M${x2 - 5},${y2 - 3} L${x2},${y2} L${x2 - 5},${y2 + 3}`} />
                    {lbl && mode === "modules" ? <g className="elabel"><rect x={mx - lbl.length * 2.9 - 4} y={my - 9} width={lbl.length * 5.8 + 8} height={13} /><text x={mx} y={my + 1}>{lbl}</text></g> : null}
                  </g>
                );
              })}
              {g.nodes.map((n) => {
                const p = L.pos.get(n.id);
                const fails = n.inst ? lab.events.some((e) => e.kind === "assert" && String(e.path || "").startsWith(n.inst.path)) : false;
                return (
                  <g key={n.id} className={cls("node", n.kind, (n.bad || fails) && "bad", sel === n.id && "sel")} transform={`translate(${p.x},${p.y})`}
                    onClick={() => lab.select({ node: n.id, ...(n.inst ? { instance: n.inst.path } : {}) })} onDoubleClick={() => n.inst && lab.setUI({ right: "modules" })}>
                    <rect width={NW} height={NH} />
                    {n.kind === "reg" || n.kind === "mem" ? <line x1="0" x2={NW} y1="4" y2="4" /> : null}
                    {n.kind === "agent" ? <path d={`M${NW - 10},0.5 L${NW - 0.5},0.5 L${NW - 0.5},10`} className="corner" /> : null}
                    <text x="8" y={mode === "dag" ? 14 : 17} className="nl">{clip(n.label, mode === "dag" ? 18 : 22)}</text>
                    <text x="8" y={mode === "dag" ? 26 : 31} className="ns">{clip(n.sub, mode === "dag" ? 20 : 28)}</text>
                  </g>
                );
              })}
            </svg>
          )}
        </div>
        <div className="hint"><b>Click</b> a node{mode === "modules" ? " or a stream" : ""} to inspect · {mode === "modules" ? <><b>Double-click</b> an instance to open it in Modules</> : <>dotted edges are registers' next values · the inspector links back to the source line</>}</div>
      </div>
      <GraphSide c={c} G={G} dom={dom} mode={mode} />
    </>
  );
}

function BigDag({ G, dom }) {
  const st = G.stats();
  const ops = Object.entries(st.ops).sort((a, b) => b[1] - a[1]);
  const max = ops[0]?.[1] || 1;
  return (
    <div className="bigdag">
      <p className="note">The {dom} domain has {st.nodes} nodes, more than the {DAG_MAX} drawn as a picture. The census and the printed IR follow; pick a node id in the inspector to follow it.</p>
      <table className="rt census"><tbody>{ops.map(([op, n]) => <tr key={op}><td className="nm">{op}</td><td className="num">{n}</td><td className="mcol"><div className="meter"><i style={{ width: (n / max) * 100 + "%" }} /></div></td></tr>)}</tbody></table>
      <Code text={safe(() => G.print({ max: 400 }), "")} />
    </div>
  );
}

function GraphSide({ c, G, dom, mode }) {
  useLab("frame", "sel");
  const sel = lab.sel.node;
  const [goto, setGoto] = useState("");
  if (sel?.startsWith("n") && G) {
    const id = +sel.slice(1);
    const n = G.node(id);
    if (n) return <NodeInspector n={n} G={G} dom={dom} />;
  }
  if (sel?.startsWith("s:") && c) {
    const s = (c.streams || []).find((x) => x.name === sel.slice(2));
    if (s) return <StreamSide s={s} />;
  }
  const inst = sel?.startsWith("i:") ? (c?.instances || []).find((i) => i.path === sel.slice(2)) : null;
  return (
    <div className="side">
      {inst ? (
        <div className="block"><header><h2>{inst.path}</h2><span className="sp" /><span className="sub">{inst.cell || inst.kind}</span></header>
          <Kv rows={[["domain", inst.domain || "—"], ["provides", (inst.provides || []).join(", ") || "—"], ["needs", (inst.needs || []).join(", ") || "—"], ["registers", (inst.regs || []).length], ["ports", (inst.ports || []).map((p) => p.name).join(", ") || "—"], inst.states?.length ? ["states", inst.states.join(", ")] : null, inst.line ? ["line", <button key="l" type="button" className="link" onClick={() => lab.goto(inst.line)}>{inst.line}</button>] : null]} />
          <div className="ctlrow"><Btn sm onClick={() => lab.setUI({ right: "modules" })}>Open in Modules</Btn>{inst.domain && c?.domains?.[inst.domain] ? <Btn sm onClick={() => { lab.setUI({ graphMode: "dag" }); lab.select({ domain: inst.domain, node: null }); }}>Its DAG</Btn> : null}</div>
        </div>
      ) : <div className="block"><header><h2>Graph</h2></header><p className="note">{mode === "dag" ? "One DAG per clock domain: registers cut the cycles, pure nodes are hash-consed, so equal logic exists once. Every node keeps the source it came from." : "Instances in columns by kind, linked by the streams they provide and need and the pins they bind. Click a stream label to see its traffic."}</p></div>}
      {mode === "dag" && G ? (
        <div className="block"><header><h2>Go to a node</h2></header>
          <div className="sendev"><input value={goto} onChange={(e) => setGoto(e.target.value)} placeholder="%id or a register path" aria-label="Node" onKeyDown={(e) => { if (e.key !== "Enter") return; const v = goto.trim().replace(/^%/, ""); const id = /^\d+$/.test(v) ? +v : G.names?.get(v); if (id != null && G.node(id)) lab.select({ node: "n" + id }); else lab.toast("No such node in " + dom, "bad"); }} /></div>
          <Kv rows={Object.entries(G.stats().ops).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([op, k]) => [op, k])} />
        </div>
      ) : null}
      <Legend mode={mode} />
    </div>
  );
}

function NodeInspector({ n, G, dom }) {
  const users = G.users(n.id);
  const val = lab.sim && n.attrs?.path ? safe(() => peek(lab.sim, n.attrs.path)) : null;
  const go = (id) => lab.select({ node: "n" + id });
  const attrs = Object.entries(n.attrs || {}).filter(([k, v]) => v !== undefined && v !== null && k !== "path").slice(0, 12);
  return (
    <div className="side">
      <div className="block"><header><h2>%{n.id} {n.op}</h2><span className="sp" /><span className="sub">{dom} · {tn(n.type)}</span></header>
        <Kv rows={[
          n.attrs?.path ? ["path", String(n.attrs.path)] : null, val != null ? ["now", fmtVal(val)] : null,
          ...attrs.map(([k, v]) => [k, k === "next" ? <button key={k} type="button" className="link" onClick={() => go(v)}>%{v}</button> : k === "table" && Array.isArray(v) ? `${v.length} entries` : clip(summarize(v, 80), 80)]),
        ]} />
        {n.args.length ? <div className="nlinks"><span className="dim">reads</span> {n.args.map((a, i) => <button key={i} type="button" className="link" onClick={() => go(a)}>%{a} {G.node(a)?.op}</button>)}</div> : null}
        {users.length ? <div className="nlinks"><span className="dim">read by</span> {users.slice(0, 24).map((u, i) => <button key={i} type="button" className="link" onClick={() => go(u)}>%{u} {G.node(u)?.op}</button>)}{users.length > 24 ? ` +${users.length - 24}` : ""}</div> : null}
      </div>
      <div className="block"><header><h2>Where it came from</h2><span className="sp" /><span className="sub">{(n.origin || []).length} span{(n.origin || []).length === 1 ? "" : "s"}</span></header>
        {(n.origin || []).length ? (n.origin || []).map((o, i) => (
          <div key={i} className="origin">
            <button type="button" className="link" onClick={() => lab.goto(o.line)}>{o.file && o.file !== "design.js" ? o.file + ":" : "line "}{o.line}{o.col != null ? ":" + o.col : ""}</button>
            {o.src ? <code>{clip(o.src, 120)}</code> : null}
          </div>
        )) : <p className="note">No origin: this node was made by the compiler (a synchronizer, a prescaler or a pass).</p>}
      </div>
    </div>
  );
}

function StreamSide({ s }) {
  useLab("frame");
  const ss = (lab.sim && streamStats(lab.sim, s.name)) || null;
  const hist = useRef([]);
  const lastF = useRef(null);
  if (ss && ss.fired != null) { const f = Number(ss.fired); if (lastF.current != null) { hist.current.push(Math.max(0, f - lastF.current)); if (hist.current.length > 60) hist.current.shift(); } lastF.current = f; }
  return (
    <div className="side">
      <div className="block"><header><h2>{s.name}</h2><span className="sp" /><span className="sub">stream · {tn(s.type)}</span></header>
        <Kv rows={[["producer", s.producer || "scenario"], ["consumers", (s.consumers || []).join(", ") || "none"], ["buffer", s.depth != null ? `${s.depth} · ${s.overflow || "block"}` : "none (a wire with a handshake)"], s.cross ? ["crosses", `${s.cross.from} → ${s.cross.to}`] : null, ["fired", ss?.fired ?? "—"], ["dropped", ss?.dropped ?? "—", Number(ss?.dropped) > 0]]} />
        <span className="note">beats per frame, recent</span>
        <Spark values={hist.current} />
        {ss?.last?.length ? <><span className="note">last beats</span><Code text={summarize(ss.last.slice(-12), 600)} max={120} /></> : null}
      </div>
      <Legend mode="modules" />
    </div>
  );
}

function Legend({ mode }) {
  return mode === "dag" ? (
    <div className="block legend"><header><h2>Legend</h2></header>
      <div className="lg"><svg width="30" height="18"><rect x="0.5" y="0.5" width="26" height="16" className="lg-w" /></svg>pure op<svg width="30" height="18"><rect x="0.5" y="0.5" width="26" height="16" className="lg-d" /></svg>in / out</div>
      <div className="lg"><svg width="30" height="18"><rect x="0.5" y="0.5" width="26" height="16" className="lg-w" /><line x1="0" x2="27" y1="4" y2="4" className="lg-w" /></svg>register / memory<svg width="30" height="10"><path d="M0,5 h26" className="lg-e dot" /></svg>next</div>
    </div>
  ) : (
    <div className="block legend"><header><h2>Legend</h2></header>
      <div className="lg"><svg width="30" height="18"><rect x="0.5" y="0.5" width="26" height="16" className="lg-w" /></svg>module<svg width="30" height="18"><rect x="0.5" y="0.5" width="26" height="16" className="lg-d" /></svg>pins</div>
      <div className="lg"><svg width="30" height="18"><rect x="0.5" y="0.5" width="26" height="16" className="lg-c" /></svg>std cell<svg width="30" height="18"><rect x="0.5" y="0.5" width="26" height="16" className="lg-w" /><path d="M19,0.5 L26.5,0.5 L26.5,8" className="lg-a" /></svg>agent</div>
      <div className="lg"><svg width="30" height="10"><path d="M0,5 h26" className="lg-e" /></svg>stream<svg width="30" height="10"><path d="M0,5 h26" className="lg-e dash" /></svg>crossing, bridge</div>
      <div className="lg"><svg width="30" height="10"><path d="M0,5 h26" className="lg-e bad" /></svg><span className="bad">dropping beats</span></div>
    </div>
  );
}
