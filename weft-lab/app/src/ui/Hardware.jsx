import React, { useEffect, useRef, useState } from "react";
import { lab } from "./lab.js";
import { hw } from "./hw.js";
import { useLab, Btn, Seg, cls } from "./common.jsx";
import { HwError } from "../core/hardware.js";

const STAGES = ["synth", "pnr", "pack", "load"];
const sec = (ms) => (ms == null || ms === 0 ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const when = (t) => { const d = new Date(t); return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); };

// The Hardware tab: build the editor's design for the GateMateA1-EVB with `weft serve`, watch the toolchain,
// compare the Lab's estimate with nextpnr, load the bitstream, and run it in a board session.
export function HardwareTab() {
  useLab("hw", "compiled");
  useEffect(() => {
    hw.refreshStatus().catch(() => {});
    hw.refreshBuilds().then((b) => { if (!hw.current && b.length) hw.select(b[0].id); }).catch(() => {});
    hw.refreshSession().catch(() => {});
  }, []);
  const j = hw.job;
  const run = (fn) => fn().catch((e) => { if (!(e instanceof HwError)) lab.toast(e.message, "bad"); });
  const loadable = j && j.ok && !hw.busy;
  return (
    <div className="stagewrap hw">
      <div className="toolbar">
        <Btn primary disabled={hw.busy} onClick={() => run(() => hw.build({ load: true }))} title="Compile for the A1-EVB, build, and load into SRAM">Build and load</Btn>
        <Btn disabled={hw.busy} onClick={() => run(() => hw.build())}>Build</Btn>
        <Btn disabled={hw.busy} onClick={() => run(() => hw.validate())}
          title="Build, then co-simulate the emitted RTL and a GateMate netlist against this simulator, scenario by scenario">Validate</Btn>
        <Btn disabled={!loadable} onClick={() => run(() => hw.load(hw.current, { force: j.timingOk === false }))}
          title={j?.timingOk === false ? "This build failed timing: it may misbehave on the board" : "Load the shown build into SRAM"}>
          {j?.timingOk === false ? "Load anyway" : "Load"}
        </Btn>
        <label className="lbl">seed <input type="number" min="0" className="seed" value={hw.seed} onChange={(e) => { hw.seed = Math.max(0, +e.target.value | 0); hw.bump(); }} /></label>
        <label className="lbl" title="Add the HIL bridge on the board's UART: a board session can then read every output in board cycles and drive every input (designs that use the UART cannot have it)">
          <input type="checkbox" checked={hw.hil} onChange={(e) => { hw.hil = e.target.checked; hw.bump(); }} /> HIL</label>
        <span className="sp" />
        <StatusLine />
      </div>
      <div className="scroll report">
        {hw.refusal ? <Refusal r={hw.refusal} /> : null}
        {j?.ok || hw.session || hw.boardRun ? <OnBoard j={j} run={run} /> : null}
        {j ? <Build j={j} /> : <p className="empty padded">No build yet. <b>Build</b> compiles the editor's design for the GateMateA1-EVB and runs yosys, nextpnr and gmpack; <b>Build and load</b> also writes it to the FPGA's SRAM (lost at power-off).</p>}
        <Builds />
      </div>
    </div>
  );
}

