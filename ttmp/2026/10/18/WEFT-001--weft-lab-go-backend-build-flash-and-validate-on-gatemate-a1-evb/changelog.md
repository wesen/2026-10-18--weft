# Changelog

## 2026-10-18

- Initial workspace created

## 2026-10-18

P1 (92600d2): weft binary with Glazed root, serve (embedded Lab, loopback guard) and doctor (detects the A1-EVB over JTAG). P2 (67bfc56): artifact host + sampler (francois port); Lab agent verified end to end with the Pi worker; runtime.js downloads allowlist patched for .v/.js.

### Related Files

- /home/manuel/code/wesen/2026-10-18--weft/cmd/weft/cmds/serve.go — weft serve wiring and sampler selection
- /home/manuel/code/wesen/2026-10-18--weft/pkg/artifacthost/host.go — window.claude host (views, SSE, sample, tool results)
