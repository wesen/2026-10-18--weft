// weft_hil: the hardware-in-the-loop bridge on the board's UART (guide §6.10, §8.4).
//
// The board top adds it to designs that do not use the UART. It reports the design's outputs to the host,
// stamped with the board's own cycle count, and takes the values of the HIL inputs from the host: every
// virtual input, plus the physical inputs the top routes through a mux (ovr = 1 takes the HIL value).
//
// Board to host, one line each, every field lower-case hex:
//   O ss cccccccccccccc oo..   an output changed: sequence, 56-bit cycle, outputs (bit i = outs[i])
//   H ss cccccccccccccc        heartbeat every 2^20 cycles
//   A ss cccccccccccccc        a command took effect at or before this cycle
//   E ss cccccccccccccc        a command line was malformed and ignored
//   X ss llll                  llll output changes were lost (the queue was full); an O line follows
// The sequence number counts lines (8 bits, wrapping), so the host sees a line the USB bridge dropped.
//
// Host to board:
//   I vv.. oo..   set vins and ovr (hex, any number of digits; the low NIN bits are kept)
//   W mm..        report changes only of the outputs whose mask bit is 1 (all after configuration)
//   R             reset the design: vins and ovr clear, dut_rst pulses, the cycle count restarts at 0;
//                 the A line comes at cycle 0, then an O line with the outputs out of reset
//   T             the current cycle (an A line)
//
// Every event goes through one queue in cycle order, so a line stamped c proves that every output change up
// to c has been reported before it. One line takes 2 ms at 115200 baud: the bridge reports about 500 changes a
// second, and the queue absorbs bursts of 2^AW. A change that finds the queue full is counted, not reported.
`default_nettype none
module weft_hil #(
  parameter CLK_HZ = 10000000,
  parameter BAUD   = 115200,
  parameter NOUT   = 1,   // outputs reported (at least 1)
  parameter NIN    = 1,   // HIL inputs (at least 1)
  parameter AW     = 9    // the event queue holds 2^AW lines (512 x 59+NOUT bits: one CC_BRAM_40K up to NOUT 21)
) (
  input  wire            clk,
  input  wire            rst,                // configuration reset; R never resets the bridge
  input  wire [NOUT-1:0] outs,               // design outputs, synchronous to clk
  output reg  [NIN-1:0]  vins    = 0,
  output reg  [NIN-1:0]  ovr     = 0,
  output reg             dut_rst = 1'b0,     // the design's reset, for R
  output wire            tx,
  input  wire            rx
);
  localparam integer NH = (NOUT + 3) / 4;    // hex digits of the output field
  localparam integer QW = 3 + 56 + NOUT;     // queue entry: {kind, cycle (or lost count), outs}
  localparam [2:0] K_O = 3'd0, K_H = 3'd1, K_A = 3'd2, K_E = 3'd3, K_X = 3'd4;

  // ---------------------------------------------------------------- cycle count and reset sequence
  reg [55:0]    cycle = 56'd0;
  reg [3:0]     rseq  = 4'd0;                // R in progress: counts down; dut_rst for the first four
  wire          in_r  = rseq != 4'd0;
  reg           ack_pend = 1'b0, err_pend = 1'b0, hb_pend = 1'b0, force_o = 1'b0;
  reg           r_o = 1'b0;                  // R's A line is queued: force an O line after it
  reg [NOUT-1:0] last  = 0;
  reg [NOUT-1:0] watch = {NOUT{1'b1}};
  reg [15:0]    lost  = 16'd0;

  // ---------------------------------------------------------------- the event queue
  reg  [QW-1:0] mem [0:(1<<AW)-1];
  reg  [AW:0]   wp = 0, rp = 0;
  reg  [QW-1:0] head;
  wire [AW:0]   used  = wp - rp;            // sized: the difference wraps like the pointers
  wire          full  = used[AW];
  wire          empty = wp == rp;
  reg           push;
  reg  [QW-1:0] din;
  always @(posedge clk) begin
    if (push) mem[wp[AW-1:0]] <= din;
    head <= mem[rp[AW-1:0]];
  end

  wire chg = |((outs ^ last) & watch);

  // one push a cycle: X, then O, then A/E, then H
  always @* begin
    push = 1'b0;
    din  = {K_O, cycle, outs};
    if (!full && !in_r) begin
      if (lost != 0) begin
        push = 1'b1; din = {K_X, lost, 40'd0, outs};
      end else if (chg || force_o) begin
        push = 1'b1; din = {K_O, cycle, outs};
      end else if (ack_pend || err_pend) begin
        push = 1'b1; din = {err_pend ? K_E : K_A, cycle, outs};
      end else if (hb_pend) begin
        push = 1'b1; din = {K_H, cycle, outs};
      end
    end
  end

  // ---------------------------------------------------------------- commands from the host
  wire       rx_valid;
  wire [7:0] rx_data;
  weft_core_uart_rx #(.CLK_HZ(CLK_HZ), .BAUD(BAUD)) u_rx (
    .clk(clk), .rst(rst), .rx(rx), .m_valid(rx_valid), .m_data(rx_data), .m_ready(1'b1));

  localparam [2:0] P_IDLE = 3'd0, P_I1 = 3'd1, P_I2 = 3'd2, P_W = 3'd3, P_END = 3'd4, P_BAD = 3'd5;
  reg [2:0]      pst = P_IDLE;
  reg            pcmd_r = 1'b0;              // P_END: 1 = R, 0 = T
  reg            pdig = 1'b0;                // the current field has a digit
  reg [NIN-1:0]  pa = 0, pb = 0;
  reg [NOUT-1:0] pw = 0;
  wire           is_hex = (rx_data >= "0" && rx_data <= "9") || (rx_data >= "a" && rx_data <= "f") ||
                          (rx_data >= "A" && rx_data <= "F");
  wire [3:0]     nib = rx_data <= "9" ? rx_data[3:0] : rx_data[3:0] + 4'd9;
  wire           nl = rx_data == 8'h0a, sp = rx_data == " ";

  // ---------------------------------------------------------------- state
  always @(posedge clk) begin
    if (rst) begin
      cycle <= 0; rseq <= 0; dut_rst <= 1'b0; vins <= 0; ovr <= 0; watch <= {NOUT{1'b1}};
      ack_pend <= 1'b0; err_pend <= 1'b0; hb_pend <= 1'b0; force_o <= 1'b0; r_o <= 1'b0; lost <= 0;
      wp <= 0; pst <= P_IDLE; last <= outs;
    end else begin
      last <= outs;
      if (push) wp <= wp + 1'b1;

      // what was pushed is no longer pending; a change that could not be pushed is lost
      if (push && din[QW-1 -: 3] == K_X) begin lost <= chg ? 16'd1 : 16'd0; force_o <= 1'b1; end
      else if (chg && !push && !in_r) lost <= lost == 16'hffff ? lost : lost + 1'b1;
      if (push && din[QW-1 -: 3] == K_O) force_o <= 1'b0;
      if (push && (din[QW-1 -: 3] == K_A || din[QW-1 -: 3] == K_E)) begin
        ack_pend <= 1'b0; err_pend <= 1'b0;
        if (r_o) begin force_o <= 1'b1; r_o <= 1'b0; end
      end
      if (push && din[QW-1 -: 3] == K_H) hb_pend <= 1'b0;

      if (in_r) begin
        rseq    <= rseq - 1'b1;
        dut_rst <= rseq > 4'd5;
        cycle   <= 0;
        if (rseq == 4'd1) begin ack_pend <= 1'b1; err_pend <= 1'b0; r_o <= 1'b1; force_o <= 1'b0; lost <= 0; end
      end else begin
        cycle <= cycle + 1'b1;
        if (cycle[19:0] == 20'hfffff) hb_pend <= 1'b1;   // the line carries the next cycle, a multiple of 2^20
      end

      if (rx_valid && rx_data != 8'h0d) begin
        case (pst)
          P_IDLE:
            if (rx_data == "I") begin pst <= P_I1; pa <= 0; pb <= 0; pdig <= 1'b0; end
            else if (rx_data == "W") begin pst <= P_W; pw <= 0; pdig <= 1'b0; end
            else if (rx_data == "R" || rx_data == "T") begin pst <= P_END; pcmd_r <= rx_data == "R"; end
            else if (!nl && !sp) pst <= P_BAD;
          P_I1, P_I2, P_W:
            if (is_hex) begin
              pdig <= 1'b1;
              if (pst == P_I1) pa <= {pa, nib};
              else if (pst == P_I2) pb <= {pb, nib};
              else pw <= {pw, nib};
            end else if (sp) begin
              if (pdig && pst == P_I1) begin pst <= P_I2; pdig <= 1'b0; end
              else if (pdig) pst <= P_BAD;
            end else if (nl) begin
              pst <= P_IDLE;
              if (pdig && pst == P_I2) begin vins <= pa; ovr <= pb; ack_pend <= 1'b1; end
              else if (pdig && pst == P_W) begin watch <= pw; ack_pend <= 1'b1; end
              else err_pend <= 1'b1;
            end else pst <= P_BAD;
          P_END:
            if (nl) begin
              pst <= P_IDLE;
              if (pcmd_r) begin rseq <= 4'd9; dut_rst <= 1'b1; vins <= 0; ovr <= 0; end
              else ack_pend <= 1'b1;
            end else if (!sp) pst <= P_BAD;
          default:
            if (nl) begin pst <= P_IDLE; err_pend <= 1'b1; end
        endcase
      end
    end
  end

  // ---------------------------------------------------------------- lines to the host
  localparam integer FW = 4 * (2 + 14 + NH);
  reg  [1:0]    fst = 2'd0;                  // 0 idle, 1 head being read, 2 sending
  reg  [2:0]    lk = K_O;
  reg  [6:0]    pos = 0;
  reg  [FW-1:0] fld = 0;                     // hex digits still to send, most significant first
  reg  [7:0]    seq = 8'd0;
  wire [6:0]    lastp = lk == K_O ? 7'd20 + NH : lk == K_X ? 7'd9 : 7'd19;
  wire [3:0]    d = fld[FW-1 -: 4];
  wire          tx_ready;
  reg  [7:0]    ch;
  reg           hexc;
  always @* begin
    hexc = 1'b0;
    if (pos == 0) ch = lk == K_O ? "O" : lk == K_H ? "H" : lk == K_A ? "A" : lk == K_E ? "E" : "X";
    else if (pos == lastp) ch = 8'h0a;
    else if (pos == 1 || pos == 4 || (pos == 19 && lk == K_O)) ch = " ";
    else begin hexc = 1'b1; ch = d < 4'd10 ? "0" + d : "a" + d - 4'd10; end
  end
  weft_core_uart_tx #(.CLK_HZ(CLK_HZ), .BAUD(BAUD)) u_tx (
    .clk(clk), .rst(rst), .s_valid(fst == 2'd2), .s_data(ch), .s_ready(tx_ready), .tx(tx));

  wire [NOUT-1:0] h_outs = head[NOUT-1:0];
  wire [4*NH-1:0] h_hex  = {{(4*NH-NOUT){1'b0}}, h_outs};
  always @(posedge clk) begin
    if (rst) begin
      fst <= 2'd0; rp <= 0; seq <= 8'd0;
    end else case (fst)
      2'd0: if (!empty) fst <= 2'd1;
      2'd1: begin                            // head holds mem[rp] now
        lk  <= head[QW-1 -: 3];
        fld <= {seq, head[NOUT +: 56], h_hex};
        pos <= 0;
        seq <= seq + 1'b1;
        rp  <= rp + 1'b1;
        fst <= 2'd2;
      end
      default: if (tx_ready) begin
        if (pos == lastp) fst <= 2'd0;
        else begin
          pos <= pos + 1'b1;
          if (hexc) fld <= fld << 4;
        end
      end
    endcase
  end
endmodule
`default_nettype wire
