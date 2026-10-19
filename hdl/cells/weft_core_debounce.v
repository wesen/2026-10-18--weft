// weft_core_debounce: hardware core of Weft's debounce cell.
//
// For each of N raw inputs: a level counts once it has held for SETTLE_CYC cycles, and held[i] follows the
// settled level. Releasing a settled press yields the event {id: i, long: 0}. With LONG_CYC > 0, a press
// that stays settled for LONG_CYC cycles yields {id: i, long: 1} at that moment instead, and its release
// yields nothing. Events leave on the ev_valid/ev_id/ev_long/ev_ready stream, lowest pending id first.
//
// Against the Lab's model (cells.js, "debounce"):
//   - the model measures settleMs/longMs in picoseconds; the core counts cycles (the adapter computes
//     SETTLE_CYC and LONG_CYC from the domain clock), so settling can differ by up to one cycle.
//   - the model queues every event; the core keeps one pending event per input. While an event waits (the
//     consumer is not ready), a second event of the same input replaces it, and pending events of different
//     inputs leave in id order rather than time order. A consumer that is always ready sees no difference.
`default_nettype none
module weft_core_debounce #(
  parameter N          = 1,
  parameter ID_W       = 1,
  parameter SETTLE_CYC = 100000,
  parameter LONG_CYC   = 0
) (
  input  wire            clk,
  input  wire            rst,
  input  wire [N-1:0]    raw,
  output wire [N-1:0]    held,
  output wire            ev_valid,
  output reg  [ID_W-1:0] ev_id,
  output wire            ev_long,
  input  wire            ev_ready
);
  localparam integer SW = SETTLE_CYC > 0 ? $clog2(SETTLE_CYC + 1) : 1;
  localparam integer LW = LONG_CYC > 0 ? $clog2(LONG_CYC + 1) : 1;

  wire [N-1:0] pend, pend_long;
  assign ev_valid = |pend;
  assign ev_long  = pend_long[ev_id];
  wire pop = ev_valid & ev_ready;

  integer j;
  always @* begin
    ev_id = 0;
    for (j = N - 1; j >= 0; j = j - 1) if (pend[j]) ev_id = j;
  end

  genvar i;
  generate
    for (i = 0; i < N; i = i + 1) begin : g_in
      reg          last = 1'b0, stable = 1'b0, sent = 1'b0, p = 1'b0, pl = 1'b0;
      reg [SW-1:0] scnt = 0;     // cycles the raw level has held
      reg [LW-1:0] lcnt = 0;     // cycles the settled press has lasted

      wire          changed = raw[i] != last;
      wire [SW-1:0] s_now   = changed ? {SW{1'b0}} : (scnt == SETTLE_CYC ? scnt : scnt + 1'b1);
      wire          flip    = (s_now >= SETTLE_CYC) && raw[i] != stable;
      wire          press   = flip & raw[i];
      wire          unpress = flip & ~raw[i];
      wire          st_now  = flip ? raw[i] : stable;
      wire [LW-1:0] l_now   = press ? {LW{1'b0}} : (lcnt == LONG_CYC ? lcnt : lcnt + 1'b1);
      wire          s_sent  = press ? 1'b0 : sent;
      wire          long_ev = (LONG_CYC > 0) && st_now && !s_sent && (l_now >= LONG_CYC);
      wire          short_ev = unpress & ~sent;

      assign held[i]      = stable;
      assign pend[i]      = p;
      assign pend_long[i] = pl;

      always @(posedge clk) begin
        if (rst) begin
          last <= 1'b0; stable <= 1'b0; sent <= 1'b0; p <= 1'b0; pl <= 1'b0;
          scnt <= 0; lcnt <= 0;
        end else begin
          last   <= raw[i];
          scnt   <= s_now;
          lcnt   <= l_now;
          stable <= st_now;
          sent   <= s_sent | long_ev;
          if (pop && ev_id == i) p <= 1'b0;
          if (short_ev || long_ev) begin
            p  <= 1'b1;
            pl <= long_ev;
          end
        end
      end
    end
  endgenerate
endmodule
`default_nettype wire
