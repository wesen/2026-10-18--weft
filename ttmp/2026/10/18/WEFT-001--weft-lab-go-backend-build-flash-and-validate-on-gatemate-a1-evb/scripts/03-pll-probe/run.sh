#!/usr/bin/env bash
# Ask nextpnr-himbaechel which frequency CC_PLL really produces for a list of OUT_CLK requests (10 MHz ref),
# to check weft-lab/app/src/core/gatemate-pll.js against it. Usage: run.sh [SPEED|ECONOMY|LOWPOWER] [MHz...]
set -euo pipefail
cd "$(dirname "$0")"
export PATH="${OSS_CAD_SUITE:-$HOME/fpga/oss-cad-suite}/bin:$PATH"
mode="${1:-SPEED}"; shift || true
freqs=("${@:-1.0 7.3728 12.0 24.0 25.175 33.333 48.0 50.0 66.0 100.0 125.0 133.0 37.5}")
mkdir -p build
for f in ${freqs[@]}; do
  sed "s/OUT_CLK(\"[0-9.]*\")/OUT_CLK(\"$f\")/; s/PERF_MD(\"[A-Z]*\")/PERF_MD(\"$mode\")/" top.v > build/t.v
  yosys -q -p "read_verilog build/t.v; synth_gatemate -top top -luttree -nomx8; write_json build/t.json" >/dev/null
  nextpnr-himbaechel --device CCGM1A1 --json build/t.json -o ccf=top.ccf -o out=build/t.txt --router router2 --seed 1 > build/t.log 2>&1
  echo "$mode $f $(grep -o 'PLL fout=.*' build/t.log)"
done