// the board session (guide §6.10, §6.12): the build on the board, its pins in board cycles through the HIL
// bridge (or its UART text), and the editor's scenarios run there
function OnBoard({ j, run }) {
  const s = hw.session, br = hw.boardRun;
  const other = s && j && s.build !== j.id;
  const hil = j?.report?.hil;
  const note = s ? `session ${s.session} · ${s.mode} · ${s.build}` : hil ? "this build carries the HIL bridge" : j?.ok ? "no HIL bridge: tick HIL and build again to read outputs and drive inputs (a design on the UART runs its UART scenarios without it)" : "";
  return (
    <section className="rsec">
      <h3>On the board <span className="dim">· {note}</span></h3>
      <div className="hwbtns">
        {!s ? <Btn disabled={!j?.ok || hw.busy} onClick={() => run(() => hw.openSession(j.id, { force: j.timingOk === false }))}
          title="Load the shown build and hold the board for this page: no other load until the session closes">Open session</Btn>
          : <Btn onClick={() => run(() => hw.closeSession())}>Close session</Btn>}
        {s?.mode === "hil" ? <Btn onClick={() => run(() => hw.resetBoard())} title="Reset the design; the cycle count restarts at 0">Reset design</Btn> : null}
        <Btn disabled={!j?.ok || br?.running || other} onClick={() => run(() => hw.runOnBoard({ id: j.id, force: j.timingOk === false }))}
          title={other ? `the open session is on ${s.build}` : "Run the editor's portable scenarios on the board, each from a reset, timed in board cycles"}>Run scenarios on board</Btn>
      </div>
      {s?.mode === "hil" ? <HilPins s={s} /> : null}
      {s?.mode === "uart" ? <UartPane /> : null}
      {br ? <BoardRun br={br} /> : null}
    </section>
  );
}

function HilPins({ s }) {
  const st = s.state || {};
  const set = (res, v) => hw.setInputs({ [res]: v }).catch((e) => lab.toast(e.message, "bad"));
  return (
    <div className="hwpins">
      <div className="ledrow-b">{s.outputs.map((p) => (
        <span key={p.resource} className="ledcell" title={`${p.resource} = ${hw.pins[p.resource] ? 1 : 0}`}>
          <span className={cls("led", hw.pins[p.resource] && "on")} style={{ opacity: hw.pins[p.resource] ? 1 : 0.22 }} /><span className="tiny">{p.resource}</span>
        </span>
      ))}</div>
      {s.inputs.length ? <div className="hwbtns">{s.inputs.map((p) => {
        const v = st.inputs?.[p.resource] ?? 0, taken = !p.physical || (st.overrides || []).includes(p.resource);
        return (
          <span key={p.resource} className="hwin">
            <Btn sm onClick={() => set(p.resource, v ? 0 : 1)} title={p.physical ? (taken ? "taken over from the pin" : "follows the physical pin; click to take it over") : "virtual: the bridge drives it"}>
              {p.resource} {taken ? (v ? "▣ 1" : "□ 0") : "· pin"}</Btn>
            {p.physical && taken ? <button type="button" className="ibtn" title="Give it back to the physical pin" onClick={() => set(p.resource, null)}>↩</button> : null}
          </span>
        );
      })}</div> : null}
      <p className={cls("note", (st.lost || st.gaps) && "bad", !(st.lost || st.gaps) && "dim")}>cycle {(st.cycle ?? 0).toLocaleString()} · {st.changes ?? 0} output changes since the reset{st.lost ? ` · ${st.lost} lost (overflow)` : ""}{st.gaps ? ` · ${st.gaps} report lines lost` : ""}</p>
    </div>
  );
}

function UartPane() {
  const [text, setText] = useState("");
  const send = () => { if (!text) return; hw.sendUart(text.replace(/\\n/g, "\n")).then(() => setText("")).catch((e) => lab.toast(e.message, "bad")); };
  return (
    <div className="hwpins">
      <pre className="hwlog">{hw.uart || "(nothing received yet)"}</pre>
      <div className="hwbtns"><input className="hwsend" value={text} placeholder="text to send (\n for a newline)" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(); }} /><Btn sm onClick={send}>Send</Btn></div>
    </div>
  );
}

function BoardRun({ br }) {
  const rows = br.results;
  return (
    <>
      <table className="rt">
        <thead><tr><th>scenario</th><th>result</th><th className="num">board cycles</th><th className="num">time</th><th>details</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.name} className={cls(r.status === "fail" && "badrow")} title={r.steps.map((s) => `${s.ok === false ? "FAIL" : "ok"} ${s.label}${s.note ? " — " + s.note : ""}`).join("\n")}>
            <td className="nm">{r.name}</td><td className={r.status === "pass" ? "ok" : r.status === "fail" ? "bad" : "dim"}>{r.status}</td>
            <td className="num">{r.cycles ? r.cycles.toLocaleString() : ""}</td><td className="num">{sec(r.ms)}</td><td className="lastmsg">{r.message || ""}</td>
          </tr>
        ))}
        {br.running ? <tr className="sel"><td className="nm">{br.current || "…"}</td><td>running…</td><td /><td /><td className="lastmsg">{br.steps.at(-1)?.label || "opening the session"}</td></tr> : null}
        </tbody>
      </table>
      <p className="note dim">Each scenario starts from a reset of the design. Time is the board's cycle count from the HIL bridge, and an input takes effect at the cycle the bridge acknowledges (a millisecond or two after the step, over USB). With the design on the UART, time is the host's clock.</p>
    </>
  );
}

