---
Title: 'Weft Lab on real hardware: intern guide to the Go backend, GateMate toolchain and validation'
Ticket: WEFT-001
Status: active
Topics:
    - weft
    - fpga
    - gatemate
    - backend
    - go
    - toolchain
DocType: design-doc
Intent: long-term
Owners: []
RelatedFiles:
    - Path: repo://pkg/artifacthost/host.go
      Note: Artifact runtime host (window.claude sample/downloads)
    - Path: repo://ttmp/2026/10/18/WEFT-001--weft-lab-go-backend-build-flash-and-validate-on-gatemate-a1-evb/scripts/02-spike-gatemate-flow/run.sh
      Note: Spike proving Weft Verilog → bitstream → board
    - Path: repo://weft-lab/app/src/core/gatemate-pll.js
      Note: Port of nextpnr's CC_PLL divider search
    - Path: repo://weft-lab/app/src/core/verilog.js
      Note: Verilog emitter the bundle is built on (emitVerilog, emitTop, pinParts)
ExternalSources: []
Summary: 'Intern-facing analysis, design and implementation guide: how the Weft Lab browser IDE, the Weft compiler, the GateMate open-source toolchain, the Olimex GateMateA1-EVB and a Glazed-based Go server fit together to compile, load and validate Weft designs on real hardware.'
LastUpdated: 2026-10-18T18:30:00-04:00
WhatFor: Onboarding and the implementation plan for WEFT-001.
WhenToUse: Read before touching weft-lab/app/src/core/{boards,verilog,hardware}.js, cmd/weft, pkg/board, pkg/toolchain, pkg/hw, pkg/artifacthost or pkg/sampler.
---

# Weft Lab on real hardware: intern guide to the Go backend, GateMate toolchain and validation

## 1. Executive summary

Weft Lab is a browser IDE for Weft, a JavaScript grammar for describing FPGA hardware. Today the Lab compiles a
Weft script to a dataflow graph, simulates it cycle by cycle on an imaginary board, and prints an *estimated*
build report. Nothing ever reaches a real chip. This ticket adds the missing half: a Go program called `weft`
that serves the Lab from your machine and turns a Weft design into a bitstream for the Olimex GateMateA1-EVB.
It then loads that bitstream into the FPGA and checks that the hardware does what the simulator said it would.

The work splits into five pieces:

- **A hardware bundle** produced by the Lab's JavaScript compiler. It is a self-contained JSON file holding the
  design's Verilog, its clocks, and which top-level port bit belongs to which board resource.
- **A board layer** in Go. It knows the A1-EVB's pins and polarities and wraps the design in a generated board
  top module, a pin constraint file (`.ccf`) and a timing constraint file (`.sdc`).
- **A toolchain runner** in Go. It drives yosys, nextpnr-himbaechel, gmpack and openFPGALoader from the OSS CAD
  Suite, parses their logs, and will not load a build that failed timing unless asked to with `force`.
- **A validation ladder.** It checks the design at four levels: build checks, RTL co-simulation, gate-level
  netlist co-simulation, and scenarios run on the physical board through its UART.
- **An artifact host**, adapted from the francois project. It injects the `window.claude` runtime into the Lab
  page so the Lab's architect agent can call a model from the local server, as it does on claude.ai.

The core path has already been demonstrated by a spike (§4.6). Example F-01 (blinky) was emitted by the Lab's
compiler and wrapped by hand for the board. It was synthesized, placed, routed and packed in about 4 seconds:
63 LUT cells, 25 flip-flops, and a maximum clock of 90.86 MHz against a 10 MHz constraint. The 4,172-byte
bitstream was then loaded into the board's SRAM over JTAG (`Done`, exit 0).

## 2. Problem statement and scope

The Lab's books promise a milestone they never reach. Book 2 lists "M9 Silicon | Mapping, emitters, nextpnr and
Vivado flows | F-01 blinks on a real board" (Book 2, line 53). The Lab ends earlier. Its report is explicitly an
estimate (`report.estimated === true`, `weft-lab/ARCH.md:352`), and its Verilog leaves native cells as black
boxes (`weft-lab/app/src/core/verilog.js:381-390`). It also has no notion of a physical clock pin, a reset
source, pin polarity or a programming cable.

**In scope**

1. A Go binary, `weft`, with `serve`, `doctor`, `emit`, `build`, `flash` and `validate` commands, built on
   Glazed. Glazed is the go-go-golems command framework on top of Cobra: it declares flags as typed fields,
   adds help pages, and lets a command emit rows that print as a table, JSON or YAML.
2. Serving the Lab page with the `window.claude` capabilities it uses: `sample` for the agent and `downloads`.
3. A GateMate A1-EVB board profile on both sides: the Lab compiles against it, and Go maps it to pins.
4. Synthesis, place and route, packing and SRAM loading for designs on the main clock, with real timing and
   utilization numbers shown in the Lab.
5. Verilog implementations of the std cells the examples use most: `uart-rx`, `uart-tx` and `debounce`.
6. Validation at four levels (§6.10), the board level going through the A1-EVB's built-in UART.
7. Letting the architect agent build, load and validate through its existing `eval` tool.

**Out of scope for this ticket** (each listed again in §11)

- Writing persistent configuration flash (`openFPGALoader -f`). SRAM loading is volatile and safe.
- Cologne Chip's proprietary `p_r` place and route tool. Every past project used the OSS flow (§4.4).
- `hdmi`, `video-timing`, `sigma-delta` audio and partial reconfiguration (F-17, F-19 live change) on hardware.
- Multi-user or remote hosting. The server binds to loopback.

## 3. Orientation: the parts and how they relate

This section gives you enough vocabulary to read the rest. Each subsection introduces one layer, from the chip
up to the browser.

### 3.1 What an FPGA build is

An FPGA (field-programmable gate array) is a chip whose logic is set by a configuration file rather than fixed
in silicon. Its fabric is a grid of small logic blocks, each holding a lookup table and a flip-flop. A *lookup
table* (LUT) is a tiny memory that implements any Boolean function of a few inputs. A *flip-flop* (FF) stores
one bit and updates it on a clock edge. Between the blocks runs a programmable *routing* network. The
*bitstream* is the file that sets every LUT, flip-flop mode and routing switch.

Turning a hardware description into a bitstream takes four steps. **Synthesis** converts Verilog into a
*netlist*: a graph of the chip family's primitive cells (LUTs, flip-flops, adders, block RAMs, I/O buffers).
**Placement** assigns each cell to a physical site. **Routing** connects the sites through the switch network.
**Packing** (bitstream generation) writes the configuration bits. *Static timing analysis* then reports how
fast each clock can run: the longest register-to-register path sets the maximum frequency (fmax). A design
whose fmax is below its clock's frequency has failed timing and may misbehave.

*Programming* loads the bitstream into the chip, usually over JTAG, a four-wire test and debug interface.
Loading into configuration SRAM takes effect immediately and is lost at power-off. Writing a configuration
flash chip survives power cycles.

### 3.2 GateMate and the Olimex GateMateA1-EVB

The board is the **Olimex GateMateA1-EVB**, built around a Cologne Chip **CCGM1A1** FPGA. Its logic block is the
*CPE* (cartridge programmable element). The CCGM1A1 has 20,480 CPEs, which nextpnr counts as 40,960 LUT sites
and 40,960 flip-flop sites (`CPE_LT`, `CPE_FF`), plus 162 I/O sites (`IOSEL`). Yosys maps logic to `CC_*`
primitives such as `CC_LUT2`, `CC_L2T4`, `CC_ADDF`, `CC_DFF`, `CC_BUFG`, `CC_IBUF`, `CC_OBUF`, `CC_PLL`,
`CC_BRAM_20K` and `CC_USR_RSTN`.

An RP2040 microcontroller on the board runs DirtyJTAG firmware, and one USB cable does all the work.
openFPGALoader talks to the RP2040 as a JTAG adapter (USB `1209:c0ca`, board name `olimex_gatemateevb`). The same
USB device also exposes two CDC serial ports. The first, `/dev/ttyACM0`, is wired to the FPGA's UART pins.

| Board resource | FPGA pin | Direction | Notes |
| --- | --- | --- | --- |
| 10 MHz oscillator | `IO_SB_A8` | in | needs `SCHMITT_TRIGGER=true` |
| user LED | `IO_SB_B6` | out | **active-low**, the only user LED |
| user button FPGA_BUT1 | `IO_SB_B7` | in | **active-low** |
| UART TX (FPGA to host) | `IO_SA_B6` | out | to RP2040 GPIO13, then `/dev/ttyACM0` |
| UART RX (host to FPGA) | `IO_SA_A6` | in | from RP2040 GPIO12 |
| PMOD | `IO_EA_A4..A7`, `IO_EA_B4..B7` | io | 8 pins, 3.3 V level-shifted |

Sources: `/home/manuel/code/wesen/2026-08-28--pca-gatemate/pca_z80/constraints/olimex_gatematea1_evb.ccf` and
`/home/manuel/code/wesen/2026-08-25--vm-cpu-gatemate/sources/board/litex-olimex-gatemate.py:16-76`. One older
pin note (`.../sources/board/gatemate-pin-reference.md:22-23`) has the UART TX pin wrong. Trust the CCF above.

### 3.3 Weft, the grammar

A Weft script is the body of a JavaScript function that returns a *design*. Builders such as `module()`,
`design()`, `board()` and `std.uart.rx()` are immutable values, and their methods return new builders. A Weft
script uses lambdas (inline functions) in three roles, and the distinction matters everywhere:

- A **builder lambda** runs once, while the script is evaluated, as ordinary JavaScript. It shapes the graph.
  Example: the predicate in `.when(t => t.family === "xc7", …)`.
- A **hardware lambda** is never called. The compiler parses its source text (with acorn) and turns its
  statements into gates and registers. Example: `$ => { $.led = !$.led; }` in `.every("250ms", …)`.
- A **runtime lambda** is ordinary JavaScript that runs later, beside the running hardware, and talks to it
  through handles. Examples: `host()` handlers and scenario predicates.

The compiler lowers a design through *IR levels* (intermediate representations):

1. **HIR**: the module hierarchy with parsed hardware lambdas.
2. **lower**: per-clock-domain graphs right after lowering.
3. **dag**: those graphs after optimization.
4. **net**: an estimated technology mapping.

