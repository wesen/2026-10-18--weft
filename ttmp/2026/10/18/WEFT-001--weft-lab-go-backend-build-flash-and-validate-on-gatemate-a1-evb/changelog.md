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
