---
Title: Board sessions and the HIL bridge
Slug: board-session
Short: "Drive a design's inputs and watch its outputs on the real A1-EVB, timed in board cycles, and run its scenarios there."
Topics:
- gatemate
- validation
- hil
Commands:
- build
- validate
- serve
IsTemplate: false
IsTopLevel: true
ShowPerDefault: true
SectionType: GeneralTopic
---

A *board session* holds the A1-EVB for one build: it loads the bitstream, opens the board's serial port,
and from then on the host can reset the design, set its inputs and read its outputs until the session
closes. `weft validate --levels board`, the Lab's **On the board** panel and the agent's `hw` methods all
work through a session. While a session is open no other load reaches the board: a load answers 409
`board_session`.

The A1-EVB has one LED and one button, so watching a design there needs help. A build made with `--hil`
(the **HIL** box in the Lab) therefore carries the *HIL bridge*, a small module on the board's UART that
reports every output change, stamped with the cycle it happened in, and takes commands that set inputs.

    weft build weft-lab/examples/F-05-buttons.js --hil --load
    weft validate weft-lab/examples/F-01-blinky.js --levels build,board

## Modes

A session takes one of three modes from its build:

| mode | when | what the host sees | time |
|------|------|--------------------|------|
| `hil` | the build carries the bridge | every bound output, every change; every bound input can be set | board cycles |
| `uart` | the design binds `uart.tx` / `uart.rx` itself | the bytes the design sends; the host can send bytes | the host's clock |
| `none` | neither | nothing: the session can only hold the board | — |

A design that uses the UART cannot have the bridge as well: `weft build --hil` refuses it with "HIL: the
design uses uart.tx". `weft validate` picks the bridge for every other design.

## What the bridge adds

The bridge (`hdl/hil/weft_hil.v`, built into `weft`) sits next to the design in the generated board top.

- **Outputs**: every bound output resource, in bundle order, tapped where the design drives the pin. Outputs
  of other clock domains go through a two-flop synchronizer into the main domain first.
- **Inputs**: every bound input resource. A physical input (`btn:user`, alias `btn:0`) passes through a
  multiplexer, so the host can take it over and give it back. Its pin keeps working while the host leaves
  it alone. A virtual input (`btn:1..3`, `sw:0..7`, which read 0 without the bridge) takes the host's
  value directly. Both pass the usual synchronizer in their domain.
- **Reset**: the host's reset holds the design's reset for 5 cycles, so a scenario starts from the same
  state as in the simulator.
- **Cost**: about 430 flip-flops and one `CC_BRAM_40K` for the report queue, plus `uart.tx` and `uart.rx`.

## The protocol

The bridge speaks text at 115200 baud, 8N1, one line per message. All fields are lower-case hex. `ss` is a
sequence number that wraps at 256, and `c…` is the 56-bit cycle count of the main clock since the last
reset.

| board → host | meaning |
|--------------|---------|
| `O ss c… oo…` | the outputs changed at cycle c; `oo…` is the new value of all outputs, output 0 in bit 0 |
| `H ss c…` | heartbeat, every 2^20 cycles (about 0.1 s at 10 MHz) |
| `A ss c…` | a command was applied at cycle c |
| `E ss c…` | a malformed command was ignored |
| `X ss llll` | `llll` output changes were lost (the queue was full); an `O` line with the current outputs follows |

| host → board | meaning |
|--------------|---------|
| `I <vins> <ovr>` | set the input values; `ovr` selects which physical inputs take the host's value instead of their pin |
| `W <mask>` | report only the outputs in mask |
| `R` | reset: inputs and overrides cleared, the design reset, the cycle count restarted; `A` at cycle 0, then an `O` line |
| `T` | answer with an `A` line carrying the current cycle |

All lines leave through one queue (512 entries) in cycle order. A line stamped with cycle c therefore
proves that every change up to c has already arrived, which is how the host waits for a cycle: it sends
`T` and reads up to its `A`. At most one line enters the queue per cycle. If two outputs change in two
consecutive cycles, both are reported. A design that changes outputs faster than 115200 baud can carry them
(roughly one `O` line per 2 ms with eight outputs) for longer than the queue absorbs loses changes. The
bridge says so with an `X` line, and the session counts them as `lost`.

`ttmp/2026/10/18/WEFT-001…/scripts/08-hil-probe.py` talks to the bridge directly, which is handy when the
session API is in doubt.

## Scenarios on the board

The board runs a scenario's recorded steps. Each scenario starts with `R`, so the design begins at cycle 0
from its reset state.

- `wait("1.1s")` waits for 11,000,000 board cycles at 10 MHz, not for 1.1 s of the host's time.
- `press`, `release`, `toggle` and `set` send an `I` command. The input changes at the cycle the bridge
  acknowledges, a millisecond or two after the step because of USB. A press of 100 ms holds for 100 ms of
  board cycles from that acknowledgement. A `bounce` option is ignored: each input change is one command,
  with no chatter.
- `expectPins` and `expectToggles` read the output history the bridge reported. With `within`, they pass
  if the value is right at any change up to that much later. Toggle counts start at the reset.
- Any lost change or sequence gap fails the scenario, since counts could otherwise be wrong.
- Steps that reach into the design (`poke`, `force`, `knob`, …) have no board equivalent: the scenario is
  skipped with the step named, as in co-simulation.

In `uart` mode only `wait`, `uart` and `expectUart` run. Time is the host's clock, so each `expectUart` gets
25 ms on top of its `within` for the trip over USB.

## The API

`weft serve` mounts the session under `/api/hw/board/session`. `weft validate` uses serve's API when serve
answers on `--listen`, so the Lab and the CLI never fight over the board, and otherwise mounts the same
handlers in-process.

| route | does |
|-------|------|
| `POST /api/hw/board/session` `{build, force?}` | load the build and open the session; 409 `session_open`, `board_busy`, `needs_force` (failed timing) or `no_bitstream` |
| `GET /api/hw/board/session` | the session (`null` when none is open): mode, inputs, outputs, state |
| `DELETE /api/hw/board/session` | close it and free the board |
| `GET …/events` | server-sent events: `session` first, then `pins`, `heartbeat`, `overflow`, `gap`, `reset`, `uart`, `closed` |
| `POST …/reset` | send `R`; answers the state at cycle 0 (`epoch` counts resets) |
| `POST …/inputs` `{set: {"btn:1": 1, "btn:0": null}}` | set inputs; `null` gives a physical input back to its pin; answers the acknowledged cycle |
| `POST …/wait` `{cycle, epoch, since, timeout?}` | wait until the board passes `cycle`; answers the changes after cursor `since` |
| `POST …/uart` `{text}`, `GET …/uart?since=&wait=` | `uart` mode: send bytes, read what the design sent |

An input that the design does not bind answers 400 `not_input`. A bridge that stops answering (no `A`
within 2 s) answers 502 `board`. A request that needs the other mode answers 409 `mode`.

## From the Lab

The Hardware tab's **HIL** box builds with the bridge. Under **On the board**, *Open session* loads the
build and shows a cell per output and a button per input. A physical input shows `pin` until the host takes
it over, and ↩ gives it back. A note keeps the cycle and the number of changes since the reset. *Run
scenarios on board* runs the editor's scenarios in a session, reusing the open one when it is on the same
build, and fills a table with each result in board cycles. A `uart` session shows the design's output and a
line to send.

The agent has `hw.openSession()`, `hw.session()`, `hw.setInputs({...})`, `hw.resetBoard()`,
`hw.sendUart(text)`, `hw.runOnBoard()` and `hw.closeSession()`. In read-only mode it keeps `hw.session()`
only.