The central data structure is the **DAG**, one hash-consed graph per clock domain (`weft-lab/ARCH.md:56-75`).
Its nodes are pure operations (`add`, `mux`, `slice`, …) and stateful ones (`reg`, `mem`, `in`, `out`, `cell`).
A **board profile** names the resources a design may bind to, such as `led:0`, `btn:user` and `uart.tx`. A
**knob** is a register that host code reads or writes while the design runs, through a bridge cell (F-12's
synthesizer parameters are knobs). A **scenario** is a test that runs against the simulated board. It comes in
two kinds. A `kind: "steps"` scenario is a recorded list of steps (`wait`, `press`, `expectToggles`, …) built
with `.scenario(name, sc => sc.wait(…)…)`. A `kind: "tb"` scenario is an async testbench function that drives
the simulator directly (F-03's `tb.measure`). A **portable** scenario is a `steps` scenario whose steps are
all in the set the board runner can perform (§6.10). Only portable scenarios can run on hardware.

Here is F-01 (`weft-lab/examples/F-01-blinky.js`, without its header comment):

```js
const blink = module("blink")
  .out("led", bit)
  .every("250ms", $ => { $.led = !$.led; })         // 12 MHz × 250 ms: a 22-bit prescaler, generated for you
  .bind({ led: "led:0" });

return design("blinky")
  .board("pico")
  .use(blink)
  .scenario("blinks at 2 Hz", sc => sc
    .wait("1.1s")
    .expectToggles("led:0", n => n === 4));
```

### 3.4 Weft Lab, the application

Weft Lab is one HTML page of about 843 KB. It contains a React UI, the whole compiler and the simulator as
plain ES2022 modules, and the 19 example files. `weft-lab/app/build.mjs` bundles it with esbuild and loads
React from cdnjs (`build.mjs:58-59`), so the page needs network access even when `weft serve` hosts it
locally. Everything under `weft-lab/app/src/core/` is DOM-free and runs in Node, which is how the tests run
(`node app/test/<name>.test.mjs`). The whole `app/src` tree is about 14k lines; the DOM-free core is about
9.7k of them.

| Area | Files | What it does |
| --- | --- | --- |
| compiler front | `core/dsl.js`, `core/front.js`, `core/lower.js`, `core/compile.js` | builders, lambda parsing, lowering to DAGs, `compile()` |
| compiler middle | `core/passes.js`, `core/estimate.js`, `core/verilog.js` | pass pipeline, estimates, Verilog emitter |
| simulation | `core/sim.js`, `core/cells.js`, `core/scenario.js`, `core/formal.js`, `core/changes.js`, `core/host.js` | cycle simulator, native cell models, scenarios, model checking, live change, host runtime |
| data | `core/types.js`, `core/ir.js`, `core/boards.js`, `core/std.js` | bit-vector types, the `Graph` class, board profiles, `std.*` |
| UI | `ui/*.jsx`, `ui/lab.js`, `ui/engine.js` | tabs, the `lab` state object, the run loop |
| agent | `agent/lab-agent.js`, `agent/os-agents.js` | the architect agent and its `eval` tool |

### 3.5 The artifact runtime and `window.claude`

On claude.ai, an artifact page receives an object `window.claude`. Its `use(name)` method returns a capability
or `null`. The Lab asks for two capabilities at startup (`weft-lab/app/src/main.jsx:6-15`): `sample`, which
calls a Claude model, and `downloads`, which saves a file. The architect agent calls
`sample(turns, { tools, onText, signal, modelTier, effort, cache })` (`weft-lab/app/src/agent/lab-agent.js:219-223`)
with one tool, `eval`. The tool is defined by `evalTool` (lines 247-252), and its `execute` function hands the
code to `runEval` (lines 254-282), which runs it inside the page. The tool loop therefore spans both sides:
the model runs remotely, and every tool call comes back into the page to be executed.

The francois project (`/home/manuel/code/wesen/go-go-golems/francois`) recreates this runtime for artifacts
hosted from a local Go server. It injects a boot blob and `runtime.js` into the page's `<head>`. The page and
the server then talk through Server-Sent Events (SSE) plus a few POST endpoints, and a Go `Backend` interface
makes the model calls through a Node worker. The worker is built on Pi, the model runtime of the pi coding
agent; it reads the provider credentials Pi already keeps in `~/.pi/agent/`. We reuse francois's design and
its runtime shim (§6.11, decision D-5).

### 3.6 The whole system

```text
+------------------------------- browser ---------------------------------+
|  Weft Lab page (dist/index.html: React + src/core compiler/simulator)   |
|    Code tab --> compile() --> Compiled --> Sim, Scenarios, Report        |
|                                  |                                       |
|                                  +--> hardware.buildBundle() --------+   |
|    Agent tab --> window.claude.use("sample") --+                     |   |
|    runtime.js (injected by the server)         |                     |   |
+------------------------------------------------|---------------------|---+
           SSE + POST /api/views/...             |                     |  POST /api/hw/builds
+------------------------------------------------v---------------------v---+
|  weft serve (Go, Glazed command)                                         |
|    pkg/artifacthost : inject boot+runtime, views, sample calls, tools    |
|    pkg/sampler      : Backend interface -> Node worker (Pi) -> model     |
|    pkg/hw           : build jobs, SSE logs, flash, validation, board lock|
|    pkg/board        : A1-EVB pin map -> board top .v, .ccf, .sdc          |
|    pkg/toolchain    : yosys -> nextpnr-himbaechel -> gmpack -> loader     |
+---------------------+-----------------------------------+----------------+
                      | USB: JTAG (DirtyJTAG, RP2040)     | USB CDC: /dev/ttyACM0
               +------v-----------------------------------v------+
               |  Olimex GateMateA1-EVB:  RP2040  <-->  CCGM1A1    |
               +-------------------------------------------------+
```

Read it left to right as one build. The page compiles the script exactly as before. When you press *Build for
GateMate*, it recompiles against the `gatemate-a1-evb` board profile and packs the result into a bundle. It
posts the bundle to `weft serve`, which wraps it for the board, runs the toolchain as a job, and streams logs
back. On request, the server loads the bitstream through the RP2040 and runs validation, using
`/dev/ttyACM0` for the board-level checks.

## 4. Current state, with evidence

### 4.1 The compiler entry points

- `compile(script, opts)` is defined at `weft-lab/app/src/core/compile.js:353`. It never throws: script errors
  become diagnostics (`weft-lab/ARCH.md:115-117`).
- `opts.board` retargets a design. The given board is put at the front of the target list
  (`weft-lab/app/src/core/compile.js:131-136`), so `compile(script, { board: "gatemate-a1-evb" })` will rebuild a
  design written for `pico` or `dev` against the new profile. Prescalers are recomputed from the new clock.
- A design that binds a resource the new profile lacks does not compile. `claimPin` reports an error such as
  `the gatemate-a1-evb board has no hdmi` (`weft-lab/app/src/core/lower.js:729-731`), and `c.ok` is false.
- Retargeting is wrong for *bare-part* designs (F-13, F-14). They name a part and no board, so their unbound
  module ports become the top-level ports. Once `opts.board` is set, unbound outputs are dropped
  (`lower.js:803`) and unbound inputs become `free` inputs tied to 0 (`lower.js:926`). The result compiles
  cleanly to an empty design. `buildBundle` therefore refuses such designs (§6.4).
- `opts.overrides` can change a domain's frequency: a key `clock.<domain>` replaces that domain's `hz`
  (`compile.js:111-114`), and prescalers are sized from it. Co-simulation uses this to keep dividers short
  (§6.10).
- The `Compiled` shape is in `weft-lab/ARCH.md:79-112`. Its fields used by hardware work are `domains`
  (`{ [name]: { hz, graph } }`), `pins` (`[{ resource, dir, domain, node, bit, instance, port, cell? }]`),
  `cells`, `knobs` and `scenarios`.
- Board profiles live in `weft-lab/app/src/core/boards.js:34-86` (`pico`, `dev`, `studio`) and part capacities
  in `PART_DATA` at line 7. The estimator keeps a second part table, `PARTS`
  (`weft-lab/app/src/core/estimate.js:9-17`), and the family table `FAMILY` (line 32). The unknown-board
  message lists `(pico, dev, studio)` as literal text (`compile.js:130`). There is **no GateMate profile or
  part** in any of these places.
- `solvePll` (`compile.js:61-85`) computes what a `.clocks()` PLL domain actually achieves. It knows iCE40
  and, for every other family, uses Xilinx MMCM limits.

### 4.2 What the Verilog emitter produces

`emitVerilog(compiled)` (`weft-lab/app/src/core/verilog.js:235`) returns `[{ path, text, top? }]`, and these
facts follow from its source:

1. It writes one module per clock domain, named `<design>_<domain>` (line 246), with ports `clk`, `rst`, one
   input per `in` node and one output per `out` node. Each node that another domain or a native cell reads
   also becomes an extra output named `x_<id>` (lines 211-217). Cell adapters connect through these ports.
2. The top module (`emitTop`, line 263) has one clock input per domain (`clk_<domain>`), one `rst` input, and
   one port per pin resource base name. `led:0..2` becomes `output [2:0] led`, and `uart.tx` becomes `uart_tx`
   (`pinParts`, line 259). A port's width is the highest bound index plus one (line 278), so a design that
   binds only `led:3` still gets `output [3:0] led`.
3. The header comment says it plainly: clocks are top-level inputs (PLL primitives are not emitted), and
   `rst` is synchronous and active high (line 341). Registers are written as
   `x <= rst ? init : next` (line 202), with `reg … = init` initializers.
4. Knob inputs are tied to their reset value, because they are written by a host bridge the RTL does not
   model (line 305).
5. Native cells become `(* blackbox *)` modules named `weft_<kind>` with one port per stream signal and pin
   (lines 345-390). Port names come from the design's stream names, so they differ from design to design.
6. Memory reads are registered (`memrd`, line 187), which suits block-RAM inference on GateMate. Memory reads
   and writes are not gated by `rst` (lines 187-197); only `reg` nodes are.

The Lab already exposes this output. `lab.verilog()` (`weft-lab/app/src/ui/lab.js:470-480`) feeds the Report
tab and the *download .v* action. The pass tests can dump every design's RTL for external checkers through
`WEFT_RTL_DIR` (`weft-lab/app/test/passes.test.mjs:10-16`).

### 4.3 Test baseline

The imported source passes its own suites unchanged (diary Step 1): `types`, `ir`, `compile` (all 19 examples
compile as expected), `sim`, `cells`, `passes` (18/18), `formal`, and `scenarios`. The scenarios suite reports
28 scenarios: 26 pass, 2 skip because they need Claude.

### 4.4 How past GateMate projects built and loaded designs

There were four earlier projects: MATE-16, PCA-Z80, Uxn, and GateMate Symbolic. All of them used the OSS CAD
Suite at `/home/manuel/fpga/oss-cad-suite` (VERSION `20260825`; activate with `source
~/fpga/oss-cad-suite/environment`). The same suite also ships `iverilog` and `vvp`, which the validation
ladder uses (§6.10). Their canonical flow is adapted below from
`/home/manuel/code/wesen/2026-08-25--vm-cpu-gatemate/mate16/Makefile:62-78`. The Makefile uses `$(TOP)`,
`$(CCF)` and `blink.json`, and has no seed; the `--seed` came from later projects:

```bash
yosys -ql build/yosys.log -p 'read_verilog -defer -sv $(RTL); synth_gatemate -top top -luttree -nomx8; stat; write_json build/top.json'
nextpnr-himbaechel -l build/nextpnr.log --device CCGM1A1 --json build/top.json \
  -o ccf=top.ccf -o out=build/top.txt --sdc top.sdc --router router2 [--seed 1]
gmpack build/top.txt build/top.bit
openFPGALoader -b olimex_gatemateevb build/top.bit
```

These rules come from those projects' diaries, and the runner must encode them:

- **`-nomx8` is mandatory.** nextpnr rejects `CC_MX8` ("Cell type 'CC_MX8' is unsupported").
- **Timing failure does not fail the exit code.** nextpnr prints `ERROR: Max frequency for clock … (FAIL at
  10.00 MHz)` and still ends with `Program finished normally.` Past projects grepped `^ERROR:` and checked
  that the bitstream was newer than the routing log
  (`.../GATEMATE-SYMBOLIC-008--.../scripts/20-physical-qualification.sh`). That check cannot tell a timing
  failure from a real error, so our runner passes `--timing-allow-fail` and parses timing separately (§6.7).
- **Router seeds matter.** The default seed left one wire overused after 3,000 iterations, and seed 1 routed.
  Pin the seed and record it.
- **Reset** comes from `CC_USR_RSTN`, the active-low end of configuration, through a two-flop synchronizer
  (assert asynchronously, release synchronously).
- **Polarity** bit every project once: the LED and the button are active-low.
- **USB permissions** need the udev rule for `1209:c0ca`. It is already installed at
  `/etc/udev/rules.d/99-openfpgaloader.rules`.
- **Only one process may hold `/dev/ttyACM0`.** Board-level checks start the serial capture *before* loading,
  because designs print as soon as configuration ends.

On this machine today, `openFPGALoader -b olimex_gatemateevb --detect` finds the chip (`idcode 0x20000001`,
`family GateMate Series`, `model GM1Ax`). The CDC serial ports, however, have **no driver bound**: the
`cdc_acm` kernel module is installed but not loaded, so no `/dev/ttyACM*` exists. Fixing that needs
`sudo modprobe cdc_acm` (§11).

### 4.5 How francois hosts artifacts

Francois serves an artifact page top-level and splices a boot blob and `runtime.js` into it. The boot blob is
`<script type="application/json" id="francois-view">{artifactId, version, manifest, owner, models}</script>`, and
the script is `<script src="/static/runtime.js">` (`francois/pkg/host/routes.go:67-97`, `inject` at 239-259). The
shim defines a frozen `window.claude` whose `use(name)` returns a capability only if the manifest declares it.
The one exception is `user`, which it always returns (`francois/ui/src/runtime.ts:819-828`). A `sample()` call
runs this protocol (`francois/pkg/host/server.go:242-362`, `routes.go:98-228`):

1. `POST /api/views` with the page's `{version}` creates a view. The version comes from the boot blob, must be
   at least 1, and must exist in the store (`routes.go:104-114`). Then `GET /api/views/{view}/events` opens an
   SSE stream that starts with `{"type":"ready"}`.
2. `POST /api/views/{view}/calls` starts a call with `{callId, input, options, tools: [descriptors]}`. Tool
   *functions* stay in the page.
3. The server streams `text` and `thinking` events and, for each tool use, a
   `{"type":"tool", callId, toolCallId, name, input}` event.
4. The page runs the tool and posts the result to `POST …/calls/{call}/tools/{toolCallId}/result` as
   `{value, isError}` (at most 32 KiB).
5. The server emits `result` (or `error`), and the page resolves the promise.

Two limits matter to us. Each call has a 5-minute timeout (`server.go:289`). The model gets at most 5 tool
rounds: the server leaves `maxRounds` unset (`server.go:278`), and the worker then defaults to 5 and caps any
value at 10 (`worker/src/main.ts:233`). This matches claude.ai, which allows "a handful of rounds". An `eval`
call that waits for a long build would therefore fail; §6.9 shows how the agent avoids that.

The shim's `downloads` capability runs entirely in the browser: it builds a Blob and clicks a download link.
It accepts only a fixed list of file extensions (`francois/ui/src/runtime-files.ts:2-6`), and that list
includes neither `v` nor `js`. The Lab saves both (`.v` and `.js` files through `saveFile`), so the stock shim
would reject them with `rejected_extension` (§6.11 has the patch).

The Go side drives a `piworker.Backend` (`francois/pkg/piworker/backend.go:9-91`). Its production
implementation (`client.go`) launches `worker/dist/main.js`, which uses Pi's model runtime with credentials
from `~/.pi/agent/auth.json`, and talks to it over NDJSON on stdio. Francois is not resolvable from the Go
module proxy (`go list -m github.com/go-go-golems/francois@latest` returns "no matching versions"), so it
cannot be imported. Section 6.11 says what we copy.

### 4.6 Spike: F-01 from the Lab's emitter to the board

`scripts/01-spike-emit-verilog.mjs` compiles a Weft example in Node and writes `emitVerilog` output. For F-01
it produced `blinky_sys.v` (13 DAG nodes: a 22-bit prescaler and the LED register) and `blinky.v`.
`scripts/02-spike-gatemate-flow/` adds three hand-written files: a board top (`weft_board_top.v`, 10 MHz clock,
`CC_USR_RSTN` reset synchronizer, inverted LED), a CCF and an SDC. `run.sh` runs the flow. Results:

| Step | Result |
| --- | --- |
| yosys `synth_gatemate -luttree -nomx8` | 0.29 s; 22 `CC_ADDF`, 25 `CC_DFF`, 27 `CC_LUT2`, 8 `CC_L2T4`, 1 `CC_USR_RSTN`, … |
| nextpnr-himbaechel `--router router2 --seed 1` | 3.8 s; `CPE_LT 63/40960`, `CPE_FF 25/40960`, `IOSEL 2/162` |
| timing | `Max frequency for clock 'u_design.clk_sys': 90.86 MHz (PASS at 10.00 MHz)` |
| gmpack | `top.bit`, 4,172 bytes, sha256 `cb1bbe49…b6b9c1a6` |
| openFPGALoader `-b olimex_gatemateevb` | `Load SRAM via JTAG … 100.00%`, `Done`, exit 0 |

The emitted Verilog synthesized without modification. The spike kept pico's 12 MHz prescaler, so the LED
toggles every 300 ms instead of 250 ms; retargeting to the GateMate profile fixes that. Nobody looked at the
LED during the spike, which is why §6.10 adds a board-level check that does not depend on eyes.

## 5. Gap analysis

| Need | Today | Gap | Phase |
| --- | --- | --- | --- |
| Serve the Lab locally with a working agent | page only works fully inside claude.ai | artifact host + sampler | P1, P2 |
| Compile against the real board | profiles `pico`, `dev`, `studio` only | `gatemate-a1-evb` profile + `ccgm1a1` part + delay model | P3 |
| A self-contained build input | `emitVerilog` files only | bundle: files + clocks + port-to-resource map + cells + scenarios | P3 |
| Physical clock, reset, polarity, pin locations | clocks and `rst` are bare inputs | generated board top, `.ccf`, `.sdc` | P4 |
| Real synthesis and timing | estimate only | toolchain runner with log parsing and gating | P4 |
| Load the board | none | openFPGALoader with board lock and error classes | P5 |
| See it in the Lab | Report tab shows estimates | Hardware tab: build, load, logs, real vs estimate | P5 |
| Std cells in hardware | black boxes | Verilog cores + generated adapters for uart-rx/tx, debounce | P7 |
| Evidence the board matches the simulator | none | L0 to L3 validation ladder | P6, P8 |
| Clocks other than 10 MHz | n/a | `CC_PLL` per extra domain | P7 |
| Agent can drive hardware | `eval` scope has no hardware | `hw` object in the agent scope | P8 |

## 6. Proposed architecture

### 6.1 Repository layout

```text
2026-10-18--weft/
  go.mod                         module github.com/wesen/2026-10-18--weft (go 1.26.3, toolchain go1.26.9)
  Makefile                       web, generate, build, test, lint
  cmd/weft/main.go               Glazed root: logging + help + command registration
  cmd/weft/cmds/                 serve.go doctor.go emit.go build.go flash.go validate.go
  pkg/board/                     board model; gatemate/ (A1-EVB profile, wrapper, ccf, sdc generators)
  pkg/bundle/                    the hardware bundle type (Go mirror of the JS schema) + validation
  pkg/toolchain/                 locate OSS CAD Suite, run steps, parse yosys/nextpnr logs
  pkg/hw/                        build jobs, job store, event fan-out, flash, board lock, HTTP handlers
  pkg/validate/                  vectors, testbench generation, iverilog co-sim, board session
  pkg/serialio/                  exclusive serial port owner (go.bug.st/serial)
  pkg/artifacthost/              page injection, views, SSE, sample calls, tool results (from francois)
  pkg/sampler/                   Backend interface, Node worker client, fake (from francois piworker)
  pkg/web/                       go:embed of the built Lab page, runtime.js and the cell HDL library
  hdl/cells/                     weft_core_uart_rx.v, weft_core_uart_tx.v, weft_core_debounce.v, weft_hil.v
  weft-lab/                      working copy of the Lab (app/, examples/, ARCH.md)
    app/src/core/hardware.js     NEW: buildBundle(), cell adapters, vectors export
    app/tools/weft-hw.mjs        NEW: headless emitter used by `weft emit/build/validate`
  ttmp/.../WEFT-001-.../         this ticket (sources/, design-doc/, diary/, scripts/)
```

### 6.2 The hardware bundle: the contract between JavaScript and Go

The bundle is the only thing the Go side needs from the compiler. The page produces it with `buildBundle`, and
the CLI produces it through `node weft-lab/app/tools/weft-hw.mjs`. It is plain JSON with a schema tag, so the
Go server never runs JavaScript during a build. Example for F-01 compiled against the GateMate profile:

```json
{
  "schema": "weft.hw-bundle/v1",
  "design": "blinky",
  "board": "gatemate-a1-evb",
  "source": { "file": "F-01-blinky.js", "sha256": "4f…" },
  "top": "blinky",
  "files": [
    { "path": "blinky_sys.v", "text": "module blinky_sys (...)" },
    { "path": "blinky.v", "text": "module blinky (...)", "top": true }
  ],
  "clocks": [ { "domain": "sys", "port": "clk_sys", "hz": 10000000, "main": true } ],
  "reset": { "port": "rst", "activeHigh": true, "synchronous": true },
  "ports": [
    { "name": "led", "dir": "out", "width": 1, "bits": [ { "bit": 0, "resource": "led:0" } ] }
  ],
  "cells": [],
  "knobs": [],
  "estimate": { "luts": 25, "ffs": 23, "fmaxMHz": { "sys": 120.4 } },
  "scenarios": [ { "name": "blinks at 2 Hz", "kind": "steps", "portable": true } ]
}
```

The numbers in `estimate` are placeholders; real ones come from the Lab's report. Field rules:

- `ports` lists every top-level port except clocks and `rst`, with the resource carried by each bit. Go uses
  this to place pins; it never parses Verilog. The mapping follows `emitTop` exactly:
  - `name` is the `pinParts` base name of the resource (`led:5` → `led`, `uart.tx` → `uart_tx`,
    `btn:user` → `btn_user`; `verilog.js:259-261`).
  - `bits[].bit` is the index `pinParts` takes from the resource id (`led:5` → 5). It is **not**
    `compiled.pins[].bit`, which is the bit inside the DAG node. The two differ for descending ranges
    (`led:7..0`, `boards.js:115-120`) and for designs that bind single bits from several nodes (F-04).
  - `width` is the highest index plus one, as `emitTop` sizes the port (`verilog.js:278`). A design that binds
    only `led:3` has `width: 4` and one `bits` entry. Bits without an entry stay unconnected (outputs) or are
    tied to 0 (inputs).
  - Pins owned by native cells are included. They appear in `compiled.pins` with `node: null` and
    `cell: true` (`lower.js:684`), and `emitTop` adds their ports through the cell stubs (`verilog.js:331-333`).
- A bundle with zero bound pins is refused by `buildBundle` and again by Go: nothing on the board could
  observe or drive it.
- `clocks[].main` marks the domain fed by the board oscillator. Other domains need a PLL output (§6.5). For a
  PLL domain, `hz` is what the GateMate branch of `solvePll` achieves (§6.3), so the simulator, the bundle and
  the cores' `CLK_HZ` agree.
- `cells[]` carries `{ path, kind, module, params, domain }`. Adapters for supported kinds are already in
  `files` (§6.6); `module` names a library core the server must add, such as `weft_core_uart_tx`.
- `estimate` copies the Lab's report so the Hardware tab can show estimate and reality side by side.
- `scenarios[].portable` is true for a `steps` scenario whose steps the board runner supports (§6.10).

### 6.3 The GateMate profile on the JavaScript side

`boards.js` gains a part record and a profile:

```js
// PART_DATA: CCGM1A1 counts CPE halves as LUT sites, as nextpnr reports them
ccgm1a1: { name: "ccgm1a1", family: "gatemate", luts: 40960, ffs: 40960, brams: 64, bramKb: 20,
           sprams: 0, spramKb: 0, dsps: 0, ios: 162, lut: "LUT4", delayClass: "gatemate" },

"gatemate-a1-evb": {
  profile: "gatemate-a1-evb",
  title: "gatemate-a1-evb — Olimex GateMateA1-EVB (CCGM1A1), 1 LED + 7 on PMOD, 1 button, USB serial",
  part: "ccgm1a1", mainHz: 10e6, clockPin: "clk",
  resources: {
    clk: { kind: "clock", dir: "in", pin: "IO_SB_A8", hz: 10e6 },
    ...range("led", n(8), "led", "out", ["IO_SB_B6", "IO_EA_A4", "IO_EA_A5", "IO_EA_A6", "IO_EA_A7", "IO_EA_B4", "IO_EA_B5", "IO_EA_B6"]),
    "btn:user": { kind: "button", dir: "in", pin: "IO_SB_B7" },
    ...range("btn", n(4), "button", "in", ["IO_SB_B7", null, null, null]),   // btn:0 = btn:user; null = virtual
    ...range("sw", n(8), "switch", "in", []),                                // all virtual
    "uart.tx": { kind: "uart", dir: "out", pin: "IO_SA_B6" },
    "uart.rx": { kind: "uart", dir: "in", pin: "IO_SA_A6" },
  },
  groups: { uart: ["uart.tx", "uart.rx"], btn: ["btn:user"] },               // btn: as on pico
},
```

The JavaScript profile only needs ids, directions and the clock. Pin names appear there for display, but the
**Go board package is authoritative** for pins and polarity (decision D-3).

`btn:0` and `btn:user` are two names for the one real button, so designs written for `dev` and for `pico` both
reach it. Go rejects a bundle that binds both, because both would claim IO_SB_B7.

Resources with no pin are *virtual*. They exist so that examples written for `dev` (four buttons, eight
switches) still compile. Virtual resources compile exactly like real ones: `claimPin` only checks that the id
exists (`lower.js:729`), and `resolveBoard` and `expandResources` never read `pin` (`boards.js:94-124`). On
hardware they are tied inactive, or driven by the HIL bridge. HIL (hardware in the loop) means the host
computer takes part in the running design: the board top can add a small UART device that reports the
design's outputs to the host and lets the host set its inputs (§6.10). Resources the profile does not list at
all (`hdmi`, `audio`, studio's `btn:up`) remain compile errors.

The profile is not the only JavaScript change for the new board:

- `estimate.js` gets a `ccgm1a1` record in its own part table `PARTS` (`estimate.js:9-17`) and a `gatemate`
  entry in `FAMILY` (line 32). The delay constants are a first guess, to be calibrated against nextpnr's
  fmax as builds come in (§10).
- `solvePll` (`compile.js:61-85`) gains a `gatemate` branch, so the frequency a PLL domain gets in the
  simulator, the bundle and the cores' `CLK_HZ` matches the hardware. The branch calls
  `weft-lab/app/src/core/gatemate-pll.js`, a port of nextpnr's own divider search
  (`himbaechel/uarch/gatemate/pll.cc`, `get_pll_settings`, for the path weft uses: internal feedback,
  `PDIV0_MUX = 1`, low jitter). A port beats a closed-form model because the reachable set depends on the mode's
  DCO range and divider limits (output = 10 MHz × N1·N2 / (2·M1·M2), DCO = 20 MHz × N1·N2 inside
  1250–2500 MHz for SPEED), and because ties between settings are broken by a DCO-centering weight. So
  25.175 MHz becomes 25.2083 MHz (121/24) in SPEED mode and 25.2778 MHz (91/18) in ECONOMY mode. The port reproduces nextpnr's
  "PLL fout=" line exactly for 13 requested frequencies in both modes
  (`scripts/03-pll-probe/run.sh` is the check).
- The unknown-board message (`compile.js:130`) stops listing profiles by hand and prints the keys of
  `BOARDS`.

### 6.4 `hardware.js` and the headless emitter

A new DOM-free module, `weft-lab/app/src/core/hardware.js`, owns the compiled-design-to-bundle step:

```js
export function buildBundle(compiled, { board = "gatemate-a1-evb", file, source } = {}) {
  // 1. refuse what hardware cannot do, each with a named reason:
  //    - compile errors (this includes resources the board lacks, §4.1)
  //    - a bare-part design: compiled.design._ has neither board nor targets, so retargeting
  //      dropped every port (§4.1); the message says so
  //    - zero bound pins; unsupported cells
  // 2. files = emitVerilog(compiled, { cells: "adapters" })  -> domain modules + top + cell adapters
  // 3. ports = compiled.pins (cell-owned ones too) grouped by pinParts(resource).base;
  //    bit = pinParts(resource).idx, width = highest idx + 1 (§6.2)
  // 4. clocks = Object.entries(compiled.domains) -> { domain, port: "clk_" + sanitize(d), hz, main }
  // 5. cells = compiled.cells -> { path, kind, module: CORE[kind], params, domain }
  // 6. estimate = pick(compiled.report, ...), scenarios = portable summaries
  return { schema: "weft.hw-bundle/v1", design, board, source, top, files, clocks, reset, ports, cells, knobs, estimate, scenarios };
}
export function vectors(script, scenarioName, { board = "gatemate-a1-evb", cosimHz = 1e6, regs = false } = {}) {
  /* §6.10 L1: compile with overrides { "clock.sys": cosimHz }, run the scenario, return
     { rtl: emitVerilog(...), header, changes: [[cycle, port, value], ...] } */
}
```

`weft-lab/app/tools/weft-hw.mjs` is a 50-line Node CLI around it. `weft-hw.mjs bundle <script.js> --board
gatemate-a1-evb` writes the bundle to stdout. `weft-hw.mjs vectors <script.js> --scenario NAME [--cosim-hz HZ]`
writes the co-simulation RTL and change list (§6.10). The Go CLI runs it with `node` (Node 24 is already
required for the web build).

### 6.5 The board layer: generated top, CCF and SDC

`pkg/board` turns a bundle into board files. The A1-EVB definition is Go data:

```go
type Pin struct {
	Name      string // "IO_SB_B6"
	ActiveLow bool
	Attrs     string // extra CCF attributes, e.g. "SCHMITT_TRIGGER=true"
}

type Resource struct {
	ID      string // "led:0"
	Dir     Dir    // In | Out
	Pin     *Pin   // nil: virtual (HIL-driven or tied inactive)
	Kind    string // led, button, switch, uart, clock
}

type Board struct {
	Name       string  // "gatemate-a1-evb"
	Device     string  // "CCGM1A1" (nextpnr --device)
	Loader     string  // "olimex_gatemateevb" (openFPGALoader -b)
	ClockPin   Pin     // IO_SB_A8, 10 MHz
	ClockHz    float64
	Resources  map[string]Resource
	SerialHint string  // "/dev/ttyACM0"
}

func (b *Board) Wrap(bn *bundle.Bundle, opt WrapOptions) (*Wrapped, error)

type Wrapped struct {
	TopModule string        // "weft_board_top"
	Files     []bundle.File // weft_board_top.v (+ library cores the bundle names)
	CCF, SDC  string
	Virtual   []string      // resources left to the HIL bridge or tied off
}
```

`Wrap` writes a top module in five parts:

1. **Clock.** `clk_10m` from `IO_SB_A8` feeds the main domain directly. Each other domain gets a `CC_PLL`
   output followed by a `CC_BUFG`, as in `/home/manuel/code/wesen/2026-08-30--uxn-computer/uxn/rtl/cc_pll_25.sv`.
   The parameters are strings: `REF_CLK("10.0")`, `OUT_CLK` set to the domain's *requested* MHz (the value
   the design asked for, which nextpnr's divider search starts from), and `PERF_MD("SPEED")`. SPEED matches
   the FPGA's default performance mode; `ECONOMY` (which `cc_pll_25.sv` uses) makes nextpnr warn "PERF_MD
   mode is 'ECONOMY' but FPGA performance mode is 'SPEED'" and changes the dividers it picks. The bundle's
   `hz` already holds the achieved value from `solvePll`'s GateMate branch (§6.3); the runner parses
   nextpnr's `PLL fout=` line and fails the build if the two disagree.
2. **Reset.** `CC_USR_RSTN` feeds a two-flop synchronizer per domain. The design's `rst` (synchronous, active
   high) is the synchronizer output. A PLL domain's synchronizer is also held in reset until that PLL's
   `USR_PLL_LOCKED` goes high, because the clock is not stable before lock (`cc_pll_25.sv` gates the same
   way). `WrapOptions.ButtonReset` can OR in the user button.
3. **Pins.** Each bundle port bit with a physical resource connects to a top-level pin port. Active-low
   resources are inverted at the pin, so the design always sees active-high levels. A bundle that binds both
   `btn:0` and `btn:user` is rejected, since both are IO_SB_B7.
4. **Virtual resources.** With `WrapOptions.HIL` set, virtual inputs come from `weft_hil` registers and design
   outputs are tapped by it (§6.10). Physical inputs then pass through a mux in the wrapper, so `weft_hil` can
   also override them; that is how a scenario's `press("btn:user")` runs on the board. Without HIL, virtual
   inputs are tied to 0, the inactive level, and physical inputs connect straight through.
5. **Constraints.** One CCF line per used pin and one SDC `create_clock` for the oscillator (100 ns). PLL
   outputs need no SDC line: this nextpnr has no `create_generated_clock` (the string is absent from the
   binary), and it does not need one, because the packer constrains each PLL output itself. A probe build
   logged `constraining clock net 'clk0' to 25.17 MHz` and then `Max frequency for clock 'gclk': … (PASS at
   25.18 MHz)`, the clock named after the `CC_BUFG` output net.

For F-01 the output is the spike's hand-written wrapper, now generated (only the LED port's name differs):

