// Testbench for weft_core_debounce with N = 2, SETTLE_CYC = 20, LONG_CYC = 200. Expected cycles follow the
// Lab's model: a level counts on the first edge at least SETTLE_CYC edges after its last change; a release
// yields {id, 0}, a press that lasts LONG_CYC edges after it counted yields {id, 1} (and its release yields
// nothing). An event pushed on edge e is taken on edge e + 1 when the consumer is ready.
`timescale 1ns/1ps
`default_nettype none
module weft_core_debounce_tb;
  localparam integer SETTLE = 20, LONG = 200;

  reg clk = 1'b0;
  always #50 clk = ~clk;
  reg  [1:0] raw = 2'b00;
  reg        ev_ready = 1'b1;
  wire [1:0] held;
  wire       ev_valid, ev_long;
  wire [0:0] ev_id;
  weft_core_debounce #(.N(2), .ID_W(1), .SETTLE_CYC(SETTLE), .LONG_CYC(LONG)) dut (
    .clk(clk), .rst(1'b0), .raw(raw), .held(held), .ev_valid(ev_valid), .ev_id(ev_id), .ev_long(ev_long), .ev_ready(ev_ready));

  integer cyc = 0;                       // rising edges so far
  always @(posedge clk) cyc <= cyc + 1;
  integer errors = 0, nev = 0, held0_at = -1;
  integer ev_at [0:15];
  reg [1:0] ev_v [0:15];                 // {id, long}
  // the monitor samples at the falling edge; stimulus changes 1 ns later, so the next rising edge is cyc + 1
  always @(negedge clk) begin
    if (ev_valid && ev_ready) begin ev_at[nev] = cyc + 1; ev_v[nev] = {ev_id, ev_long}; nev = nev + 1; end
    if (held[0] && held0_at < 0) held0_at = cyc;
  end

  task ticks(input integer k); begin repeat (k) @(negedge clk); #1; end endtask
  task expect_event(input integer k, input integer at, input id, input lng);
    begin
      if (nev <= k) begin $display("WEFT-TB FAIL event %0d missing (want {%0d, %0d} on edge %0d)", k, id, lng, at); errors = errors + 1; end
      else if (ev_at[k] != at || ev_v[k] !== {id, lng}) begin
        $display("WEFT-TB FAIL event %0d: {%0d, %0d} on edge %0d, want {%0d, %0d} on edge %0d", k, ev_v[k][1], ev_v[k][0], ev_at[k], id, lng, at);
        errors = errors + 1;
      end
    end
  endtask

  integer e, press0, rel0, p1, r1, r0, go;
  initial begin
    ticks(5);
    // a bouncy press of input 0: it counts SETTLE edges after the last bounce
    e = cyc + 1; raw[0] = 1'b1; ticks(5);
    raw[0] = 1'b0; ticks(4);
    press0 = cyc + 1; raw[0] = 1'b1; ticks(SETTLE + 5);
    if (held0_at != press0 + SETTLE) begin $display("WEFT-TB FAIL held[0] rose on edge %0d, want %0d", held0_at, press0 + SETTLE); errors = errors + 1; end
    if (nev != 0) begin $display("WEFT-TB FAIL a press yielded an event"); errors = errors + 1; end
    // a bouncy release: one short event
    raw[0] = 1'b0; ticks(3); raw[0] = 1'b1; ticks(3);
    rel0 = cyc + 1; raw[0] = 1'b0; ticks(SETTLE + 10);
    expect_event(0, rel0 + SETTLE + 1, 1'b0, 1'b0);
    // a glitch on input 1 shorter than SETTLE: nothing
    raw[1] = 1'b1; ticks(SETTLE - 5); raw[1] = 1'b0; ticks(SETTLE + 10);
    if (nev != 1 || held[1]) begin $display("WEFT-TB FAIL a glitch counted (events %0d, held %b)", nev, held); errors = errors + 1; end
    // a long press of input 1, then its release: one long event, no short one
    p1 = cyc + 1; raw[1] = 1'b1; ticks(SETTLE + LONG + 10);
    expect_event(1, p1 + SETTLE + LONG + 1, 1'b1, 1'b1);
    raw[1] = 1'b0; ticks(SETTLE + 10);
    if (nev != 2) begin $display("WEFT-TB FAIL the release of a long press yielded an event"); errors = errors + 1; end
    // a short press of input 1
    raw[1] = 1'b1; ticks(50);
    r1 = cyc + 1; raw[1] = 1'b0; ticks(SETTLE + 10);
    expect_event(2, r1 + SETTLE + 1, 1'b1, 1'b0);
    // the consumer stalls: events of both inputs wait, then leave lowest id first
    ev_ready = 1'b0;
    raw[1] = 1'b1; ticks(50); raw[1] = 1'b0; ticks(5);
    raw[0] = 1'b1; ticks(50); raw[0] = 1'b0; ticks(SETTLE + 10);
    if (!ev_valid || ev_id !== 1'b0) begin $display("WEFT-TB FAIL stalled: valid %b id %0d, want 1 0", ev_valid, ev_id); errors = errors + 1; end
    @(posedge clk) #1;                   // ready rises after a rising edge, so the monitor sees the first take
    go = cyc + 1; ev_ready = 1'b1; ticks(5);
    expect_event(3, go, 1'b0, 1'b0);
    expect_event(4, go + 1, 1'b1, 1'b0);
    if (nev != 5) begin $display("WEFT-TB FAIL %0d events, want 5", nev); errors = errors + 1; end
    if (held !== 2'b00) begin $display("WEFT-TB FAIL held is %b at the end", held); errors = errors + 1; end
    if (errors == 0) $display("WEFT-TB PASS weft_core_debounce (%0d events)", nev);
    $finish;
  end
endmodule
