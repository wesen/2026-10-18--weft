// Testbench for weft_core_uart_rx: a serial line driven at its own bit time, unrelated to the core's clock.
// Checks bytes at the nominal rate and 2.5 % off, the presentation time (half a bit before the model's ten bit
// times), the one-byte holding register (a second byte that arrives before the first is taken is lost),
// and that a short glitch or a frame with a low stop bit yields nothing.
`timescale 1ns/1ps
`default_nettype none
module weft_core_uart_rx_tb;
  localparam integer CLK_HZ = 10000000, BAUD = 115200, PER = 100;
  localparam real BIT = 1.0e9 / BAUD;    // ns

  reg clk = 1'b0;
  always #(PER / 2) clk = ~clk;
  reg        rx = 1'b1, m_ready = 1'b1;
  wire       m_valid;
  wire [7:0] m_data;
  weft_core_uart_rx #(.CLK_HZ(CLK_HZ), .BAUD(BAUD)) dut (
    .clk(clk), .rst(1'b0), .rx(rx), .m_valid(m_valid), .m_data(m_data), .m_ready(m_ready));

  integer errors = 0, n = 0;
  reg [7:0] got [0:31];
  realtime start_at = 0.0, shown_at = 0.0;
  reg was_valid = 1'b0;

  // a byte is taken on a rising edge where m_valid and m_ready are high; sample at the falling edge before it
  always @(negedge clk) begin
    if (m_valid && !was_valid) shown_at = $realtime;
    was_valid = m_valid;
    if (m_valid && m_ready) begin got[n] = m_data; n = n + 1; end
  end

  task send(input [7:0] b, input real bit, input stop);
    integer k;
    begin
      start_at = $realtime;
      rx = 1'b0; #(bit);
      for (k = 0; k < 8; k = k + 1) begin rx = b[k]; #(bit); end
      rx = stop; #(bit);
      rx = 1'b1; #(bit);
    end
  endtask

  task expect_bytes(input integer want_n, input [7:0] b0, input [7:0] b1, input [7:0] b2, input [8*24-1:0] what);
    begin
      #(PER * 4);
      if (n != want_n) begin $display("WEFT-TB FAIL %0s: %0d bytes, want %0d", what, n, want_n); errors = errors + 1; end
      else begin
        if (want_n > 0 && got[0] !== b0) begin $display("WEFT-TB FAIL %0s: byte 0 is %h, want %h", what, got[0], b0); errors = errors + 1; end
        if (want_n > 1 && got[1] !== b1) begin $display("WEFT-TB FAIL %0s: byte 1 is %h, want %h", what, got[1], b1); errors = errors + 1; end
        if (want_n > 2 && got[2] !== b2) begin $display("WEFT-TB FAIL %0s: byte 2 is %h, want %h", what, got[2], b2); errors = errors + 1; end
      end
      n = 0;
    end
  endtask

  real lat;
  initial begin
    #(PER * 7.3);
    // nominal rate, and the presentation time: after the stop bit's middle sample
    send(8'h48, BIT, 1'b1);
    lat = (shown_at - start_at) / BIT;
    if (lat < 9.5 || lat > 9.5 + 6.0 * PER / BIT) begin $display("WEFT-TB FAIL byte shown %0.3f bit times after its start, want 9.5..9.57", lat); errors = errors + 1; end
    send(8'h69, BIT, 1'b1);
    send(8'h0a, BIT, 1'b1);
    expect_bytes(3, 8'h48, 8'h69, 8'h0a, "nominal baud");
    // 2.5 % slow and fast
    send(8'ha5, BIT * 1.025, 1'b1); send(8'h5a, BIT * 1.025, 1'b1);
    expect_bytes(2, 8'ha5, 8'h5a, 0, "2.5 % slow");
    send(8'hc3, BIT * 0.975, 1'b1); send(8'h3c, BIT * 0.975, 1'b1);
    expect_bytes(2, 8'hc3, 8'h3c, 0, "2.5 % fast");
    // holding register: the second byte arrives while the first waits, and is lost
    m_ready = 1'b0;
    send(8'h11, BIT, 1'b1); send(8'h22, BIT, 1'b1);
    if (!m_valid || m_data !== 8'h11) begin $display("WEFT-TB FAIL holding: valid %b data %h, want 1 11", m_valid, m_data); errors = errors + 1; end
    @(posedge clk) #1 m_ready = 1'b1;    // the monitor samples at the falling edge before the taking edge
    expect_bytes(1, 8'h11, 0, 0, "holding register");
    send(8'h33, BIT, 1'b1);
    expect_bytes(1, 8'h33, 0, 0, "after the overrun");
    // a glitch shorter than half a bit, and a frame whose stop bit is low
    rx = 1'b0; #(BIT / 4); rx = 1'b1; #(BIT * 12);
    expect_bytes(0, 0, 0, 0, "glitch");
    send(8'h77, BIT, 1'b0); #(BIT * 2);
    expect_bytes(0, 0, 0, 0, "low stop bit");
    send(8'h0d, BIT, 1'b1);
    expect_bytes(1, 8'h0d, 0, 0, "after a framing error");
    if (errors == 0) $display("WEFT-TB PASS weft_core_uart_rx (latency %0.3f bit times)", lat);
    $finish;
  end
endmodule