```verilog
module weft_board_top (input wire clk_10m, output wire led_0_n);
  wire usr_rstn;  CC_USR_RSTN u_usr_rstn (.USR_RSTN(usr_rstn));
  reg [1:0] rst_sys = 2'b11;
  always @(posedge clk_10m or negedge usr_rstn)
    if (!usr_rstn) rst_sys <= 2'b11; else rst_sys <= {rst_sys[0], 1'b0};
  wire [0:0] led;
  blinky u_design (.clk_sys(clk_10m), .rst(rst_sys[1]), .led(led));
  assign led_0_n = ~led[0];                     // led:0 is active-low on IO_SB_B6
endmodule
```

```text
Pin_in  "clk_10m" Loc = "IO_SB_A8" | SCHMITT_TRIGGER=true;
Pin_out "led_0_n" Loc = "IO_SB_B6";
```

### 6.6 Native cells: fixed cores plus generated adapters

The Lab's cells are transaction-level JavaScript models. For example, `uart-rx` enqueues whole bytes one frame
apart (`weft-lab/app/src/core/cells.js:134-169`). Hardware needs bit-level Verilog. Each emitted black box also
has port names derived from the design's stream names (`rx_bytes_valid`, `tx_bytes_ready`, …), so one fixed
Verilog file cannot match every design. The design therefore separates the two concerns:

