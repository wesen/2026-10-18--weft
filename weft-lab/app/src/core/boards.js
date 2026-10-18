// Board profiles and part data (owner A). The boards are fictional profiles built on real parts: what a
// design may bind to (resources), the main clock, and the part's capacity for the report and the checks.
// `board("dev").part("xc7a100t-1csg324")` copies a profile with another part (F-16).

// Part capacity. Numbers are the parts' datasheet capacities, rounded where a family counts differently
// (7-series LUT6 count = slices × 4; iCE40 counts LUT4s; BRAM kb is one block's size).
export const PART_DATA = {
  ice40up5k: { name: "ice40up5k", family: "ice40", luts: 5280, ffs: 5280, brams: 30, bramKb: 4, sprams: 4, spramKb: 256, dsps: 8, ios: 39, lut: "LUT4", delayClass: "ice40" },
  ice40hx8k: { name: "ice40hx8k", family: "ice40", luts: 7680, ffs: 7680, brams: 32, bramKb: 4, sprams: 0, spramKb: 0, dsps: 0, ios: 206, lut: "LUT4", delayClass: "ice40" },
  xc7a35t: { name: "xc7a35t", family: "xc7", luts: 20800, ffs: 41600, brams: 50, bramKb: 36, sprams: 0, spramKb: 0, dsps: 90, ios: 210, lut: "LUT6", delayClass: "xc7" },
  xc7a50t: { name: "xc7a50t", family: "xc7", luts: 32600, ffs: 65200, brams: 75, bramKb: 36, sprams: 0, spramKb: 0, dsps: 120, ios: 250, lut: "LUT6", delayClass: "xc7" },
  xc7a100t: { name: "xc7a100t", family: "xc7", luts: 63400, ffs: 126800, brams: 135, bramKb: 36, sprams: 0, spramKb: 0, dsps: 240, ios: 300, lut: "LUT6", delayClass: "xc7" },
  "lfe5u-25f": { name: "lfe5u-25f", family: "ecp5", luts: 24288, ffs: 24288, brams: 56, bramKb: 18, sprams: 0, spramKb: 0, dsps: 28, ios: 197, lut: "LUT4", delayClass: "ecp5" },
  "lfe5u-85f": { name: "lfe5u-85f", family: "ecp5", luts: 83640, ffs: 83640, brams: 208, bramKb: 18, sprams: 0, spramKb: 0, dsps: 156, ios: 365, lut: "LUT4", delayClass: "ecp5" },
  // CCGM1A1 (GateMate A1): luts/ffs count CPE halves (CPE_LT/CPE_FF), as nextpnr-himbaechel reports them;
  // BRAMs are 20 Kbit halves of the 32 40-Kbit blocks
  ccgm1a1: { name: "ccgm1a1", family: "gatemate", luts: 40960, ffs: 40960, brams: 64, bramKb: 20, sprams: 0, spramKb: 0, dsps: 0, ios: 162, lut: "LUT4", delayClass: "gatemate" },
  generic: { name: "generic", family: "generic", luts: 1e6, ffs: 1e6, brams: 1000, bramKb: 36, sprams: 0, spramKb: 0, dsps: 1000, ios: 1000, lut: "LUT6", delayClass: "xc7" },
};

// a full part string ("xc7a35t-1csg324", "ice40up5k-sg48") → its capacity record
export function partData(part) {
  const p = String(part || "").toLowerCase();
  if (!p) return { ...PART_DATA.generic };
  for (const key of Object.keys(PART_DATA)) if (key !== "generic" && p.startsWith(key)) return { ...PART_DATA[key], part: p };
  if (p.startsWith("ice40")) return { ...PART_DATA.ice40up5k, name: p, part: p };
  if (p.startsWith("xc7")) return { ...PART_DATA.xc7a35t, name: p, part: p };
  if (p.startsWith("lfe5")) return { ...PART_DATA["lfe5u-85f"], name: p, part: p };
  if (p.startsWith("ccgm1a")) return { ...PART_DATA.ccgm1a1, name: p, part: p };
  return { ...PART_DATA.generic, name: p, part: p };
}
export const familyOfPart = (part) => partData(part).family;

// resources: id → { kind, dir, pin }. Ranged ids ("led:0..7") and groups ("uart") are expanded by `expand`.
const range = (prefix, ids, kind, dir, pins) => Object.fromEntries(ids.map((id, i) => [`${prefix}:${id}`, { kind, dir, pin: pins?.[i] ?? null }]));
const n = (k) => Array.from({ length: k }, (_, i) => i);

