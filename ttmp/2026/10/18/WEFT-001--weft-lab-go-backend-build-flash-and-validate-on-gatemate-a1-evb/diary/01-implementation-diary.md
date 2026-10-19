---
Title: Implementation diary
Ticket: WEFT-001
Status: active
Topics:
    - weft
    - fpga
    - gatemate
    - backend
    - go
    - toolchain
DocType: diary
Intent: long-term
Owners: []
RelatedFiles:
    - Path: repo://hdl/hdl.go
      Note: embedded cell cores
    - Path: repo://pkg/hw/validate.go
      Note: validation inside hardware jobs
    - Path: repo://pkg/validate/testbench.go
      Note: testbench generation for L1/L2
    - Path: repo://ttmp/2026/10/18/WEFT-001--weft-lab-go-backend-build-flash-and-validate-on-gatemate-a1-evb/scripts/07-uart-echo.py
      Note: board UART echo check for F-16
ExternalSources: []
Summary: ""
LastUpdated: 2026-10-18T18:09:36.261047227-04:00
WhatFor: ""
WhenToUse: ""
---

# Implementation diary

This diary records the WEFT-001 work chronologically: importing the Weft Lab artifact and its two books,
researching the GateMate toolchain and the francois artifact host, writing the intern guide, and building the
Go backend that serves the Lab and builds, flashes and validates designs on the GateMate A1-EVB.

## Step 1: Locate the artifacts, import the source and both books, confirm the baseline

The session started as a question about which artifacts Claude could reach and ended with the Weft Lab source
tree and its two specification books stored in the ticket's `sources/`. The ChatGPT link was a dead end; the
real material was the claude.ai artifact "Weft Lab" (an 843 KB single-page app) plus two Claude Docs documents
in the same project. The user then supplied the source as a zip, asked for a docmgr ticket, an intern guide
uploaded to reMarkable, and an implementation with commits and a detailed diary.

The imported source passes its own test suites unchanged, which fixes the starting point: the compiler,
simulator, scenarios and formal checks all work in Node before any backend work starts.

### Prompt Context

**User prompt (verbatim):** "get the source and the dwo big documents. the source is in ~/Downloads/weft-lab-src.zip ."

**User prompt (verbatim, sent while that turn ran):** "import them into this repo. Create a docmgr ticket, and import the files into the sources/ folder of the docmgr ticket. Then I want to actually build a go backend serving the app that can then properly compile and upload and validate on my gatematea1-evb (if you look in ~/code/wesen/go-go-golems/go-go-parc you can see past projects with the gatemate which are also here in source, maybe that can help you get started too). 

Create  a detailed analysis / design / implementation guide that is for a new intern, explaining all the parts of the system needed to understand what it is, with prose paragraphs and bullet point sand pseudocode and diagrams and api references and file references. It should be very clear and technical. Store in the ticket and the nupload to remarkable.

Then implement, step by step, commit at appropriate intervals and keep a detailed diary as you work (using the diary format from the skill)"

**User prompt (verbatim, follow-up):** "import original src and the docs is what i meant, btw. and you can work on the src and further modify it ofc too, we don't have to start from scratch. Use go glazed framework for the go side, and you can look at ~/code/wesen/go-go-golems/francois for how to host claude artifacts and provide them the proper APIs for the coding agent and such"

**Assistant interpretation:** Store the pristine zip, the extracted source and both books in the ticket's
`sources/`; evolve a working copy of the source in the repository; design and then build a Glazed-based Go
server that hosts the Lab (with the artifact runtime APIs the in-page agent needs) and drives the GateMate
toolchain to synthesize, place, route, program and validate designs on the user's A1-EVB.

**Inferred user intent:** Turn a browser-only FPGA teaching lab (whose "build" is an estimate) into a tool that
produces real bitstreams on real hardware, with documentation good enough for a new intern to own it.

### What I did

- Read the artifact `https://claude.ai/artifact/QVBkfqq36p3cAEGhf7PnF5` with the Artifact tool: it is
  "Weft Lab", owned by the user, 843,036 bytes, built by `app/build.mjs`.