- **Cores** (`hdl/cells/weft_core_<kind>.v`) are hand-written, reviewed once, and have fixed ports. For example:
  `weft_core_uart_tx #(CLK_HZ, BAUD) (clk, rst, s_valid, s_data[7:0], s_ready, tx)`.
- **Adapters** are generated per design by `verilog.js`, in place of today's black-box stubs. Each adapter has
  exactly the stub's interface and instantiates the core, wiring stream roles to core ports. The roles are
  already computable: `groupIO` in `cells.js:76-89` separates produced streams from consumed ones, and
  `verilog.js` will import it (today it does not import `cells.js`).

| Cell kind | Core | Status in this ticket |
| --- | --- | --- |
| `uart-tx` | `weft_core_uart_tx`: 8N1, divider `CLK_HZ/BAUD`, ready while idle | P7 |
| `uart-rx` | `weft_core_uart_rx`: 16x oversampling, mid-bit sampling, 1-deep holding register, `valid` until `ready` | P7 |
| `debounce` | `weft_core_debounce`: per-input counter for `settleMs`, event register `{id, long}`, `held` | P7 |
| `bridge-uart` | knob access over UART | later |
| `xfifo` | async FIFO (gray-coded pointers, 2-flop sync) | later, with multi-domain |
| `video-timing`, `hdmi`, `sigma-delta` | none | build error "not supported on gatemate-a1-evb" |

