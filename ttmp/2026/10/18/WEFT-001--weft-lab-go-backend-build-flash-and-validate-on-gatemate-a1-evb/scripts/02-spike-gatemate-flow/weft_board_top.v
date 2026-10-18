// Spike wrapper: GateMate A1-EVB board top around the Weft design top `blinky`.
module weft_board_top (
  input  wire clk_10m,
  output wire user_led_n
);
  wire usr_rstn;
  CC_USR_RSTN u_usr_rstn (.USR_RSTN(usr_rstn));
  reg [1:0] rst_sync = 2'b11;
  always @(posedge clk_10m or negedge usr_rstn)
    if (!usr_rstn) rst_sync <= 2'b11; else rst_sync <= {rst_sync[0], 1'b0};
  wire led;
  blinky u_design (.clk_sys(clk_10m), .rst(rst_sync[1]), .led(led));
  assign user_led_n = ~led;
endmodule