- Found the two books in the artifact list ("Weft, From First Principles", "Building Weft: Implementation and
  Reference"). Both are Claude Docs documents, so they were read with the Docs connector, not the Artifact tool.
- Exported each book as Markdown through `mcp__claude_ai_Claude_Docs__export`. The inline result was too
  large for the tool channel; the harness saved it to `tool-results/`, and a 10-line decoder
  (base64 → bytes, length check against the reported `bytes`) wrote the files. Book 1: 248,642 bytes, 3,037
  lines. Book 2: 397,824 bytes, 5,200 lines.
- The export replaced 8 embedded widget diagrams with placeholders. A sub-agent paged the outline of each doc,
  found every `<embed ref='node/…'>`, read each widget node and saved its JSX source unchanged to
  `sources/local/diagrams/` with an `index.md` mapping file, caption, node id and placeholder line.
- Created the ticket and imported the material:
  ```bash
  docmgr ticket create-ticket --ticket WEFT-001 --title "Weft Lab Go backend: build, flash and validate on GateMate A1-EVB" --topics weft,fpga,gatemate,backend,go,toolchain
  docmgr import file --ticket WEFT-001 --file ~/Downloads/weft-lab-src.zip --name "Weft Lab source (zip as exported from the artifact build)"
  docmgr import file --ticket WEFT-001 --file docs/weft-from-first-principles.md --name "Book 1: Weft, From First Principles (Claude Docs export)"
  docmgr import file --ticket WEFT-001 --file docs/building-weft.md --name "Book 2: Building Weft: Implementation and Reference (Claude Docs export)"
  ```
  and extracted the zip to `sources/weft-lab/` (80 files, 2.2 MB; every entry under `weft-lab/`, no absolute
  or `..` paths — checked with `unzip -Z1 | grep -E '(^/|\.\./)'` before extracting).
- Copied `sources/weft-lab` to `weft-lab/` at the repository root as the working copy, ran `npm ci` in
  `weft-lab/app` (the zip has no `node_modules`), and ran every test suite.

### Why

- `sources/` keeps the original bytes for reference and diffing; the repository copy is what we change. The
  user confirmed this split ("import original src and the docs … you can work on the src and further modify it").
- Markdown export rather than paging the outline: one call per book, byte-exact, and greppable.

### What worked

- Baseline test run in `weft-lab/app` (Node v24.18.0):
  ```
  types        exit=0 types ok
  ir           exit=0 ir ok
  compile      exit=0 all examples compile as expected
  sim          exit=0 sim ok
  cells        exit=0 cells ok
  passes       exit=0 18/18 passed
  formal       exit=0 formal ok
  scenarios    exit=0 28 scenarios: 26 pass, 0 fail, 2 skip, 0 threw
  ```
  The two skips are the scenarios that need Claude (F-18 "closes timing", F-19 "the mechanic on call").

### What didn't work

- `docs read` of the artifact id `QVBkfqq36p3cAEGhf7PnF5` was refused with `{"verdict":"deny","reason":"access"}`:
  the Lab is a plain HTML artifact, not a doc. The Artifact tool's `read` worked.
- The first decoder run failed on Book 2 with `json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)`:
  that saved result is a JSON array whose first element is a provenance notice, not the payload. Fixed by
  selecting the element whose text starts with `{`.
- Text search for a widget caption returned `hits='0'`: captions are not searchable text, which is why the
  diagrams were recovered by paging the outline.

### What I learned

- The Lab's "build" today is entirely estimated (`report.estimated === true`, ARCH.md §7). Real hardware needs
  everything after `emitVerilog`.
- `verilog.js` already writes Verilog-2005: one module per clock domain plus a top. Clocks are top-level
  inputs (no PLL), `rst` is a synchronous active-high input, knobs are tied to their reset values, and std cells
  (`uart-rx`, `uart-tx`, `debounce`, …) are `(* blackbox *)` stubs (`weft-lab/app/src/core/verilog.js:235-390`).
- The in-page architect agent needs `window.claude.use("sample")` with page-side tool execution
  (`weft-lab/app/src/agent/lab-agent.js:198-240`), which is exactly what francois provides.

### What was tricky to build

- Large connector results: the Docs export returns the file inline as base64. Anything above the tool output
  limit is spilled to a file by the harness, so the decoding has to happen from disk and must verify the byte
  count, or a truncated spill would pass silently.

### What warrants a second pair of eyes

- The diagrams in `sources/local/diagrams/` are the widgets' JSX as stored. They use the Docs renderer's
  `var(--cds-…)` colour tokens, and `book1-03` uses `claude.Visualize`, so they do not render standalone.

### What should be done in the future

- N/A for this step.

### Code review instructions

- `ttmp/.../WEFT-001-.../sources/` (pristine), `weft-lab/` (working copy). Re-run the baseline with
  `cd weft-lab/app && for t in types ir compile sim cells passes formal scenarios; do node test/$t.test.mjs; done`.

### Technical details

- Artifact ids: Weft Lab `be31a437-1760-42c7-aba7-4d705f1e9094`; Book 1 doc `e0dfff0e-faaa-46d1-b633-a9e924396aba`
  (tab body `93b3adf5-2b32`, rev 80); Book 2 doc `9491a9dc-ac0e-48e7-80a1-25ce0ebf067d` (tab body
  `be60bacc-3585`, rev 96).

## Step 2: Prove the GateMate flow end to end, then write the intern guide

Before designing anything I wanted proof that a Verilog file emitted by the unmodified Weft compiler can become
a bitstream on this machine's OSS CAD Suite and load into the A1-EVB. Two spike scripts did that for F-01
(blinky): `scripts/01-spike-emit-verilog.mjs` runs `compile()` + `emitVerilog()` headless in Node, and
`scripts/02-spike-gatemate-flow/run.sh` wraps the result in a hand-written board top (`weft_board_top.v`),
then runs yosys → nextpnr-himbaechel → gmpack → openFPGALoader. The bitstream loaded into SRAM.

With the flow proven, I wrote the intern guide
(`design-doc/01-weft-lab-on-real-hardware-intern-guide-to-the-go-backend-gatemate-toolchain-and-validation.md`)
and handed it to a reviewer agent to check every file:line claim and the technical soundness. The review came
back with 17 findings (below); the same agent is applying them while implementation continues.

### Prompt Context

**User prompt (verbatim):** see Step 1.
**Assistant interpretation:** De-risk the hardware path first, then document the whole system for an intern.
**Inferred user intent:** A guide grounded in a flow that demonstrably works, not a paper design.
**Commit (code):** none yet for the spike scripts and guide (committed with the guide once review fixes land).

### What I did
- `scripts/01-spike-emit-verilog.mjs`: imports `weft-lab/app/src/core`, compiles F-01 retargeted, writes the
  per-domain modules + top from `emitVerilog(compiled)` (verilog.js:235).
- `scripts/02-spike-gatemate-flow/`: `weft_board_top.v` (10 MHz `IO_SB_A8` clock, `CC_USR_RSTN` + 2-flop
  reset sync, active-low LED inversion), `board.ccf`, `board.sdc`, `run.sh`.
- Read the past GateMate projects in go-go-parc and their sources (mate16 Makefile, uxn `cc_pll_25.sv`) for
  pin names, polarity, `-nomx8`, PLL usage and the openFPGALoader board name.
- Wrote the guide: system overview, Weft IR levels, Verilog emission contract, the `weft.hw-bundle/v1` JSON
  contract, GateMate profile, toolchain runner, board session, validation ladder L0–L3, artifact host, HTTP
  API and CLI tables, decision records D-1..D-9, phases P1–P8, risks.
- Spawned a background reviewer agent to verify line references and soundness.

### Why
- The highest risk was the hardware path (toolchain flags, pins, polarity, bitstream loading), so it went first.
- A reviewer with fresh context catches claims I made from memory of the code rather than from the code.

### What worked
- yosys `synth_gatemate -top weft_board_top -luttree -nomx8`: 0.29 s; 22 CC_ADDF, 25 CC_DFF, 27 CC_LUT2, 8 CC_L2T4.
- nextpnr-himbaechel `--device CCGM1A1`: 3.8 s; CPE_LT 63/40960, CPE_FF 25/40960, IOSEL 2/162; fmax 90.86 MHz,
  PASS at 10 MHz.
- `gmpack` → `top.bit` 4,172 bytes, sha256 `cb1bbe49b717a84747f7ed5d3cd9ad5c108b2ac8efb03f22cd5c801ab6b9c1a6`.
- `openFPGALoader -b olimex_gatemateevb top.bit`: "Load SRAM 100% Done", exit 0.

### What didn't work
- The LED was not visually confirmed: F-01's prescaler assumes the board clock it was written for, so on the
  10 MHz clock the toggle period differs; nobody was watching the board. Load success is the evidence here.
- `/dev/ttyACM*` does not exist: the `cdc_acm` module is installed but not loaded. UART-based validation
  (P7/P8) needs `sudo modprobe cdc_acm` from the user.
- USB access (JTAG) needs the sandbox disabled for the command in this session.

### What I learned
- nextpnr exits 0 even when timing fails; the flow must parse the log and check the bitstream's freshness.
- `-nomx8` is mandatory for this nextpnr; without it placement fails on CC_MX8.
- The review's main corrections (all being applied to the guide):
  - L1/L2 vectors from a 200k-cycle window would never see F-01/F-02 toggle: use change lists over a whole
    scenario, compiled with a short `clock.sys` override.
  - The Sim never resets, so the testbench must release `rst` at cycle 0, not hold it for two cycles.
  - Cell-driven pins have no DAG node; co-simulation must cut at the cell boundary.
  - `synth_gatemate` flattens, and `CC_USR_RSTN`/`CC_PLL` have no simulation models: L2 synthesizes the design
    top alone with `-noiopad -noclkbuf`.
  - Gating pnr on any `^ERROR:` would make `force` load nothing: use `--timing-allow-fail` and parse timing.
  - This nextpnr has no `create_generated_clock`; `solvePll` uses MMCM math for GateMate and needs a branch.
  - The francois runtime.js downloads allowlist lacks `v` and `js`, so the Lab's "save Verilog" would fail.
  - A board session must own the lock and do the load itself (capture before load).

### What was tricky to build
- Retargeting: `compile(script, {board})` (compile.js:131-136) silently drops unbound outputs and frees
  unbound inputs, so a bare-part design builds "successfully" into nothing. The bundle builder must refuse
  designs that had no `board`/`targets` in their source.

### What warrants a second pair of eyes
- Reset strategy: the board top holds `rst` through `CC_USR_RSTN` + sync; equivalence with the simulator relies
  on `rst` reaching every register's init value, not on GateMate honouring `INIT` attributes.

### What should be done in the future
- Visual LED check once a design with a known 10 MHz period is built (P4).

### Code review instructions
- `bash scripts/02-spike-gatemate-flow/run.sh` (needs the board; run outside the sandbox).

### Technical details
- Flow: `yosys -p "read_verilog ...; synth_gatemate -top weft_board_top -luttree -nomx8; write_json top.json"`
  → `nextpnr-himbaechel --device CCGM1A1 --json top.json -o ccf=board.ccf -o out=top.txt --sdc board.sdc
  --router router2 --seed 1` → `gmpack top.txt top.bit` → `openFPGALoader -b olimex_gatemateevb top.bit`.

## Step 3: P1 — the weft binary: Glazed root, serve the embedded Lab, doctor

P1 gives the project a Go module and a `weft` binary built the way the user's other Glazed tools are (francois
as the template): a cobra root with the Glazed logging section and embedded help, `weft serve` hosting the Lab
page on a loopback origin, and `weft doctor` reporting one row per prerequisite. Doctor found the board over
JTAG on the first real run.

### Prompt Context

**User prompt (verbatim):** see Step 1 ("Use go glazed framework for the go side").
**Assistant interpretation:** Build the Go side with Glazed commands, following francois's layout.
**Inferred user intent:** A tool consistent with the user's other Go CLIs (help system, structured output).
**Commit (code):** 92600d2 — "P1: weft Go skeleton (Glazed root, serve embedded Lab, doctor)"

### What I did
- `go.mod` (`github.com/wesen/2026-10-18--weft`, go 1.26.3, toolchain go1.26.9); Glazed pinned to the same
  pseudo-version francois uses (`v1.4.4-0.20260823170018-a7fdfda5e3c6`).
- `cmd/weft/main.go`: root with `logging.AddLoggingSectionToRootCommand`, `help.NewHelpSystem`,
  `doc.AddDocToHelpSystem`, `help_cmd.SetupCobraRootCommand`; errors rendered once as `weft: <err>`.
- `cmd/weft/cmds/register.go`: builds every command before mounting; shared flags `suiteFlag`, `boardFlag`,
  `serialFlag`.
- `cmd/weft/cmds/serve.go` (BareCommand) and `doctor.go` (GlazeCommand, rows `check, ok, detail`).
- `pkg/toolchain/suite.go` (Suite: env with bin/ + py3bin/ on PATH, tool versions), `loader.go`
  (`openFPGALoader --detect` parser + error classification).
- `pkg/web/web.go`: `//go:generate` builds the Lab with `weft-lab/app/build.mjs` and copies it to
  `static/lab.html` (gitignored); `//go:embed static`; `--lab-file` override.
- `pkg/server/server.go`: refuses non-loopback `--listen`; Host must equal the listen address; Origin must
  match; `Cache-Control: no-store`; error envelope `{"error":{"code","message"}}`.
- `pkg/doc/topics/01-getting-started.md`; `Makefile` (web, build, test, js-test, lint incl. glazed-lint).
- Tests: `pkg/server/server_test.go` (loopback, Host/Origin guard), `pkg/toolchain/loader_test.go` (detect
  output captured from the real board).

### Why
- Embedding the built page keeps `weft serve` a single binary; `--lab-file` keeps the edit loop short.
- Doctor as a GlazeCommand gives `--format json` for scripts and CI for free.

