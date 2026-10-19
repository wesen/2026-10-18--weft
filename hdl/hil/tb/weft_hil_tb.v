// Testbench for weft_hil at 1 Mbaud (ten cycles a bit), with a host UART on the other side. Checks the line
// formats, the sequence numbers, R (ack at cycle 0, then the outputs; vins and ovr clear; dut_rst pulses),
// O lines stamped with the cycle the change was seen, I and its ack, the watch mask, malformed commands (E),
// an overflow (every change is either reported or counted, then an O line resynchronizes), and the heartbeat.
`timescale 1ns/1ps
`default_nettype none
module weft_hil_tb;
  localparam integer CLK_HZ = 10000000, BAUD = 1000000, PER = 100, NOUT = 3, NIN = 2;
  localparam integer BIT = 1000000000 / BAUD;  // ns

  reg clk = 1'b0;
  always #(PER / 2) clk = ~clk;
  reg            rst = 1'b1, rx = 1'b1;
  reg [NOUT-1:0] outs = 0;
  wire [NIN-1:0] vins, ovr;
  wire           dut_rst, tx;
  weft_hil #(.CLK_HZ(CLK_HZ), .BAUD(BAUD), .NOUT(NOUT), .NIN(NIN), .AW(3)) dut (
    .clk(clk), .rst(rst), .outs(outs), .vins(vins), .ovr(ovr), .dut_rst(dut_rst), .tx(tx), .rx(rx));

  integer errors = 0;
  task fail(input [8*72-1:0] what); begin $display("WEFT-TB FAIL %0s", what); errors = errors + 1; end endtask

  // ---------------------------------------------------------------- host: send a command line
  task send_byte(input [7:0] b); integer k; begin
    rx = 1'b0; #(BIT);
    for (k = 0; k < 8; k = k + 1) begin rx = b[k]; #(BIT); end
    rx = 1'b1; #(BIT);
  end endtask
  task send(input [8*12-1:0] s, input integer n); integer k; begin
    for (k = n - 1; k >= 0; k = k - 1) send_byte(s[8*k +: 8]);
    send_byte(8'h0a);
  end endtask

  // ---------------------------------------------------------------- host: receive and decode lines
  reg  [7:0]  lb [0:63];
  integer     ln = 0, nl = 0;
  reg  [7:0]  r_kind [0:1023];
  reg  [7:0]  r_seq  [0:1023];
  reg  [55:0] r_cyc  [0:1023];
  reg  [15:0] r_val  [0:1023];   // outputs (O) or lost count (X)
  function [3:0] hexv(input [7:0] c);
    hexv = c <= "9" ? c - "0" : c - "a" + 10;
  endfunction
  function ishex(input [7:0] c);
    ishex = (c >= "0" && c <= "9") || (c >= "a" && c <= "f");
  endfunction
  task decode; integer k, want; reg ok; begin
    ok = ln >= 5 && lb[1] == " " && lb[4] == " " && ishex(lb[2]) && ishex(lb[3]);
    r_kind[nl] = lb[0];
    r_seq[nl]  = {hexv(lb[2]), hexv(lb[3])};
    r_cyc[nl]  = 0; r_val[nl] = 0;
    case (lb[0])
      "O": want = 21;  // NOUT = 3: one hex digit
      "X": want = 9;
      "H", "A", "E": want = 19;
      default: want = -1;
    endcase
    if (ln != want) ok = 1'b0;
    if (ok && lb[0] == "X") for (k = 5; k < 9; k = k + 1) begin ok = ok & ishex(lb[k]); r_val[nl] = {r_val[nl], hexv(lb[k])}; end
    else if (ok) begin
      for (k = 5; k < 19; k = k + 1) begin ok = ok & ishex(lb[k]); r_cyc[nl] = {r_cyc[nl], hexv(lb[k])}; end
      if (lb[0] == "O") begin ok = ok & lb[19] == " " & ishex(lb[20]); r_val[nl] = hexv(lb[20]); end
    end
    if (!ok) begin $display("WEFT-TB FAIL line %0d: malformed (kind %c, %0d chars)", nl, lb[0], ln); errors = errors + 1; end
    if (nl > 0 && r_seq[nl] !== r_seq[nl-1] + 8'd1) begin
      $display("WEFT-TB FAIL line %0d: sequence %h after %h", nl, r_seq[nl], r_seq[nl-1]); errors = errors + 1;
    end
    nl = nl + 1;
  end endtask
  reg [7:0] got;
  integer kb;
  initial forever begin
    @(negedge tx);
    #(BIT / 2);
    for (kb = 0; kb < 8; kb = kb + 1) begin #(BIT); got[kb] = tx; end
    #(BIT);
    if (tx !== 1'b1) begin $display("WEFT-TB FAIL stop bit"); errors = errors + 1; end
    if (got == 8'h0a) begin decode; ln = 0; end
    else begin lb[ln] = got; ln = ln + 1; end
  end

  task wait_lines(input integer n); integer t; begin
    t = 0;
    while (nl < n && t < 200000) begin @(posedge clk); t = t + 1; end
    if (nl < n) begin $display("WEFT-TB FAIL waited for line %0d, have %0d", n, nl); errors = errors + 1; end
  end endtask

  // ---------------------------------------------------------------- monitors
  integer rst_cycles = 0, vins_at = -1;
  reg [55:0] vins_cyc = 0;
  reg [NIN-1:0] vins_prev = 0;
  always @(posedge clk) begin
    if (dut_rst) rst_cycles = rst_cycles + 1;
    if (vins !== vins_prev) begin vins_prev = vins; vins_cyc = dut.cycle; end
  end

  // ---------------------------------------------------------------- the sequence
  integer n, i, sent, lost, first;
  reg [55:0] c0, c1;
  initial begin
    repeat (5) @(posedge clk);
    #1 rst = 1'b0;
    repeat (50) @(posedge clk);

    // T: an ack with the current cycle
    n = nl; c0 = dut.cycle;
    send("T", 1);
    wait_lines(n + 1);
    if (r_kind[n] != "A" || r_cyc[n] < c0) fail("T: no ack, or an ack from the past");

    // R: dut_rst pulses, the ack comes at cycle 0, then an O line with the outputs out of reset
    outs = 3'b011;
    repeat (2000) @(posedge clk);       // the change is reported first
    n = nl; rst_cycles = 0;
    send("I 3 3", 5);
    wait_lines(n + 2);                  // O for the change, A for I
    n = nl;
    send("R", 1);
    wait_lines(n + 2);
    if (r_kind[n] != "A" || r_cyc[n] != 0) begin $display("WEFT-TB FAIL R: line %c at cycle %0d, want A at 0", r_kind[n], r_cyc[n]); errors = errors + 1; end
    if (r_kind[n+1] != "O" || r_val[n+1] != 3'b011 || r_cyc[n+1] > 2) fail("R: no O line with the outputs after the ack");
    if (rst_cycles != 5) begin $display("WEFT-TB FAIL R: dut_rst high %0d cycles, want 5", rst_cycles); errors = errors + 1; end
    if (vins !== 0 || ovr !== 0) fail("R: vins and ovr did not clear");

    // an output change: the O line carries the cycle the change was seen
    repeat (500) @(posedge clk);
    #1 outs = 3'b101; c0 = dut.cycle;
    n = nl;
    wait_lines(n + 1);
    if (r_kind[n] != "O" || r_cyc[n] != c0 || r_val[n] != 3'b101) begin
      $display("WEFT-TB FAIL change: %c at %0d value %h, want O at %0d value 5", r_kind[n], r_cyc[n], r_val[n], c0); errors = errors + 1;
    end

    // I: vins and ovr take the values; the ack is stamped at or just after the cycle they changed
    n = nl;
    send("I 2 1", 5);
    wait_lines(n + 1);
    if (vins !== 2'b10 || ovr !== 2'b01) fail("I: vins/ovr not set");
    if (r_kind[n] != "A" || r_cyc[n] < vins_cyc || r_cyc[n] > vins_cyc + 2) begin
      $display("WEFT-TB FAIL I: ack at %0d, vins changed at %0d", r_cyc[n], vins_cyc); errors = errors + 1;
    end
    n = nl;
    send("I 1fff 0", 8);                // extra digits: the low NIN bits are kept
    wait_lines(n + 1);
    if (vins !== 2'b11 || ovr !== 2'b00) fail("I: long fields not truncated to NIN bits");

    // W: a masked output's change is not reported
    n = nl;
    send("W 6", 3);
    wait_lines(n + 1);
    #1 outs = 3'b100;                   // bit 0 only: masked
    repeat (3000) @(posedge clk);
    if (nl != n + 1) fail("W: a masked change was reported");
    #1 outs = 3'b110; c0 = dut.cycle;   // bit 1
    wait_lines(n + 2);
    if (r_kind[n+1] != "O" || r_cyc[n+1] != c0 || r_val[n+1] != 3'b110) fail("W: the unmasked change is missing");
    n = nl;
    send("W 7", 3);
    wait_lines(n + 1);

    // malformed commands
    n = nl;
    send("Q", 1);
    wait_lines(n + 1);
    if (r_kind[n] != "E") fail("an unknown command got no E line");
    n = nl;
    send("I 3", 3);
    wait_lines(n + 1);
    if (r_kind[n] != "E") fail("I with one field got no E line");
    if (vins !== 2'b11) fail("a malformed I changed vins");

    // overflow: 30 changes in 30 cycles, a queue of 8: reported + lost = 30, then an O line with the outputs
    repeat (3000) @(posedge clk);
    n = nl;
    @(posedge clk);
    c0 = dut.cycle + 1;
    for (i = 0; i < 30; i = i + 1) begin #1 outs = outs ^ 3'b001; @(posedge clk); end
    c1 = dut.cycle;
    wait_lines(n + 11);                 // 9 O lines (8 queued, 1 sending), X, O
    sent = 0; lost = -1; first = -1;
    for (i = n; i < nl; i = i + 1) begin
      if (r_kind[i] == "O" && r_cyc[i] >= c0 && r_cyc[i] <= c1) sent = sent + 1;
      if (r_kind[i] == "X" && lost < 0) begin lost = r_val[i]; first = i; end
    end
    if (lost < 0) fail("overflow: no X line");
    else begin
      if (sent + lost != 30) begin $display("WEFT-TB FAIL overflow: %0d reported + %0d lost, want 30", sent, lost); errors = errors + 1; end
      wait_lines(first + 2);
      if (r_kind[first+1] != "O" || r_val[first+1] != outs || r_cyc[first+1] <= c1) fail("overflow: no O line after the X line");
    end

    // heartbeat: an H line at cycle 2^20
    while (dut.cycle < 56'h100000 + 3000) @(posedge clk);
    repeat (3000) @(posedge clk);
    lost = 0;
    for (i = 0; i < nl; i = i + 1) if (r_kind[i] == "H" && r_cyc[i] == 56'h100000) lost = 1;
    if (!lost) fail("no heartbeat at cycle 0x100000");

    if (errors == 0) $display("WEFT-TB PASS weft_hil (%0d lines; overflow: %0d reported, %0d lost)", nl, sent, 30 - sent);
    $finish;
  end
endmodule
