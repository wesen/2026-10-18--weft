// Host runtime (owner C): host() lambdas run on simulated time beside the board. `.every(period)` fires on
// the simulator's clock, `.on(event)` on interrupts (a knob of kind "irq", by path) or simulator events,
// `.onStart` once. Each lambda gets a `dev` handle that reaches the design's register map over the bridge
// (in the simulator: directly, with the same clamping the hardware does).
import { durMs, typeName } from "./types.js";

export function devHandle(sim, name = "host", extra = {}) {
  const knob = (path) => {
    const k = () => sim.knob(path);
    const set = (v) => { const kept = k().set(v); bump(); return kept; };
    return {
      path,
      get info() { return k().info; },
      read: async () => k().get(),
      get: async () => k().get(),
      set: async (v) => set(await v),
      update: (f) => { const v = k().get(); const nv = f(v); return nv && typeof nv.then === "function" ? nv.then(set) : Promise.resolve(set(nv)); },
    };
  };
  const bump = () => { const b = sim._cells.find((c) => c.kind === "bridge-uart"); if (b) b.ctx.state.ops++; };
  return {
    name,
    knob,
    status: (path) => ({ path, read: async () => { bump(); return sim.status(path); } }),
    registers: async () => sim.registers().map((r) => ({ ...r, type: r.type || typeName(r.type) })),
    clock: { seconds: () => sim.time / 1e12, ms: () => sim.time / 1e9, now: () => sim.time },
    log: (...args) => sim.log(`[${name}]`, ...args),
    peek: (p) => sim.peek(p),
    board: sim.board,
    uart: (id) => sim.board.uart(id),
    sleep: (d) => new Promise((resolve) => sim.at(sim.time + durMs(d) * 1e9, resolve)),
    ...extra,
  };
}

// start the hosts of a compiled design (all, or `only` one name) → { count, stop() }
export function startHosts(compiled, sim, opts = {}) {
  const hosts = (compiled.hosts || []).filter((h) => !opts.only || h.name === opts.only);
  const offs = [];
  let stopped = false;
  const irqPaths = new Set((compiled.knobs || []).filter((k) => k.kind === "irq").map((k) => k.path));
  for (const h of hosts) {
    const dev = devHandle(sim, h.name);
    const call = (fn, ...args) => {
      if (stopped || typeof fn !== "function") return;
      try {
        const r = fn(dev, ...args);
        if (r && typeof r.catch === "function") r.catch((e) => sim.log(`[${h.name}] error: ${e.message}`));
      } catch (e) { sim.log(`[${h.name}] error: ${e.message}`); }
    };
    for (const ev of h.every || []) {
      const period = (typeof ev.ms === "number" ? ev.ms : durMs(ev.ms ?? ev.period ?? ev.every)) * 1e9;
      if (!(period > 0)) continue;
      const tick = (t) => { if (stopped) return; call(ev.fn); sim.at(t + period, () => tick(t + period)); };
      sim.at(sim.time + period, () => tick(sim.time));
    }
    for (const on of h.on || []) {
      const evName = on.event;
      if (irqPaths.has(evName) || !["assert", "frame", "reset", "drop", "uart", "escalation", "cover", "knob"].includes(evName)) {
        offs.push(sim.on("irq", (e) => { if (e.path === evName) call(on.fn, e); }));
        if (!irqPaths.has(evName)) offs.push(sim.on(evName, (e) => call(on.fn, e)));
      } else offs.push(sim.on(evName, (e) => call(on.fn, e)));
    }
    if (h.onStart) call(h.onStart);
  }
  return { count: hosts.length, names: hosts.map((h) => h.name), stop() { stopped = true; for (const off of offs) off(); } };
}