### What worked
- `make test`, `make lint` (go vet + glazed-lint) clean; `make js-test` passes (133 s, formal tests dominate).
- `weft doctor` (sandbox disabled for USB):
  `board | true | colognechip GateMate Series GM1Ax (idcode 0x20000001)`; yosys 0.68+130,
  nextpnr-0.11.1-9-gb17408e2, openFPGALoader v1.1.1, iverilog 14.0 (devel), node v24.18.0;
  `serial | false | /dev/ttyACM0 does not exist: load the CDC driver with sudo modprobe cdc_acm`.
- `weft serve`: `GET /` 200 (842,672 bytes), runtime.js 200, rebound Host → 403 `forbidden_host`,
  foreign Origin → 403 `forbidden_origin`, `--listen 0.0.0.0:8088` refused.

### What didn't work
- `node --test test/` in `weft-lab/app` failed with `✖ test (34.516385ms) 'test failed'` (Node 24 treats the
  directory argument as a file); fixed with `node --test test/*.test.mjs`.
- The nextpnr version regex first returned the program name ("nextpnr-himbaechel") because the output starts
  with `"nextpnr-himbaechel" -- Next Generation Place and Route (Version nextpnr-0.11.1-9-gb17408e2)`; fixed
  with a capture group on `Version (nextpnr-...)`.
- My smoke script's `pkill -f 'weft serve --listen ...'` also matched the shell running it and killed it
  mid-script; later runs stop the server with `kill -INT $(pgrep -x weft)`.

### What I learned
- francois is not on the Go module proxy (`go list -m github.com/go-go-golems/francois@latest` → no matching
  versions), so its code is copied, with provenance noted in package comments.

### What was tricky to build
- Nothing beyond the failures above.

### What warrants a second pair of eyes
- `server.New` accepts `localhost:<port>`; the Host check is then literal (`localhost:<port>`), so opening
  `127.0.0.1:<port>` would be refused. Intentional (one origin), but surprising.

### What should be done in the future
- `boardFlag` is defined but unused until P4 (emit/build/flash).

### Code review instructions
- Start at `cmd/weft/cmds/register.go`, then `serve.go`, `doctor.go`, `pkg/server/server.go`.
- `make web build test lint && ./bin/weft doctor --skip-board`.

### Technical details
- Doctor rows: oss-cad-suite, yosys, nextpnr-himbaechel, openFPGALoader, iverilog, gmpack, node, lab page,
  board (`openFPGALoader -b olimex_gatemateevb --detect`), serial.

## Step 4: P2 — the artifact runtime host, so the Lab's agent works outside claude.ai

The Lab calls `window.claude.use("sample")` for its architect agent and `use("downloads")` to save files. P2
reproduces those two capabilities locally by porting francois's host to a single artifact: the page is served
with francois's `runtime.js` and a boot block injected after `<head>`; the runtime opens a view, holds an SSE
stream, and posts model calls that a sampler backend answers. With the real Pi worker the agent ran an `eval`
in the page and answered correctly in 4.2 s.

### Prompt Context

**User prompt (verbatim):** see Step 1 ("look at ~/code/wesen/go-go-golems/francois for how to host claude
artifacts and provide them the proper APIs for the coding agent and such").
**Assistant interpretation:** Serve the Lab with a working `window.claude` (sample with page tools, downloads).
**Inferred user intent:** The Lab's agent should work against the local server like it does on claude.ai.
**Commit (code):** 67bfc56 — "P2: artifact runtime host and sampler for the Lab's agent"

### What I did
- `pkg/sampler`: copied francois `pkg/piworker` (backend.go, client.go, validate.go, client_test.go) at
  d847ba4; new `fake.go` with a weft `Fake` (its eval reads `editor.get()`) and a `None` backend.
- `pkg/artifacthost/host.go`: `New`, `Register(mux)`, `Inject`, views/SSE, `sample` with admission
  (2 running, 10 queued), 5-minute call timeout, page-tool round trips (150 s each), cancel, tool results
  (≤ 32 KiB), `rpc` answering `not_declared`, `Broadcast` for later hardware events.
- `cmd/weft/cmds/serve.go`: `--sampler pi|fake|none` (pi falls back to none with a warning), `--worker`
  (default francois `worker/dist/main.js`), `--pi-agent-dir`, `--model-quick/default/complex`.
- `pkg/web/static/runtime.js`: downloads allowlist gains `v sv js ccf sdc vcd bit yaml` (review finding 11).
- `pkg/artifacthost/host_test.go`: injection, sample + eval tool round trip, sampling_disabled, view header.

### Why
- One artifact and two capabilities: the Lab declares nothing else, so db/rooms/assets/comments stay out.
- Degrading to `None` keeps the Lab usable when Pi is not configured.

### What worked
- `go test ./pkg/artifacthost -race` passes.
- Real worker: `Pi worker ready models=49`; `/api/models` lists lunaroute glm-5.3 for all three tiers plus
  anthropic models.
- Playwright on `http://127.0.0.1:18088/`: `window.claude.use("sample")` → function, `use("downloads")` →
  object. Agent tab, Read-only mode, prompt "Use one eval to count the lines of the current script
  (editor.get()), then answer in one sentence." → "Worked through 1 step · 4.2 s — The current script is 202
  lines long."
- Downloads with `confirm` stubbed to false: `top.v` → `declined`, `design.js` → `declined`, `x.exe` →
  `rejected_extension` (the allowlist patch works and still refuses programs).

### What didn't work
- No failures in this step. The only console error is `/favicon.ico` 404.

### What I learned
- Go's `json.Marshal` escapes `<`, `>` and `&`, so the boot block cannot terminate its `<script>` early.
- `use("user")` returns a capability whether or not it is declared (runtime-side), harmless here.

### What was tricky to build
- Terminal events: a call must emit exactly one `result` or `error`. `run` tracks `settled`; when the backend
  returns without settling, it emits an error, using the backend's `*sampler.Failure` code when there is one
  (so `None` surfaces `sampling_disabled` instead of `upstream_error`).

### What warrants a second pair of eyes
- `View.emit` closes a view whose 128-event buffer is full rather than blocking; a slow tab loses its stream
  and reconnects (runtime.js retries every second).
- Calls are bounded at 5 minutes and the worker at 5 tool rounds: P5's `hw.build()` must return a job id
  rather than block inside one eval.

### What should be done in the future
- Favicon route (cosmetic).

### Code review instructions
- `pkg/artifacthost/host.go` (`sample`, `run`, `toolResult`), then `cmd/weft/cmds/serve.go` `startSampler`.
- `go test ./pkg/... -race`; `./bin/weft serve --sampler fake` and send a message from the Agent tab.

### Technical details
- Endpoints: `GET /`, `GET /static/runtime.js`, `GET /api/models`, `POST /api/views` (`{version:1}`),
  `GET /api/views/{view}/events`, `POST /api/views/{view}/calls`, `POST …/calls/{call}/cancel`,
  `POST …/calls/{call}/tools/{tool}/result`, `POST …/rpc`. Header `X-Francois-View` on every view call.

## Step 5: P3 — GateMate profile, the nextpnr PLL port, and hardware bundles

P3 teaches the JavaScript side about the real board and defines what it hands to Go. The `gatemate-a1-evb`
profile and `ccgm1a1` part make every example compile against the 10 MHz board clock; `hardware.js` turns a
compiled design into a `weft.hw-bundle/v1` JSON document or refuses with a named reason; `tools/weft-hw.mjs`
exposes that to Go. The surprise was the PLL: instead of modelling `CC_PLL`, I ported nextpnr's own divider
search after probe builds showed its choices depend on mode and divider limits, and the port now reproduces
nextpnr's "PLL fout=" for every frequency I probed.

In parallel the reviewer agent applied its 17 findings to the guide; I added the PLL findings, committed the
guide (4ebd83f) and uploaded it to reMarkable.

### Prompt Context

**User prompt (verbatim):** see Step 1.
**Assistant interpretation:** Phase P3 of the guide: profile, part, delay model, PLL branch, bundle, CLI.
**Inferred user intent:** Designs from the Lab become buildable inputs for the GateMate flow.
**Commit (code):** afea73a — "P3: GateMate profile, nextpnr PLL port, hardware bundles"; guide 4ebd83f.

### What I did
- `boards.js`: `ccgm1a1` in `PART_DATA` (+ `partData` prefix), `BOARDS["gatemate-a1-evb"]` with physical
  `led:0`, `btn:user`/`btn:0`, UART, PMOD LEDs `led:1..7`, and virtual `btn:1..3`, `sw:0..7`; `btn` group.
- `estimate.js`: `ccgm1a1` in `PARTS`, `FAMILY.gatemate` (k 4, lut 0.9 ns, route 1.2 ns, carry 0.28 ns/bit:
  a first guess from one nextpnr run, to calibrate in P4).
- `gatemate-pll.js`: port of `GateMatePacker::get_pll_settings` for internal feedback, `PDIV0_MUX = 1`, low
  jitter; `compile.js` `solvePll` calls it for `family === "gatemate"`; unknown-board message lists `BOARDS`.
- `verilog.js`: `pinParts` exported so the bundle and `emitTop` share one mapping.
- `hardware.js`: `buildBundle`, `HwError`, `CELL_CORES` (empty until P7), `PORTABLE_STEPS`.
- `tools/weft-hw.mjs bundle <script> [--board] [--out]`: exit 2 with `{"error":{code,message,details}}`.
- `test/hardware.test.mjs`: 9 tests (PLL table, solvePll, compile, refusals, port mapping, all examples).
- `scripts/03-pll-probe/run.sh`: the nextpnr probe, kept as evidence.

### Why
- A port is exact by construction; a model would drift wherever the simulator and the board disagree, and
  UART baud dividers computed from `CLK_HZ` would carry that error onto the wire.
- Bare-part is checked before compile errors because a retargeted bare-part design's errors (F-13's checks
  against a part without DSPs) follow from the retargeting, not from the design.