The core's `CLK_HZ` comes from the domain's `hz` in the bundle, and `BAUD` from the cell's `params.baud`.

Because the JavaScript models work at the transaction level, design-level co-simulation never compares a core
against a model cycle by cycle (§6.10 cuts the design at the cell boundary). Instead, each core gets its own
testbench in `hdl/cells/tb/`. The testbench feeds the core the same transactions the model would see and checks
the results at transaction level: the bytes that come out, and their timing within a stated tolerance. The
differences between core and model are written in the core's header and in the testbench:

- `uart-rx`: the model queues received bytes without limit (`cells.js:143-150`); the core holds one byte. A
  byte that arrives before the previous one is taken is lost in hardware.
- `uart-rx`: the model presents a byte a whole frame after it was sent; the core presents it after the stop
  bit's middle sample, about half a bit earlier.
- `uart-tx`: the model drops `ready` for exactly ten bit times; the core does the same, rounded to whole
  `CLK_HZ/BAUD` divider periods.
- `debounce`: the model measures `settleMs` in simulated picoseconds; the core counts clock cycles, so settling
  can differ by up to one cycle.

### 6.7 The toolchain runner

`pkg/toolchain` finds the suite (`--oss-cad-suite`, default `~/fpga/oss-cad-suite`). Instead of sourcing its
`environment` script, it sets `PATH` and the suite's library variables on each `exec.Cmd`. It runs one build
in a fresh directory:

```text
<work>/builds/<id>/
  bundle.json  rtl/*.v  board/weft_board_top.v  board/board.ccf  board/board.sdc
  synth.ys  yosys.log  top.json  nextpnr.log  top.txt  top.bit  report.json
```

| Step | Command | Success criteria | Parsed |
| --- | --- | --- | --- |
| synth | `yosys -ql yosys.log -s synth.ys` (reads all `.v`, `synth_gatemate -top weft_board_top -luttree -nomx8`, `stat`, `write_json top.json`) | exit 0, `top.json` exists | cell counts per `CC_*` type |
| pnr | `nextpnr-himbaechel -l nextpnr.log --device CCGM1A1 --json top.json -o ccf=board.ccf -o out=top.txt --sdc board.sdc --router router2 --seed N --timing-allow-fail` | exit 0 **and** no `^ERROR:` line other than a timing line **and** `top.txt` exists | `CPE_LT`, `CPE_FF`, `IOSEL`, `RAM` usage; last `Max frequency for clock 'X': F MHz (PASS/FAIL at T MHz)` per clock, which sets `timingOk` |
| pack | `gmpack top.txt top.bit` | runs whenever pnr succeeded, even with failed timing; exit 0, `top.bit` newer than `nextpnr.log` | size, sha256 |
| load | `openFPGALoader -b olimex_gatemateevb top.bit` | exit 0 and a `Done` line | JTAG frequency, duration |

`--timing-allow-fail` turns a timing failure from an error into a reported result. The runner reads the
`Max frequency for clock` lines and sets `timingOk` to whether every clock passes. If a timing line still
appears with an `ERROR:` prefix, the parser recognizes it by its text and counts it as timing. Any other
`^ERROR:` line is a hard failure: the build is not `ok`, and nothing is packed.

The synthesis script is a file, not `-p` on the command line, because past projects hit quoting problems with
`-D` string macros. The result is a `report.json`:

```json
{ "ok": true, "timingOk": true, "seed": 1, "stages": [{ "name": "synth", "ok": true, "ms": 290 }, …],
  "utilization": { "CPE_LT": [63, 40960], "CPE_FF": [25, 40960], "IOSEL": [2, 162] },
  "clocks": [{ "name": "u_design.clk_sys", "fmaxMHz": 90.86, "targetMHz": 10, "pass": true }],
  "bitstream": { "path": "top.bit", "bytes": 4172, "sha256": "cb1b…" } }
```

### 6.8 Jobs, the board lock and loading

`pkg/hw` keeps a small in-memory job table, persisted to `<work>/builds/<id>/job.json` so restarts can list old
builds. It enforces four rules:

- Builds may run in parallel, up to a CPU-sized limit (`--max-builds`, default 2).
- **One board operation at a time.** Loading, detection and the board session take one mutex. JTAG and the
  serial port are separate USB interfaces of the RP2040, so the lock does not exist for USB's sake. It exists
  because there is one board: a load replaces whatever design a session is watching, and only one process may
  own `/dev/ttyACM0`.
- **A board session loads its own bitstream.** It takes the lock, opens the serial port, loads the build, and
  then streams. Opening the port before loading is what lets it capture output from the first cycle (§4.4).
  While a session is open, `POST /api/hw/builds/{id}/load` returns `409` instead of waiting for the lock.
- A load refuses a build whose report is not `ok` (there is no bitstream). A build with `timingOk: false` has a
  bitstream; it loads only when the request sets `force`.

Each job publishes events to subscribers through a fan-out with a bounded per-subscriber buffer. A slow
browser tab loses old log lines but never blocks the toolchain.

### 6.9 How the Lab uses the backend

At startup the page calls `GET /api/hw/status`. A 404 or network error means it is running on claude.ai or
another plain host, and the Hardware tab stays hidden. The new **Hardware** tab joins `RIGHT` in
`weft-lab/app/src/ui/App.jsx:137` and shows:

- toolchain and board status (versions, `idcode`, serial port present);
- *Build*, *Build and load* and *Load* buttons, plus the seed;
- a live log for the running stage, with a stage list showing durations;
- an estimate-versus-real table: LUT/CPE counts, flip-flops, fmax per clock, timing pass or fail;
- the validation results per level, with links to logs and generated files.

`lab.js` gains a `hw` sub-object (`status`, `builds`, `current`, `build()`, `load()`, `validate()`, `job()`),
and the agent's `eval` scope gains the same object as `hw`. Three places in `lab-agent.js` change, or the
model will not know `hw` exists:

- `makeAgentScope` (line 364, in the "the scope" section that starts at line 328) adds `hw` to the scope
  object;
- the `eval` tool's description (line 249) adds `hw` to the scope names it lists;
- the system prompt's "In scope" list (line 151) describes `hw` in one or two sentences.

An `eval` call runs inside one `sample` round, and a call has at most 5 rounds and 5 minutes (§4.5). So
`hw.build()` never waits for the toolchain. It returns `{ id }` as soon as the job is queued, and the agent
then polls `hw.job(id)` for `{ state, stages, report }`, or waits briefly with
`await hw.job(id, { wait: "30s" })`, which returns the job as it is when the wait ends.

```js
const { id } = await hw.build({ load: true });
return await hw.job(id, { wait: "30s" });   // { state: "pnr", ... } or { state: "done", report }
```

### 6.10 Validation ladder

Each level gives stronger evidence than the one before and costs more. The Hardware tab and
`weft validate --levels` run any subset, always in order:

| Level | Question it answers | Mechanism | Needs |
| --- | --- | --- | --- |
| **L0 build** | Did synthesis, routing and timing succeed? | §6.7 criteria; fmax ≥ every clock; utilization < 100% | toolchain |
| **L1 rtl** | Does the emitted Verilog behave like the Lab's simulator? | iverilog runs the RTL of a co-simulation build against a change list recorded from `Sim` | iverilog (OSS CAD Suite) |
| **L2 net** | Did synthesis preserve behaviour? | the same change list against a separate synthesis of the design top (`synth_gatemate -noiopad -noclkbuf`) plus `cells_sim.v` | yosys, iverilog |
| **L3 board** | Does the board do what the scenario expects? | portable scenario steps on the real board through the UART | board, `/dev/ttyACM0` |

