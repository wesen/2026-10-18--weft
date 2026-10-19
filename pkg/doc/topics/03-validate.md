---
Title: Validating a design against the Lab's simulator
Slug: validation-ladder
Short: "The validation ladder of weft validate: build, RTL co-simulation, netlist co-simulation."
Topics:
- gatemate
- toolchain
- validation
Commands:
- validate
IsTemplate: false
IsTopLevel: true
ShowPerDefault: true
SectionType: GeneralTopic
---

The Lab's simulator runs the Weft graph; the board runs the Verilog the compiler emits for it, after
yosys and nextpnr. `weft validate` checks the steps in between, one rung at a time, and prints one row per
level and scenario:

| level | checks | tools |
|-------|--------|-------|
| `build` | synthesis, place and route and timing succeed for the A1-EVB (a full build, not loaded) | yosys, nextpnr, gmpack |
| `rtl` | the emitted Verilog drives the same pins as the simulator, cycle by cycle, over each scenario | iverilog |
| `net` | the same, against a GateMate netlist of that Verilog with the vendor cell models | yosys `synth_gatemate`, iverilog |
| `board` | scenarios on the real board | not implemented yet |

    weft validate weft-lab/examples/F-02-counter.js
    weft validate weft-lab/examples/F-01-blinky.js --levels build,rtl,net
    weft validate design.js --scenario "counts up, then down" --levels rtl

The command fails when any check fails, so it works in scripts and CI.

## How the co-simulation works

The compiler runs each scenario in the simulator (the same code as the Lab) and records every change of
the design's top-level ports. Cycle *k* is the *k*-th rising edge of the main clock: an input change at
*k* is applied before edge *k*, and an output value at *k* is what the design drives just before edge *k*.
A generated testbench replays the inputs into the RTL (or the netlist) and compares every output bit the
design binds, every cycle. The first difference ends the run with the cycle and the port, for example
"cycle 250001: led is 0, the simulator drove 1".

Registers start from their initializers on both sides and reset stays low: the simulator never resets,
and the GateMate flip-flop model honours the `INIT` values synthesis keeps.

`rtl` and `net` run a *co-simulation variant* of the design whose main clock is `--cosim-hz` (1 MHz by
default), so every prescaler shrinks by the same factor and whole scenarios stay short: F-01's 1.1 s
scenario is 1.1 million cycles, a few seconds in iverilog and about half a minute as a netlist.

Some scenarios cannot be replayed through ports. A scenario with a step that changes the design's
internals (`poke`, `force`, `knob`, a hot patch, …) is skipped with the step named, and so is a design
with more than one clock domain.

## Designs with native cells

The Lab models cells such as `std.uart.rx` at the transaction level (a byte appears at once, a frame time
after it was sent), so comparing their hardware cores cycle by cycle would fail for reasons that are not
bugs. Co-simulation therefore cuts such a design at the cell boundary. The device under test becomes the
main domain's module (`<design>_<domain>`): the testbench feeds it what the cells drive into the graph (a
byte stream's valid and data, a debouncer's events) and checks what the cells read from it (ready, the raw
buttons, the bytes to send), every bit of each. Pins only a cell touches, such as `uart.tx`, are not checked
there. Each core is checked against its model by its own testbench (`go test ./hdl`), and on the board.

## Files

Each run keeps everything it used: under `var/weft/validate/<id>/` for the CLI, under
`var/weft/builds/<id>/validate/` for a build that ran validation.

- `rtl/` — the emitted Verilog of the co-simulation variant.
- `net/` — `synth.ys`, `synth.log` and `netlist.v`.
- `sc-<scenario>/` — `changes.txt` (the recorded changes, one `<cycle> <port> <hex>` line each), the
  testbench `tb.v`, its `.mem` change tables, and `rtl.log` / `net.log` with the simulator's output.

## From the Lab

The Hardware tab's **Validate** button records the vectors in the page, sends them with the bundle, and
shows the results as they come, with links to each scenario's change list, testbench and log. The agent
calls `hw.validate()` and reads `hw.job(id).validation`. Over the API, a build request takes
`"validate": ["build", "rtl", "net"]` and `"vectors"`, and `POST /api/hw/builds/{id}/validate` re-runs the
ladder on a finished build.
