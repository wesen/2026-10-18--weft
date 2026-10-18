// The GateMate CC_PLL divider search, ported from nextpnr so the simulator, the hardware bundle and the
// board agree on what a PLL domain really runs at (nextpnr logs the same "PLL fout=" value).
//
// Source: nextpnr himbaechel/uarch/gatemate/pll.cc, GateMatePacker::get_pll_settings, and the call in
// pack_clocking.cc (PDIV0_MUX = 1, internal feedback). Copyright (C) 2024 The Project Peppercorn Authors;
// permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is
// hereby granted, provided that the above copyright notice and this permission notice appear in all
// copies. THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES.
//
// Only the path weft's board top uses is ported: CLK_FEEDBACK unconnected, PDIV0_MUX = 1. Frequencies are
// in MHz, as in nextpnr. The loops, limits and floating-point steps follow the C++ exactly, because the
// chosen setting (not just the best frequency) decides the result.

export const GATEMATE_PLL_MODES = {
  1: { name: "LOWPOWER", dcoMin: 500, dcoMax: 1000, pdiv1Min: 1, maxInput: 1000, maxOut: 250.0 },
  2: { name: "ECONOMY", dcoMin: 1000, dcoMax: 2000, pdiv1Min: 2, maxInput: 1250, maxOut: 312.5 },
  3: { name: "SPEED", dcoMin: 1250, dcoMax: 2500, pdiv1Min: 2, maxInput: 1666.67, maxOut: 416.75 },
};

// the frequency-match tolerance step: one unit in the last non-zero of the four decimals ("25.1750" → 0.001)
function deltaStep(num) {
  const s = num.toFixed(4);
  let zeros = 0;
  for (let i = s.length - 1; i >= 0 && s[i] === "0"; i--) zeros++;
  return [1.0, 0.1, 0.01, 0.001, 0.0001][4 - zeros] ?? 1.0;
}

// C++ round(): half away from zero
const cround = (x) => (x < 0 ? -Math.round(-x) : Math.round(x));

function dcoPenalty(m, fdco) {
  const middle = Math.trunc((m.dcoMax + m.dcoMin) / 2);
  return cround(Math.abs(fdco - middle)) * 24;
}

function getM1M2(fcore, delta, rec, maxInput) {
  for (let M1 = 1; M1 <= 64; M1++) {
    for (let M2 = 1; M2 <= 1024; M2++) {
      if ((M1 * M2) % 2 !== 0 && M1 * M2 !== 1) continue; // even, for the 90° outputs
      const local = rec.fdco / (2 * rec.PDIV1 * M1 * M2);
      if (local > maxInput / 4) continue;
      if (local - fcore < -delta) break;
      if (Math.abs(local - fcore) > delta) continue;
      if (rec.fdco / rec.PDIV1 > maxInput) continue;
      if (rec.fdco / rec.PDIV1 / M1 > maxInput / 2) continue;
      const weight = Math.abs(local - fcore) * 4200000;
      rec.M1 = M1; rec.M2 = M2; rec.fcore = local; rec.delta = Math.abs(local - fcore);
      rec.weight = weight + M1 + M2 + rec.N1 + rec.N2 + rec.K + rec.PDIV1;
      return;
    }
  }
}

// → { fcore, error (%), K, N1, N2, M1, M2, PDIV1, fdco } or null when no setting exists
export function gatematePll(fref, fcore, { mode = 3, lowJitter = true } = {}) {
  const m = GATEMATE_PLL_MODES[mode];
  if (!m || !(fref > 0) || !(fcore > 0) || fcore > m.maxOut) return null;
  const want = fcore;
  if (fcore > m.maxInput / 4) fcore = m.maxInput / 4;
  const step = deltaStep(fcore);
  let best = null;
  let matches = 0, near = 0;
  const kMax = lowJitter ? 1 : 1024;
  for (let K = 1; K <= kMax; K++) {
    for (let N1 = 1; N1 <= 64; N1++) {
      for (let N2 = 1; N2 <= 1024; N2++) {
        for (let PDIV1 = m.pdiv1Min; PDIV1 <= 2; PDIV1++) {
          const fdco = (fref / K) * PDIV1 * N1 * N2;
          if (fdco <= m.dcoMin || fdco > m.dcoMax) continue;
          if (fdco / PDIV1 > m.maxInput) continue;
          if (fdco / PDIV1 / N1 > m.maxInput / 2) continue;
          if (Math.trunc(fcore) > Math.trunc(fdco / (2 * PDIV1))) continue;
          const rec = { K, N1, N2, PDIV1, fdco, M1: 0, M2: 0, fcore: 0, delta: Infinity, weight: Infinity };
          let delta = 0;
          const limit = cround(m.maxInput / 4 - fref / K);
          while (delta < limit) {
            getM1M2(fcore, delta, rec, m.maxInput);
            if (rec.fcore !== 0 && rec.delta <= delta) { rec.weight += rec.fdco + dcoPenalty(m, fdco); break; }
            delta += step;
          }
          if (!best || rec.weight < best.weight) best = rec;
          if (rec.delta === 0) matches++;
          if (rec.delta < 0.1) near++;
        }
      }
    }
    if (matches > 10 || (matches === 0 && near > 10)) break;
  }
  if (!best || !(best.fcore > 0)) return null;
  const error = 100 - (100 * Math.min(best.fcore, want)) / Math.max(best.fcore, want);
  return { fcore: best.fcore, error, K: best.K, N1: best.N1, N2: best.N2, M1: best.M1, M2: best.M2, PDIV1: best.PDIV1, fdco: best.fdco };
}
