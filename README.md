# Weft Lab on real hardware

**Weft** is a JavaScript API for describing FPGA hardware, specified by two books. **Weft Lab** (`weft-lab/`)
is its first implementation: a browser IDE that compiles the books' nineteen example designs, simulates them
cycle by cycle and runs their test scenarios.

This repository adds `weft`, a Go program that serves the Lab locally. It builds bitstreams for the Olimex
GateMateA1-EVB with the open-source GateMate toolchain and loads them over USB. It then checks that the
hardware matches the simulator at four levels:

- **build**: synthesis, routing and timing;
- **rtl**: the emitted Verilog against the simulator;
- **net**: the synthesized netlist against the simulator;
- **board**: the scenarios run on the board, timed in board cycles through a small UART bridge.

## Quick start

```bash
# needs the OSS CAD Suite at ~/fpga/oss-cad-suite, Node, and the board on USB
sudo modprobe cdc_acm   # once, for /dev/ttyACM0
(cd weft-lab/app && npm ci)
make web && make build
./bin/weft doctor
./bin/weft serve        # the Lab, with a Hardware tab, at http://127.0.0.1:8088/
./bin/weft build weft-lab/examples/F-01-blinky.js --load
./bin/weft validate weft-lab/examples/F-01-blinky.js --levels build,rtl,net,board
```

The user documentation is built into the binary: `weft help getting-started`, `weft help build-and-flash`,
`weft help validation-ladder` and `weft help board-session`.

## Layout

| Path | Content |
| --- | --- |
| `cmd/weft/` | the CLI: `serve`, `doctor`, `emit`, `build`, `flash`, `validate` |
| `pkg/` | board top and constraints, toolchain runner, hardware API and board sessions, co-simulation, HIL protocol, artifact host |
| `hdl/` | Verilog cores (UART rx/tx, debounce) and the HIL bridge, with testbenches |
| `weft-lab/` | the Lab: compiler, simulator, UI and examples (`weft-lab/ARCH.md`) |
| `ttmp/2026/10/18/WEFT-001--…/` | the design guide, the implementation diary and the imported sources |

## References

**Weft.** The two books and the Lab source as imported, in [`sources/local/`](<ttmp/2026/10/18/WEFT-001--weft-lab-go-backend-build-flash-and-validate-on-gatemate-a1-evb/sources/local/>):

- [*Weft, From First Principles*](<ttmp/2026/10/18/WEFT-001--weft-lab-go-backend-build-flash-and-validate-on-gatemate-a1-evb/sources/local/Book 1: Weft, From First Principles (Claude Docs export).md>): the language design.
- [*Building Weft: Implementation and Reference*](<ttmp/2026/10/18/WEFT-001--weft-lab-go-backend-build-flash-and-validate-on-gatemate-a1-evb/sources/local/Book 2: Building Weft: Implementation and Reference (Claude Docs export).md>): the compiler specification and milestones.
- [Design guide](ttmp/2026/10/18/WEFT-001--weft-lab-go-backend-build-flash-and-validate-on-gatemate-a1-evb/design-doc/01-weft-lab-on-real-hardware-intern-guide-to-the-go-backend-gatemate-toolchain-and-validation.md) and [implementation diary](ttmp/2026/10/18/WEFT-001--weft-lab-go-backend-build-flash-and-validate-on-gatemate-a1-evb/diary/01-implementation-diary.md) for this work.

**Hardware and toolchain.**

- [Olimex GateMateA1-EVB](https://www.olimex.com/Products/FPGA/GateMate/GateMateA1-EVB/open-source-hardware) with the [Cologne Chip GateMate](https://colognechip.com/programmable-logic/gatemate/) CCGM1A1.
- [OSS CAD Suite](https://github.com/YosysHQ/oss-cad-suite-build), which bundles [Yosys](https://github.com/YosysHQ/yosys) (`synth_gatemate`), [nextpnr](https://github.com/YosysHQ/nextpnr) (`nextpnr-himbaechel`), [Project Peppercorn](https://github.com/YosysHQ/prjpeppercorn) (`gmpack`), [openFPGALoader](https://github.com/trabucayre/openFPGALoader) and [Icarus Verilog](https://github.com/steveicarus/iverilog).

**Software this builds on.**

- [francois](https://github.com/go-go-golems/francois) (MIT): the artifact runtime host and model worker client in `pkg/artifacthost`, `pkg/sampler` and `pkg/web/static/runtime.js` are adapted from it.
- [glazed](https://github.com/go-go-golems/glazed): the CLI framework and help system.
- [acorn](https://github.com/acornjs/acorn): the JavaScript parser the Lab's compiler uses to read hardware lambdas.

**Earlier GateMate projects** on the same board, which established its pin facts, build flags and evidence workflow:

- [MATE-16](https://github.com/wesen/2026-08-25--vm-cpu-gatemate): a bytecode stack CPU.
- [PCA-Z80](https://github.com/wesen/2026-08-28--pca-gatemate): a Z80 subset over a router mesh, with the physical UART.
- [GateMate Symbolic](https://github.com/wesen/2026-09-04--gatemate-symbolic): symbolic-computing laboratories.

**Further reading.** The books' full reading lists are in Book 1, Appendix B and Book 2, Appendix C. Three entries bear directly on the code here:

- D. M. Harris, S. L. Harris, *Digital Design and Computer Architecture*: the sequential-logic and HDL semantics that the simulator and the emitted Verilog follow.
- M. Schoeberl, [*Digital Design with Chisel*](https://www.imm.dtu.dk/~masca/chisel-book.html): the embedded hardware-language approach that Weft is contrasted with.
- C. E. Cummings, "Simulation and Synthesis Techniques for Asynchronous FIFO Design" (SNUG 2002) and "Clock Domain Crossing (CDC) Design & Verification Techniques Using SystemVerilog" (SNUG 2008), in the [Paradigm Works library](https://www.paradigm-works.com/technical-library): the synchronizers in the board top and the Lab's clock-domain crossings.

## License

MIT, see [LICENSE](LICENSE).
