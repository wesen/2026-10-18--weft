// Native cell models (owner C) and the value helpers shared by the simulator.
//
// A cell is `{ init(ctx), tick(ctx) → active }`. The simulator calls `tick` once per edge of every domain the
// cell touches, after that domain's combinational evaluation and before its registers update (ARCH §4–5).
// A cell reads the comb values of the nodes in `cell.io` with `ctx.get(key)` and sets its drives for the
// next cycle with `ctx.set(key, v)`. `tick` returns true when it changed anything (state or drives); a cell
// that will act at a later time without any input changing asks for it with `ctx.wakeAt(ps)`. Cells use
// time (ps), never tick counts, so the scheduler may skip quiescent cycles.
import { wrapTo, durMs, hzOf, u } from "./types.js";

// ---------- values: flattened structs and vectors ----------
// A struct is its fields concatenated, first field most significant; a vec is its elements, element 0 least
// significant (ARCH §1). Patterns of up to 53 bits are Numbers, wider ones BigInts. Layouts and unsigned
// types are cached: building a type object is far slower than any of the arithmetic here.
const UT = [];
export const uOf = (w) => (UT[w] ||= u(w));
const LAYOUT = new WeakMap();
export function layout(T) {
  let L = LAYOUT.get(T);
  if (L) return L;
  if (T.k === "vec") L = Array.from({ length: T.n }, (_, i) => ({ name: i, T: T.elem, off: i * T.elem.w, w: T.elem.w }));
  else { let off = T.w; L = T.fields.map(([name, FT]) => { off -= FT.w; return { name, T: FT, off, w: FT.w }; }); }
  LAYOUT.set(T, L);
  return L;
}
function sliceBits(v, lo, w) {
  if (typeof v === "bigint") { const p = BigInt.asUintN(w, v >> BigInt(lo)); return w > 53 ? p : Number(p); }
  const p = lo === 0 ? v : Math.floor(v / 2 ** lo);
  return w >= 53 ? p : p - Math.floor(p / 2 ** w) * 2 ** w;
}
// the unsigned bit pattern of a value held for T (already in range)
function patternOf(v, w) {
  if (typeof v === "bigint") return BigInt.asUintN(w, v);
  return v < 0 ? v + 2 ** w : v;
}
const isComposite = (T) => T && (T.k === "struct" || T.k === "vec");
export function decode(v, T) {
  if (!T || !isComposite(T)) return v;
  const L = layout(T), vec = T.k === "vec", out = vec ? new Array(L.length) : {};
  for (const f of L) { const p = sliceBits(v, f.off, f.w); out[f.name] = isComposite(f.T) ? decode(p, f.T) : wrapTo(p, f.T); }
  return out;
}
export function encode(x, T) {
  if (x === true) x = 1; else if (x === false || x == null) x = 0;
  if (!isComposite(T)) return wrapTo(typeof x === "bigint" || typeof x === "number" ? x : Number(x) || 0, T);
  if (typeof x === "number" || typeof x === "bigint") return wrapTo(x, uOf(T.w));
  const L = layout(T), vec = T.k === "vec";
  if (vec && !Array.isArray(x)) x = [];
  if (T.w <= 53) { let s = 0; for (const f of L) s += patternOf(encode(x[f.name], f.T), f.w) * 2 ** f.off; return s; }
  let s = 0n; for (const f of L) s |= BigInt(patternOf(encode(x[f.name], f.T), f.w)) << BigInt(f.off); return s;
}
// random raw value of a type (seeded rng → [0,1))
export function randomOf(T, rnd) {
  const RT = isComposite(T) ? uOf(T.w) : T;
  if (T.w <= 30) return wrapTo(Math.floor(rnd() * 2 ** T.w), RT);
  let b = 0n; for (let i = 0; i < T.w; i += 30) b = (b << 30n) | BigInt(Math.floor(rnd() * 2 ** 30));
  return wrapTo(BigInt.asUintN(T.w, b), RT);
}
// "led:0..7" → ["led:0", …, "led:7"]; arrays pass through
export function expand(id) {
  if (Array.isArray(id)) return id.flatMap(expand);
  const m = String(id).match(/^(.*?)(\d+)\.\.(\d+)$/);
  if (!m) return [String(id)];
  const a = +m[2], b = +m[3], out = [];
  for (let i = a; a <= b ? i <= b : i >= b; a <= b ? i++ : i--) out.push(m[1] + i);
  return out;
}
export const psOf = (d) => (d == null ? null : durMs(d) * 1e9);
export function mulberry32(seed) {
  let a = seed >>> 0 || 1;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------- io grouping: stream endpoints by name and role ----------
// io keys "<stream>.valid|data|ready"; a group is "produce" when the cell drives valid, "consume" when it reads it.
export function groupIO(io = {}) {
  const groups = {}, ports = {};
  for (const [key, e] of Object.entries(io)) {
    const m = key.match(/^(.*)\.(valid|data|ready)$/);
    if (!m) { ports[key] = e; continue; }
    (groups[m[1]] ||= { name: m[1] })[m[2]] = key;
  }
  const produce = [], consume = [];
  for (const g of Object.values(groups)) {
    const v = g.valid && io[g.valid];
    if (v?.dir === "drive" || (!v && g.data && io[g.data]?.dir === "drive")) produce.push(g); else consume.push(g);
  }
  return { produce, consume, ports };
}
const pick = (list, re) => list.find((g) => re.test(g.name)) || null;

// ---------- the models ----------
export const CELLS = {
  debounce: {
    init(ctx) {
      const st = ctx.state;
      const raw = ctx.cell.pins?.raw ?? ctx.params.raw ?? [];
      st.res = ctx.board.expand(raw);
      const n = st.res.length || ctx.params.n || 0;
      st.settle = psOf(ctx.params.settleMs ?? ctx.params.settle ?? 10);
      st.long = ctx.params.longMs != null || ctx.params.long != null ? psOf(ctx.params.longMs ?? ctx.params.long) : null;
      st.stable = new Array(n).fill(0); st.last = new Array(n).fill(0); st.since = new Array(n).fill(0);
      st.pressAt = new Array(n).fill(0); st.longSent = new Array(n).fill(false); st.q = [];
      const g = groupIO(ctx.cell.io);
      st.S = g.produce[0] || null;
      st.held = ctx.cell.io?.held ? "held" : Object.keys(g.ports).find((k) => ctx.cell.io[k].dir === "drive") || null;
    },
    tick(ctx) {
      const st = ctx.state, t = ctx.time;
      let act = false;
      if (st.S && ctx.get(st.S.valid) && ctx.get(st.S.ready)) { st.q.shift(); act = true; }
      let held = 0;
      for (let i = 0; i < st.res.length; i++) {
        const raw = ctx.input(st.res[i]) ? 1 : 0;
        if (raw !== st.last[i]) { st.last[i] = raw; st.since[i] = t; act = true; ctx.wakeAt(t + st.settle); }
        if (raw !== st.stable[i] && t - st.since[i] >= st.settle) {
          st.stable[i] = raw; act = true;
          if (raw) { st.pressAt[i] = t; st.longSent[i] = false; if (st.long != null) ctx.wakeAt(t + st.long); }
          else if (!st.longSent[i]) st.q.push({ id: i, long: 0 });
        }
        if (st.stable[i] && st.long != null && !st.longSent[i] && t - st.pressAt[i] >= st.long) { st.longSent[i] = true; st.q.push({ id: i, long: 1 }); act = true; }
        if (st.stable[i]) held += 2 ** i;
      }
      if (st.held) ctx.set(st.held, held);
      if (st.S) {
        ctx.set(st.S.valid, st.q.length ? 1 : 0);
        if (st.q.length) ctx.set(st.S.data, encode(st.q[0], ctx.typeOf(st.S.data)));
      }
      return act;
    },
    view: (st) => ({ held: st.stable.slice(), queued: st.q.length }),
  },

  "uart-rx": {
    init(ctx) {
      const st = ctx.state;
      st.baud = ctx.params.baud ?? 115_200; st.bit = 1e12 / st.baud;
      st.q = []; st.busyUntil = 0;
      st.S = groupIO(ctx.cell.io).produce[0] || null;
      const res = ctx.cell.pins?.rx ?? ctx.cell.pins?.uart ?? "uart.rx";
      ctx.board.uart(termId(res)).attachRx(ctx);
    },
    // called by the board terminal: bytes arrive one frame (10 bit times) apart
    enqueue(ctx, bytes) {
      const st = ctx.state;
      let t = Math.max(ctx.sim.time, st.busyUntil);
      for (const b of bytes) { t += 10 * st.bit; st.q.push({ b, t }); }
      st.busyUntil = t;
      if (st.q.length) ctx.wakeAt(st.q[0].t);
    },
    tick(ctx) {
      const st = ctx.state, S = st.S;
      if (!S) return false;
      let act = false;
      if (st.showing && ctx.get(S.valid) && ctx.get(S.ready)) { st.q.shift(); st.showing = false; act = true; }
      const head = st.q[0];
      if (head && head.t <= ctx.time) {
        if (!st.showing) act = true;
        st.showing = true;
        ctx.set(S.valid, 1); ctx.set(S.data, head.b);
      } else {
        st.showing = false;
        ctx.set(S.valid, 0);
        if (head) ctx.wakeAt(head.t);
      }
      return act;
    },
    view: (st) => ({ queued: st.q.length }),
  },

  "uart-tx": {
    init(ctx) {
      const st = ctx.state;
      st.baud = ctx.params.baud ?? 115_200; st.bit = 1e12 / st.baud;
      st.cur = null; st.until = 0;
      st.S = groupIO(ctx.cell.io).consume[0] || null;
      st.term = termId(ctx.cell.pins?.tx ?? ctx.cell.pins?.uart ?? "uart.tx");
      if (st.S) ctx.set(st.S.ready, 1);
    },
    tick(ctx) {
      const st = ctx.state, S = st.S;
      if (!S) return false;
      let act = false;
      if (st.cur != null && ctx.time >= st.until) {
        ctx.board.uart(st.term).cellOut(String.fromCharCode(st.cur));
        ctx.emit("uart", { id: st.term, ch: String.fromCharCode(st.cur) });
        st.cur = null; act = true;
      }
      if (st.cur == null && ctx.get(S.valid) && ctx.get(S.ready)) {
        st.cur = Number(ctx.get(S.data)) & 255; st.until = ctx.time + 10 * st.bit; ctx.wakeAt(st.until); act = true;
      }
      ctx.set(S.ready, st.cur == null ? 1 : 0);
      return act;
    },
    view: (st) => ({ busy: st.cur != null }),
  },

  "sigma-delta": {
    init(ctx) {
      const st = ctx.state;
      st.S = groupIO(ctx.cell.io).consume[0] || null;
      if (st.S) { ctx.set(st.S.ready, 1); const T = ctx.typeOf(st.S.data); st.full = T ? 2 ** (T.w - 1) : 32768; }
    },
    tick(ctx) {
      const st = ctx.state, S = st.S;
      if (!S) return false;
      ctx.set(S.ready, 1);
      if (ctx.get(S.valid) && ctx.get(S.ready)) { ctx.board.audioPush(Number(ctx.get(S.data)) / st.full, ctx.time); return true; }
      return false;
    },
  },

  "video-timing": {
    init(ctx) {
      const st = ctx.state;
      const mode = VIDEO_MODES[ctx.params.mode || "640x480@60"] || VIDEO_MODES["640x480@60"];
      Object.assign(st, { mode, x: 0, y: 0, frames: 0, hist: new Int32Array(256), first: null });
      const g = groupIO(ctx.cell.io);
      st.beam = pick(g.produce, /beam/) || g.produce.find((p) => !/frame/.test(p.name)) || null;
      st.frame = pick(g.produce, /frame/);
      st.framePort = g.ports.frame && ctx.cell.io.frame.dir === "drive" ? "frame" : null;
      st.beamT = st.beam && ctx.typeOf(st.beam.data);
      st.sh = { x: 1, y: 0, v: 0 };
      if (st.beamT && st.beamT.k === "struct") { st.sh = { x: 0, y: 0, v: 0 }; for (const f of layout(st.beamT)) if (f.name === "x" || f.name === "y") st.sh[f.name] = 2 ** f.off; else if (f.name === "visible") st.sh.v = 2 ** f.off; }
      st.r = { bv: st.beam && ctx.ref(st.beam.valid), bd: st.beam && ctx.ref(st.beam.data), fv: st.frame && ctx.ref(st.frame.valid), fd: st.frame?.data && ctx.ref(st.frame.data), fp: st.framePort && ctx.ref(st.framePort) };
      if (st.r.bv) ctx.put(st.r.bv, st.r.bv.big ? 1n : 1);
      present(ctx);
    },
    tick(ctx) {
      const st = ctx.state, m = st.mode;
      const c = ctx.D.cycle;
      if (st.first == null) st.first = c;
      st.hist[c & 255] = st.x | (st.y << 11) | ((st.x < m.w && st.y < m.h ? 1 : 0) << 22);
      if (++st.x === m.htotal) { st.x = 0; if (++st.y === m.vtotal) { st.y = 0; st.frames++; } }
      present(ctx);
      return true;
    },
    save: (st) => ({ x: st.x, y: st.y, frames: st.frames, first: st.first, hist: st.hist.slice() }),
    restore: (st, s) => { Object.assign(st, s, { hist: s.hist.slice() }); },
    view: (st) => ({ x: st.x, y: st.y, frames: st.frames }),
  },

  hdmi: {
    init(ctx) {
      const st = ctx.state;
      st.S = groupIO(ctx.cell.io).consume[0] || null;
      const T = st.S && ctx.typeOf(st.S.data);
      st.fields = rgbFields(T);
      st.lat = st.lat ?? null; st.count = 0; st.frames = st.frames ?? 0;
      if (st.S) { st.rv = ctx.ref(st.S.valid); st.rr = ctx.ref(st.S.ready); st.rd = ctx.ref(st.S.data); if (st.rr) ctx.put(st.rr, st.rr.big ? 1n : 1); }
    },
    tick(ctx) {
      const st = ctx.state;
      if (!st.rv || !st.rr) return false;
      if (!st.timing) {
        const tm = ctx.sim._cells.find((c) => c.kind === "video-timing" && c.domains.includes(ctx.domain));
        if (!tm) return false;
        st.timing = tm.ctx.state;
        const m = st.timing.mode;
        st.w = m.w; st.h = m.h;
        st.bufs = [0, 1, 2].map(() => { const b = new Uint8ClampedArray(m.w * m.h * 4); for (let i = 3; i < b.length; i += 4) b[i] = 255; return b; });
        st.cur = 0;
      }
      if (!st.rv.A[st.rv.i] || !st.rr.A[st.rr.i]) return false;
      const tm = st.timing, c = ctx.D.cycle;
      if (st.lat == null) st.lat = c - (tm.first ?? c);
      const h = tm.hist[(c - st.lat) & 255];
      if (h >> 22) {
        const x = h & 2047, y = (h >> 11) & 2047;
        const v = st.rd.A[st.rd.i], f = st.fields, buf = st.bufs[st.cur], o = (y * st.w + x) * 4;
        const n = typeof v === "bigint" ? Number(BigInt.asUintN(53, v)) : v;
        buf[o] = Math.floor(n / f.r) & f.rm; buf[o + 1] = Math.floor(n / f.g) & f.gm; buf[o + 2] = Math.floor(n / f.b) & f.bm;
        st.count++;
        if (x === st.w - 1 && y === st.h - 1) {
          const frame = makeFrame(st.w, st.h, st.bufs[st.cur], ctx.time, st.frames++, st.count);
          st.cur = (st.cur + 1) % 3; st.count = 0;
          ctx.board.pushFrame(frame);
          ctx.emit("frame", { id: ctx.path, frame });
        }
      }
      return true;
    },
    save: (st) => ({ lat: st.lat, frames: st.frames }),
    restore: (st, s) => { st.lat = s.lat; st.frames = s.frames; },
    view: (st) => ({ frames: st.frames, latency: st.lat }),
  },

  "bridge-uart": {
    init(ctx) { ctx.state.baud = ctx.params.baud ?? 1_000_000; ctx.state.ops = 0; },
    tick() { return false; },
    view: (st) => ({ baud: st.baud, ops: st.ops }),
  },

  // a stream crossing between clock domains: an asynchronous FIFO (or a handshake register when depth is 1)
  xfifo: {
    init(ctx) {
      const st = ctx.state, p = ctx.params;
      st.depth = p.depth ?? 16; st.policy = p.policy ?? p.overflow ?? "block";
      st.from = p.from; st.to = p.to; st.q = []; st.dropped = 0; st.fired = 0; st.shown = false; st.has = false;
      const io = ctx.cell.io;
      const key = (side, sig) => [`${side}.${sig}`].find((k) => io[k]) || Object.keys(io).find((k) => k.endsWith(`.${sig}`) && io[k].domain === (side === "in" ? st.from : st.to));
      st.r = {};
      for (const side of ["in", "out"]) for (const sig of ["valid", "data", "ready"]) { const k = key(side, sig); st.r[side + sig[0].toUpperCase() + sig.slice(1)] = k ? ctx.ref(k) : null; }
      st.stages = 2 + Math.floor(ctx.rng() * 2);
      const r = st.r;
      if (r.inReady) ctx.put(r.inReady, r.inReady.big ? 1n : 1);
      if (r.outValid) ctx.put(r.outValid, r.outValid.big ? 0n : 0);
    },
    tick(ctx) {
      const st = ctx.state, r = st.r, D = ctx.D;
      let act = false;
      if (!st.toD) { st.toD = ctx.sim.dom[st.to] || r.outValid?.D || null; st.fromD = ctx.sim.dom[st.from] || r.inValid?.D || null; }
      const sync = st.stages * (st.toD ? st.toD.period : 0);
      if (D === st.fromD && r.inValid) {
        if (r.inValid.A[r.inValid.i] && r.inReady.A[r.inReady.i]) {
          const v = r.inData ? r.inData.A[r.inData.i] : 1;
          // "latest" keeps only the freshest value: offering the same value again changes nothing
          if (!(st.policy === "latest" && st.has && st.lastIn === v)) {
            const e = { v, t: ctx.time };
            if (st.q.length >= st.depth) {
              if (st.policy === "drop-oldest") { st.q.shift(); st.q.push(e); st.dropped++; ctx.emit("drop", { stream: ctx.path }); }
              else if (st.policy === "latest") { st.q[st.q.length - 1] = e; st.dropped++; }
              else if (st.policy === "drop-newest") { st.dropped++; ctx.emit("drop", { stream: ctx.path }); }
            } else st.q.push(e);
            act = true; st.lastIn = v; st.has = true;
            if (st.toD) ctx.sim._wakeAt(ctx.time + sync, st.toD);
          }
        }
        if (r.inReady) { const rd = st.policy === "block" ? (st.q.length < st.depth ? 1 : 0) : 1; ctx.put(r.inReady, r.inReady.big ? BigInt(rd) : rd); }
      }
      if (D === st.toD && r.outValid) {
        if (!st.q.length && !st.shown) return act;
        if (st.shown && r.outValid.A[r.outValid.i] && (!r.outReady || r.outReady.A[r.outReady.i])) { st.q.shift(); st.fired++; st.shown = false; act = true; if (st.fromD) ctx.sim._wake(st.fromD); }
        const head = st.q[0];
        if (head && head.t + sync <= ctx.time) {
          if (!st.shown) act = true;
          st.shown = true; ctx.put(r.outValid, r.outValid.big ? 1n : 1); if (r.outData) ctx.put(r.outData, head.v);
        } else {
          st.shown = false; ctx.put(r.outValid, r.outValid.big ? 0n : 0);
          if (head) ctx.sim._wakeAt(head.t + sync, D);
        }
      }
      return act;
    },
    save: (st) => ({ q: st.q.map((e) => ({ ...e })), dropped: st.dropped, fired: st.fired, shown: st.shown, has: st.has, lastIn: st.lastIn }),
    restore: (st, s) => Object.assign(st, s, { q: s.q.map((e) => ({ ...e })) }),
    view: (st) => ({ queued: st.q.length, dropped: st.dropped, fired: st.fired }),
  },
};

export const VIDEO_MODES = {
  "640x480@60": { w: 640, h: 480, htotal: 800, vtotal: 525, hz: 25_175_000 },
  "800x600@60": { w: 800, h: 600, htotal: 1056, vtotal: 628, hz: 40_000_000 },
  "1280x720@60": { w: 1280, h: 720, htotal: 1650, vtotal: 750, hz: 74_250_000 },
};
function present(ctx) {
  const st = ctx.state, m = st.mode, r = st.r;
  if (r.bd) { const sh = st.sh, v = st.x * sh.x + st.y * sh.y + (st.x < m.w && st.y < m.h ? sh.v : 0); ctx.put(r.bd, r.bd.big ? BigInt(v) : v); }
  if (r.fv || r.fp) {
    const start = st.x === 0 && st.y === 0 ? 1 : 0;
    if (r.fv) ctx.put(r.fv, r.fv.big ? BigInt(start) : start);
    if (r.fd) ctx.put(r.fd, r.fd.big ? BigInt(start) : start);
    if (r.fp) ctx.put(r.fp, r.fp.big ? BigInt(start) : start);
  }
}
function rgbFields(T) {
  const f = { r: 2 ** 16, g: 2 ** 8, b: 1, rm: 255, gm: 255, bm: 255 };
  if (!T || T.k !== "struct") return f;
  let off = T.w;
  for (const [name, FT] of T.fields) { off -= FT.w; if (name in { r: 1, g: 1, b: 1 }) { f[name] = 2 ** off; f[name + "m"] = 2 ** Math.min(FT.w, 8) - 1; } }
  return f;
}
export function colorOf(c) {
  if (c == null) return null;
  if (typeof c === "number") return { r: (c >> 16) & 255, g: (c >> 8) & 255, b: c & 255 };
  if (Array.isArray(c)) return { r: c[0], g: c[1], b: c[2] };
  if (typeof c === "string" && /^#?[0-9a-f]{6}$/i.test(c)) return colorOf(parseInt(c.replace("#", ""), 16));
  return c;
}
export function makeFrame(w, h, data, time, index, pixels) {
  return {
    w, h, data, time, index, pixels,
    at(x, y) { const o = (y * w + x) * 4; return { r: data[o], g: data[o + 1], b: data[o + 2] }; },
    count(c) {
      let n = 0;
      if (typeof c === "function") { for (let o = 0; o < data.length; o += 4) if (c({ r: data[o], g: data[o + 1], b: data[o + 2] })) n++; return n; }
      const k = colorOf(c);
      for (let o = 0; o < data.length; o += 4) if (data[o] === k.r && data[o + 1] === k.g && data[o + 2] === k.b) n++;
      return n;
    },
  };
}
// "uart.tx" / "uart:rx" / "uart" → terminal id "uart"
export function termId(res) { return String(res).replace(/[.:](tx|rx)$/, ""); }
export { hzOf };
