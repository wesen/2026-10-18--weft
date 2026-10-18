#!/usr/bin/env bash
# Spike (WEFT-001 Step 2): F-01 emitted by Weft Lab, wrapped by hand, built and loaded on the Olimex GateMateA1-EVB.
# Regenerate blinky*.v with: node ../01-spike-emit-verilog.mjs ../../../../../../weft-lab/examples/F-01-blinky.js .
set -euo pipefail
cd "$(dirname "$0")"
source ~/fpga/oss-cad-suite/environment
mkdir -p build
yosys -ql build/yosys.log -p 'read_verilog -defer blinky_sys.v blinky.v weft_board_top.v; synth_gatemate -top weft_board_top -luttree -nomx8; stat; write_json build/top.json'
nextpnr-himbaechel -l build/nextpnr.log --device CCGM1A1 --json build/top.json -o ccf=board.ccf -o out=build/top.txt --sdc board.sdc --router router2 --seed 1
if rg -q '^ERROR:' build/nextpnr.log; then echo "refusing to pack: nextpnr reported an error"; exit 1; fi
gmpack build/top.txt build/top.bit
[[ "${1:-}" == "--load" ]] && openFPGALoader -b olimex_gatemateevb build/top.bit