function StatusLine() {
  const s = hw.status;
  if (!s) return <span className="lbl">checking the toolchain…</span>;
  const tc = s.toolchain, b = s.board;
  return (
    <span className="hwstatus">
      <span className={cls("hwchip", !tc.ok && "bad")} title={tc.ok ? Object.entries(tc.versions || {}).map(([k, v]) => `${k} ${v}`).join("\n") : tc.error}>{tc.ok ? `OSS CAD Suite ${tc.version || ""}` : "no toolchain"}</span>
      <span className={cls("hwchip", !b.detected && "bad")} title={b.error || b.chip}>{b.detected ? `${b.name} · ${b.idcode}` : b.at ? "board not found" : "board not checked"}</span>
      <span className={cls("hwchip", !s.serial.present && "dim")} title={s.serial.present ? "the FPGA's UART" : `${s.serial.device} is missing: sudo modprobe cdc_acm`}>{s.serial.device || "serial"}{s.serial.present ? "" : " ✕"}</span>
      {s.busy.builds || s.busy.queued ? <span className="hwchip">{s.busy.builds} building{s.busy.queued ? `, ${s.busy.queued} queued` : ""}</span> : null}
      <button type="button" className="ibtn" title="Check the board again" aria-label="Check the board again" onClick={() => hw.refreshStatus().catch((e) => lab.toast(e.message, "bad"))}>↻</button>
    </span>
  );
}

function Refusal({ r }) {
  return (
    <section className="rsec">
      <h3 className="bad">This design cannot go to the board <span className="dim">· {r.code}</span></h3>
      <p className="note bad">{r.message}</p>
      {(r.details || []).length ? <ul className="steps">{r.details.slice(0, 8).map((d, i) => <li key={i}>{d.line ? <a className="link" onClick={() => lab.goto(d.line)}>line {d.line}</a> : null} {d.message || d.path || JSON.stringify(d)}{d.kind ? ` (${d.kind})` : ""}</li>)}</ul> : null}
    </section>
  );
}

function Build({ j }) {
  const r = j.report;
  return (
    <>
      <section className="rsec">
        <h3>{j.design} <span className="dim">· {j.id} · seed {j.seed} · {j.state}</span></h3>
        {j.error ? <p className={cls("note", j.state !== "done" || j.ok === false ? "bad" : "")}>{j.error}</p> : null}
        <table className="rt hwstages">
          <thead><tr><th>stage</th><th>state</th><th className="num">time</th><th>result</th></tr></thead>
          <tbody>{STAGES.map((n) => (j.stages || []).find((s) => s.name === n)).filter(Boolean).map((s) => (
            <tr key={s.name} className={cls(s.state === "failed" && "badrow", s.state === "running" && "sel")}>
              <td className="nm">{s.name}</td><td className={cls(s.state === "failed" && "bad")}>{s.state === "running" ? "running…" : s.state}</td>
              <td className="num">{sec(s.ms)}</td><td className="lastmsg">{s.summary || ""}</td>
            </tr>
          ))}</tbody>
        </table>
        {j.loaded ? <p className={cls("note", !j.loaded.ok && "bad")}>Last load {when(j.loaded.at)}: {j.loaded.ok ? "on the board (SRAM)" : j.loaded.summary}</p> : null}
      </section>
      {r ? <Compare j={j} /> : null}
      {j.validation?.length || j.state === "validate" ? <Validation j={j} /> : null}
      <Log />
      <Files j={j} />
    </>
  );
}

