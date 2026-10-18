module top(input wire clk, output wire led);
  wire clk0, lock;
  CC_PLL #(.REF_CLK("10.0"), .OUT_CLK("25.175"), .PERF_MD("ECONOMY"), .LOW_JITTER(1), .CI_FILTER_CONST(2), .CP_FILTER_CONST(4))
    pll (.CLK_REF(clk), .CLK_FEEDBACK(1'b0), .USR_CLK_REF(1'b0), .USR_LOCKED_STDY_RST(1'b0), .USR_PLL_LOCKED_STDY(), .USR_PLL_LOCKED(lock), .CLK0(clk0), .CLK90(), .CLK180(), .CLK270(), .CLK_REF_OUT());
  wire gclk; CC_BUFG b (.I(clk0), .O(gclk));
  reg [24:0] c = 0; always @(posedge gclk) c <= c + 1;
  assign led = c[24] & lock;
endmodule
