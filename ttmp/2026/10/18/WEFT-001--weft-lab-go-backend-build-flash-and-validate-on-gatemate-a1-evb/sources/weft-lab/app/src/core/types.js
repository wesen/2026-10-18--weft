// Weft types and the width rules of decision D1, plus value arithmetic.
//
// Values: a JS Number for types up to 53 bits wide (holding the mathematical integer, negative for
// signed values), a BigInt for wider types. `isBig(T)` tells which. Every operation takes values in
// their operand types and returns a value in the result type that `binType`/`unType` computed, so no
// operation ever overflows its own type (D1). Narrowing happens only in `wrap` and `sat`.

const freeze = Object.freeze;
export const BIG = 53;

function scalar(signed, w, extra = {}) {
  if (!Number.isInteger(w) || w < 1) throw new TypeError(`a width must be a whole number ≥ 1, got ${w}`);
  return mk({ k: signed ? "s" : "u", signed, w, ...extra });
}
function mk(t) {
  const T = { ...t };
  Object.defineProperty(T, "init", { value: (v) => mk({ ...T, initVal: v }), enumerable: false });
  Object.defineProperty(T, "width", { get: () => T.w, enumerable: false });
  Object.defineProperty(T, "toString", { value: () => typeName(T), enumerable: false });
  return freeze(T);
}

export const u = (w) => scalar(false, w);
export const s = (w) => scalar(true, w);
export const bit = u(1);
export const pulse = scalar(false, 1, { pulse: true });
export function vec(elem, n) {
  if (!elem || !elem.k) throw new TypeError("vec(T, n) needs a type");
  return mk({ k: "vec", elem, n, w: elem.w * n, signed: false });
}
export function struct(fields) {
  const list = Object.entries(fields).map(([name, T]) => [name, T]);
  let w = 0;
  for (const [, T] of list) w += T.w;
  return mk({ k: "struct", fields: list, w, signed: false });
}
export const isType = (x) => !!x && typeof x === "object" && typeof x.k === "string" && Number.isInteger(x.w);
export const isScalar = (T) => T.k === "u" || T.k === "s";
export const isBig = (T) => T.w > BIG;
export function typeName(T) {
  if (!T) return "?";
  if (T.k === "u") return T.pulse ? "pulse" : T.w === 1 ? "bit" : `u${T.w}`;
  if (T.k === "s") return `s${T.w}`;
  if (T.k === "vec") return `vec(${typeName(T.elem)}, ${T.n})`;
  if (T.k === "struct") return `{ ${T.fields.map(([n, F]) => `${n}: ${typeName(F)}`).join(", ")} }`;
  return "?";
}
export const sameType = (a, b) => typeName(a) === typeName(b);
export const clog2 = (n) => (n <= 1 ? 0 : Math.ceil(Math.log2(n)));
export const bitlen = (k) => (k <= 0 ? 0 : Math.floor(Math.log2(k)) + 1);

