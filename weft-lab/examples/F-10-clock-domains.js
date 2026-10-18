/** F-10 Clock domains
 *  group  Time
 *  about  A sprite bounces in the 100 MHz system domain and is drawn in a 25.175 MHz pixel domain from a PLL. The
 *         position crosses between them on a stream marked .cross(). Delete that line and checks.cdc refuses to
 *         build, naming both domains and the stream.
 *  shows  .clocks() · .domain() · stream().cross() · std.video · unsigned minus unsigned is signed
 *  watch  Board (HDMI) · DAG (one graph per domain)
 *  try    Remove .cross() and read the diagnostic | Move the sprite once per frame instead of on a timer
 */
const position = stream("sprite.pos")
  .of(struct({ x: u(10), y: u(10) }))
  .buffer(1, { overflow: "latest" })                // only the newest position matters…
  .cross({ from: "sys", to: "pix" });               // …so the crossing is a handshake synchronizer, not a FIFO

const physics = module("physics")
  .provides("sprite.pos")
  .lib({ MAX_X: 640 - 16, MAX_Y: 480 - 16 })
  .regs({ x: u(10).init(40), y: u(10).init(30), left: bit, up: bit })
  .every("8ms", $ => {
    const left = $.x === 0 ? 0 : $.x === MAX_X ? 1 : $.left;
    const up = $.y === 0 ? 0 : $.y === MAX_Y ? 1 : $.up;
    $.left = left;
    $.up = up;
    if (left) $.x -= 1; else $.x += 1;
    if (up) $.y -= 1; else $.y += 1;
    $.push("sprite.pos", { x: $.x, y: $.y });
  });

const raster = module("raster")
  .domain("pix")
  .needs("sprite.pos", "beam")                      // beam: { x, y, visible } from std.video.timing
  .provides("pixels")
  .regs({ sx: u(10), sy: u(10) })
  .on("sprite.pos", ($, p) => { $.sx = p.x; $.sy = p.y; })
  .on("beam", ($, b) => {
    const dx = b.x - $.sx, dy = b.y - $.sy;         // u10 − u10 is s11: left of the sprite stays negative
    const inside = dx >= 0 && dx < 16 && dy >= 0 && dy < 16;
    $.push("pixels", inside ? { r: 255, g: 200, b: 0 } : { r: 0, g: 0, b: b.y.bits(8, 1) });
  });

return design("bounce")
  .board("dev")
  .clocks(c => c
    .pin("sys", "clk")                              // 100 MHz from the board
    .pll("pix", { from: "sys", hz: "25.175 MHz", tolerance: "0.5%" }))   // the compiler solves the dividers
  .use(position, physics, raster)
  .use(
    std.video.timing("beam").mode("640x480@60").domain("pix"),
    std.video.hdmi("hdmi").domain("pix").bind({ tmds: "hdmi" }))    // asks .clocks() for pix × 5 by itself
  .scenario("draws a 16 × 16 sprite", sc => sc
    .wait("40ms")
    .expectFrame("hdmi", f => f.count({ r: 255, g: 200, b: 0 }) === 256))
  .scenario("bounces off the right edge", sc => sc
    .poke("physics.x", 620).wait("50ms")
    .expectState("physics", s => s.left === 1));