export const BOARDS = {
  pico: {
    profile: "pico",
    title: "pico — iCE40 UP5K, 3 LEDs, one button, USB serial",
    part: "ice40up5k-sg48",
    mainHz: 12e6,
    clockPin: "clk",
    resources: {
      clk: { kind: "clock", dir: "in", pin: "35", hz: 12e6 },
      ...range("led", n(3), "led", "out", ["39", "40", "41"]),
      "btn:user": { kind: "button", dir: "in", pin: "10" },
      "uart.tx": { kind: "uart", dir: "out", pin: "14" },
      "uart.rx": { kind: "uart", dir: "in", pin: "15" },
    },
    groups: { uart: ["uart.tx", "uart.rx"], btn: ["btn:user"] },
  },
  dev: {
    profile: "dev",
    title: "dev — Artix-7 35T, 8 LEDs, 4 buttons, 8 switches, HDMI, audio, USB serial",
    part: "xc7a35t-1csg324",
    mainHz: 100e6,
    clockPin: "clk",
    resources: {
      clk: { kind: "clock", dir: "in", pin: "E3", hz: 100e6 },
      ...range("led", n(8), "led", "out", ["H17", "K15", "J13", "N14", "R18", "V17", "U17", "U16"]),
      ...range("btn", n(4), "button", "in", ["N17", "M18", "P17", "M17"]),
      ...range("sw", n(8), "switch", "in", ["J15", "L16", "M13", "R15", "R17", "T18", "U18", "R13"]),
      "uart.tx": { kind: "uart", dir: "out", pin: "D4" },
      "uart.rx": { kind: "uart", dir: "in", pin: "C4" },
      hdmi: { kind: "hdmi", dir: "out", pin: "tmds[0..3]" },
      audio: { kind: "audio", dir: "out", pin: "A11" },
    },
    groups: { uart: ["uart.tx", "uart.rx"] },
  },
  studio: {
    profile: "studio",
    title: "studio — Artix-7 35T, a game pad, 8 LEDs, HDMI, audio, USB serial",
    part: "xc7a35t-1csg324",
    mainHz: 100e6,
    clockPin: "clk",
    resources: {
      clk: { kind: "clock", dir: "in", pin: "E3", hz: 100e6 },
      ...range("led", n(8), "led", "out", ["H17", "K15", "J13", "N14", "R18", "V17", "U17", "U16"]),
      ...range("btn", ["up", "down", "a", "b"], "button", "in", ["N17", "M18", "P17", "M17"]),
      ...range("sw", n(4), "switch", "in", ["J15", "L16", "M13", "R15"]),
      "uart.tx": { kind: "uart", dir: "out", pin: "D4" },
      "uart.rx": { kind: "uart", dir: "in", pin: "C4" },
      hdmi: { kind: "hdmi", dir: "out", pin: "tmds[0..3]" },
      audio: { kind: "audio", dir: "out", pin: "A11" },
    },
    groups: { uart: ["uart.tx", "uart.rx"] },
  },
};

// A real board (unlike the profiles above): Olimex GateMateA1-EVB. The Go board package (pkg/board) owns
// its pins and polarity; the pin names here are for display. Resources without a pin are virtual: they
// compile like real ones so dev/pico examples still build, and on hardware they are tied inactive or
// driven by the HIL bridge. btn:0 and btn:user are the same button (designs may bind one, not both).
BOARDS["gatemate-a1-evb"] = {
  profile: "gatemate-a1-evb",
  title: "gatemate-a1-evb — Olimex GateMateA1-EVB (CCGM1A1), 1 LED + 7 on PMOD, 1 button, USB serial",
  part: "ccgm1a1",
  mainHz: 10e6,
  clockPin: "clk",
  resources: {
    clk: { kind: "clock", dir: "in", pin: "IO_SB_A8", hz: 10e6 },
    ...range("led", n(8), "led", "out", ["IO_SB_B6", "IO_EA_A4", "IO_EA_A5", "IO_EA_A6", "IO_EA_A7", "IO_EA_B4", "IO_EA_B5", "IO_EA_B6"]),
    "btn:user": { kind: "button", dir: "in", pin: "IO_SB_B7" },
    ...range("btn", n(4), "button", "in", ["IO_SB_B7", null, null, null]),
    ...range("sw", n(8), "switch", "in", []),
    "uart.tx": { kind: "uart", dir: "out", pin: "IO_SA_B6" },
    "uart.rx": { kind: "uart", dir: "in", pin: "IO_SA_A6" },
  },
  groups: { uart: ["uart.tx", "uart.rx"], btn: ["btn:user"] },
};

// The board used when a design names none: a simulation-only profile (F-11) or a bare part (F-13, F-14).
export function bareBoard(part = null, hz = 100e6) {
  return { profile: null, title: part ? `${part} (no board: the design's ports are the top)` : "simulation only", part: part || "generic", mainHz: hz, clockPin: null, resources: {}, groups: {} };
}

// resolve a profile name or a board() builder state into the compiled board record (ARCH §3)
export function resolveBoard(spec) {
  let base, part = null;
  if (!spec) base = bareBoard();
  else if (typeof spec === "string") base = BOARDS[spec];
  else if (spec.profile !== undefined || spec.part !== undefined) {
    base = spec.profile ? BOARDS[spec.profile] : bareBoard(spec.part);
    part = spec.part || null;
  }
  if (!base) return null;
  const p = part || base.part;
  const pd = partData(p);
  return {
    profile: base.profile, title: base.title, part: p, family: pd.family, mainHz: base.mainHz,
    clockPin: base.clockPin, resources: { ...base.resources }, groups: { ...base.groups }, partData: pd,
  };
}

// "led:0..7" → ["led:0", …]; "uart" → ["uart.tx", "uart.rx"]; arrays flatten
export function expandResources(spec, board) {
  if (Array.isArray(spec)) return spec.flatMap((s) => expandResources(s, board));
  const s = String(spec).trim();
  const m = s.match(/^(.*?):(\d+)\.\.(\d+)$/);
  if (m) {
    const a = +m[2], b = +m[3], out = [];
    if (a <= b) for (let i = a; i <= b; i++) out.push(`${m[1]}:${i}`);
    else for (let i = a; i >= b; i--) out.push(`${m[1]}:${i}`);
    return out;
  }
  if (board?.groups?.[s] && !board.resources[s]) return board.groups[s].slice();
  return [s];
}