**Vectors (L1, L2).** Co-simulation compares the emitted Verilog with the simulator over a whole scenario. At
10 MHz that is too long: F-01's 1.1 s scenario is 11 million cycles, and its LED does not change before cycle
2.5 million, so a short window would compare a constant. `vectors(script, scenario, { cosimHz })` therefore
compiles a co-simulation variant of the design with `overrides: { "clock.sys": cosimHz }` (`compile.js:111-114`,
default 1 MHz). Every prescaler shrinks by the same factor (F-01's 250 ms tick becomes 250,000 cycles), and
the whole scenario runs. The L1 RTL is emitted from this same variant, so both sides share every divider. The
board build keeps the real clock.

`vectors` runs the scenario through `runScenario` with `waves: true` (`scenario.js:63-72`) and prepares the
simulator in `opts.onSim`. Two calls are needed there:

- `sim.waves.watch(ioPaths)` restricts recording to the signals being compared;
- raising `sim.waves.limit` stops trimming.

Waves record only changes. Once the total number of recorded changes passes the limit (default 200,000), the
oldest half of every long signal is thrown away (`sim.js:315-343`), so without these calls early history would
silently disappear on a busy design. `ioPaths` are the DAG paths of the pin `in` and `out` nodes
(`pin:led:0,led:1,…`), plus the cell-boundary nodes described below. With `regs: true` they also include every
register's path.

Quiescence skipping (`sim.js:4`, `825-848`) does no harm here. The simulator skips cycles only when an edge
changes nothing but prescaler counters, so a pin never changes inside a skipped stretch. A change recorded at
time t (in ps) belongs to cycle round(t / period). A signal's value in any cycle is its last recorded change.

The output is a change list: a header naming each port with its width, then one `<cycle> <port> <hex>` line per
change, starting with every port's value at cycle 0. The generated testbench applies each input change before
the rising edge of its cycle, checks outputs after that edge, and prints the first mismatch with its cycle and
port. With `regs: true`, registers are compared too. The emitter names a register by sanitizing its path
(`verilog.js:53-64`), so the testbench reaches it hierarchically (`u_sys.blink_led`). A mismatch then names the
first register that diverged, not just the first output.

Four rules keep the comparison sound:

- **Reset.** The simulator never resets: registers start at their initial values and step from the first edge
  (`sim.js:589`, `762`). The testbench matches that. It holds `rst` low from cycle 0 and relies on the
  `reg x = init` initializers, which iverilog honors. Memory reads and writes are not gated by `rst` in the
  RTL anyway (`verilog.js:187-197`).
- **Cells.** The JavaScript cell models work at the transaction level (§6.6), so comparing through a cell
  cycle by cycle would fail for reasons that are not bugs. The testbench cuts the design at the cell boundary.
  It instantiates the domain modules without the cells and drives each cell's outputs into the DAG (the cell's
  `drive` signals) from the change list. It compares each cell's inputs (its `read` signals, which leave the
  domain modules as `x_<id>` ports) against the change list. Each core is checked by its own testbench (§6.6).
  Pins driven only by a cell, such as `uart.tx` (no DAG node, `lower.js:684`), are therefore not compared at
  L1; L3 checks them.
- **One clock.** Cycles are counted in the main domain. A design with more than one clock domain is skipped at
  L1 and L2 with a named reason until P7 adds per-domain change lists.
- **L2 uses its own synthesis.** The board top's netlist cannot be co-simulated. Synthesis flattens it, and it
  contains `CC_USR_RSTN` and `CC_PLL`, which `cells_bb.v` declares as black boxes with no simulation model. L2
  therefore synthesizes only the design top, from the co-simulation RTL:
  `synth_gatemate -top <design> -noiopad -noclkbuf -luttree -nomx8`, then `write_verilog -noattr netlist.v`.
  Flattening is harmless here because the testbench touches only the design top's ports. `-noiopad` and
  `-noclkbuf` keep I/O and clock buffers out, so the netlist has the RTL's ports. The same testbench and
  change list then apply, with `cells_sim.v` added. A design with cells synthesizes its domain modules
  instead, so the cell-boundary cut still applies. The board-top primitives are simulated at no level.

**HIL bridge (L3 for pin-only designs).** The board has one LED, so most examples cannot be checked by looking at
it. When `WrapOptions.HIL` is set and the design does not use `uart.*`, the board top adds `weft_hil`. It is a
small UART device on the board's UART pins. It sends a line whenever a design output changes, and it accepts
lines that set the *HIL inputs*: every virtual input, plus the physical inputs the wrapper muxes (§6.5). Every
line from the board carries an 8-bit sequence number (hex, wrapping), so the host notices a lost line:

```text
board -> host   O 1a 00000002faf080 01\n   output change: sequence, 56-bit cycle count, output bits in bundle order (hex)
board -> host   H 1b 00000000c00000\n      heartbeat every 2^20 cycles (about 105 ms at 10 MHz); 0xc00000 = 12 x 2^20
board -> host   X 1c 0003\n                overflow: output changes lost since the previous line (saturates at ffff)
host  -> board  I 0005 0001\n              HIL input values, then the override mask for muxed physical inputs (hex, bundle order)
```

In the mask, a 1 lets the HIL value replace a physical pin and a 0 passes the pin through. Virtual inputs
always take the HIL value.

At 115,200 baud an `O` line of 23 bytes takes 2 ms, so the bridge can report about 500 output changes per
second. When its line buffer is full, it counts the changes it could not report and sends an `X` line as soon
as there is room. An `X` line or a gap in the sequence numbers fails the check with
`HIL overflow: N changes lost`, rather than letting it miscount toggles. Outputs that change faster than this
(F-03's PWM on `led:0`) cannot be checked by toggle counts.

The cycle count lets the host measure time on the board's own clock rather than through USB latency.
*Expect four toggles of `led:0` in 1.1 s* then means: count the `O` lines whose `led:0` bit changed between two
cycle counts 11,000,000 apart, with no sequence gap and no `X` line in between.

On the board, agreement with the simulator's initial state rests on `rst`, not on initializers. The board
top holds `rst` for two cycles after configuration, which puts every register at its init value whether or
not the GateMate flip-flops honor `INIT`. The board therefore runs two cycles behind the simulator, far below
anything a millisecond-scale L3 check can see.

**Portable scenarios (L3).** A new runner in `weft-lab/app/src/core/hwscenario.js` interprets the recorded
steps of a `kind: "steps"` scenario against a board client instead of a `Sim`. It runs in the page, and in Node
for `weft validate`. JavaScript predicates such as `n => n === 4` therefore stay in JavaScript. The supported
operations are `wait`, `press`, `release`, `toggle`, `set`, `uart`, `expectToggles`, `expectPins` and
`expectUart`. Any other step makes the scenario `skip` with the step named. Time comes from the HIL cycle
counts, so `wait("1.1s")` waits for 11,000,000 board cycles.

The client talks to a board session API (§6.12), and where that API lives depends on the caller:

- In the page, it is `weft serve`'s API.
- `weft validate` first checks whether `weft serve` answers on its `--listen` address. If it does, the Node
  runner uses serve's API, and serve's board lock keeps the two apart.
- If serve is not running, `weft validate` runs the board session in-process. It mounts the same `pkg/hw`
  handlers on an ephemeral loopback port for the length of the run and passes that URL to the Node runner.

### 6.11 The artifact host and sampler

`pkg/artifacthost` is a trimmed copy of francois's `pkg/host`, reduced to the single page `weft serve` hosts:

- `GET /` serves the embedded Lab page with the boot blob and the runtime script injected after `<head>`. The
  boot JSON is marshalled with Go's `json.Marshal`, which already escapes `<`, `>` and `&`. (Francois's hosted
  variant adds its own `ReplaceAll` for `<`, `francois/pkg/catalog/hosted/routes.go:187-188`, which changes
  nothing.) The boot blob carries `version: 1` for the one embedded page.
- `GET /static/runtime.js` serves francois's built shim, copied from `francois/pkg/web/static/runtime.js` at
  commit `d847ba4` with a provenance header and **one local patch**: the `downloads` extension allowlist
  (`ui/src/runtime-files.ts:2-6` in the source) gains `v`, `sv`, `js`, `ccf`, `sdc`, `vcd`, `bit` and `yaml`.
  Without it, the Lab's `.v` and `.js` saves fail with `rejected_extension` and the Lab shows
  "Download was declined" (§4.5).
- `POST /api/views`, `GET /api/views/{view}/events`, `POST /api/views/{view}/calls`,
  `POST /api/views/{view}/calls/{call}/cancel`, `POST /api/views/{view}/calls/{call}/tools/{tool}/result`
  and `POST /api/views/{view}/rpc` follow §4.5 exactly. `POST /api/views` accepts only `{version: 1}`. The
  manifest declares `sample` and `downloads`. `downloads` is browser-only in the shim, so `rpc` only answers
  `user`, which the shim offers whatever the manifest says.
- The limits are francois's: 5 minutes per `sample` call and at most 5 tool rounds (§4.5). The agent's `hw`
  object is designed around them (§6.9).
- The checks are francois's: the `Host` header must equal the listen address, `Origin` must match when present,
  and responses are `no-store`.

`pkg/sampler` copies `francois/pkg/piworker` (Backend, Request, Event, ToolResult, ValidateRequest, the NDJSON
worker client and Fake). `--sampler pi` runs francois's worker in place
(`--worker ~/code/wesen/go-go-golems/francois/worker/dist/main.js`, credentials from `~/.pi/agent`). The worker
must be built once in the francois checkout. Francois uses pnpm (`pnpm-lock.yaml`, `packageManager` in
`package.json`), so the commands are `pnpm install --frozen-lockfile` and then `pnpm build`, which writes
`worker/dist/main.js`. `--sampler fake` returns canned text for tests. `--sampler none` leaves `sample` out of
the manifest, so `use("sample")` returns null, and the agent panel then shows its built-in "not available"
message (`lab-agent.js:211-215`).

### 6.12 HTTP API reference (hardware)

All bodies are JSON. Errors use francois's envelope: `{"error": {"code": "...", "message": "..."}}`.

| Method and path | Body or query | Response |
| --- | --- | --- |
| `GET /api/hw/status` | | `{ toolchain: {ok, suite, versions: {yosys, nextpnr, gmpack, openFPGALoader, iverilog}}, board: {name, detected, idcode?, error?}, serial: {device, present}, busy: {board: bool, builds: n} }` |
| `POST /api/hw/builds` | `{ bundle, seed?, load?: bool, force?: bool, hil?: bool, validate?: ["rtl","net"] }` | `202 { id }` |
| `GET /api/hw/builds` | | `[{ id, design, state, createdAt, ok }]`, newest first |
| `GET /api/hw/builds/{id}` | | `{ id, design, state, stages: [{name, state, ms, exit?, summary?}], report?, validation?, files: [name] }` |
| `GET /api/hw/builds/{id}/events` | SSE | `{type:"state"}`, `{type:"stage", name, state, ms}`, `{type:"log", stage, line}`, `{type:"report", report}`, `{type:"validation", level, result}`, `{type:"done", ok}` |
| `GET /api/hw/builds/{id}/files/{name}` | | raw file (`top.bit`, logs, generated `.v`, `.ccf`, `.sdc`) |
| `POST /api/hw/builds/{id}/load` | `{ force?: bool }` | `202`; progress on the build's event stream. `409` while a board session is open; `force` is required when `timingOk` is false |
| `POST /api/hw/builds/{id}/validate` | `{ levels: [...], cosim?: { rtl, changes } }` (the output of `vectors()`) | `202`; results on the event stream |
| `POST /api/hw/board/session` | `{ build, force?: bool }` | `{ session, inputs: [...], outputs: [...], uart: bool }`; takes the board lock, opens the serial port, loads the build, then streams |
| `GET /api/hw/board/session/events` | SSE | `{type:"pins", seq, cycle, bits}`, `{type:"uart", text}`, `{type:"heartbeat", seq, cycle}`, `{type:"overflow", lost}` |
| `POST /api/hw/board/session/inputs` | `{ set: { "btn:1": 1 } }` | `{ ok }` |
| `POST /api/hw/board/session/uart` | `{ text }` | `{ ok }` |
| `DELETE /api/hw/board/session` | | `{ ok }`; releases the port and the lock |

### 6.13 CLI reference

Every command is a Glazed command. Structured results (`doctor`, `build`, `validate`) are GlazeCommands that
emit rows, so `--output json|yaml|table` works.

