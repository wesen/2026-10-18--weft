// The live-change pipeline (owner C), as F-17 tells it:
//   proposed → checked → verified → built → canary → committed | rolled-back   (or rejected on the way)
// A knob-only change is a register write and commits at once. patch/replace re-elaborate the design through
// `recompile(design)`; verify runs the recorded checks (lint, ports, replay, timing); build is the region's
// partial (an estimate in the Lab); the canary swaps the candidate into the running simulator, carrying
// registers by path and running the module's `.migrate()`, and watches asserts and stalls for its window.
// A trip restores the previous design and its state; the rollback is confirmed after a short clean run.
import { Sim } from "./sim.js";
import { durMs } from "./types.js";
import { compileDesign } from "./compile.js";

const FINAL = new Set(["committed", "rolled-back", "rejected"]);
const ps = (d) => (typeof d === "number" ? d * 1e9 : durMs(d) * 1e9);
const CONFIRM = ps("20ms");     // how long the restored design must run clean before "rolled-back"
let nextId = 1;

export function specOf(change) {
  const st = change?._ || change || {};
  return {
    name: st.name ?? change?.name ?? "change",
    ops: st.ops || [],
    verify: st.verify || [],
    deploy: st.deploy || [],
    rollbackOn: st.rollbackOn || [],
    line: st.line ?? null,
  };
}

// a design with module `name` replaced by `mod`, keeping the old instance's name, domain and bindings
export function replaceIn(d, name, mod) {
  if (!d?._?.items || typeof d._w !== "function") { if (d.replaceModule) return d.replaceModule(name, mod); throw new Error("this design cannot replace modules"); }
  let found = false;
  const items = d._.items.map((e) => {
    const it = e.item;
    if (!it || it.name !== name || !it._ || !mod?._ || it._.kind !== mod._.kind) return e;
    found = true;
    let m = mod.as(name);
    const dom = it._.domain || mod._.domain;
    if (dom) m = m.domain(dom);
    if (it._.binds && Object.keys(it._.binds).length) m = m.bind(it._.binds);
    return { ...e, item: m };
  });
  if (!found) throw new Error(`no module named ${name} to replace`);
  return d._w({ items });
}

export class ChangePipeline {
  constructor({ compiled, sim, recompile = null, sample = null, record = null, onChange = null } = {}) {
    this.current = compiled; this.sim = sim; this.sample = sample;
    // default: re-elaborate the changed Design with the original script, so positions still resolve
    this.recompile = recompile || ((design) => compileDesign(design, { file: this.current.file, script: this.current.script, peek: this.current.peek, header: this.current.header }));
    this.onChange = onChange;
    this.changes = [];
    this.active = null;            // the change in canary or confirming a rollback
    this.queue = [];
    this.offs = [];
    this.rec = { streams: record?.streams || compiled?.record?.streams || [], keep: ps(record?.keep ?? compiled?.record?.keep ?? "2s") };
    this.offs.push(sim.on("assert", (e) => this._onAssert(e)));
  }
  stop() { for (const off of this.offs) off(); this.offs = []; }
  isFinal(status) { return FINAL.has(status); }
  find(name) {
    const hit = (c) => (name instanceof RegExp ? name.test(c.name) : c.name === name || c.id === name);
    for (let i = this.changes.length - 1; i >= 0; i--) if (hit(this.changes[i])) return this.changes[i];
    return null;
  }
  list() { return this.changes.slice(); }
  pendingApproval() { return this.changes.find((c) => c.status === "awaiting-approval") || null; }
  approve(id) { const c = this.changes.find((x) => x.id === id || x.name === id); if (c && c.status === "awaiting-approval") { this._to(c, "proposed", "approved"); this._run(c); } return c; }
  reject(id, why = "rejected by a person") { const c = this.changes.find((x) => x.id === id || x.name === id); if (c && !FINAL.has(c.status)) this._to(c, "rejected", why); return c; }

