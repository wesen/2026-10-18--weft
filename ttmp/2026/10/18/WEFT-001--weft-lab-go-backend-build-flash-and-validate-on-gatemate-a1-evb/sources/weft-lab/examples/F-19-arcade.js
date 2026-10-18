/** F-19 Arcade
 *  group  Whole designs
 *  about  Two-player pong on the studio board: buttons in, HDMI and audio out. The game is an fsm stepped once per
 *         frame; the picture is drawn in the pixel domain; knobs, a status counter and an irq reach a host panel
 *         over UART. Reset groups supervise like process trees, the boot order waits for the PLL, the renderer
 *         sits in a reconfigurable slot, and a mechanic is on call when the pixel path keeps falling over.
 *  shows  everything at once · fsm().step() · two crossings · groups as reset trees · .boot() · probes in a dossier
 *  watch  Board · DAG · Changes · Agent
 *  try    Hang the encoder four times and approve the mechanic's fix | Add a third palette as a change
 */
const scene = struct({ bx: u(10), by: u(9), p1: u(9), p2: u(9), size: u(7), s1: u(4), s2: u(4) });

const FONT = ["111101101101111", "010110010010111", "111001111100111", "111001111001111", "101101111001001",
              "111100111001111", "111100111101111", "111001001001001", "111101111101111", "111101111001111"];
const glyphs = rom("glyphs").of(u(15)).from(10, d => parseInt(FONT[d], 2));   // 3 × 5 digits, built from strings

const PALETTES = [
  { fg: { r: 240, g: 240, b: 230 }, bg: { r: 16, g: 24, b: 40 } },   // day
  { fg: { r: 255, g: 176, b: 0 }, bg: { r: 0, g: 0, b: 0 } },        // night
];

// ---------- streams: two of them cross clock domains ----------
const frames = stream("frame").of(bit).cross({ from: "pix", to: "sys" });   // one beat per frame start
const scenes = stream("scene").of(scene).buffer(1, { overflow: "latest" }).cross({ from: "sys", to: "pix" });
const sounds = stream("sfx").of(struct({ hz: u(10), ms: u(9) })).buffer(4, { overflow: "drop-oldest" });

// ---------- input ----------
const pads = std.debounce("pads")
  .bind({ raw: ["btn:up", "btn:down", "btn:a", "btn:b"] })
  .settle("5ms");                                   // .held: u(4), the debounced levels

// ---------- the game, in the system domain ----------
function movePaddles($) {                           // hardware helpers: shipped by .lib(), inlined where called
  const bottom = H - $.paddle;
  if ($.held[0] && $.p1 > 4) $.p1 -= 4;
  if ($.held[1] && $.p1 < bottom) $.p1 += 4;
  if ($.held[2] && $.p2 > 4) $.p2 -= 4;
  if ($.held[3] && $.p2 < bottom) $.p2 += 4;
}
function hits(y, top, size) {
  return y + BALL >= top && y <= top + size;
}