// the Lab's delay-model estimate next to what yosys and nextpnr report
function Compare({ j }) {
  const r = j.report, est = j.estimate || {}, res = est.resources || {}, u = r.utilization || {};
  const used = (k) => u[k]?.[0], avail = (k) => u[k]?.[1];
  const rows = [["LUTs", res.luts, "CPE_LT"], ["flip-flops", res.ffs, "CPE_FF"], ["BRAM (20K halves)", res.brams, "RAM_HALF"], ["IOs (nextpnr adds the clock pin)", res.ios, "GPIO"], ["PLLs", null, "PLL"]];
  const clocks = r.clocks || [];
  const domainOf = (name) => (name.match(/clk_([\w$]+)$/) || [])[1];
  return (
    <section className="rsec">
      <h3>Estimate vs. the toolchain <span className="dim">· {est.part || "ccgm1a1"} delay model vs. yosys/nextpnr</span></h3>
      <table className="rt">
        <thead><tr><th>resource</th><th className="num">estimate</th><th className="num">nextpnr</th><th className="num">available</th><th className="num">Δ</th></tr></thead>
        <tbody>{rows.filter(([, e, k]) => e != null || used(k) != null).map(([label, e, k]) => (
          <tr key={k}><td className="nm">{label} <span className="tag">{k}</span></td><td className="num">{e ?? "—"}</td><td className="num">{used(k) ?? "—"}</td><td className="num">{avail(k) ?? "—"}</td><td className="num">{delta(e, used(k))}</td></tr>
        ))}</tbody>
      </table>
      <table className="rt">
        <thead><tr><th>clock</th><th className="num">target</th><th className="num">estimate fmax</th><th className="num">nextpnr fmax</th><th className="num">Δ</th><th>timing</th></tr></thead>
        <tbody>{clocks.map((c) => {
          const e = est.fmaxMHz?.[domainOf(c.name)];
          return (
            <tr key={c.name} className={cls(!c.pass && "badrow")}>
              <td className="nm">{c.name}</td><td className="num">{c.targetMHz} MHz</td><td className="num">{e != null ? `${(+e).toFixed(1)} MHz` : "—"}</td>
              <td className="num">{c.fmaxMHz} MHz</td><td className="num">{delta(e, c.fmaxMHz)}</td><td className={c.pass ? "ok" : "bad"}>{c.pass ? "PASS" : "FAIL"}</td>
            </tr>
          );
        })}</tbody>
      </table>
      {(r.plls || []).length ? <p className="note">{r.plls.map((p) => `PLL ${p.domain}: asked ${p.wantMHz} MHz, the Lab modelled ${(+p.modelMHz).toFixed(4)}, nextpnr configured ${p.foutMHz} MHz ${p.ok ? "✓" : "✕"}`).join(" · ")}</p> : null}
      {(r.virtual || []).length ? <p className="note">Virtual on this board ({r.hil ? "driven and read by the HIL bridge" : "inputs read as 0"}): {r.virtual.join(", ")}</p> : null}
      {j.timingOk === false ? <p className="note bad">At least one clock misses its target. The bitstream exists, but loading it is your call: it may work on the bench and fail when warm.</p> : null}
    </section>
  );
}
const delta = (e, real) => (e == null || real == null || !e ? "" : `${real >= e ? "+" : ""}${Math.round(((real - e) / e) * 100)} %`);

function Log() {
  const [stage, setStage] = useState("all");
  const ref = useRef(null);
  const lines = hw.logs.filter((l) => stage === "all" || l.stage === stage);
  useEffect(() => { const el = ref.current; if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight; });
  return (
    <section className="rsec">
      <h3>Log <span className="dim">· live while a stage runs; whole logs are under Files</span></h3>
      <Seg sm label="Stage" items={["all", ...STAGES]} value={stage} onChange={setStage} />
      <pre ref={ref} className="hwlog">{lines.length ? lines.slice(-800).map((l) => (stage === "all" ? `${l.stage.padEnd(5)} ${l.line}` : l.line)).join("\n") : "(nothing streamed yet)"}</pre>
    </section>
  );
}