  // submit a change() builder; agent proposals wait for approval
  submit(change, meta = {}) {
    const sp = specOf(change);
    const kinds = new Set(sp.ops.map((o) => o.op));
    const c = {
      id: `c${nextId++}`, name: sp.name, spec: sp, builder: change,
      kind: kinds.size === 1 ? [...kinds][0] : kinds.size ? "mixed" : "empty",
      knobOnly: sp.ops.length > 0 && sp.ops.every((o) => o.op === "knob"),
      status: "proposed", history: [], reason: "", created: this.sim.time,
      fromAgent: !!meta.fromAgent, agent: meta.agent || null, target: sp.ops.find((o) => o.op !== "knob")?.target || null,
      checks: [], before: this.current, after: null,
    };
    c.history.push({ status: "proposed", time: this.sim.time, note: meta.note || "" });
    this.changes.push(c);
    if (c.fromAgent) { this._to(c, "awaiting-approval", `from ${c.agent || "an agent"}`); return c; }
    this._run(c);
    return c;
  }
  // a whole edited script, already compiled, as a change: lint, canary swap, commit or roll back
  submitDesign(compiled, { name = "edit", canary = "300ms", watch = ["asserts"], rollbackOn = ["assert"] } = {}) {
    const c = {
      id: `c${nextId++}`, name, spec: { name, ops: [], verify: [{ op: "lint", args: [] }], deploy: canary ? [{ op: "canary", args: [canary, { watch }] }] : [], rollbackOn },
      kind: "design", knobOnly: false, status: "proposed", history: [{ status: "proposed", time: this.sim.time, note: "an edited design" }], reason: "",
      created: this.sim.time, fromAgent: false, agent: null, target: null, checks: [], before: this.current, after: null, compiled,
    };
    this.changes.push(c);
    this.onChange?.(c);
    this._run(c);
    return c;
  }
  _to(c, status, note = "") {
    c.status = status;
    if (note) c.reason = note;
    c.history.push({ status, time: this.sim.time, note });
    this.onChange?.(c);
    this.sim.emit("change", { id: c.id, name: c.name, status, note, time: this.sim.time });
  }
  _run(c) {
    if (c.knobOnly) {
      const kept = c.spec.ops.map((o) => `${o.path} = ${this.sim.knob(o.path).set(o.value)}`);
      this._to(c, "checked", "a register write");
      this._to(c, "verified", "no rebuild");
      this._to(c, "committed", kept.join(", "));
      return;
    }
    if (this.active) { this.queue.push(c); c.history.push({ status: "queued", time: this.sim.time, note: `behind ${this.active.name}` }); return; }
    this.active = c;
    let out;
    if (c.compiled) out = c.compiled;
    else {
      let design;
      try { design = this._candidateDesign(c); } catch (e) { return this._reject(c, e.message); }
      try { out = this.recompile(design); } catch (e) { return this._reject(c, `recompile: ${e.message}`); }
    }
    const go = (cand) => {
      if (!cand || cand.ok === false) {
        const err = cand?.diags?.find((d) => d.level === "error");
        return this._reject(c, `does not compile${err ? `: ${err.message}` : ""}`);
      }
      c.after = cand;
      this._to(c, "checked", `${Object.keys(cand.domains || {}).length} domains`);
      const v = this._verify(c, cand);
      if (!v.ok) return this._reject(c, v.note);
      this._to(c, "verified", v.note);
      const b = this._build(c, cand);
      if (!b.ok) return this._reject(c, b.note);
      this._to(c, "built", b.note);
      this._canary(c, cand);
    };
    if (out && typeof out.then === "function") out.then(go, (e) => this._reject(c, e.message)); else go(out);
  }
  _reject(c, why) {
    this._to(c, "rejected", why);
    if (this.active === c) this.active = null;
    this._next();
  }
  _next() { const n = this.queue.shift(); if (n) this._run(n); }
  _candidateDesign(c) {
    let d = this.current.design;
    if (!d) throw new Error("the running design has no builder to change");
    for (const o of c.spec.ops) {
      if (o.op === "replace") d = replaceIn(d, o.target, o.module);
      else if (o.op === "patch") { if (!d.patchModule) throw new Error("this design cannot patch modules"); d = d.patchModule(o.target, o.patch); }
    }
    return d;
  }
  // verify: the recorded v => v.lint().ports("same").replay("last 1s").timing() calls, in order
  _verify(c, cand) {
    const notes = [];
    for (const call of c.spec.verify) {
      const a = call.args || [];
      if (call.op === "lint") {
        const errs = (cand.diags || []).filter((d) => d.level === "error");
        if (errs.length) return { ok: false, note: `lint: ${errs[0].message}` };
        notes.push(`lint ${(cand.diags || []).filter((d) => d.level === "warn").length} warnings`);
      } else if (call.op === "ports") {
        const t = c.target;
        const sig = (comp) => { const i = (comp.instances || []).find((x) => x.path === t); if (!i) return null; return JSON.stringify({ p: (i.ports || []).map((p) => [p.name, p.dir, String(p.type?.w ?? p.type)]).sort(), pr: [...(i.provides || [])].sort(), n: [...(i.needs || [])].sort() }); };
        const a0 = sig(this.current), b0 = sig(cand);
        if (a[0] === "same" && a0 !== b0) return { ok: false, note: `ports: ${t} changed its interface` };
        notes.push("ports same");
      } else if (call.op === "replay") {
        const r = this._replay(c, cand, a[0]);
        if (!r.ok) return r;
        notes.push(r.note);
      } else if (call.op === "timing") {
        const t = cand.report?.timing || {};
        const bad = Object.entries(t).filter(([, v]) => v && typeof v === "object" && typeof v.slack === "number" && v.slack < 0);
        if (bad.length) return { ok: false, note: `timing: ${bad[0][0]} slack ${bad[0][1].slack.toFixed(2)} ns` };
        notes.push("timing met (estimate)");
      } else notes.push(call.op);
    }
    return { ok: true, note: notes.join(" · ") || "no checks" };
  }
  // replay: run the candidate from the live state for the window, on a scratch simulator; asserts must
  // hold and the recorded streams must keep flowing at the rate they had
  _replay(c, cand, spec = "last 1s") {
    const m = String(spec).match(/(\d[\d_.]*\s*\w+)/);
    const win = Math.min(ps(m ? m[1] : "1s"), this.rec.keep);
    let scratch;
    try {
      scratch = new Sim(this.current, { seed: this.sim.seed + 1, waves: false });
      scratch.restore(this.sim.snapshot({ events: false }));
      scratch.reload(cand, { migrate: this._migrations(c) });
    } catch (e) { return { ok: false, note: `replay: ${e.message}` }; }
    const watch = this.rec.streams.length ? this.rec.streams : [];
    const before = Object.fromEntries(watch.map((s) => [s, scratch.streams.get(s)?.fired ?? 0]));
    const fails = [];
    scratch.on("assert", (e) => fails.push(e));
    scratch.runFor(win);
    if (fails.length) return { ok: false, note: `replay: "${fails[0].name}" fails at ${(fails[0].time / 1e9).toFixed(1)} ms` };
    const flowed = watch.map((s) => `${s} ${(scratch.streams.get(s)?.fired ?? 0) - before[s]} beats`);
    return { ok: true, note: `replay ${(win / 1e9).toFixed(0)} ms clean${flowed.length ? ` (${flowed.join(", ")})` : ""}` };
  }
  _migrations(c) {
    const mig = {};
    for (const o of c.spec.ops) if (o.op === "replace" && o.module?._?.migrate) mig[o.target] = o.module._.migrate;
    return mig;
  }
  // build: the partial for the region the target is placed in, if it fits (estimated resources)
  _build(c, cand) {
    const dep = c.spec.deploy.find((x) => x.op === "partial");
    const region = dep?.args?.[0] ?? cand.place?.[c.target] ?? null;
    c.region = region;
    if (!region) return { ok: true, note: "full rebuild (estimate)" };
    const r = (cand.regions || []).find((x) => x.name === region);
    const use = cand.report?.perModule?.[c.target];
    if (r && use) for (const k of ["luts", "ffs", "brams", "dsps"]) if (r[k] != null && use[k] != null && use[k] > r[k]) return { ok: false, note: `${c.target} needs ${use[k]} ${k}; region ${region} has ${r[k]}` };
    return { ok: true, note: `partial for region ${region}${use ? ` (${use.luts ?? "?"} LUTs, ${use.dsps ?? 0} DSPs)` : ""}` };
  }
  _canary(c, cand) {
    const can = c.spec.deploy.find((x) => x.op === "canary");
    const dur = can ? ps(can.args[0] ?? "300ms") : 0;
    const watch = can?.args?.[1]?.watch || ["asserts"];
    c.watch = watch;
    const migrate = this._migrations(c);
    const sim = this.sim;
    c.prev = this.current;
    sim.reload(cand, { migrate });
    for (const o of c.spec.ops) if (o.op === "knob") sim.knob(o.path).set(o.value);
    this.current = cand;
    if (!dur) { this._commit(c); return; }
    c.until = sim.time + dur;
    c.trip = null;
    c.flow = Object.fromEntries(this._watchedStreams(c).map((s) => [s, { n: sim.streams.get(s)?.fired ?? 0, t: sim.time }]));
    this._to(c, "canary", `${(dur / 1e9).toFixed(0)} ms, watching ${watch.join(", ")}`);
  }
  _watchedStreams(c) {
    const out = [];
    for (const w of c.watch || []) { const m = String(w).match(/^(.*)\.rate$/); if (m) out.push(m[1]); }
    if (c.spec.rollbackOn.includes("stall") && c.target) {
      const i = (this.current.instances || []).find((x) => x.path === c.target);
      for (const s of i?.provides || []) if (!out.includes(s)) out.push(s);
    }
    return out.filter((s) => this.sim.streams.has(s));
  }
  _onAssert(e) {
    const c = this.active;
    if (!c || c.status !== "canary" || c.trip) return;
    const on = c.spec.rollbackOn.length ? c.spec.rollbackOn : ["assert"];
    if (!on.includes("assert") && !(c.watch || []).includes("asserts")) return;
    c.trip = `"${e.name}" failed at ${(e.time / 1e9).toFixed(1)} ms`;
  }
  // advance time-based stages; called between simulator slices
  poll() {
    const c = this.active, sim = this.sim;
    if (!c) return;
    if (c.status === "canary") {
      if (!c.trip && c.spec.rollbackOn.includes("stall")) {
        for (const [s, f] of Object.entries(c.flow || {})) {
          const n = sim.streams.get(s)?.fired ?? 0;
          if (n > f.n) { f.n = n; f.t = sim.time; } else if (sim.time - f.t > ps("50ms")) c.trip = `${s} stalled for 50 ms`;
        }
      }
      if (c.trip) return this._rollback(c, c.trip);
      if (sim.time >= c.until) return this._commit(c);
    } else if (c.status === "rolling-back" && sim.time >= c.confirmAt) {
      this._to(c, "rolled-back", c.reason);
      this.active = null;
      this._next();
    }
  }
  _commit(c) {
    this._to(c, "committed", c.region ? `region ${c.region} swapped` : "deployed");
    this.active = null;
    this._next();
  }
  _rollback(c, why) {
    const sim = this.sim;
    sim.reload(c.prev, {});
    this.current = c.prev;
    c.confirmAt = sim.time + CONFIRM;
    this._to(c, "rolling-back", why);
    c.reason = why;
  }
}