| Command | Purpose | Key flags |
| --- | --- | --- |
| `weft serve` | host the Lab, the artifact runtime and the hardware API | `--listen 127.0.0.1:8088`, `--work-dir var/weft`, `--oss-cad-suite`, `--sampler pi\|fake\|none`, `--worker`, `--pi-agent-dir`, `--serial /dev/ttyACM0`, `--max-builds` |
| `weft doctor` | one row per check: suite, versions, node, board detect, serial, worker | `--oss-cad-suite`, `--serial`, `--skip-board` |
| `weft emit` | Weft script to bundle JSON (runs the headless emitter) | `<script.js>`, `--board`, `--out` |
| `weft build` | script or bundle to bitstream; one row per stage | `<script.js\|bundle.json>`, `--seed`, `--load`, `--force`, `--hil`, `--work-dir` |
| `weft flash` | load an existing bitstream or build into SRAM | `<top.bit\|build-id>`, `--force` |
| `weft validate` | run validation levels; one row per level and check; uses `weft serve`'s board session when serve is running, else its own (§6.10) | `<script.js>`, `--scenario`, `--levels rtl,net,board`, `--cosim-hz`, `--listen` |

## 7. Decision records

### Decision D-1: Compile in JavaScript, build in Go, with a bundle between them

- **Context:** The Lab is about 14k lines of JavaScript in `app/src`, about 9.7k of them in the DOM-free core
  (compiler and simulator), and it already runs in the page and in Node. The toolchain and hardware access need
  a native process.
- **Options considered:** (a) port the compiler to Go; (b) have Go run Node on the script for every request;
  (c) the page or the CLI compiles, and sends Go a self-contained bundle.
- **Decision:** (c).
- **Rationale:** No duplicated compiler. The page already holds the exact `Compiled` the user is looking at. A
  bundle is inspectable, cacheable by hash, and testable on its own.
- **Consequences:** The bundle schema is a public contract. It needs a version tag (`weft.hw-bundle/v1`) and Go
  validation. The CLI depends on Node.
- **Status:** accepted.

### Decision D-2: The OSS flow, not Cologne Chip's `p_r`

- **Context:** GateMate has two place-and-route tools. The vendor's `p_r` is proprietary; `nextpnr-himbaechel`
  is open.
- **Options considered:** `p_r`; nextpnr-himbaechel plus gmpack.
- **Decision:** nextpnr-himbaechel with yosys `synth_gatemate` and gmpack, from the OSS CAD Suite already
  installed.
- **Rationale:** Every past project reached hardware with it (§4.4). It is installed, scriptable, and has
  parseable logs.
- **Consequences:** No vendor ILA. `-nomx8` is mandatory, and large designs route slowly (Uxn took hours at 66%).
- **Status:** accepted.

### Decision D-3: Go owns pins and polarity; JavaScript owns design facts

- **Context:** Both sides need to know about the board.
- **Options considered:** generate the wrapper and CCF in `verilog.js`; generate them in Go from the bundle.
- **Decision:** Go generates the board top, CCF and SDC. JavaScript only names resources and their bit
  positions.
- **Rationale:** Pin facts were the source of most past bring-up mistakes (button pin "took three attempts",
  inverted LED). They belong in one reviewed Go table with tests. The page then stays board-agnostic.
- **Consequences:** The JavaScript profile's pin strings are informational. A resource id must exist on both
  sides, which is checked when a bundle is accepted.
- **Status:** accepted.

### Decision D-4: Cell cores plus generated adapters

- **Context:** Black-box port names depend on stream names, and the JavaScript cell models are not bit-level.
- **Options considered:** generate whole cell implementations in JavaScript; fixed Verilog with fixed names;
  fixed cores plus generated adapters.
- **Decision:** fixed cores (`hdl/cells`) plus adapters generated by `verilog.js`.
- **Rationale:** The tricky logic (UART timing, debouncing) is written and reviewed once. The per-design part is
  pure wiring, which the emitter already has the information for.
- **Consequences:** Two places to change when a cell's interface changes. Co-simulation with cells compares
  against cores, not the JavaScript models.
- **Status:** accepted.

### Decision D-5: Copy francois's runtime shim and worker client

- **Context:** The agent needs `sample` with page-side tools, and francois implements exactly that.
- **Options considered:** import francois as a Go module; copy `pkg/piworker` and the built `runtime.js`;
  write a direct Anthropic backend.
- **Decision:** copy, with a provenance header naming commit `d847ba4`, behind our own `sampler.Backend`
  interface. The `runtime.js` copy carries exactly one patch: the `downloads` allowlist gains `v`, `sv`, `js`,
  `ccf`, `sdc`, `vcd`, `bit` and `yaml` (§6.11).
- **Rationale:** The module is not on the proxy (§4.5). A `replace` to a sibling checkout would make the build
  depend on a directory layout. Behind the interface, an Anthropic backend can still be added later.
- **Consequences:** The `pi` backend needs the francois checkout, its `node_modules` and a built
  `worker/dist/main.js` at runtime. The copied shim must be refreshed by hand when francois changes, and the
  allowlist patch re-applied each time.
- **Status:** accepted.

### Decision D-6: One origin, one page

- **Context:** Francois gives each artifact its own port, so localStorage stays isolated between artifacts.
- **Decision:** `weft serve` hosts one page at `/` on one port.
- **Rationale:** There is one artifact. The Lab keeps state in localStorage (saved designs, drafts), and a fixed
  origin keeps it across restarts.
- **Consequences:** Changing `--listen` changes the origin and so hides old localStorage. The serve help text
  says so.
- **Status:** accepted.

### Decision D-7: Load to SRAM by default

- **Decision:** `load` writes SRAM only. Writing flash is out of scope until it is known whether the board is
  the 2 MB-flash variant.
- **Rationale:** SRAM loading is reversible (a power cycle) and is what every past project did.
- **Status:** accepted.

### Decision D-8: The main domain runs from the 10 MHz oscillator

- **Context:** Examples written for `dev` assume 100 MHz, and those for `pico` assume 12 MHz.
- **Options considered:** a PLL to the example's original frequency; run the main domain at the board's
  10 MHz and let `compile` recompute prescalers.