// the validation ladder (guide §6.10): build, then each scenario replayed against the RTL and the netlist
function Validation({ j }) {
  const rows = j.validation || [];
  const has = (f) => (j.files || []).includes(f);
  const links = (v) => {
    if (!v.dir) return [];
    if (v.dir === "validate/net") return [["synth.log", "validate/net/synth.log"]];
    return [["changes", `${v.dir}/changes.txt`], ["testbench", `${v.dir}/tb.v`], ["log", `${v.dir}/${v.level}.log`]];
  };
  const pass = rows.filter((v) => v.status === "pass").length, fail = rows.filter((v) => v.status === "fail").length;
  return (
    <section className="rsec">
      <h3>Validation <span className="dim">· {j.state === "validate" ? "running…" : `${pass} passed, ${fail} failed, ${rows.length - pass - fail} skipped`}</span></h3>
      <table className="rt">
        <thead><tr><th>level</th><th>scenario</th><th>result</th><th className="num">cycles</th><th className="num">time</th><th>details</th><th /></tr></thead>
        <tbody>{rows.map((v, i) => (
          <tr key={i} className={cls(v.status === "fail" && "badrow")}>
            <td className="nm">{v.level}</td><td>{v.scenario || ""}</td>
            <td className={v.status === "pass" ? "ok" : v.status === "fail" ? "bad" : "dim"}>{v.status}</td>
            <td className="num">{v.cycles ? v.cycles.toLocaleString() : ""}</td><td className="num">{sec(v.ms)}</td>
            <td className="lastmsg">{v.message || ""}</td>
            <td className="hwfiles">{links(v).map(([label, f]) => <a key={f} className="link" href={hw.fileURL(f, j.id)} target="_blank" rel="noreferrer">{label}</a>)}</td>
          </tr>
        ))}</tbody>
      </table>
      {has("validate/net/netlist.v") ? <p className="hwfiles"><a className="link" href={hw.fileURL("validate/net/netlist.v", j.id)} target="_blank" rel="noreferrer">netlist.v</a><a className="link" href={hw.fileURL("validate/net/synth.log", j.id)} target="_blank" rel="noreferrer">synth.log</a></p> : null}
      <p className="note dim">rtl and net run a variant of the design whose main clock is 1 MHz, so every scenario replays whole; a scenario that pokes internal signals is skipped. A design with native cells (UART, debounce) is checked up to its cells; their cores have their own testbenches.</p>
    </section>
  );
}

function Files({ j }) {
  const files = (j.files || []).filter((f) => f !== "top.txt" && f !== "top.json" && !f.startsWith("validate/"));
  if (!files.length) return null;
  return (
    <section className="rsec">
      <h3>Files <span className="dim">· var/weft/builds/{j.id}</span></h3>
      <p className="hwfiles">{files.map((f) => <a key={f} className="link" href={hw.fileURL(f, j.id)} target="_blank" rel="noreferrer">{f}</a>)}</p>
    </section>
  );
}

function Builds() {
  if (!hw.builds.length) return null;
  return (
    <section className="rsec">
      <h3>Builds <span className="dim">· everything in the work directory, the CLI's too, newest first</span></h3>
      <table className="rt">
        <thead><tr><th>build</th><th>state</th><th>result</th><th>board</th></tr></thead>
        <tbody>{hw.builds.slice(0, 30).map((b) => (
          <tr key={b.id} className={cls("clickable", b.id === hw.current && "sel", b.ok && !b.timingOk && "badrow")} onClick={() => hw.select(b.id)}>
            <td className="nm">{b.id}</td><td>{b.state}</td>
            <td>{!b.ok ? "no bitstream" : b.timingOk ? "timing met" : "timing failed"}</td>
            <td>{b.loaded ? (b.loaded.ok ? `loaded ${when(b.loaded.at)}` : "load failed") : ""}</td>
          </tr>
        ))}</tbody>
      </table>
    </section>
  );
}
