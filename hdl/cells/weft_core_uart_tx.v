// weft_core_uart_tx: hardware core of Weft's uart-tx cell (8N1, LSB first).
//
// The stream side is a valid/ready sink: a byte is taken on a clock edge where s_valid and s_ready are both
// high. s_ready is high exactly while the line is idle, so the core holds no queue.
//
// Against the Lab's model (cells.js, "uart-tx"): the model drops ready for ten bit times measured in
// picoseconds; the core drops it for ten bits of DIV clock cycles each, DIV = CLK_HZ/BAUD rounded down, so
// the core is never slower than the nominal rate. At 10 MHz and 115200 baud DIV is 86 (0.94 % fast, well
// inside a receiver's tolerance) and ready returns 8 cycles before the model's. Rounding to nearest (87,
// 0.22 % slow) lost bytes on the board: a design that forwards bytes 1:1 (F-16) fell behind a host sending at
// 115207 baud and overran its one-byte receive register after about 1400 bytes; the model never falls behind.
`default_nettype none
module weft_core_uart_tx #(
  parameter CLK_HZ = 10000000,
  parameter BAUD   = 115200
) (
  input  wire       clk,
  input  wire       rst,
  input  wire       s_valid,
  input  wire [7:0] s_data,
  output wire       s_ready,
  output reg        tx = 1'b1
);
  localparam integer DIV = CLK_HZ / BAUD;  // clock cycles per bit, rounded down
  localparam integer CW  = DIV > 1 ? $clog2(DIV) : 1;

  reg [9:0]    frame = 10'h3ff;  // {stop, data, start}; bit 0 is on the line
  reg [3:0]    left  = 4'd0;     // bits still on their way, the current one included; 0 = idle
  reg [CW-1:0] cnt   = 0;        // cycles left in the current bit, minus one

  assign s_ready = (left == 4'd0);

  always @(posedge clk) begin
    if (rst) begin
      tx   <= 1'b1;
      left <= 4'd0;
      cnt  <= 0;
    end else if (left == 4'd0) begin
      if (s_valid) begin
        frame <= {1'b1, s_data, 1'b0};
        tx    <= 1'b0;               // the start bit begins now
        left  <= 4'd10;
        cnt   <= DIV - 1;
      end
    end else if (cnt != 0) begin
      cnt <= cnt - 1'b1;
    end else if (left == 4'd1) begin
      left <= 4'd0;                  // the stop bit is done: idle, line high
      tx   <= 1'b1;
    end else begin
      tx    <= frame[1];
      frame <= {1'b1, frame[9:1]};
      left  <= left - 1'b1;
      cnt   <= DIV - 1;
    end
  end
endmodule
`default_nettype wire