const game = fsm("game")
  .in("held", u(4))                                 // p1 up, p1 down, p2 up, p2 down
  .needs("frame").provides("scene", "sfx")
  .step("frame")                                    // states run once per frame, not once per clock
  .knob("speed", u(3), { reset: 2, min: 1, max: 6 })
  .knob("paddle", u(7), { reset: 64, min: 24, max: 120 })
  .status("rallies", u(16))
  .irq("point")
  .lib({ W: 640, H: 480, BALL: 8, movePaddles, hits })
  .regs({
    bx: u(10).init(316), by: u(9).init(236), vx: s(4), vy: s(4),
    p1: u(9).init(208), p2: u(9).init(208), s1: u(4), s2: u(4), wait: u(7),
  })
  .seq($ => {                                       // every clock, offer the newest scene; the crossing keeps one
    $.push("scene", { bx: $.bx, by: $.by, p1: $.p1, p2: $.p2, size: $.paddle, s1: $.s1, s2: $.s2 });
  })
  .initial("serve")
  .state("serve", $ => {
    $.bx = 316; $.by = 236; $.vy = 1;
    $.vx = $.s1 > $.s2 ? -$.speed : $.speed;        // serve toward whoever is ahead
    $.wait += 1;
    if ($.wait === 60) { $.wait = 0; return "play"; }   // a second of stillness
  })
  .state("play", $ => {
    movePaddles($);
    const x = $.bx + $.vx, y = $.by + $.vy;         // u10 + s4 is s12: off-screen stays honest
    if (y <= 0 || y >= H - BALL) { $.vy = $.vy > 0 ? -1 : 1; $.push("sfx", { hz: 220, ms: 30 }); }
    if (x <= 16 && hits(y, $.p1, $.paddle)) {
      $.vx = $.speed; $.rallies += 1; $.push("sfx", { hz: 440, ms: 40 });
    } else if (x >= W - 24 && hits(y, $.p2, $.paddle)) {
      $.vx = -$.speed; $.rallies += 1; $.push("sfx", { hz: 440, ms: 40 });
    } else if (x < 0 || x > W - BALL) {
      if (x < 0) $.s2 += 1; else $.s1 += 1;
      $.point = 1;
      $.push("sfx", { hz: 110, ms: 300 });
      return "point";
    }
    $.bx = sat(x, u(10));
    $.by = sat(y, u(9));
  })
  .state("point", $ => {
    $.wait += 1;
    if ($.s1 === 9 || $.s2 === 9) return "over";
    if ($.wait === 45) { $.wait = 0; return "serve"; }
  })
  .state("over", $ => {
    if ($.held !== 0) { $.s1 = 0; $.s2 = 0; $.wait = 0; return "serve"; }
  });

// ---------- the picture, in the pixel domain ----------
function box(px, py, x, y, w, h) {
  return px >= x && px < x + w && py >= y && py < y + h;
}
function digitAt(bx, by, x0, d) {                   // is the beam inside digit d, drawn 8× at (x0, 24)?
  const cx = (bx - x0) >> 3, cy = (by - 24) >> 3;
  return cx >= 0 && cx < 3 && cy >= 0 && cy < 5 && GLYPHS[d][14 - (cy * 3 + cx)];
}

const renderer = module("renderer")
  .domain("pix")
  .needs("beam", "scene").provides("pixels")
  .knob("palette", u(1))                            // a knob in another domain is synchronized for you
  .lib({ GLYPHS: glyphs, PALETTES, box, digitAt })
  .regs({ sc: scene })
  .on("scene", ($, s) => { $.sc = s; })
  .on("beam", ($, b) => {
    const s = $.sc;
    const lit =
      box(b.x, b.y, s.bx, s.by, 8, 8) ||
      box(b.x, b.y, 8, s.p1, 8, s.size) ||
      box(b.x, b.y, 624, s.p2, 8, s.size) ||
      (b.x.bits(9, 1) === 160 && b.y[4]) ||         // the dashed net
      digitAt(b.x, b.y, 260, s.s1) ||
      digitAt(b.x, b.y, 356, s.s2);
    const pal = PALETTES[$.palette];
    $.push("pixels", lit ? pal.fg : pal.bg);
  })
  .supervise(s => s.watchdog("20ms", $ => $.has("beam")).reset("local"))   // no beam for 20 ms: reset
  .probe(p => p.signals("sc", "palette").depth(1024).keep("before-reset"));   // the capture goes into dossiers

// ---------- sound ----------
const beeper = module("beeper")
  .needs("sfx").provides("samples")
  .lib({ K: Math.round(2 ** 24 / 48_000) })         // phase step per hertz
  .regs({ phase: u(24), step: u(20), left: u(16) })
  .on("sfx", ($, e) => { $.step = e.hz * K; $.left = e.ms * 48; })
  .every("48 kHz", $ => {
    if ($.left === 0) { $.push("samples", 0); return; }
    $.left -= 1;
    $.phase += $.step;
    $.push("samples", $.phase[23] ? 6000 : -6000);  // a square wave, the way arcades did it
  });