- **Decision:** 10 MHz direct. Extra domains use `CC_PLL`.
- **Rationale:** Retargeting already recomputes every `.every()` divider, and every divisor a design computes
  from `clock.hz` (F-06's `DIV`), from the board clock (§4.1). Std UART cells take their divisor from the
  core's `CLK_HZ/BAUD` (§6.6). 10 MHz gives the most timing margin. Faster main clocks can come later as a
  profile option.
- **Consequences:** Designs that need a minimum clock speed (video) need their own domain, which matches how
  the examples are written anyway.
- **Status:** accepted.

### Decision D-9: Board-level validation through the board's UART

- **Context:** One user LED, one button, no logic analyzer, and JTAG is only used for configuration.
- **Options considered:** eyes on the LED; an external logic analyzer; a UART bridge inside the FPGA.
- **Decision:** the `weft_hil` UART bridge for pin-only designs, and the design's own UART for UART designs.
- **Rationale:** `/dev/ttyACM0` needs no wiring, past projects validated over it, and cycle-stamped reports
  measure time on the board's own clock.
- **Consequences:** HIL adds logic to the design under test (the bridge, and a mux on each overridable
  physical input), and a design that uses the UART cannot use HIL. The bridge reports about 500 output
  changes per second at most, and an overflow fails the check (§6.10). These limits are stated in the result.
- **Status:** accepted.

## 8. Pseudocode and key flows

### 8.1 Build from the Lab

```text
user clicks "Build and load"
page:   c = compile(lab.script, { board: "gatemate-a1-evb" })
        if !c.ok: show diagnostics; stop
        b = buildBundle(c, { file: preset.file, source: lab.script })   // refuses bare-part designs, zero pins
        POST /api/hw/builds { bundle: b, seed: 1, load: true }  ->  { id }
        open SSE /api/hw/builds/{id}/events; render stage list and log
server: job := hw.NewJob(bundle)                  // validates schema, resources, cells, btn:0 + btn:user
        go job.Run(ctx):
          w   := board.Gatemate.Wrap(bundle, {HIL: opt.hil})
          dir := writeTree(bundle.files, w.files, w.CCF, w.SDC, synthScript(w))
          r   := toolchain.Synth(dir)  ; emit stage events, tee log lines
          r   := toolchain.PnR(dir, seed)          // --timing-allow-fail
                 fail on exit != 0 or a non-timing ^ERROR:; timingOk from the Max frequency lines
          r   := toolchain.Pack(dir)               // always runs after a successful PnR
          job.report = parse(yosys.log, nextpnr.log, top.bit)
          if opt.load && job.report.ok && (job.report.timingOk || opt.force):
             if hw.sessionOpen(): emit load error 409; else
             hw.boardLock.Lock(); toolchain.Load(dir/top.bit); Unlock()
          emit {type:"done", ok}
```

### 8.2 One `sample` call with a tool round

```text
page                               weft serve                          worker (Node, Pi)
 |-- POST /api/views ----------------->| create view
 |-- GET  /api/views/v/events (SSE) -->| data: {"type":"ready"}
 |-- POST /calls {callId, input, tools}>| validate, queue, Backend.Sample -->| model call
 |<- data: {"type":"text", text} -------|<-------------------- text events --|
 |<- data: {"type":"tool", toolCallId,  |<---------------------- tool use ---|
 |         name:"eval", input:{code}}   |   execute() waits on a channel     |
 | run eval in the page                 |                                    |
 |-- POST /calls/c/tools/t/result ----->|-- tool_result -------------------->| next round
 |<- data: {"type":"result", result} ---|<----------------------- result ----|
```

### 8.3 L1 co-simulation

```text
out     = node weft-hw.mjs vectors F-01.js --scenario "blinks at 2 Hz" --cosim-hz 1e6
          # compiles with overrides {"clock.sys": 1e6}; onSim: waves.watch(ioPaths), waves.limit = Infinity
          # writes cosim/rtl/*.v (emitted from the same variant) and cosim/changes.txt:
          #   header: ports [name, dir, width]; then "<cycle> <port> <hex>" per change, cycle 0 first
          #   cycle = round(t_ps / period_ps); values hold until the next change
tb.v    = generateTestbench(top="blinky", changes)
          # rst = 0 from cycle 0 (reg initializers give the Sim's initial state)
          # each cycle: apply input changes, @(posedge clk), #1 compare outputs (and registers if --regs)
          # designs with cells: domain modules only; cell drive signals are inputs, cell read signals compared
iverilog -g2005 -o sim.vvp tb.v cosim/rtl/*.v && vvp sim.vvp
pass when the testbench prints "WEFT-COSIM PASS <cycles>"; else first "MISMATCH cycle=N port=P got=G want=W"
L2: yosys -p 'read_verilog cosim/rtl/*.v; synth_gatemate -top blinky -noiopad -noclkbuf -luttree -nomx8;
              write_verilog -noattr netlist.v'
    iverilog -g2005 tb.v netlist.v $(yosys-config --datdir)/gatemate/cells_sim.v   # same tb, same changes
    (no CC_USR_RSTN or CC_PLL: they belong to the board top, which is never simulated)
```

### 8.4 The HIL bridge in Verilog (sketch)

```verilog
module weft_hil #(parameter CLK_HZ = 10_000_000, BAUD = 115_200, NOUT = 1, NIN = 0, NOVR = 0) (
  input  wire clk, rst,
  input  wire [NOUT-1:0] outs,       // design outputs, bundle order
  output reg  [NIN-1:0]  vins,       // HIL input values: virtual inputs, then muxed physical inputs
  output reg  [NOVR-1:0] ovr,        // 1 = the wrapper's mux takes vins instead of the physical pin
  output wire tx, input wire rx);
  reg [55:0] cycle;  reg [NOUT-1:0] last;  reg [7:0] seq;  reg [15:0] lost;
  // on (outs != last) or heartbeat: format "O <seq> <cycle> <outs>\n" into a small line buffer;
  // buffer full: lost <= lost + 1 (saturating); next free slot: "X <seq> <lost>\n", lost <= 0
  // shift lines out with weft_core_uart_tx; parse "I <vins> <ovr>\n" with weft_core_uart_rx
endmodule
```

## 9. Implementation phases

Each phase ends with a commit and a diary step. The checks named are the exit criteria.

1. **P1, Go skeleton.** `go.mod`, the Glazed root, `weft serve` serving the embedded Lab page, `weft doctor`.
   The Makefile `web` target runs `weft-lab/app/build.mjs`, and `go generate ./pkg/web` copies
   `dist/index.html` in. Check: `weft doctor` lists suite versions and the board; the page loads from
   `weft serve`.
2. **P2, artifact runtime.** `pkg/artifacthost` and `pkg/sampler` (pi, fake, none). Check: a Go test drives
   view → call → tool → result with the fake backend; the Lab agent answers through the Pi worker.
3. **P3, GateMate profile and bundle.** Profile and part in `boards.js`, `PARTS` and the `gatemate` delay model
   in `estimate.js`, the `gatemate` branch of `solvePll`, `hardware.js`, and `tools/weft-hw.mjs`. Check:
   `node test/hardware.test.mjs`. Every example either bundles or fails with a named reason (F-13 and F-14 as
   bare-part designs), and F-01, F-02 and F-06 bundle.
4. **P4, board layer and toolchain.** `pkg/bundle`, `pkg/board/gatemate`, `pkg/toolchain`, and
   `weft emit|build|flash`. Check: golden-file tests for the wrapper, CCF and SDC; log-parser tests on real
   logs; `weft build F-01 --load` produces and loads a bitstream.
5. **P5, hardware API and Lab tab.** `pkg/hw` jobs, SSE and lock; the Hardware tab; `hw` in the agent scope
   (scope, tool description and system prompt, §6.9). Check: build and load from the browser, logs stream,
   the estimate-versus-real table fills, and the agent builds through `hw.build()` and `hw.job()`.
6. **P6, validation L0 to L2.** Change lists, testbench generation, iverilog runs, the separate L2 synthesis,
   and `weft validate`. Check: F-01 and F-02 pass L1 and L2 over their whole scenarios at the co-simulation
   clock, and a deliberately broken netlist fails with a named cycle and port.
7. **P7, cells and clocks.** UART and debounce cores, their own testbenches and adapters, and `CC_PLL` for
   extra domains. Check: each core's testbench passes; F-05 bundles and passes L1 with the debounce adapter;
   F-16 passes L1 with the cells cut out; F-16 echoes on the board once `/dev/ttyACM0` exists.
8. **P8, board-level validation.** `weft_hil` (sequence numbers, overflow, physical-input override), the board
   session API, and `hwscenario.js`. Check: F-01's "blinks at 2 Hz" passes on the board, measured in board
   cycles, and a scenario that presses `btn:user` passes through the override.

## 10. Test strategy

- **Go unit tests.**
  - Wrapper, CCF and SDC generation against golden files, one per case: pin-only, active-low, virtual,
    multi-bit, sparse (`led:3` only), HIL with a physical-input override, and two-domain with PLL lock.
  - Log parsers against the real logs saved from the spike and from later builds, including a timing-failed
    log (timing `FAIL` gives `timingOk: false` and a bitstream; any other `ERROR:` gives a failed build).
  - Bundle validation for missing resources, zero bound pins, `btn:0` together with `btn:user`, unsupported
    cells and a wrong schema tag.
  - The board lock: a load during an open session returns `409`.
  - The artifact host with the fake sampler.
- **Integration tests, gated by environment variables.** `WEFT_TOOLCHAIN=1 go test ./pkg/toolchain -run
  Integration` runs the real flow on F-01's bundle. `WEFT_HARDWARE=1` additionally loads it. CI and casual
  runs skip both.
- **JavaScript tests.** `node test/hardware.test.mjs` covers bundle shape for every example, port-to-resource
  mapping (including `led:7..0` and cell-owned pins), the refusal of bare-part designs, adapter text for each
  cell kind, and that change lists from `Sim` round-trip.
- **Core testbenches.** Each `hdl/cells/weft_core_*.v` has a testbench in `hdl/cells/tb/` that checks it
  against the JavaScript model at transaction level, with the documented differences (§6.6).
- **Cross-checks.** L1 and L2 are themselves tests of the emitter and of synthesis. Running them over every
  example that bundles is the broadest regression check we have.
- **Calibration.** Record nextpnr's fmax and `CPE_LT` next to the Lab estimate for each example in the diary,
  then fit the `gatemate` delay model to them.
- **Manual smoke playbook** (to be written in `playbooks/`): `weft doctor`, `weft serve`, then build F-01 from
  the page, watch the LED, and run L3.

## 11. Risks, alternatives and open questions

- **The serial ports are not available yet.** The `cdc_acm` module is not loaded, so `/dev/ttyACM*` does not
  exist (§4.4). L3 and the UART examples need `sudo modprobe cdc_acm`, made persistent through
  `/etc/modules-load.d/`. Everything up to and including loading works without it.
- **Sandboxed agents cannot reach USB.** In this session, `openFPGALoader --detect` only works outside the
  command sandbox. The server, run normally, is not affected.
- **Large designs route slowly.** Uxn needed hours at 66% utilization. Builds need a timeout (default 10
  minutes), and the UI must show that routing is still progressing.
- **Simulator and hardware semantics.** Registers have declared initial values in the emitted RTL (`reg x =
  init`) and are also reset by `rst`. The simulator never resets, so L1 holds `rst` low and relies on the
  initializers (§6.10). On the board, agreement rests on `rst`: the board top asserts it for two cycles after
  configuration, which sets every register whether or not GateMate honors `INIT`. Memory reads and writes are
  not gated by `rst` (`verilog.js:187-197`). A design that writes memory from its initial state therefore
  repeats that write during the two reset cycles, with the same address and data, which is harmless.
- **The page needs the network.** React loads from cdnjs (§3.4), so the Lab served by `weft serve` does not
  work offline.
- **Knobs** are tied to reset values in hardware until a `bridge-uart` core exists. F-12 behaves as if no
  knob is ever written.
- **Open: is the board the `-2M` variant with configuration flash?** This decides whether flash writing can
  be offered later.
- **Open: what is plugged into the PMOD header?** The profile maps `led:1..7` there, which is harmless
  without a module but only visible with one.
- **Open: which model backend?** The Pi worker reuses existing credentials. A direct Anthropic backend would
  remove the dependency on the francois checkout.
- **Alternative rejected: running scenarios on the board by translating them to Go.** Scenario predicates
  are JavaScript functions (`n => n === 4`), so the board runner stays in JavaScript (§6.10).

## 12. References

**Weft Lab (working copy, `weft-lab/`)**

- `ARCH.md`: contracts. §3 is the compiled shape, §5 the simulation semantics, "Contract changes" the extra
  fields.
- `app/src/core/compile.js:131-136, 353`: board override and `compile()`. `compile.js:61-85`: `solvePll`.
  `compile.js:111-114`: `clock.<domain>` overrides. `compile.js:130`: unknown-board message.
- `app/src/core/lower.js:684`: cell-owned pins. `lower.js:729-731`: `claimPin`. `lower.js:803, 926`: unbound
  ports on bare-part designs.
- `app/src/core/verilog.js:235-390`: emitter, top, cell stubs. `verilog.js:211-217`: `x_<id>` exports.
- `app/src/core/boards.js:7-124`: parts, profiles, resource expansion.
- `app/src/core/estimate.js:9-17, 32`: `PARTS` and `FAMILY`.
- `app/src/core/cells.js:76-196`: `groupIO`, debounce, `uart-rx` and `uart-tx` models.
- `app/src/core/sim.js:507`: `Sim`. `sim.js:315-343`: `Waves` and trimming. `sim.js:825-848`: quiescence
  skipping. `app/src/core/scenario.js:63-72`: `runScenario`. `app/src/core/passes.js:1516`: `traceGraph`.
- `app/src/main.jsx:6-15`, `app/src/ui/App.jsx:58-62`: capability use (`sample`, `downloads`).
- `app/src/agent/lab-agent.js:198-282`: agent loop (`sendCore` 198-236), the `eval` tool (`evalTool` 247-252)
  and `runEval` (254-282). `lab-agent.js:151`: system prompt scope list. `lab-agent.js:364`:
  `makeAgentScope`.
- `app/src/ui/lab.js:470-480`: `verilog()`. `app/src/ui/App.jsx:137`: right-hand tabs.
- `app/build.mjs`: page build (React from cdnjs at lines 58-59).

**Books (ticket `sources/local/`)**

- Book 1, chapter 16 "Targets and backends", lines 2280-2421: levels and targets, and one scenario on several
  levels.
- Book 2, chapter 13 "Mapping and back ends", lines 3811-4224.
- Recovered diagrams: `sources/local/diagrams/index.md`.

**GateMate evidence**

- `/home/manuel/code/wesen/2026-08-25--vm-cpu-gatemate/mate16/Makefile:62-78`: canonical flow.
- `/home/manuel/code/wesen/2026-08-28--pca-gatemate/pca_z80/constraints/olimex_gatematea1_evb.ccf`: pins.
- `/home/manuel/code/wesen/2026-08-30--uxn-computer/uxn/rtl/cc_pll_25.sv`: PLL instance.
- `/home/manuel/code/wesen/go-go-golems/go-go-parc/Research/2026/09/04/ARTICLE - Playbook - GateMate Board Evidence Workflow.md`:
  serial capture before loading.
- `/home/manuel/code/wesen/2026-09-04--gatemate-symbolic/pkg/microscope/serial.go`: Go serial pattern
  (`go.bug.st/serial`).

**francois** (`/home/manuel/code/wesen/go-go-golems/francois`, commit `d847ba4`)

- `pkg/host/routes.go`, `pkg/host/server.go`, `pkg/piworker/*.go`, `ui/src/runtime.ts`, `pkg/web/static/runtime.js`.
- `ui/src/runtime-files.ts:2-6`: the `downloads` extension allowlist we patch.
- `pkg/host/server.go:278, 289` and `worker/src/main.ts:233`: tool-round and call-time limits.
- The claude.ai sample spec copy:
  `ttmp/2026/10/11/FRANCOIS-001--host-claude-artifacts-with-glazed-and-pi-model-runtime/sources/Artifact Claude API (sample) — Spec.md`.

**This ticket**

- `scripts/01-spike-emit-verilog.mjs`, `scripts/02-spike-gatemate-flow/`: the spike.
- `diary/01-implementation-diary.md`: chronological record.
