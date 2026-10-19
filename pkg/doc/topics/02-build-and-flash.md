---
Title: Building and loading designs on the GateMateA1-EVB
Slug: build-and-flash
Short: Turn a Weft script into a bitstream with weft build, and load it with weft flash.
Topics:
- gatemate
- toolchain
- build
Commands:
- emit
- build
- flash
IsTemplate: false
IsTopLevel: true
ShowPerDefault: true
SectionType: GeneralTopic
---

A build has four steps, all visible as rows of `weft build`:

1. **emit** — the Weft compiler (embedded in the binary, run with Node) compiles the script for
   `gatemate-a1-evb` and produces a hardware bundle. `weft emit <script.js>` prints that bundle.
2. **synth** — yosys `synth_gatemate` over the design and a generated board top (`weft_board_top`), which
   adds the 10 MHz clock, PLLs for other clock domains, the reset, pin polarity and input synchronizers.
3. **pnr** — nextpnr-himbaechel places and routes with `--timing-allow-fail`, so a design that misses
   timing still gets a report and a bitstream.
4. **pack** — gmpack writes `top.bit`.

    weft build weft-lab/examples/F-01-blinky.js --load
    weft build bundle.json --seed 3 --verbose
    weft build weft-lab/examples/F-05-buttons.js --hil --load

`--hil` adds the HIL bridge to the board top. The bridge reports every output change over the board's UART
and lets the host set every input, including the virtual buttons and switches. A board session uses it
(`weft help board-session`). A design that uses the UART itself cannot have it.

Everything lands in `var/weft/builds/<id>/`: the sources, `synth.log`, `pnr.log`, `report.json`
(utilization, fmax per clock, PLL checks, bitstream hash) and `top.bit`.

## Loading

`--load` (or `weft flash <id>`) writes the bitstream to the FPGA's SRAM through the board's RP2040
programmer. It runs until power-off; the flash is never touched.

A build whose clocks failed timing is refused unless you pass `--force`: it may work at room temperature
and fail later, so loading it is a decision you make explicitly.

    weft flash 20261018-185817-blinky-5e56
    weft flash path/to/top.bit
    weft flash <id> --force

## From the Lab

Under `weft serve` the Lab gets a **Hardware** tab (it stays hidden on claude.ai, where there is no
backend). *Build* and *Build and load* compile the editor's design for the A1-EVB in the page, send the
bundle to the server, and stream the stages and tool output back; the tab then puts the Lab's estimate
next to nextpnr's utilization and fmax. The estimate covers the design's own graph: the native-cell cores
and the HIL bridge (about 1,170–1,450 LUT sites) are not in it, so a `--hil` build places far more than
it estimates. Builds from the tab and from `weft build` share
`var/weft/builds/`, so either can load the other's.

The Lab's agent sees the same thing as `hw`: `hw.build()` returns a build id at once, and
`hw.job(id, { wait: "30s" })` waits for the result. The JSON API behind both is under `/api/hw/`
(`status`, `builds`, `builds/{id}`, `builds/{id}/events`, `builds/{id}/files/{name}`,
`builds/{id}/load`). A load returns 409 when the build failed timing and the request lacks
`"force": true`, and while a board session owns the board.

## What can go to hardware

The design must name a board (`.board("gatemate-a1-evb")`, or any board whose resources the A1-EVB also
has), bind at least one resource, and use only native cells that have a hardware core. Otherwise
`weft emit` refuses with the reason: `bare-part`, `no-pins`, `cells`, or the compile error, for example
"the gatemate-a1-evb board has no hdmi".

Three native cells have hand-written cores (`hdl/cells/`, built into `weft`): `std.debounce`
(`weft_core_debounce`), `std.uart.rx` and `std.uart.tx` (`weft_core_uart_rx`, `weft_core_uart_tx`, 8N1).
The emitted Verilog wires each such cell to its core through a generated adapter, and `weft build` adds the
core to synthesis (`cells/` in the build directory). Where hardware and the Lab's models differ (the receiver
holds one byte, the transmitter runs up to 1 % fast so a design that forwards bytes never falls behind, the
debouncer keeps one pending event per input), the core's header says so.

The A1-EVB's FPGA UART (`uart.tx`, `uart.rx`) reaches the host as the RP2040's first serial port,
`/dev/ttyACM0` at 115200 baud (it needs the `cdc_acm` module). The RP2040 forwards USB data without flow
control and drops what overflows its buffer, so a host should not send bursts much longer than 1 KB ahead
of what comes back.

On the A1-EVB, `led:0` and `btn:user` (alias `btn:0`) are the board's LED and button, `led:1..7` are PMOD
pins, and `btn:1..3` and `sw:0..7` are virtual: they compile, and on the board they read as 0, unless the
build carries the HIL bridge, which sets them from the host.