// ---------- runtime: a host panel and a mechanic ----------
const panel = host("panel")
  .over("bridge")
  .on("game.point", async dev => {
    const rallies = await dev.status("game.rallies").read();
    if (rallies > 20) await dev.knob("game.speed").update(v => v + 1);   // the ceiling of 6 is enforced in hardware
    dev.log(`point after ${rallies} rallies`);
  });

const mechanic = std.agents.mechanic
  .scope(s => s
    .read("*")
    .propose("modules/renderer", "modules/beeper", "knobs/*")
    .never("pins", "clocks", "boot", "streams"));

// ---------- the design ----------
return design("arcade")
  .board("studio")
  .clocks(c => c.pin("sys", "clk").pll("pix", { from: "sys", hz: "25.175 MHz" }))
  .use(frames, scenes, sounds, pads, game, renderer, beeper, panel, mechanic)
  .use(
    std.video.timing("beam").mode("640x480@60").domain("pix").provides("beam", "frame"),
    std.video.hdmi("hdmi").domain("pix").bind({ tmds: "hdmi" }),
    std.sigmaDelta("dac").needs("samples").bind({ out: "audio" }),
    std.bridge.uart("bridge").baud(1_000_000).bind({ uart: "uart" }))
  .wire("pads.held", "game.held")
  .use(
    group("video")
      .children("beam", "renderer", "hdmi")
      .supervise(s => s.strategy("all-for-one").maxResets(3, "10s").escalate("mechanic")),   // one stalls, all reset
    group("audio")
      .children("beeper", "dac")
      .supervise(s => s.strategy("one-for-one")))
  .boot(b => b
    .start("clocks")                                // every reset is held until the PLL locks
    .then("beam", "hdmi")                           // a black screen first, never a torn one
    .then("pads", "game", "renderer")
    .background("beeper", "dac", "bridge"))
  .regions(r => r.partition("gfx", { luts: 2500, brams: 2 }))
  .place({ renderer: "gfx" })                       // the mechanic's fixes ship as partial bitstreams
  .compile(c => c
    .check("room to grow", r => r.resources.luts <= 0.7 * r.part.luts)
    .check("pixel margin", r => r.timing.slack("pix") >= 2 || r.timing.worst("pix").explain())
    .emit("verilog", { to: "build/rtl" })
    .emit("host-js", { to: "host/arcade.js" })
    .emit("sim:wasm", { to: "build/arcade.wasm" }))
  .scenario("serve, rally, point", sc => sc
    .wait("1.1s").expectState("game", s => s.state === "play")
    .expectIrq("game.point", { within: "6s" })
    .expectFrame("hdmi", f => f.count(PALETTES[0].fg) > 0))
  .scenario("paddles move", sc => sc
    .wait("1.1s").press("btn:up", { for: "200ms" })
    .expectState("game", s => s.p1 < 208))
  .scenario("a stuck encoder resets the picture, not the game", sc => sc
    .wait("1s").hang("hdmi").wait("100ms")
    .expectResets("hdmi", 1).expectResets("renderer", 1).expectResets("game", 0))
  .scenario("night mode, no rebuild", sc => sc
    .apply(change("night").knob("renderer.palette", 1))
    .wait("40ms")
    .expectFrame("hdmi", f => f.count(PALETTES[1].bg) > 250_000))
  .scenario("the mechanic on call", sc => sc
    .repeat(4, s => s.hang("hdmi").wait("300ms"))
    .expectEscalation("video", "mechanic")          // the dossier: resets, the probe capture, the source, nearby DAG
    .approve()
    .expectChange(/./, "committed", { within: "3m" }));
