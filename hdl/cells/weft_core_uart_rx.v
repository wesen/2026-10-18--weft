// weft_core_uart_rx: hardware core of Weft's uart-rx cell (8N1, LSB first).
//
// rx passes a two-flop synchronizer. A falling edge starts a frame; the core checks the start bit half a bit
// later, then samples each data bit and the stop bit in its middle, DIV = CLK_HZ/BAUD (rounded) cycles
// apart. A frame whose stop bit reads low is dropped. Received bytes go to a one-byte holding register shown
// on the m_valid/m_data/m_ready stream; m_valid stays high until a cycle where m_ready is high.
//
// Against the Lab's model (cells.js, "uart-rx"):
//   - the model queues bytes without limit; the core holds one. A byte that completes while the previous one
//     has not been taken is lost.
//   - the model shows a byte one frame (ten bit times) after its start; the core shows it after the stop
//     bit's middle sample, about half a bit (plus the synchronizer's two cycles) earlier.
//   - the model has no notion of baud error; the core samples mid-bit, so it tolerates a few percent.
// The guide's sketch said 16x oversampling; at 10 MHz that divider would be 5.43 and round to 5 (8.5 % off),
// so the core counts whole bits instead (87 cycles at 115200 baud, 0.16 % off).
`default_nettype none
module weft_core_uart_rx #(
  parameter CLK_HZ = 10000000,
  parameter BAUD   = 115200
) (
  input  wire       clk,
  input  wire       rst,
  input  wire       rx,
  output reg        m_valid = 1'b0,
  output reg  [7:0] m_data = 8'd0,
  input  wire       m_ready
);
  localparam integer DIV  = (CLK_HZ + BAUD / 2) / BAUD;  // clock cycles per bit
  localparam integer HALF = DIV / 2;
  localparam integer CW   = $clog2(DIV + 1);

  reg [2:0]    sync  = 3'b111;   // two synchronizer flops, then the previous synchronized value
  wire         rxs   = sync[1];
  wire         fell  = sync[2] & ~sync[1];
  reg [3:0]    state = 4'd0;     // 0 idle, 1 start bit, 2..9 data bits, 10 stop bit
  reg [CW-1:0] cnt   = 0;
  reg [7:0]    shift = 8'd0;

  always @(posedge clk) begin
    sync <= {sync[1:0], rx};
    if (m_valid && m_ready) m_valid <= 1'b0;
    if (rst) begin
      state   <= 4'd0;
      cnt     <= 0;
      m_valid <= 1'b0;
    end else if (state == 4'd0) begin
      if (fell) begin
        state <= 4'd1;
        cnt   <= HALF - 1;
      end
    end else if (cnt != 0) begin
      cnt <= cnt - 1'b1;
    end else if (state == 4'd1) begin
      // the middle of the start bit: still low, or a glitch
      state <= rxs ? 4'd0 : 4'd2;
      cnt   <= DIV - 1;
    end else if (state == 4'd10) begin
      state <= 4'd0;
      if (rxs && (!m_valid || m_ready)) begin
        m_data  <= shift;
        m_valid <= 1'b1;
      end
    end else begin
      shift <= {rxs, shift[7:1]};
      state <= state + 1'b1;
      cnt   <= DIV - 1;
    end
  end
endmodule
`default_nettype wire
