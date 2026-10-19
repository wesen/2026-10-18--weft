// Testbench for weft_core_uart_tx: five bytes offered back to back, decoded from the line at the nominal
// baud rate. Checks every byte, the start and stop bits, and that s_ready stays low for ten bit times: at most
// the model's 868.06 cycles at 10 MHz (the core is never slower) and at least 1 % less (860 with DIV 86).
`timescale 1ns/1ps
`default_nettype none
module weft_core_uart_tx_tb;
  localparam integer CLK_HZ = 10000000, BAUD = 115200, PER = 100, N = 5;
  localparam real BIT = 1.0e9 / BAUD;    // ns
  localparam integer DIV = CLK_HZ / BAUD;

  reg clk = 1'b0;
  always #(PER / 2) clk = ~clk;
  reg        s_valid = 1'b0;
  reg  [7:0] s_data = 8'd0;
  wire       s_ready, tx;
  weft_core_uart_tx #(.CLK_HZ(CLK_HZ), .BAUD(BAUD)) dut (
    .clk(clk), .rst(1'b0), .s_valid(s_valid), .s_data(s_data), .s_ready(s_ready), .tx(tx));

  reg [7:0] msg [0:N-1];
  initial begin msg[0] = 8'h48; msg[1] = 8'h69; msg[2] = 8'h0a; msg[3] = 8'h00; msg[4] = 8'hff; end
  integer errors = 0, nrx = 0;

  // sender: inputs change just after a falling edge, so the next rising edge sees them
  integer i, busy;
  initial begin
    repeat (3) @(negedge clk);
    if (tx !== 1'b1) begin $display("WEFT-TB FAIL idle line is %b", tx); errors = errors + 1; end
    for (i = 0; i < N; i = i + 1) begin
      #1 s_valid = 1'b1; s_data = msg[i];
      while (!s_ready) @(negedge clk);
      @(negedge clk);                    // the rising edge in between took the byte
      busy = 0;
      while (!s_ready) begin busy = busy + 1; @(negedge clk); end
      if (busy < 860 || busy > 869) begin $display("WEFT-TB FAIL byte %0d: s_ready low for %0d cycles, want 860..869", i, busy); errors = errors + 1; end
    end
    #1 s_valid = 1'b0;
  end

  // receiver: sample the line in the middle of each bit
  integer k;
  reg [7:0] got;
  initial begin
    forever begin
      @(negedge tx);
      #(BIT / 2);
      if (tx !== 1'b0) begin $display("WEFT-TB FAIL byte %0d: start bit reads %b", nrx, tx); errors = errors + 1; end
      for (k = 0; k < 8; k = k + 1) begin #(BIT); got[k] = tx; end
      #(BIT);
      if (tx !== 1'b1) begin $display("WEFT-TB FAIL byte %0d: stop bit reads %b", nrx, tx); errors = errors + 1; end
      if (got !== msg[nrx]) begin $display("WEFT-TB FAIL byte %0d: got %h, want %h", nrx, got, msg[nrx]); errors = errors + 1; end
      nrx = nrx + 1;
    end
  end

  initial begin
    #(BIT * 10 * (N + 1) + 10000);
    if (nrx != N) begin $display("WEFT-TB FAIL received %0d of %0d bytes", nrx, N); errors = errors + 1; end
    if (tx !== 1'b1) begin $display("WEFT-TB FAIL line not idle at the end"); errors = errors + 1; end
    if (errors == 0) $display("WEFT-TB PASS weft_core_uart_tx (%0d bytes, DIV %0d)", N, DIV);
    $finish;
  end
endmodule