### What worked
- Probe (yosys + nextpnr-himbaechel, REF_CLK 10.0, SPEED): 1.0→1.0000, 7.3728→7.3718, 12→12, 24→24,
  25.175→25.2083, 33.333→33.3333, 37.5→37.5, 48→48, 50→50, 66→65.8333, 100→100, 125→125, 133→132.5 MHz;
  ECONOMY 25.175→25.2778. The JS port matches all 14 to four decimals (2–200 ms per solve).
- nextpnr constrains PLL outputs itself: `constraining clock net 'clk0' to 25.17 MHz`, then
  `Max frequency for clock 'gclk': 281.29 MHz (PASS at 25.18 MHz)`, so PLL domains need no SDC line.
- Bundles: F-01, F-02, F-04, F-06 bundle. Refusals: F-03 compile (its intentional capture error), F-05 and
  F-16 cells (debounce, uart-rx/tx until P7), F-07/F-09/F-15/F-18 no-pins, F-08/F-10/F-12/F-17/F-19 compile
  (resources the board lacks: audio, hdmi, btn:up), F-11/F-13/F-14 bare-part.
- `node --test test/*.test.mjs`: 17 files pass (121 s); `make web` builds the page (826 KB).

### What didn't work
- First probe build used `PERF_MD("ECONOMY")` (copied from uxn's `cc_pll_25.sv`) and nextpnr warned
  `Warning: PLL 'pll' PERF_MD mode is 'ECONOMY' but FPGA performance mode is 'SPEED'.` and gave 25.2778 MHz;
  my port (SPEED) said 25.2083 and looked wrong until a SPEED probe confirmed 25.2083. The board top uses SPEED.
- In the guide I first wrote that nextpnr "does not pick the closest frequency"; checking the divider grid by
  hand showed 121/24 and 91/18 are the closest reachable values in their modes, so I corrected the text.
- My estimate.js edit closed the `FAMILY` object before the new entry:
  `SyntaxError: Unexpected token ':'` at estimate.js:59; removed the stray `};`.
- Two test mistakes: `$.a = $.a + 1` on a u2 is a Weft compile error (`u3 does not fit in u2`), fixed with
  `wrap()`; F-01 compiled without a board override targets `pico`, a valid board, so the "no board" case now
  uses F-11.

### What I learned
- `compiled.domains[d]` holds only `{hz, graph}`; clock kind, pin and PLL settings live in `compiled.clocks`.
- `compiled.report.part` is the whole part record, not a name.

### What was tricky to build
- The PLL search's floating-point tolerance walk (`f_core_delta += stepsize` from 0, stepsize from the
  requested value's fourth-decimal formatting) must be reproduced exactly, or a different (N1, N2, M1, M2)
  wins a tie and the frequency changes.

### What warrants a second pair of eyes
- `gatemate-pll.js` carries nextpnr's permission notice (ISC-style); check it satisfies the license.
- The gatemate delay constants are guesses; the Lab's fmax for GateMate is not trustworthy until P4 calibrates.

### What should be done in the future
- P4's runner must parse `PLL fout=` and fail when it disagrees with the bundle's `hz`.
- P7 adds cores and adapters to `CELL_CORES` so F-05 and F-16 bundle.

### Code review instructions
- `weft-lab/app/src/core/hardware.js` (`buildBundle`, `portsOf`), `gatemate-pll.js`, `boards.js` profile.
- `cd weft-lab/app && node --test test/hardware.test.mjs`;
  `node tools/weft-hw.mjs bundle ../examples/F-01-blinky.js | head -40`.

### Technical details
- GateMate CC_PLL (SPEED): DCO = 10 MHz × PDIV1 × N1 × N2 in (1250, 2500] MHz; out = DCO / (2·PDIV1·M1·M2),
  M1·M2 even or 1, out ≤ 416.75 MHz.

## Step 6: P4 — board layer, toolchain runner, weft emit/build/flash

P4 is the first time a Weft script reaches the FPGA from this repository. `weft build F-01-blinky.js --load`
emits a bundle with the embedded compiler, wraps it in a generated board top, runs yosys, nextpnr and gmpack
into `var/weft/builds/<id>/`, and loads the bitstream over JTAG in about 4 seconds. The build report is
computed from the tool logs rather than from exit codes, because nextpnr's exit code depends on whether
`--timing-allow-fail` is set and says nothing about PLL frequencies.

The design choices that matter for later phases: the board wrapper owns everything board-specific (reset,
PLLs, polarity, synchronizers, virtual resources), so the emitted design stays the one the simulator ran;
and a timing failure still produces a bitstream but refuses to load without `--force`.

### Prompt Context

**User prompt (verbatim):** see Step 1.
**Assistant interpretation:** Phase P4 of the guide: bundle types, board wrapper, toolchain runner, CLI.
**Inferred user intent:** Designs from the Lab build and load on the A1-EVB from the command line.
**Commit (code):** b4f6dec — "P4: board layer, toolchain runner, weft emit/build/flash"

### What I did
- `pkg/bundle`: Go types for `weft.hw-bundle/v1` and `Validate` (Verilog identifiers, flat unique `.v`
  paths with exactly one top, one main clock, synchronous active-high reset, ≥1 port, bits within width).
- `pkg/board`: `Board`/`Resource`/`Pin`, `Lookup`, `PinPort`, `Wrap` → `weft_board_top.v`, CCF, SDC.
  `gatemate.go` registers the A1-EVB: `led:0` IO_SB_B6 and `btn:user`=`btn:0` IO_SB_B7 (both active-low),
  `led:1..7` on PMOD, UART on IO_SA_B6/IO_SA_A6, `btn:1..3` and `sw:0..7` virtual.
- Wrapper: `rst_req = ~usr_rstn | ~<pll>_locked… | ~button` into a 2-flop reset released on `clk_10m`;
  one `CC_PLL` (`PERF_MD("SPEED")`, `OUT_CLK` = the domain's requested MHz) plus `CC_BUFG` per PLL domain;
  2-flop synchronizers on physical inputs in their domain; virtual inputs tied to 0 with a comment; two
  resources on one pin are refused. Golden files for F-01 and F-02 (`go test ./pkg/board -update`).
- `pkg/toolchain/logparse.go`: per-clock `Max frequency` (last line wins), `PLL fout=`, utilization,
  non-timing `ERROR:` lines, "Program finished normally"; `ParseYosysStat` for CC_* counts. Fixtures are
  real logs with home paths scrubbed.
- `pkg/toolchain/build.go`: `Suite.Build` writes `rtl/`, `board/`, `synth.ys`, `bundle.json`, runs
  synth → pnr → pack with each stage's output streamed to `<stage>.log`, checks `top.txt` exists and
  `top.bit` is not older than `pnr.log`, compares every PLL's `fout` to the compiler's `hz` (1e-4 MHz), writes `report.json`.
  `Suite.Load` runs openFPGALoader and requires its "Done" line.
- `pkg/emitter`: esbuild bundles `tools/weft-hw.mjs` (go:generate) into `pkg/emitter/js/weft-hw.mjs`
  (gitignored, embedded); `Emit` runs it with Node and maps exit 2 to a typed `*Error`.
- `pkg/hw`: build ids (`20261018-185817-blinky-5e56`), `RunBuild`, `OpenBuild` (id or directory),
  `Loadable`/`Load` with `ErrNeedsForce`.
- Commands: `weft emit` (bare), `weft build [--load] [--seed] [--button-reset] [--verbose]` (one row per
  stage), `weft flash <bit|id|dir> [--force]`; help topic `build-and-flash`; `doctor` uses the board's loader.
- Ticket `scripts/04-designs/two-clocks.js` (sys + 25.175 MHz `pix`) and `too-fast.js` (400 MHz `pix`).

### Why
- Logs over exit codes: `--timing-allow-fail` turns a timing failure into a warning with exit 0; without it
  the same failure is an `ERROR:` with exit 1. Either way the useful facts (fmax per clock, PLL fout) are only
  in the log, so the runner always passes `--timing-allow-fail` and decides from the parsed log.
- Bitstream-but-refuse for timing failures: a design at 400 MHz is a mistake, but a design that misses by 5 %
  may be worth trying; the refusal message names the exact `weft flash <id> --force` command.
- Virtual resources tie to 0 instead of failing, so every example that reads `sw:0` still runs on a board
  without switches; the report lists them under `virtual` so nobody is surprised.

### What worked
- Board detected: `weft doctor` → colognechip GateMate Series GM1Ax, idcode 0x20000001.
- `weft build weft-lab/examples/F-01-blinky.js --load`: synth 218 ms, pnr 3387 ms, pack 8 ms; CPE_LT 63/40960,
  CPE_FF 25/40960, IOSEL 2/162; `u_design.clk_sys` 87.46 MHz (PASS at 10 MHz); 4,413-byte bitstream;
  openFPGALoader "Load SRAM via JTAG: 100% Done".
- two-clocks: `clk_pix` 83.03 MHz (PASS at 25.18), `clk_sys` 94.38 MHz; PLL check model 25.20833 vs fout
  25.2083 MHz → ok; PLL 1/4 used.
- too-fast: `clk_pix` 90.59 MHz (FAIL at 400 MHz), report `ok: true, timingOk: false`; `--load` refused with
  exit 1; `weft flash <id> --force` loads it.
- Estimate vs nextpnr fmax (the Lab's `FAMILY.gatemate` guesses from P3):

  | Example | estimate MHz | nextpnr MHz | CPE_LT |
  |---|---|---|---|
  | F-01 blinky | 102.5 | 87.46 | 63 |
  | F-02 counter | 108.7 | 103.25 | 91 |
  | F-04 breathing | 66.0 | 79.81 | 369 |
  | F-06 hello-uart | 51.7 | 63.69 | 351 |

  All within ±20 %, errors in both directions; not worth refitting four constants on four points.
- `GOWORK=off go test ./...` passes, including `TestBuildBlinky` against the real toolchain (3.5 s);
  `make lint` (glazed-lint + vet) clean.

### What didn't work
- I had believed nextpnr exits 0 on a timing failure. Strict mode (no `--timing-allow-fail`) prints
  `ERROR: Max frequency for clock 'u_design.clk_pix': 90.59 MHz (FAIL at 400.00 MHz)` and exits 1, which my
  first parser counted as a toolchain error. The timing regex now accepts `Info|Warning|ERROR` and runs first;
  both log variants are fixtures.
- `c.Port[len("clk_"):]` in the wrapper could panic on a port not named `clk_*`; the clock-net map now
  stores the port name itself.
- Unused `os/exec` import in `build.go` after moving process handling into `step()`.
- Glazed does not close the processor when `RunIntoGlazeProcessor` returns an error, so the stage table is
  not printed for a refused `--load`. I kept that contract (errors must reach the root) and put the
  actionable command in the error text, with stage progress already on stderr.

### What I learned
- nextpnr-himbaechel constrains PLL output nets from `OUT_CLK` itself; the SDC only needs the 10 MHz input.
- nextpnr writes `top.txt` even when strict timing fails, so "file exists" is not a success signal; the
  runner decides from the parsed log, and refuses a `top.bit` older than `pnr.log`.

### What was tricky to build
- The reset: `CC_USR_RSTN` is low during configuration, PLL `locked` comes later, and the user button is
  active-low and asynchronous. ORing all three requests and synchronizing the release on the always-running
  `clk_10m` gives one `rst` for every domain; domains clocked by a PLL see reset held until lock.

### What warrants a second pair of eyes
- The reset is released on `clk_10m` but consumed in PLL domains; release is synchronous to the wrong clock
  for those domains. Fine for one cycle of slop at today's rates; P6's netlist sim should cover it.
- `checkPLLs` matches PLL lines to domains by requested MHz; two domains requesting the same frequency
  would both match the first line (harmless, same answer, but untidy).

### What should be done in the future
- P5 wraps `hw.RunBuild`/`Load` in a job table with SSE and a board lock.
- Refit `FAMILY.gatemate` once P6/P7 add bigger designs (UART cores, BRAM).

### Code review instructions
- Start at `pkg/board/board.go` (`Wrap`, `top`) and `testdata/F-02-counter.top.v`, then
  `pkg/toolchain/build.go` (`Build`, `checkPLLs`) and `logparse.go`.
- `GOWORK=off go test ./pkg/... -count=1`; with the board attached:
  `./bin/weft build weft-lab/examples/F-01-blinky.js --load` (needs USB access).

### Technical details
- nextpnr: `nextpnr-himbaechel --device CCGM1A1 --json synth.json -o pins=board/top.ccf
  -o out=top.txt --sdc board/top.sdc --router router2 --seed N --timing-allow-fail`.
- Build directory: `bundle.json rtl/*.v board/{weft_board_top.v,top.ccf,top.sdc} synth.ys synth.json
  synth.log pnr.log top.txt top.bit pack.log report.json [load.log]`.

## Step 7: P5 — hardware API, the Hardware tab, and `hw` for the agent

P5 moves the P4 flow behind `weft serve`, so the Lab and its agent can use the board. The server keeps a job
table (bounded build concurrency, one board mutex, a per-job event fan-out, `job.json` on disk), exposes it
under `/api/hw/`, and the page grows a Hardware tab that only appears when that API answers. The agent gets
the same capabilities as an `hw` object in its eval scope.

All three paths were exercised on the board: Build and load from the browser, a timing-failed build that
skips its load until "Load anyway", and the agent building F-02 on its own through `hw.build()` and
`hw.job(id, { wait })`.

### Prompt Context

**User prompt (verbatim):** see Step 1.
**Assistant interpretation:** Phase P5 of the guide (§6.8, §6.9, §6.12): jobs, SSE, lock, API, tab, agent scope.
**Inferred user intent:** Build and load from the Lab itself, and let the Lab's agent do the same.
**Commit (code):** e5acc8c — "P5: hardware API, the Lab's Hardware tab, hw in the agent scope"

### What I did
- `pkg/hw/build.go`: split `prepare` (wrap, id, directory) out of `RunBuild` so the API can return an id
  before the toolchain runs; wrap errors become `*hw.Refusal` (HTTP 422 `refused`).
- `pkg/hw/jobs.go`: `Manager` (`Submit`, `Load`, `Job`, `Jobs`, `SetSession`, `Close`) and `Job` (`View`,
  `Wait`, `Subscribe`, `Files`). Builds wait on a semaphore of `--max-builds`; loads hold `boardMu`; while
  `session` is set a load is refused with `ErrBoardSession`. Job state is the running stage's name, then
  `done`/`failed`/`interrupted`. `job.json` is written at submit and finish; on start the manager lists
  every directory under `builds/`, from `job.json` or, for CLI builds, `report.json`.
- Events: `snapshot` (the whole job, then the last 500 log lines), `state`, `stage`, `log`, `report`, `done`.
  A subscriber has a 1024-event buffer; log lines that do not fit are dropped, any other event that does not
  fit closes the stream, and the browser's EventSource reconnects to a fresh snapshot.
- `pkg/hw/status.go`: tool versions asked once; `openFPGALoader --detect` at most every 10 s, only when
  `boardMu.TryLock()` succeeds (never during a load); serial device presence.
- `pkg/hw/http.go`: the §6.12 routes except validate and the board session (P6/P8); `hil`/`validate` in a
  build request answer 501. `GET builds/{id}?wait=30s` long-polls (capped at 60 s), which is what the
  agent uses instead of SSE. Files are served from the build directory with path checks.
- `pkg/hw/jobs_test.go`: a fake OSS CAD Suite whose `bin/` scripts replay the real yosys/nextpnr log
  fixtures, driven over `httptest`: build+load, the SSE stream, timing failure → `needs_force` →
  `board_session` → forced load, busy, refusals, restart.
- `weft serve`: `--max-builds` (default 2); a missing suite only refuses builds.
- Lab: `src/ui/hw.js` (API client, one EventSource for the shown build, `agentHw()` for the agent),
  `src/ui/Hardware.jsx`, the tab in `App.jsx` (probed at startup), CSS in `weft.css`.
- `lab-agent.js`: `hw` in `makeAgentScope`, in the eval tool's description, and (only when the backend
  answers) in the system prompt's scope list, including "never load without the user asking for it".
  Read-only mode refuses `hw.load` and `hw.build({ load: true })`.
- Help topic `build-and-flash`: a "From the Lab" section.

### Why
- Long-poll for the agent, SSE for the page: an eval runs inside one `sample` round with at most 5 rounds,
  so the agent needs one request that returns either the result or the current state; the tab wants every
  log line as it comes.
- Drop logs but close on anything else: a lost log line costs nothing, a lost `done` leaves the page
  spinning forever. Closing forces a reconnect, and the snapshot repairs whatever was lost.
- Stage views from `report.json`: the toolchain emits a stage's `done` before the runner has written its
  summary, and the runner can still fail a stage afterwards (nextpnr ERROR lines, PLL mismatch).

### What worked
- `GET /api/hw/status`: suite 20260825 with all five versions; board detected (`0x20000001`); `/dev/ttyACM0`
  absent (the tab says `sudo modprobe cdc_acm`).
- Browser, F-01 *Build and load*: synth 237 ms, pnr 3.5 s, pack 9 ms (4,413 bytes), load 26 ms;
  `load.log` ends `100.00%` / `Done`. Toast "blinky is on the board".
- Browser, T-02 (400 MHz `pix`): `clk_pix` 90.59 MHz FAIL at 400; load stage `skipped` ("this build failed
  timing; load it anyway with force"); *Load anyway* → loaded in 38 ms, error cleared.
- Agent (Pi worker, Balanced): 4 evals in 22.8 s: `hw.bundle()`, `report()` + `hw.build({ load: false })`,
  `hw.job("20261018-191542-counter-5dba", { wait: "30s" })`, `chat.table(...)`; it reported CPE_LT 91 vs
  58 estimated, CPE_FF 31 vs 31, fmax 103.25 vs 108.7 MHz, and did not load.
- Restarting the server restores every build, including the load stage and seed.
- `go test ./... -count=1` (race-clean for `pkg/hw`), `make lint`, `make js-test` (17 files) pass.

### What didn't work
- First browser build: the stage table had no summaries (pnr's utilization/fmax line was missing) because
  the job took stage views only from the tools' events. Fixed by replacing them from `report.Stages` and
  the load result; the API test now asserts the pnr, pack and load summaries.
- CLI builds showed "seed 0": the seed came from `job.json`, which `weft build` does not write. It now comes
  from `report.json`.
- `serve.go` failed to compile: `syntax error: unexpected name weft in argument list` — I had put
  backticks inside the command's raw-string long help.
- I first mapped refusals to a `board.Refusal` type that does not exist; `hw.Refusal` wraps every
  `Wrap`/`Lookup` error instead (they are all refusals).
- `gofmt -l` flagged `status.go`: a blank line left in the import block by a sed cleanup.

### What I learned
- Loading SRAM is fast: 26–38 ms for 4–13 KB bitstreams at 6 MHz JTAG. Detection (~0.3 s) costs more than a
  load.
- The comparison table shows the GateMate LUT estimate is consistently low: blinky 37 vs 63 CPE_LT, counter
  58 vs 91, toofast 81 vs 131 (×1.6–1.7), while FFs are within 10 %. A LUT scale factor for
  `FAMILY.gatemate` is a cheap fix once P6/P7 add bigger designs.

### What was tricky to build
- Snapshot ordering: `Subscribe` builds the snapshot and registers the subscriber under the job mutex, and
  every publish happens under the same mutex, so no event can fall between the snapshot and the stream.

### What warrants a second pair of eyes
- `Status` holds its cache mutex while detection runs (bounded by openFPGALoader's 30 s timeout), so a hung
  cable would stall concurrent status calls.
- The agent's `hw.build()` is allowed in Read-only mode (it writes only `var/weft/builds`); only loads are
  refused. Check that this matches the Read-only promise in the system prompt.
- `nextpnr`'s GPIO count includes the clock pin, so the IO row's Δ is labelled rather than corrected.

### What should be done in the future
- P6: `POST builds/{id}/validate` and validation events; P8: the board session uses `SetSession`.

### Code review instructions
- `pkg/hw/jobs.go` (`run`, `Load`, `load`, `Subscribe`, `publishLocked`, `setReport`), `pkg/hw/http.go`
  (`failWith`), then `weft-lab/app/src/ui/hw.js` and `Hardware.jsx`.
- `GOWORK=off go test ./pkg/hw -race -short`; with the board: `./bin/weft serve`, open
  http://127.0.0.1:8088/, load F-01, Hardware tab, *Build and load*.

### Technical details
- API errors: 404 `not_found`, 409 `busy` | `needs_force` | `no_bitstream` | `board_session`, 422
  `bad_bundle` | `refused`, 501 `unsupported` (hil/validate), 503 `no_toolchain`.

## Step 8: P6 — the validation ladder L0–L2: vectors, testbenches, `weft validate`, Validate in the Lab

P6 checks that what goes to the board behaves like what the Lab simulated. The page (or `weft-hw.mjs
vectors` for the CLI) runs every scenario on the simulator and records each change of the design's
top-level ports. Go turns those recordings into a Verilog testbench per scenario and replays it against the
emitted RTL (L1, iverilog) and against a GateMate netlist of that RTL with the vendor cell models (L2). L0
is the build itself: a bitstream, timing met, nothing over capacity.

The exit criteria hold. F-01 and F-02 pass L1 and L2 over whole scenarios (1.1 M and 650 k cycles), and a
deliberately broken netlist fails at the expected cycle and port: "cycle 250001: led is 0, the simulator
drove 1". The browser's Validate button ran F-02 end to end: build pass, rtl 3.3 s, net 39.9 s, and the poke
scenario was skipped with its reason.

### Prompt Context

**User prompt (verbatim):** see Step 1. Mid-phase the user added: "I modprobed cdc_acm, we should be good".
**Assistant interpretation:** Phase P6 of the guide (§6.10, §8.3): L0–L2 in the CLI, the job API, the tab and the agent.
**Inferred user intent:** Trust a design on the board because the toolchain's output provably matches the simulator.
**Commit (code):** 93f5da0 — "P6: validation ladder L0-L2, weft validate, Validate in the Lab"

### What I did
- `weft-lab/app/src/core/vectors.js`: `vectors(script, { file, board, cosimHz, scenario })` compiles the
  design a second time with `overrides: { "clock.<main>": cosimHz }` (1 MHz by default), builds its hardware
  bundle (refusals propagate as `HwError`), and records each scenario as `[cycle, port, hex]` changes.
  Designs with more than one domain get `skip`; scenarios with a step in `INTERNAL` (poke, force, release,
  knob, apply, patch, change, reload, restore, irq) get a per-scenario `skip` naming the step.
- `weft-hw.mjs vectors` (`--scenario`, `--cosim-hz`) and `pkg/emitter.Vectors` for the CLI; the shared
  `run` helper in `emitter.go` maps exit code 2 to `*emitter.Error` for both subcommands.
- `pkg/validate`: `Parse` (schema, bundle, port indexes, cycle order and range), `Generate` (testbench and
  one `<port>.mem` per port holding `{cycle[63:0], value[W-1:0]}` words for `$readmemh`), `Run` (writes
  `rtl/`, synthesizes `net/netlist.v`, then one `sc-<slug>/` per scenario with `tb.v`, `changes.txt`, mems
  and logs), and `parseOutput` (`WEFT-COSIM PASS <n>` or the first `MISMATCH cycle=… port=… got=… want=…`).
- `weft validate <script> --levels build,rtl,net[,board]`: one row per level and scenario, progress on
  stderr, an error exit when any check fails. `board` answers `skip` until P8.
- `pkg/hw/validate.go` and `jobs.go`: a build request takes `validate` and `vectors`; after a successful
  build the job enters state `validate`, publishes one `validation` event per result, and persists the
  results in `job.json`. `POST /api/hw/builds/{id}/validate` re-runs the ladder on a finished build.
  Unknown levels, and rtl/net without vectors, are 422 `refused`; bad vectors are 422 `bad_vectors`.
- Lab: `hw.validate()` in `hw.js` (vectors are computed in the page, then sent with the bundle), the
  Validate button and a Validation table in `Hardware.jsx` with links to each scenario's change list,
  testbench and log, and to `netlist.v`/`synth.log`. Files hides `validate/`, so the `.vvp` and `.mem`
  files stay out of the list.
- Agent: `hw.validate(opts)` (allowed in Read-only mode unless `load: true`), `validation` lines in
  `hw.job()`, and a sentence in `HW_SCOPE`.
- Tests: `pkg/validate/validate_test.go` (generation golden values, parse rejections, real-toolchain
  co-simulation of F-01 and F-02, broken netlist), `TestValidate` in `pkg/hw` (fake `iverilog` and `vvp`),
  `test/vectors.test.mjs` (F-01's toggle cycles, ordering, skips, scenario selection, refusal).
- Help topic `validation-ladder` (`pkg/doc/topics/03-validate.md`) and `pkg/doc/doc_test.go`.

### Why
- **Record from the board hooks, not the waves.** Waves record a value when the simulator notices it, which
  for an input can be the instant `setInput` runs rather than the edge that first sees it. `record()` wraps
  `board.setInput` (an input change belongs to cycle `D.cycle+1`, the next edge) and `board._pin` (an
  output observed during edge k belongs to cycle `PD.cycle+1`, because the pin observers fire before the
  registers commit). These two definitions make the testbench order simple: apply inputs, `#1`, compare,
  then raise the clock.
- **A 1 MHz variant, not the board's 10 MHz.** Every prescaler is sized from the main clock, so lowering it
  shrinks the cycle count of a timed scenario by the same factor. F-01's 1.1 s scenario becomes 1.1 M
  cycles, which the netlist simulation finishes in about 30 s.
- **No reset in the testbench.** The simulator never resets; registers start at their initializers. The
  emitted RTL uses `initial` values, `synth_gatemate` keeps them as `INIT` on `CC_DFF`, and `cells_sim.v`
  honours `INIT`, so `rst` is held low on both sides.
- **Synthesize the design top alone for L2.** The board top instantiates `CC_USR_RSTN` and `CC_PLL`, which
  have no simulation models; `-noiopad -noclkbuf` keeps the netlist's ports identical to the RTL's.
- **Compare only bound bits.** A port can be wider than the bits the design binds to pins; unbound bits are
  free to differ, so each comparison is masked.

### What worked
- `vectors()` takes 43–135 ms for F-01, F-02, F-04 and F-06. F-03 is refused (compile errors for the
  board), F-05 too (its debounce cell has no hardware core until P7).
- L1/L2 timings: F-01 rtl 4.2 s, net 31.5 s (1.1 M cycles); F-02 rtl 2–3 s, net 20–25 s (650 k cycles).
- `./bin/weft validate weft-lab/examples/F-02-counter.js --levels rtl,net` prints the table and exits 0.
- Browser, F-02 *Validate*: build pass 5.5 s (103.25 MHz), rtl 3.3 s and net 39.9 s for "counts up, then
  down" (650,000 cycles match), "wraps below zero" skipped at both levels: `step poke("counter.down")
  changes the design's internals, which the RTL's ports cannot reproduce`. The header reads "3 passed, 0
  failed, 2 skipped".
- `GOWORK=off go test ./pkg/validate -count=1` (real toolchain): `ok … 128.143s`. `go test ./... -short`,
  `make lint`, `make js-test` (23 pass) and `git diff --check` pass.
- UART (for P7/P8): after `modprobe cdc_acm`, `/dev/ttyACM0` (DirtyJTAG 1209:c0ca, interface 01) is the
  FPGA's UART at 115200 baud; F-06 (FSM UART) prints `hello\r\n` on it. `/dev/ttyACM1` stays silent.

### What didn't work
- First broken-netlist test: I deleted the `assign` that drives `led`, but in the netlist `led` comes from
  a `CC_DFF .Q(led)`, so nothing changed and the test passed when it should fail. It now redirects `.Q` to
  another net and adds `assign led = 1'b0;`.
- Second attempt: iverilog rejected the netlist with `Output port expression must support a continuous
  assignment.` because I declared `wire weft_broken;` after its first use. Dropping the declaration (an
  implicit net) fixed it. The testbench now reports `MISMATCH cycle=250001 port=led got=0 want=1`.
- The help topic silently vanished: `weft help validation-ladder` answered `Unknown help topic`. Its
  `Short:` contained `weft validate: build`, which YAML reads as a mapping (`yaml: line 3: mapping values
  are not allowed in this context`), and glazed logs topic parse errors only at debug level, before logging
  is set up. Quoting fixed it; `TestTopicsParse` now parses every topic and checks for duplicate slugs. The
  first slug, `validate`, also collided with the command name, so the topic is now `validation-ladder`.
- The `validate` command's aligned long help was reflowed by the markdown renderer into one paragraph;
  it is now a bullet list with one line per item.
- The log pane showed `synth undefined` for blank tool lines (a P5 bug): `Event.Line` is `omitempty`, so an
  empty line arrives without `line`. The client now defaults it to `""`.
- A first JS test used F-10 as the multi-domain example; it is refused for the board ("the gatemate-a1-evb
  board has no hdmi"), so the test uses an inline two-domain design instead.

### What I learned
- The simulator's edge order (combinational values from the old registers, pin observers, then commit)
  means "the output at cycle k" is the value just before edge k, the same thing a testbench sees between
  the input change and the rising edge.
- Netlist simulation is 7–12× slower than RTL simulation in iverilog: F-01 4.2 s against 31.5 s (≈260 k
  against ≈35 k cycles/s), F-02 3.3 s against 39.9 s in the browser run.

### What was tricky to build
- Merging changes: several bit-level `_pin` calls for one port land in the same cycle. `put()` folds them
  into one `[cycle, port, value]` entry, so the testbench applies one word per port per cycle.
- Re-validation on a job that already has results: the server clears the results and enters state
  `validate` before the first new result, and the client clears its copy on that `state` event, so stale
  rows never mix with new ones.

### What warrants a second pair of eyes
- `INTERNAL` is a deny-list of scenario ops. A new op that changes internals would be recorded as if it
  were pin-only, and L1 would report a misleading mismatch instead of a skip.
- Validation runs while the build semaphore is held, so a 40 s netlist run delays a queued build. That is
  fine at `--max-builds 2`, but a separate validation pool might be better later.
- Read-only agents may call `hw.validate()`: it writes only under `var/weft/builds`, the same reasoning as
  `hw.build()`.

### What should be done in the future
- P7: hardware cores for uart-rx, uart-tx and debounce, with co-simulation cutting at the cell boundary
  (F-05 and F-16 must pass L1).
- P8: `board` level through `weft_hil` and the board session.
- Multi-domain co-simulation needs time-based change lists rather than cycle numbers.

### Code review instructions
- Start at `weft-lab/app/src/core/vectors.js` (`record`), then `pkg/validate/testbench.go` (`Generate`),
  `pkg/validate/run.go` (`Run`, `synthNetlist`, `simulate`), `pkg/hw/validate.go`, and
  `weft-lab/app/src/ui/hw.js` (`validate`, `onEvent`).
- `GOWORK=off go test ./pkg/validate -count=1 -v` (about 2 min, needs the OSS CAD Suite);
  `./bin/weft validate weft-lab/examples/F-01-blinky.js --levels build,rtl,net`; in the Lab, load F-02,
  Hardware tab, *Validate*.

### Technical details
- Vectors: `{ schema: "weft.vectors/v1", cosimHz, bundle, skip?, scenarios: [{ name, skip?, cycles,
  changes: [[cycle, port, hex]], sim: { status, message } }] }`. Every port is 0 until its first change.
- Testbench per cycle: apply the cycle's input words, `#1`, compare `(p & mask) !== (want & mask)` for each
  output, `#4 clk = 1; #5 clk = 0`.
- L2 synthesis: `synth_gatemate -top <top> -noiopad -noclkbuf -luttree -nomx8; write_verilog -noattr
  netlist.v`, simulated with `share/yosys/gatemate/cells_sim.v`.
- Files: `var/weft/validate/<id>/` (CLI) or `var/weft/builds/<id>/validate/` (jobs): `rtl/`, `net/`,
  `sc-<scenario>/{tb.v, changes.txt, <port>.mem, rtl.log, net.log, rtl-compile.log, net-compile.log}`.

## Step 9: P7 — hardware cores for debounce, uart-rx and uart-tx; adapters; co-simulation cut at the cells

P7 lets designs with the Lab's native cells go to the board. Three hand-written cores live in `hdl/cells/`
(embedded in the binary by a small `hdl` package), each with a self-checking testbench. The emitter replaces
the cells' black boxes with adapters that keep the same interface and instantiate the core, and the build
adds the cores. Co-simulation of such designs cuts at the cell boundary: the domain module is the device
under test, fed with what the cells drive and checked on what they read.

Every exit check holds: the three testbenches pass, F-05 bundles (debounce adapter) and passes L1 and L2,
F-16 passes L1 and L2 with its UART cells cut out, and F-16 echoes on the board through `/dev/ttyACM0`. The
board test also found a real problem the testbench could not: a transmitter that is 0.2 % slow loses bytes in
a design that forwards them 1:1. After the fix, 50,000 bytes echo intact at the full line rate.

### Prompt Context

**User prompt (verbatim):** see Step 1. During this phase the user asked: "are you using WASM for the
bitstream creation and all that?" (answered: no; yosys, nextpnr, gmpack, openFPGALoader and iverilog are the
native OSS CAD Suite binaries, run by the Go server; only the Weft compiler is JavaScript).
**Assistant interpretation:** Phase P7 of the guide (§6.6, §6.10, §9 step 7).
**Inferred user intent:** Designs that use the Lab's UART and button components run on the real board.
**Commit (code):** c6e0dc0 — "P7: cores for debounce, uart-rx and uart-tx; adapters; co-simulation cut at the cells"

### What I did
- Cores (`hdl/cells/`):
  - `weft_core_uart_tx #(CLK_HZ, BAUD)`: 8N1, valid/ready sink, ready while idle, divider `CLK_HZ/BAUD`
    rounded down.
  - `weft_core_uart_rx #(CLK_HZ, BAUD)`: two-flop synchronizer, falling-edge start, start bit checked at
    half a bit, mid-bit sampling with a whole-bit counter, low stop bit drops the frame, one-byte holding
    register (`m_valid` until `m_ready`).
  - `weft_core_debounce #(N, ID_W, SETTLE_CYC, LONG_CYC)`: per-input settle counter (the model's
    `t - since >= settle` in cycles), `held`, short event on release, long event at `LONG_CYC` after the press
    counted (then nothing on release), one pending event per input, lowest id first.
  - Each header lists where it differs from the JS model.
- Testbenches (`hdl/cells/tb/`), run by `go test ./hdl` (`TestCoreTestbenches`, skipped with `-short`):
  - uart-tx: 5 bytes back to back decoded at the nominal rate, start and stop bits, `s_ready` low time.
  - uart-rx: nominal and ±2.5 % baud, presentation time, the holding register losing a second byte, a glitch,
    a low stop bit.
  - debounce: bouncy press and release, a glitch, a long press, a short press, a stalled consumer — all at
    exact cycles derived from the model's rule.
- `verilog.js`: `CELL_CORES` (kind → core, per-instance parameters from the cell and its domain clock, and a
  `wire` function that maps the cell's stream roles from `groupIO` to core ports, or returns a reason).
  `cellStubs` records each port's io key or pin name and builds the adapter plan. `emitCellStubs` writes an
  adapter module, or a black box for kinds without a core. Domain file entries now carry `module`, `domain`
  and `ports`.
- `hardware.js`: uses that table; refuses a cell without a core (`cells`) and one whose interface does not fit
  its core; `cells[].module` names the core.
- Go: `hdl.Core`/`hdl.Modules`; `board.Wrap` adds the named cores to `Wrapped.Cores` (an unknown core is a
  refusal); the toolchain writes them to `cells/` and reads them in `synth.ys`.
- Co-simulation cut: `vectors.js` adds `dut: { module, file, ports }` for designs with cells and records
  every domain-module port as node values (`recordCut`). `pkg/validate` gets `DUT`, a port abstraction shared
  by both modes (`Vectors.ports()`), `Generate(v, s)`, and L1/L2 that compile and synthesize only the DUT's
  file in cut mode.
- Tests: `TestWrapCores` and an "unknown core" refusal in `pkg/board`; `TestGenerateCut` and F-05/F-16 in
  `TestCosimExamples`; JS tests for the adapter text, the sigma-delta refusal, and cut-mode vectors of F-05
  and F-16.
- Help topics: cores and the A1-EVB UART in `build-and-flash`, "Designs with native cells" in
  `validation-ladder`; the Hardware tab and the agent's `HW_SCOPE` say the same in a sentence.
- `scripts/07-uart-echo.py`: sends text to `/dev/ttyACM0` and prints what comes back.

### Why
- **Adapters with the stub's interface.** The top-level wiring from P3–P6 stays exactly as it was; only the
  cell module's body changes. Stream names differ per design (`presses_valid`, `rx_bytes_data`), so only
  generated code can map them to fixed core ports.
- **Cycle counts computed in JavaScript.** The adapter receives `SETTLE_CYC`/`LONG_CYC` (or `CLK_HZ`/`BAUD`)
  from the top, computed from the domain's `hz`, so fractional milliseconds and non-integer MHz clocks need no
  32-bit Verilog parameter arithmetic.
- **A whole-bit counter in the receiver, not 16× oversampling.** At 10 MHz, `CLK_HZ/BAUD/16` is 5.43; a
  divider of 5 is 8.5 % off, 87 for a whole bit is 0.16 % off.
- **Recording the cut from the simulator's own hooks.** A cell ticks inside edge k after the graph is
  evaluated (`sim.js` edge body: values, pin observers, `X.tick()`, commit), so a read value belongs to cycle k
  and a drive is first seen by edge k + 1. Wrapping `sim._tick` (one call per edge, before and after the cells)
  keeps the change list in cycle order even with several cells.

### What worked
- Testbenches: `WEFT-TB PASS weft_core_uart_tx (5 bytes, DIV 86)`, `WEFT-TB PASS weft_core_uart_rx (latency
  9.547 bit times)`, `WEFT-TB PASS weft_core_debounce (5 events)`.
- GateMate synthesis of the cores alone: uart-tx 79 cells (20 `CC_DFF`), uart-rx 89 (31), debounce with N=4,
  10 ms and 500 ms at 10 MHz 980 cells (180 `CC_DFF`).
- Builds: F-16 `shout` CPE_LT 299, CPE_FF 91, 75.48 MHz; F-05 `lights` CPE_LT 774, CPE_FF 190, 41.35 MHz
  (both PASS at 10 MHz).
- Co-simulation, cut at the cells: F-05 rtl 10.0 s and net 13.1 s (761,000 cycles); F-16 rtl 59 ms and net
  134 ms (1,328 cycles). `weft validate weft-lab/examples/F-16-targets.js --levels build,rtl,net` passes.
- Board, F-16 loaded (44 ms): `sent b'hello, fabric\n'` → `got b'HELLO, FABRIC\n' after 3.9 ms`; `The Quick
  Brown Fox 123 {xyz}~` → `THE QUICK BROWN FOX 123 {XYZ}~`; 10,000 and 50,000 bytes intact at 115,200 baud
  effective with at most 1 KB in flight.
- `go test ./... -short`, `make lint`, `make js-test` (26 files) and `git diff --check` pass.

### What didn't work
- `release` is a Verilog keyword: my first debounce core named a wire `release`; renamed to `unpress`.
- Two testbench failures were the testbenches' fault: they raised `m_ready`/`ev_ready` just after a falling
  edge, the next rising edge took the waiting item, and the monitor (which samples at the falling edge) never
  saw it: `WEFT-TB FAIL holding register: 0 bytes, want 1` and `WEFT-TB FAIL event 3: {1, 0} on edge 597,
  want {0, 0} on edge 596`. Ready now rises just after a rising edge.
- First board read returned `llo\r\nhello\r\nhello…`: F-06's output from earlier, buffered while nothing read
  the port, most likely in the RP2040's USB CDC buffer (`tcflush` does not reach it). The script drains the
  port first.
- **Lost bytes with the first transmitter.** A 2000-byte burst came back as 1998 bytes, first difference at
  byte 1442. The transmitter's divider was 87 (rounded to nearest: 114,943 baud, 0.22 % slow) while the
  RP2040 sends at about 115,207 baud, so F-16's echo fell behind by one byte every few hundred and overran the
  one-byte receive register once the pipeline's slack was used up. The model never falls behind (its rx and
  tx rates are identical). The divider now rounds down (86: 116,279 baud, 0.94 % fast); the same burst comes
  back intact.
- **Lost bytes in the RP2040 bridge.** 10,000 bytes written at once came back as 1808, with a 14-byte gap at
  byte 141 — before the FPGA. The kernel and USB took all 10,000 bytes in 18 ms; the bridge forwards USB data
  without flow control and drops what overflows its buffer. Keeping at most 1 KB in flight fixes the test; the
  `build-and-flash` topic now says so.
- My first `07-uart-echo.py` ignored the return value of a non-blocking `os.write` and had a fixed 1 s
  timeout.

### What I learned
- The board catches what a core testbench cannot: both the clock-ratio overrun and the bridge's lack of flow
  control only show at the system level, with a real host on the other side.
- Cut mode compiles and synthesizes only the DUT's file, so neither the top nor the adapters (which name
  cores the RTL directory does not contain) take part in L1 or L2.

### What was tricky to build
- The cut's port list has to match what `emitTop` connects. Rather than describing it in the bundle, cut
  mode calls `emitVerilog` again (it is deterministic) and reads the main domain module's port list from the
  new `ports` field.

### What warrants a second pair of eyes
- The rounded-down transmitter is fast by less than one divider step, `BAUD/CLK_HZ` (0.94 % at 10 MHz, at
  most 0.46 % at 25 MHz). That is fine for 115200 baud on this board; a very low `CLK_HZ/BAUD` ratio would
  make it worse, and the adapter does not check.
- `CELL_CORES.debounce.wire` assumes presses are `{ id, long }` with `long` in bit 0, which is what
  `std.js` `cellInterface` produces today.
- The F-05 board behaviour (the user button through the debounce core) is not tested by hand: `btn:1..3` and
  `sw:0` are virtual on the A1-EVB, so only `btn:user` → `led:0` can be exercised.

### What should be done in the future
- P8: board-level scenarios through `weft_hil` and a board session; `scripts/07-uart-echo.py` becomes a
  `uart`/`expectUart` step there.

### Code review instructions
- `hdl/cells/*.v` and their testbenches; `weft-lab/app/src/core/verilog.js` (`CELL_CORES`, `cellStubs`,
  `emitCellStubs`); `vectors.js` (`recordCut`); `pkg/validate/vectors.go` (`DUT`, `ports`); `pkg/board/board.go`
  (cores in `Wrap`).
- `GOWORK=off go test ./hdl ./pkg/validate -count=1 -v`; with the board: `./bin/weft build
  weft-lab/examples/F-16-targets.js --load`, then `python3 -I ttmp/.../scripts/07-uart-echo.py`.

### Technical details
- Adapter for F-05: `weft_debounce #(.LONG_CYC(5000000), .SETTLE_CYC(100000)) u_buttons` →
  `weft_core_debounce #(.N(4), .ID_W(2), ...)` with `.ev_id(presses_data[2:1]), .ev_long(presses_data[0])`.
- F-16's cut DUT `shout_sys` ports: inputs `tx_bytes_out_ready`, `rx_bytes_valid`, `rx_bytes_data`,
  `pin_uart_rx`; checked outputs `x_4` (tx valid), `x_7` (tx data), `x_10` (rx ready), `x_73` (the rx pin).
