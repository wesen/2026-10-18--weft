# Changelog

## 2026-10-18

- Initial workspace created

## 2026-10-18

P1 (92600d2): weft binary with Glazed root, serve (embedded Lab, loopback guard) and doctor (detects the A1-EVB over JTAG). P2 (67bfc56): artifact host + sampler (francois port); Lab agent verified end to end with the Pi worker; runtime.js downloads allowlist patched for .v/.js.

### Related Files

- /home/manuel/code/wesen/2026-10-18--weft/cmd/weft/cmds/serve.go — weft serve wiring and sampler selection
- /home/manuel/code/wesen/2026-10-18--weft/pkg/artifacthost/host.go — window.claude host (views, SSE, sample, tool results)

## 2026-10-18

Intern guide reviewed (17 findings fixed), committed 4ebd83f, uploaded to reMarkable: /ai/2026/10/18/WEFT-001/WEFT-001 Weft Lab on real hardware - intern guide.pdf

## 2026-10-18

P3 (afea73a): GateMate profile, nextpnr CC_PLL port, hardware bundles. P4 (b4f6dec): board wrapper/CCF/SDC, yosys/nextpnr/gmpack runner with log-derived report, embedded emitter, weft emit/build/flash; F-01 builds and loads in ~4 s, PLL fout matches the compiler, timing failures refuse to load without --force.

### Related Files

- /home/manuel/code/wesen/2026-10-18--weft/pkg/board/board.go — board wrapper (reset, PLLs, polarity, synchronizers)
- /home/manuel/code/wesen/2026-10-18--weft/pkg/toolchain/build.go — toolchain runner and report.json

## 2026-10-18

P5 (e5acc8c): job manager + /api/hw (status, builds, SSE events, files, load with force/409 rules), Lab Hardware tab (estimate vs nextpnr, live log, Load anyway), hw in the agent scope. Verified on the board from the browser and through the agent.

### Related Files

- /home/manuel/code/wesen/2026-10-18--weft/pkg/hw/jobs.go — job table, board lock, event fan-out
- /home/manuel/code/wesen/2026-10-18--weft/weft-lab/app/src/ui/hw.js — Lab client and the agent's hw object

## 2026-10-18

P6 (93f5da0): validation ladder L0-L2. vectors.js records scenario port changes on a 1 MHz co-simulation variant; pkg/validate replays them against the emitted RTL (iverilog) and a synth_gatemate netlist; weft validate, POST /api/hw/builds/{id}/validate, the Hardware tab's Validate button and hw.validate() for the agent. F-01/F-02 pass L1+L2; a broken netlist fails at cycle 250001 on led.

### Related Files

- /home/manuel/code/wesen/2026-10-18--weft/pkg/validate/run.go — co-simulation runner (RTL and netlist)
- /home/manuel/code/wesen/2026-10-18--weft/weft-lab/app/src/core/vectors.js — records scenario port changes from the simulator

## 2026-10-18

P7 (c6e0dc0): hardware cores for debounce, uart-rx and uart-tx in hdl/cells with testbenches; generated adapters; co-simulation cut at the cell boundary. F-05 and F-16 pass L1/L2; F-16 echoes on the board (50,000 bytes at 115200). The uart-tx divider rounds down after a board test showed a 0.2 %-slow transmitter overrunning a 1:1 echo.

### Related Files

- /home/manuel/code/wesen/2026-10-18--weft/hdl/cells/weft_core_uart_tx.v — uart-tx core (divider rounded down)
- /home/manuel/code/wesen/2026-10-18--weft/weft-lab/app/src/core/verilog.js — CELL_CORES and the generated adapters

## 2026-10-18

P8 (134b04c): board-level validation. weft build --hil adds the weft_hil bridge (cycle-stamped output changes, host-set inputs, over the board UART); board sessions under /api/hw/board/session hold the board; hwscenario.js runs portable scenarios in board cycles; weft validate --levels board, the Lab's On the board panel and the agent's hw session methods. F-01 'blinks at 2 Hz' and a btn:user scenario pass on the A1-EVB.

### Related Files

- /home/manuel/code/wesen/2026-10-18--weft/hdl/hil/weft_hil.v — The HIL bridge
- /home/manuel/code/wesen/2026-10-18--weft/pkg/doc/topics/04-board-session.md — Help topic board-session
- /home/manuel/code/wesen/2026-10-18--weft/pkg/hw/session.go — Board sessions
- /home/manuel/code/wesen/2026-10-18--weft/weft-lab/app/src/core/hwscenario.js — Scenarios on the board

## 2026-10-18

Closed: P1–P8 done; project report in go-go-parc (764c6f2); help topics corrected for input latency and bridge cost; repository published as github.com/wesen/2026-10-18--weft