// ---------- D1: types of constants and operations ----------
export function constType(k) {
  if (typeof k === "bigint") {
    if (k >= 0n) return u(Math.max(1, k.toString(2).length));
    return s((-k - 1n).toString(2).length + 1);
  }
  if (typeof k === "boolean") return bit;
  if (!Number.isInteger(k)) throw new TypeError(`hardware constants are integers; got ${k}`);
  if (k >= 0) return u(Math.max(1, bitlen(k)));
  return s(bitlen(-k - 1) + 1);
}
// signed view of a scalar: u(n) meets a signed operand as s(n+1)
const asSigned = (T) => (T.signed ? T : s(T.w + 1));
// smallest type holding both (the join; R1.6)
export function join(a, b) {
  if (a.signed === b.signed) return a.signed ? s(Math.max(a.w, b.w)) : u(Math.max(a.w, b.w));
  const A = asSigned(a), B = asSigned(b);
  return s(Math.max(A.w, B.w));
}
export function binType(op, a, b) {
  switch (op) {
    case "add": {
      if (!a.signed && !b.signed) return u(Math.max(a.w, b.w) + 1);
      const J = join(a, b);
      return s(J.w + 1);
    }
    case "sub": {
      if (!a.signed && !b.signed) return s(Math.max(a.w, b.w) + 1);
      const J = join(a, b);
      return s(J.w + 1);
    }
    case "mul": return a.signed || b.signed ? s(a.w + b.w) : u(a.w + b.w);
    case "and": case "or": case "xor": return join(a, b);
    case "eq": case "ne": case "lt": case "le": case "gt": case "ge": case "land": case "lor": return bit;
    default: throw new Error(`no type rule for ${op}`);
  }
}
export function unType(op, a) {
  switch (op) {
    case "neg": return s((a.signed ? a.w : a.w) + 1);
    case "not": return a;
    case "lnot": return bit;
    default: throw new Error(`no type rule for ${op}`);
  }
}
export function shiftType(op, a, k, kType) {
  // k: a constant shift amount (number) or null for a dynamic shift whose amount has type kType
  if (k != null) {
    if (op === "shl") return a.signed ? s(a.w + k) : u(a.w + k);
    const w = Math.max(1, a.w - k);
    return a.signed ? s(w) : u(w);
  }
  if (op === "shl") { const add = Math.min(2 ** kType.w - 1, 64); return a.signed ? s(a.w + add) : u(a.w + add); }
  return a;
}
// may a value of type src be assigned to dst without wrap()/sat()? (widening is implicit)
export function fits(src, dst) {
  if (!isScalar(src) || !isScalar(dst)) return src.w <= dst.w;
  if (src.signed && !dst.signed) return false;
  if (!src.signed && dst.signed) return src.w + 1 <= dst.w;
  return src.w <= dst.w;
}

// ---------- values ----------
export const range = (T) => {
  if (T.signed) return [-(2 ** (T.w - 1)), 2 ** (T.w - 1) - 1];
  return [0, 2 ** T.w - 1];
};
// wrap any integer value into T (two's complement, modulo 2^w)
export function wrapTo(v, T) {
  const w = T.w;
  if (isBig(T)) {
    const b = typeof v === "bigint" ? v : BigInt(v);
    return T.signed ? BigInt.asIntN(w, b) : BigInt.asUintN(w, b);
  }
  if (typeof v === "bigint") v = Number(T.signed ? BigInt.asIntN(w, v) : BigInt.asUintN(w, v));
  if (w <= 31) {
    if (T.signed) { const sh = 32 - w; return (v << sh) >> sh; }
    return v & (2 ** w - 1);
  }
  if (w === 32) return T.signed ? v | 0 : v >>> 0;
  const m = 2 ** w;
  let r = v - Math.floor(v / m) * m;
  if (T.signed && r >= m / 2) r -= m;
  return r;
}
export function satTo(v, T) {
  if (isBig(T)) {
    const b = typeof v === "bigint" ? v : BigInt(v);
    const lo = T.signed ? -(1n << BigInt(T.w - 1)) : 0n, hi = T.signed ? (1n << BigInt(T.w - 1)) - 1n : (1n << BigInt(T.w)) - 1n;
    return b < lo ? lo : b > hi ? hi : b;
  }
  const n = typeof v === "bigint" ? Number(v) : v;
  const [lo, hi] = range(T);
  return n < lo ? lo : n > hi ? hi : n;
}
// convert a value held for type `from` into the representation of type `to` (same mathematical value)
export function conv(v, to) {
  if (isBig(to)) return typeof v === "bigint" ? v : BigInt(v);
  return typeof v === "bigint" ? Number(v) : v;
}
// the raw bit pattern of v in T as an unsigned value (Number or BigInt per T)
export function bitsOf(v, T) {
  if (isBig(T)) return BigInt.asUintN(T.w, typeof v === "bigint" ? v : BigInt(v));
  return wrapTo(v, u(T.w));
}
// read a pattern (unsigned) as T
export function fromBits(p, T) { return wrapTo(p, T); }

