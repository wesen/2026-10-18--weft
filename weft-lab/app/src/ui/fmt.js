// Formatting for hardware quantities: picoseconds, hertz, counts, widths and values.
export const clip = (s, n = 200) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

export function fmtPs(ps) {
  ps = Number(ps) || 0;
  const a = Math.abs(ps);
  if (a === 0) return "0 s";
  if (a < 1e3) return ps.toFixed(0) + " ps";
  if (a < 1e6) return (ps / 1e3).toFixed(a < 1e4 ? 2 : 1) + " ns";
  if (a < 1e9) return (ps / 1e6).toFixed(a < 1e7 ? 3 : 1) + " µs";
  if (a < 1e12) return (ps / 1e9).toFixed(a < 1e10 ? 3 : 1) + " ms";
  return (ps / 1e12).toFixed(3) + " s";
}
// the run clock: always seconds with µs resolution
export function fmtClock(ps) {
  const s = (Number(ps) || 0) / 1e12;
  const whole = Math.floor(s), frac = s - whole;
  const us = Math.floor(frac * 1e6).toString().padStart(6, "0");
  return `${whole}.${us.slice(0, 3)} ${us.slice(3)} s`;
}
export function fmtHz(hz) {
  hz = Number(hz) || 0;
  if (hz >= 1e9) return +(hz / 1e9).toFixed(3) + " GHz";
  if (hz >= 1e6) return +(hz / 1e6).toFixed(3) + " MHz";
  if (hz >= 1e3) return +(hz / 1e3).toFixed(3) + " kHz";
  return hz.toFixed(0) + " Hz";
}
export function fmtCount(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " G";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + " M";
  if (n >= 1e4) return (n / 1e3).toFixed(1) + " k";
  return String(Math.round(n));
}
export function fmtSpeed(x) {
  if (!isFinite(x)) return "max";
  if (x >= 1) return +x.toFixed(2) + "×";
  if (x >= 0.01) return +x.toFixed(3) + "×";
  if (x <= 0) return "0×";
  return "1/" + fmtCount(Math.round(1 / x)).replace(" ", "") + "×";
}
export const fmtNs = (ns) => (ns == null || !isFinite(ns) ? "—" : (+ns).toFixed(2) + " ns");
export const fmtMsReal = (ms) => (ms == null ? "—" : ms < 1 ? (ms * 1000).toFixed(0) + " µs" : ms < 1000 ? ms.toFixed(ms < 10 ? 2 : 0) + " ms" : (ms / 1000).toFixed(2) + " s");

// a value read from the simulator: Number, BigInt, boolean, array or object
export function fmtVal(v, w) {
  if (v == null) return "—";
  if (typeof v === "bigint") return "0x" + v.toString(16);
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") {
    if (w && w > 8 && v >= 0) return String(v);
    return String(v);
  }
  if (Array.isArray(v)) return "[" + v.slice(0, 16).map((x) => fmtVal(x)).join(", ") + (v.length > 16 ? ", …" : "") + "]";
  if (ArrayBuffer.isView(v)) return `[${v.constructor.name} ${v.length}]`;
  if (typeof v === "object") return "{ " + Object.entries(v).slice(0, 8).map(([k, x]) => `${k}: ${fmtVal(x)}`).join(", ") + " }";
  return String(v);
}
export const hex = (v, w = 8) => {
  if (v == null) return "—";
  const b = typeof v === "bigint" ? v : BigInt(Math.trunc(Number(v)));
  const m = BigInt.asUintN(Math.max(1, w), b);
  return m.toString(16).padStart(Math.ceil(w / 4), "0");
};
// "250ms", "1s", 1000 → ps
export function durPs(d) {
  if (typeof d === "number") return d * 1e9; // ms
  const m = String(d).trim().match(/^([\d_.]+)\s*(ps|ns|us|µs|ms|s|cycles?)?$/);
  if (!m) throw new Error(`cannot read the duration "${d}" (write "250ms", "10us", "1s")`);
  const v = +m[1].replace(/_/g, ""), u = m[2] || "ms";
  return v * { ps: 1, ns: 1e3, us: 1e6, "µs": 1e6, ms: 1e9, s: 1e12 }[u];
}
export function summarize(v, n = 120) {
  try { return clip(typeof v === "string" ? v : JSON.stringify(v, (k, x) => (typeof x === "bigint" ? x.toString() + "n" : x)), n); } catch { return clip(String(v), n); }
}