// Reference evaluator for one operation (the semantics every other layer must agree with).
// vals are in their operand types; result in type R.
export function evalOp(op, R, vals, attrs = {}) {
  const big = isBig(R) || vals.some((x) => typeof x === "bigint");
  const B = (x) => (typeof x === "bigint" ? x : BigInt(x));
  const out = (x) => conv(x, R);
  switch (op) {
    case "add": return out(big ? B(vals[0]) + B(vals[1]) : vals[0] + vals[1]);
    case "sub": return out(big ? B(vals[0]) - B(vals[1]) : vals[0] - vals[1]);
    case "mul": { const r = B(vals[0]) * B(vals[1]); return isBig(R) ? r : Number(r); }
    case "neg": return out(big ? -B(vals[0]) : -vals[0]);
    case "and": case "or": case "xor": case "not": {
      // bitwise on the two's complement patterns at R's width
      const P = (x) => BigInt.asUintN(R.w, B(x));
      let r;
      if (op === "and") r = P(vals[0]) & P(vals[1]);
      else if (op === "or") r = P(vals[0]) | P(vals[1]);
      else if (op === "xor") r = P(vals[0]) ^ P(vals[1]);
      else r = ~B(vals[0]);
      return wrapTo(isBig(R) ? r : Number(BigInt.asUintN(R.w, r)), R);
    }
    case "shl": return wrapTo(B(vals[0]) << B(vals[1]), R);
    case "shr": { // logical for unsigned, arithmetic for signed (D1)
      const r = B(vals[0]) >> B(vals[1]);
      return out(r);
    }
    case "eq": return cmp(vals) === 0 ? 1 : 0;
    case "ne": return cmp(vals) !== 0 ? 1 : 0;
    case "lt": return cmp(vals) < 0 ? 1 : 0;
    case "le": return cmp(vals) <= 0 ? 1 : 0;
    case "gt": return cmp(vals) > 0 ? 1 : 0;
    case "ge": return cmp(vals) >= 0 ? 1 : 0;
    case "land": return truthy(vals[0]) && truthy(vals[1]) ? 1 : 0;
    case "lor": return truthy(vals[0]) || truthy(vals[1]) ? 1 : 0;
    case "lnot": return truthy(vals[0]) ? 0 : 1;
    case "mux": return conv(truthy(vals[0]) ? vals[1] : vals[2], R);
    case "wrap": return wrapTo(vals[0], R);
    case "sat": return satTo(vals[0], R);
    case "slice": { const p = B(vals[0]) >> BigInt(attrs.lo); return wrapTo(isBig(R) ? BigInt.asUintN(R.w, p) : Number(BigInt.asUintN(R.w, p)), R); }
    case "zext": case "sext": return conv(vals[0], R);
    default: throw new Error(`evalOp: unknown op ${op}`);
  }
}
const truthy = (x) => (typeof x === "bigint" ? x !== 0n : x !== 0);
function cmp([a, b]) {
  if (typeof a === "bigint" || typeof b === "bigint") { const A = BigInt(a), Bv = BigInt(b); return A < Bv ? -1 : A > Bv ? 1 : 0; }
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------- durations and frequencies ----------
export function durMs(d) {
  if (typeof d === "number") return d;
  const m = String(d).trim().match(/^([\d_.]+)\s*(ps|ns|us|µs|ms|s|m|min)?$/);
  if (!m) throw new Error(`cannot read the duration "${d}"`);
  const v = +m[1].replace(/_/g, ""), unit = m[2] || "ms";
  return v * { ps: 1e-9, ns: 1e-6, us: 1e-3, "µs": 1e-3, ms: 1, s: 1000, m: 60000, min: 60000 }[unit];
}
export function hzOf(f) {
  if (typeof f === "number") return f;
  const m = String(f).trim().match(/^([\d_.]+)\s*(hz|khz|mhz|ghz)$/i);
  if (!m) return null;
  return +m[1].replace(/_/g, "") * { hz: 1, khz: 1e3, mhz: 1e6, ghz: 1e9 }[m[2].toLowerCase()];
}
// a period given as a duration ("250ms") or a frequency ("48 kHz") → seconds
export function periodS(x) {
  const hz = hzOf(x);
  if (hz) return 1 / hz;
  return durMs(x) / 1000;
}
