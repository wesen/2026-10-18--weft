# Weft Lab — architecture and contracts

Weft Lab is a browser IDE for the Weft FPGA grammar, built on the octavo-lab app (same build, same CSS,
same widgets, same agent design). It compiles the 19 example files in `examples/` through a real
multi-pass compiler to one DAG per clock domain, simulates them cycle by cycle on a virtual board, runs
their scenarios, shows the passes, the report, waves and live changes, and has an architect agent that
calls Claude through the artifact `sample` capability.

Specification sources: book 1 "Weft, From First Principles" and book 2 "Building Weft: Implementation
and Reference" (decisions D1–D15). Where this file and the books differ, this file wins for the Lab.

Everything is ES2022 modules. `app/src/core/**` has no DOM and runs in Node for tests:
`node app/test/<name>.test.mjs`. Never `npm install` new runtime deps; acorn, acorn-walk, esbuild, react
are present in `app/node_modules`.

## Layout and ownership

| Path | Owner | What |
| --- | --- | --- |
| `app/src/core/types.js` | done | types, D1 width rules, value arithmetic (`evalOp` is the reference semantics) |
| `app/src/core/ir.js` | done | `Graph`: hash-consed DAG, `topo`, `verify`, `print`, `hash`, `fold` |
| `app/src/core/dsl.js` | A | builders (immutable), `makeScope()` |
| `app/src/core/boards.js` | A | board profiles `pico`, `dev`, `studio` and part data |
| `app/src/core/std.js` | A (builders) + C (cell behaviour in `cells.js`) | `std.*` |
| `app/src/core/front.js` | A | hardware-lambda parser, capture check, HIR |
| `app/src/core/lower.js` | A | HIR + design → per-domain DAGs, streams, fsm, pipeline, memories, knobs, pins, cells |
| `app/src/core/compile.js` | A | `compile(script, opts)` orchestration (calls B's `runPipeline`) |
| `app/src/core/passes.js` | B | pass manager, core passes, checks, custom passes/analyses/rewrites, rule checking |
| `app/src/core/estimate.js` | B | technology estimate (LUT/FF/RAM/DSP per family), timing estimate, report |
| `app/src/core/verilog.js` | B | Verilog emitter from the DAGs |
| `app/src/core/sim.js` | C | compiled two-phase simulator, multi-domain scheduler, waves |
| `app/src/core/cells.js` | C | native cell models (std components, board I/O) |
| `app/src/core/scenario.js` | C | scenario runner (recorder steps and async testbenches) |
| `app/src/core/host.js` | C | host runtime (`host()` lambdas, `dev` handles) |
| `app/src/core/changes.js` | C | change pipeline |
| `app/src/core/formal.js` | C | explicit-state model checking for assert/assume/cover |
| `app/src/ui/**`, `app/src/agent/**`, `app/src/main.jsx`, `app/build.mjs` | D | the Lab UI, state, agent, build |

Owners write their own tests in `app/test/`. Do not edit another owner's files; if a contract needs to
change, write the request at the end of this file under "Contract changes" and work around it.

## 1. Values and types (done: types.js)

Types are frozen objects `{ k: "u"|"s"|"vec"|"struct", w, signed, pulse?, initVal?, elem?, n?, fields? }`.
`u(n)`, `s(n)`, `bit`, `pulse`, `vec(T,n)`, `struct({..})`, `T.init(v)`. Values are JS Numbers for
types up to 53 bits (`isBig(T)` false) and BigInts above. `binType`, `unType`, `shiftType`, `join`,
`constType`, `fits` implement D1. `evalOp(op, resultType, values, attrs)` is the reference semantics for
every opcode; the simulator's generated code must agree with it (C tests this).

Structs and vectors inside the DAG are flattened to bit vectors: a struct value is the concatenation of
its fields, first field most significant; `field` nodes (`attrs: { name, lo, hi }`) and `pack` nodes
(args in field order) convert. A `vec` is the concatenation of elements, element 0 least significant;
`index` with a constant index lowers to `slice`, with a dynamic index to a mux tree. Lowering may keep
`field`/`pack` nodes; the simulator evaluates them as slices and concatenations.

## 2. The DAG (done: ir.js)

One `Graph` per clock domain. Node `{ id, op, args, type, attrs, origin: [{file,line,col,src}], domain }`.
Opcodes: `in out const reg mem memrd memwr probe cell` (stateful, never merged) and the pure set in
`PURE` (add sub mul neg and or xor not shl shr eq ne lt le gt ge land lor lnot mux concat slice sext
zext wrap sat rom field index pack). `shr` is arithmetic for a signed operand. Conventions:

- `in` nodes: `attrs.path` (e.g. `counter.en`) and `attrs.src` = `"pin" | "port" | "knob" | "cell" |
  "cross" | "free"`. `"free"` means an unconnected input the testbench may poke (default 0).
- `reg`: `attrs.path`, `attrs.init` (value), `attrs.next` (node id), optional `attrs.pulse`,
  `attrs.module` (instance path), `attrs.name` (register name inside the module), `attrs.knob` for
  host-written registers. Registers update every edge of their domain (enables are muxes).
- `out`: `attrs.path`; design-level outputs (pins, stream taps, probes) are `out` nodes.
- Wires the UI should be able to show get a `probe` node (`args: [src]`, `attrs.path`).
- `mem`: `attrs { path, words, elem (type), rdw, init (array|null) }`. `memrd`: args `[mem, addr, en]`,
  value = data read at the previous edge where en was 1 (registered read, D8). `memwr`: args
  `[mem, addr, data, en]`. `rom`: args `[index]`, `attrs.table` (array of values), combinational.
- Crossing: a destination-domain `in` node with `attrs { src: "cross", from: { domain, node }, stages }`
  — the simulator samples the source node at each destination edge through `stages` (2 or 3, seeded) of
  delay. Stream crossings are native cells (`xfifo`), see §4.

## 3. The compiled design (A produces, everyone consumes)

`compile(script, { file = "design.js", board = null, examples = false }) → Compiled`:

```js
{
  ok,                     // false when any error diagnostic exists
  diags: [{ level: "error"|"warn"|"info", code, message, line, col, file }],
  name, header,           // design name; parsed /** F-NN Title … */ header {id,title,group,about,shows,watch,tries}
  design,                 // the evaluated Design builder (for agents/changes)
  board: { profile, part, family, mainHz, resources: { [id]: { kind, dir, pin? } }, partData },
  targets: [ { name, board } ],          // .boards() designs; the first is the active one
  domains: { [name]: { hz, graph } },    // one Graph per clock domain (D11 level "dag")
  hir,                    // A's HIR (opaque to others, shown by the UI as JSON)
  instances: [ { path, kind: "module"|"fsm"|"pipeline"|"cell"|"agent"|"host",
                 def, domain, params, line, ports: [{name, dir, type}], regs: [{name, type, path}],
                 provides: [], needs: [], knobs: [], cell?: "uart-rx"|… , states?: [..] } ],
  streams: [ { name, type, producer, consumers: [], depth, overflow, cross: {from,to}|null,
               signals: { valid, data, ready } /* node ids in the producer domain */,
               dropped: nodeId|null } ],
  pins: [ { resource: "led:3", dir: "in"|"out", domain, node, bit: 0, instance, port } ],
  knobs: [ { path: "synth.hz", module, name, kind: "knob"|"status"|"irq", type, reset, min, max, addr, domain, node } ],
  cells: [ { path, kind, domain, params, io: { [signal]: { dir: "drive"|"read", node, domain } }, pins: { [port]: resource } } ],
  asserts: [ { path, name, kind: "assert"|"assume"|"cover", module, domain, node /* bit: 1 = holds / hit */ , line } ],
  scenarios: [ { name, kind: "steps"|"tb", steps?: [{op, args, line}], fn?: Function, opts: { levels, targets } } ],
  hosts: [ { name, over, every: [{ ms, fn }], on: [{ event, fn }], onStart } ],
  changes: {},            // change builders found as top-level consts are not visible; scenarios carry them
  agents: [ { name, model, guidelines, scope, budget, on: [{event, fn}] } ],
  groups: [ { name, children, strategy, maxResets, window, escalate } ],
  boot: [[..], ..], regions: [...], place: {}, record: { streams, keep } | null,
  prove: { module, bmc, induction, engine } | null,
  compileCfg,             // the recorded .compile(c => …) configuration (B interprets)
  stages: [ { name, level, passes: [ { name, ms, nodesBefore, nodesAfter, diags, note } ], snapshot? } ],
  report: { …B's report… },
  timings: { evaluate, elaborate, front, lower, passes, total },   // ms
}
```

`compile` must never throw for a bad script: syntax errors, builder misuse and capture errors become
diagnostics with line numbers (the script is the body of a function; subtract the wrapper's line offset).
A design that compiles with errors still returns whatever it built, so the UI can show it.

Script evaluation: the example file is the body of a function returning the design. `compile` wraps it as
`new Function(...scopeNames, script)` with the scope from `makeScope(std)`. Builder lambdas run during
evaluation. Hardware lambdas are kept as `{ fn, src, line, col }` (line in the script, from
`new Error().stack` at the builder call, or from locating `src` in the script text) and parsed by
`front.js`.

## 4. Native cells (A declares the interface, C implements behaviour)

std components are native cells: their behaviour is JavaScript in the simulator, their interface is
declared by `std.js` so linking, the graph, the report and Verilog (as a black box) work. Kinds:

| kind | builder | params | streams / ports | pins |
| --- | --- | --- | --- | --- |
| `debounce` | `std.debounce(n).bind({raw}).settle(d).longPress(d).provides(s)` | settleMs, longMs, n | provides `s` `{ id: u(clog2 n), long: bit }`; out port `held: u(n)` | raw buttons |
| `uart-rx` | `std.uart.rx(n).baud(b).bind({rx}).provides(s)` | baud | provides `s` u8 | rx |
| `uart-tx` | `std.uart.tx(n).baud(b).bind({tx}).needs(s)` | baud | needs `s` u8 | tx |
| `sigma-delta` | `std.sigmaDelta(n).needs(s).bind({out})` | — | needs `s` (signed samples) | out (audio) |
| `video-timing` | `std.video.timing(n).mode("640x480@60").domain(d).provides(..)` | mode | provides `beam` `{x:u(10), y:u(10), visible:bit}` (a beat every pixel clock) and `frame` (bit, at frame start) when listed | — |
| `hdmi` | `std.video.hdmi(n).domain(d).bind({tmds})` | — | needs `pixels` `{r,g,b}` u8; reads the timing cell's beam position natively | tmds |
| `bridge-uart` | `std.bridge.uart(n).baud(b).bind({uart})` | baud | host access to knobs | uart |
| `xfifo` | inserted by lowering for `stream.cross()` | depth, policy, from, to | both sides' valid/data/ready | — |

A cell's stream endpoints are DAG nodes listed in `cell.io`: for a stream the cell produces, the cell
drives `in` nodes `S.valid`, `S.data` and reads `S.ready`; for a stream it consumes, it reads `S.valid`,
`S.data` and drives `S.ready`. Other ports (debounce `held`) are driven `in` nodes. The simulator calls
each cell once per edge of its domain: `cell.tick(ctx)` after combinational evaluation reads, then sets
its drives for the next cycle (see §5).

## 5. Simulation semantics (C)

- D15: each edge of a domain evaluates all combinational nodes of that domain from current register
  values and inputs, then updates every register and memory at once. Domains interleave by time (ps):
  an event queue of edges; ties in definition order.
- Inputs: `in` nodes hold values set by the board (pins, after the inserted synchronizer registers,
  which are ordinary `reg` nodes made by lowering), by cells, by knobs, by crossings or by `poke`.
- Streams follow D7: fire = valid ∧ ready. Buffers are lowered to registers/memories by A, so the
  simulator needs nothing special except cells and `xfifo`.
- Quiescence skipping: when a domain's step changes no register, no memory, no cell state and no
  input is scheduled, the scheduler may jump that domain ahead to the next prescaler terminal count or
  input event. Lowering marks prescaler counters with `attrs.prescaler = { period }` so C can do this.
- Waves: record every `reg`, `in`, `out` and `probe` by path, change-compressed, last 200 000 changes.
- Asserts: `asserts[].node` evaluated every edge; a 0 is a failure event `{ time, cycle, path, name }`.

`new Sim(compiled, { seed = 1, waves = true })`:
`time` (ps) · `cycle(domain)` · `runFor(ps)` · `runUntil(pred, limitPs)` · `step(n = 1, domain = main)` ·
`poke(path, v)` (force until `release`) · `release(path)` · `peek(path)` (reg/in/out/probe paths and
`a.b[3]`, `a.b.field`) · `state(instance)` → `{ name: value }` · `board` (see below) ·
`stream(name)` → `{ fired, dropped, last: [beats] }` · `knob(path)` → `{ get, set(v) → kept }` ·
`status(path)` · `on(event, fn)` events: `assert`, `irq`, `uart`, `frame`, `drop`, `reset` ·
`snapshot()` / `restore(s)` · `waves` · `stats` `{ cyclesPerSecond, simSeconds }`.

`board`: `pins` (resource → value), `press(id, { for, bounce })`, `release(id)`, `toggle(id)`,
`set(id, v)`, `leds()` → array, `uart(id).send(text)`, `uart(id).text`, `frames` (last frames from hdmi
cells: `{ w, h, data: Uint8ClampedArray RGBA, time }`), `audio` (recent samples), `lastFrame()`.

## 6. Scenarios (C)

`runScenario(compiled, name, { level = "dag", onStep }) → Promise<{ status: "pass"|"fail"|"skip",
steps: [{ label, ok, note, time }], message, simTime, ms }>`, each run on a fresh `Sim`.
Recorder ops (args exactly as the examples write them): `wait step poke release press toggle set uart
feed throttle write run apply approve build hang repeat expect expectPins expectSignal expectState
expectStream expectUart expectFrame expectDropped expectKnob expectIrq expectResets expectToggles
expectChange expectBuild expectProposal expectEscalation`. Expectations with `{ within }` poll until the
time limit. Steps that need Claude (`expectProposal`, `approve` of an agent change, `build` +
`expectBuild("timing", "met")` after an agent) return `skip` with note "needs Claude" when no `sample`
function is given in opts. Async testbenches get `tb` per Appendix B of book 2.

## 7. Compile pipeline and report (B)

`runPipeline(ctx) → { stages, report, emits }` where `ctx = { domains, instances, streams, cells, board,
compileCfg, diags, hir }`. Default stages per D11 with these passes actually doing work:
`flatten`/`widths` (done by A in lowering; B records them as stages with A's timings), `checks.loops`,
`checks.latches` (A reports latches; B re-checks), `checks.cdc` (domain propagation over crossings),
`constFold`, `cse` (rehash), `dce` (remove nodes reaching no out/reg/probe/memwr/cell read; narrow),
`fsm.encode` (record encoding per D12), `pipeline.cut`/`retime` (report only unless `.pipelined()`
paths exist: then compute the minimal stages for the clock with the delay model), `mem.infer`,
`dsp.pack`, `techmap` (estimate), `place`/`route` (estimate: report as "estimated"), `timing`.
Custom `pass()` / `analysis()` / `rewrite()` builders from the script run where `.after/.before/.replace`
put them, with the Graph API (`g.nodes(op?)`, `n.users`, `g.replace`, `g.duplicate`, `g.warn`,
`g.count`, `g.print`). Rewrite rules: patterns from `.from`/`.to` lambdas via A's `front.parseExpr`;
correctness checked by exhaustive evaluation over all inputs for widths 1–8 and per instance at the
real width with random + edge-case vectors (say "exhaustive up to 8 bits, sampled at N bits" — no SAT).

`report`: `{ part, family, resources: { luts, ffs, brams, dsps, carry, ios, of(path) }, perModule:
{ path: {luts, ffs, brams, dsps} }, timing: { [domain]: { hz, periodNs, worstNs, slack, fmax, levels,
path: [{ id, op, origin }] } }, registers: [...knob map with addresses], checks: [...], emits:
[{ backend, files: [{ path, text }] }] }`. Delay model per family (state it in the UI as an estimate):
iCE40 LUT4 ≈ 0.6 ns + 0.9 ns routing per level; 7-series LUT6 ≈ 0.12 + 0.45 ns; ECP5 ≈ 0.25 + 0.6.

`verilog.js`: `emitVerilog(compiled) → [{ path, text }]`, one module per domain, deterministic names.

## 8. Lab state (D)

`app/src/ui/lab.js` exports `lab` (like octavo's): `script`, `preset`, `presets`, `compiled`, `diags`,
`sim`, `running`, `speed`, `scen` (by name), `changes`, `ui` (tabs), `sel`, `sample`, `toasts`, and
methods `load(id)`, `setScript`, `recompile`, `boot`, `apply` (submit an edit as a change), `play`,
`pause`, `step`, `runScenario(name)`, `watchScenario(name)`, `runAll`, `savePreset`, `select`,
`setUI`, `toast`, `on(channel, fn)`, `bump(...channels)`. Channels as octavo: `ready ui code diags
preset run frame scen changes agent sel toast`.

Right tabs: Board · Modules · Graph · Waves · Passes · Report · Changes · Proofs.
Left tabs: Code · Agent · Reference. The Board tab draws the board profile (LEDs, buttons, switches,
UART terminal, HDMI canvas, audio scope) with octavo's machine aesthetic and has the info tiles
(SYSTEM, ID, BOARD/PART, CLOCKS, LUTs, FFs, BRAM, DSP, FMAX/SLACK, SCENARIOS, CHANGES).

## 9. The architect agent (D)

Octavo's agent design: one `eval` tool whose code runs in the page with a scope: `lab`, `editor`
(`get`, `set`, `edit(find, replace)`, `boot`, `apply`), `compile(script?)`, `sim` (live) and `io`
(`press`, `toggle`, `uart`, `poke`, `peek`, `run(dur)`), `scenarios` (`list`, `run(name)`, `runAll`),
`report`, `ir(domain)` (`print`, `stats`), `changes` (`submit(change)`, `list`), `examples`, the DSL
builders, `log`. Modes Auto / Ask / Read-only with per-step revert. `sample(turns, { tools, onText,
signal, modelTier, effort, cache: false })` from `await window.claude.use("sample")`; absent → the panel
says the agent needs the Lab opened in Claude, everything else works. `agent()` components in designs
(F-18 closer, F-19 mechanic) use the same `sample` to propose changes when their event fires.

## 10. Build (D)

`app/build.mjs` (from octavo's): bundles `src/main.jsx` with esbuild (React/ReactDOM as UMD globals from
cdnjs 18.3.1), inlines CSS, examples (generated `examples.gen.js` from `../examples/*.js` with headers
parsed), docs (`reference.txt`, guidelines), writes `dist/index.html` beginning with `<title>Weft Lab</title>`
and `<meta name="claude:viewport-fit-sides" content="cover">`. No wasm engine is needed.

## 11. Acceptance

All 19 examples compile with no errors except F-03's deliberate `capture`. Scenarios that must pass at
level dag: F-01, F-02 (both), F-03, F-04, F-05, F-06, F-07, F-08, F-09 (both), F-11, F-12 (both), F-13,
F-14, F-15, F-16. Best effort: F-10, F-17, F-19 (video and live change). F-18 and agent steps are
`skip` without Claude. F-11's `.prove()` proves the three assertions by explicit-state search.

## Contract changes

(append requests here: who, what, why)

- **B → A (pass builders, std.passes, compileCfg).** `passes.js` exports the builder factories and std
  objects; please re-export them rather than writing your own: `import { pass, analysis, rewrite, backend,
  STD_PASSES, STD_ANALYSES, STD_PIPELINE, CompilerB } from "./passes.js"`. In `makeScope` expose
  `pass, analysis, rewrite, backend`; in `std` set `std.passes = STD_PASSES` (it already contains
  `saturate`, `checks.cdc`, `mem.infer`, `place.with(...)` etc.), `std.analyses = STD_ANALYSES`,
  `std.pipeline = { default: STD_PIPELINE }`. For `design.compile(fn)`, store the raw lambda as
  `compileCfg` (or `null`); `runPipeline` applies it to its own `CompilerB` recorder. (A recorded array
  `[{ op, args }]` or an object with `.calls` is also accepted.)
- **B → A (ctx fields runPipeline reads).** Besides ARCH §7: `ctx.knobs`, `ctx.asserts`, `ctx.pins`
  (roots for dce and inputs to emitters), `ctx.timings` (`{ front, lower }` ms, shown as the front/lower
  stage timings), `ctx.target` (`{ name, family, part, board }`, for `.when()` and `check(name, (r, t) =>…)`),
  `ctx.name`. Instances: `kind: "fsm"` with `states` and, if you have them, `transitions: [{ from, to }]`
  (for D12 ring detection); `pipelined: { path }` for `.pipelined()`; `hints: { multiply }` for `.hint()`;
  `budget` for `.budget()`. Nodes: `attrs.module` (instance path) on every node you create inside an
  instance, so per-module resources work; `attrs.latch = true` on a wire missing an assignment if you do
  not raise the error yourself; `attrs.prescaler` on `.every` counters (already in ARCH §5).
- **B → C, D (report shape).** `report.timing`, `report.resources` are plain objects with non-enumerable
  helper methods the examples call: `r.timing.slack(domain)`, `r.timing.fmax(domain)`,
  `r.timing.worst(domain).explain()`, `r.resources.of(path)`, `r.ir(level).count(op)`, `r.latency(path)`,
  `r.part`. `report.explore` is `{ spec, points: null, pending: true }` unless `ctx.explore === true` and
  `ctx.recompile(overrides) → Compiled` is given; the UI can call `runExplore(report.explore, recompile)`
  from passes.js later. `report.netlist.cells()` lists estimated technology cells (`{ type, module }`).
- **C → A (what the simulator reads; please lower to this).**
  1. `concat` args: args[0] is most significant. `pack`: for a struct, args are in field order with the
     first field most significant; for a vec, args are in element order with element 0 least significant.
     `field` may omit `lo`/`hi` (they are derived from the struct type). `index` args: `[vec, i]`.
  2. `streams[]` also carry `domain` (the domain of `signals`). `signals` are the beats as the consumer
     sees them (fire there = a beat delivered). When a buffer sits between producer and consumer, add
     `push: { valid, data, ready }` for the producer side. A stream with no producer in the design must
     have `in` nodes for `valid`/`data` (src "port"), so testbenches can `feed`/`tb.push` it. A stream with
     no consumer needs an `in` node for `ready`, so `throttle`/`tb.pull` can drive it. `dropped` is either
     a 1-bit node (counted per edge) or a counter (read as is).
  3. `.every()` counters: `attrs.prescaler = { period }` on the counter reg. Any counter shape works
     (up or down, any compare). Logic may read it only through comparisons with constants, and through
     the chain back into its own `next`.
  4. `pins[]`: `dir: "in"` → an `in` node (src "pin"), and the board sets bit `bit` of it. `dir: "out"` →
     an `out` node, and the board reads bit `bit`. Resource ids are the board's (`led:3`, `btn:up`, `sw:0`,
     `uart.tx`, `uart.rx`, `audio`, `hdmi`). A UART line pin named `<id>.tx` is decoded by the board
     terminal `<id>`.
  5. `cells[].io` keys:
     - Streams use `<stream>.valid|data|ready`. The cell drives valid/data of a stream it produces and
       ready of one it consumes.
     - debounce has the port `held`.
     - xfifo uses `in.valid|data|ready` (domain `params.from`) and `out.valid|data|ready` (domain
       `params.to`).
     - video-timing produces `beam.*` and `frame.*`, or a driven port `frame`.

     `cells[].pins` are: debounce `raw` (a range string or an array), uart-rx `rx`, uart-tx `tx`,
     sigma-delta `out`, hdmi `tmds`, bridge `uart`. `cells[].params`: debounce `{settleMs, longMs, n}`,
     uart `{baud}`, video-timing `{mode}`, xfifo `{depth, policy, from, to}`.
  6. FSMs: the state register is `<fsm>.state`. Put `attrs.states` (names in index order) on it and
     `attrs.encoding` when the encoding is not binary, or give `instances[].states`; `state(fsm).state`
     is then the name. Every reg inside an instance has `attrs.module` (reset, hang and migrate use it).
  7. Knobs: `node` is a reg with `attrs.knob` (its `next` holds it unless the design writes it) or an `in`
     with src "knob". The simulator writes the clamped value directly. An irq `node` is a 1-bit pulse.
     A status `node` is any node.
  8. Supervision: optional `instances[].supervise = { watchdog: { ms } }`. `groups[]` follow §3; a hung
     child is reset after its watchdog (default 20 ms) per the group strategy, and an escalation is
     emitted when resets exceed `maxResets` within `window`.
  9. Asserts, assumes and covers: `node` is a bit (1 = holds or hit). `past`/`within`/`sequence` lower to
     registers with `attrs.module`. formal.js explores the module's regs and treats its `in` nodes as
     free inputs.
- **C → D (simulator API beyond §5).**
  - `board.press(id, { hold: true })` keeps a button down until `board.release(id)`; without `hold` a press
    auto-releases after `for` (default 50 ms). `press` returns the hold time in ps.
  - `sim.advance(wallMs, speed) → { simMs, wallMs, speed /* achieved ×real time */, done }`.
  - `sim.waves`: `paths()`, `series(path, fromPs, toPs) → [[t, v]]`, `valueAt`, `span()`, `version` (bumps on
    change). A reload replaces `sim.waves`.
  - `sim.coverage()`, `sim.props` (per-assert fails/hits/first), `sim.resets`, `sim.escalations`,
    `sim.logLines`, `sim.irqLog`, `sim.warnings`, `sim.domains`, `sim.stats`.
  - `sim.reload(compiled, { migrate })` swaps the design in place.
  - Events beyond §5: `log`, `knob`, `hang`, `escalation`, `cover`, `reload`, `restore`.
  - Board extras: `board.audio.recent(n)` returns Float32 samples in −1..1; `board.uart(id).text` /
    `.send(text, {baud})`; frames have `.count(color | fn)` and `.at(x, y)`; `board.toggles[res]`.
  - `runScenario` returns `simTime` in ms and accepts `opts.onSim(sim)`, called once with the fresh Sim.
- **B → A, C, D (runPipeline as built).**
  - `runPipeline(ctx) → { stages, report, emits, levels, diags }`. B appends its diagnostics to `ctx.diags`.
    The returned `diags` is that same list, so do not append it again.
  - `levels = { lower, dag, net }`, each `{ [domain]: Graph }`:
    - `lower` is a clone taken before optimize.
    - `dag` is a clone taken before map.
    - `net` is the live graphs, which are also `compiled.domains`.

    They are also reachable as `report.ir(level).graphs`. A: please keep `levels` on the compiled object
    (non-enumerable is fine), so C can run scenarios at `lower`/`dag`.
  - The graphs in `ctx.domains` are optimized in place. B never removes a node id that pins, knobs, asserts,
    streams, cells or crossings refer to; such a node may stay computed beside its replacement.
  - optimize introduces only opcodes the simulator already has. One change to know about: muxTree rewrites
    a case chain `mux(S == k, a, mux(S == k', …))` over one unsigned selector of 6 bits or fewer into
    `index(pack(vec), S)`.
  - FSMs: B leaves the state register's `attrs.encoding` alone, because sim.js reads it. B records its
    choice in `attrs.physEncoding` and in `report.fsms[]`.
- **Stage records.**
  - A stage is `{ name, level, ms, iterations, note?, passes, snapshot?, inspect? }`.
  - Each entry of `passes` is `{ name, kind, ms, nodesBefore, nodesAfter, changed, note, diags, external?,
    reused?, validate? }`.
  - `snapshot` is `{ level, as, to, text }`. `inspect` is `{ level, output: [lines] }`; lines printed with
    `console.log` inside an inspect lambda are captured.
  - Passes A runs (parse … widths) are recorded with `external: true` and A's `ctx.timings`, split evenly.
- **Report (all estimated; `report.estimated === true`, `report.delayModel` gives the numbers).**
  - Plain fields:
    - `part`, `family`, `target`
    - `resources { luts, ffs, brams, dsps, carry, ios, lutram, sprams }` and `perModule`
    - `timing[d] = { hz, periodNs, worstNs, slack, fmax, levels, met, endpoint, path: [{ id, op, type, width,
      delay, arrival, origin, path }] }`
    - `failures`: one `{ event: "timing.failed", domain, target: "300 MHz", slack, path: [{ op, width, type,
      delay, origin }], resources }` per failing domain. This is F-18's dossier.
    - `memories`, `dsps`, `fsms`, `pipelines`, `latencies`, `srl`, `registers`, `plan` (the explainPlan
      text), `levels` (node counts)
    - `rules`, one per rewrite: `{ status, exhaustiveUpTo, mixedSignsUpTo, sampled, examples,
      counterexample, matches, applied, rejected }`
    - `checks`: diagnostic summaries, plus `{ kind: "check", name, ok, message }` for each `.check()`
  - Non-enumerable helpers:
    - `resources.of(path)`
    - `timing.slack(d)`, `timing.fmax(d)`, `timing.met()`, and `timing.worst(d).explain()`, which is text
      naming the source line of every step on the path
    - `ir(level)`, returning `{ count(op), nodes(), print(), stats(), graphs }`
    - `latency(path)`
    - `netlist.cells()`
    - `explore.run({ onPoint, limit })`. This recompiles through `ctx.recompile`, sets `explore.points`,
      `explore.front` and `explore.html`, and takes about 2 s for F-15's 27 points.
  - What the estimate counts:
    - Every register counts as written.
    - Stream signals, cell inputs and pins are synthesis roots.
    - Timing endpoints are register next values, memory writes, `out` nodes and stream signals. The other
      side is assumed to register them.
  - `.check()` failures are `error` diagnostics (`check-failed`). Missed timing is a `warn` (`timing`).
  - Diagnostic codes from B:
    - checks: `comb-loop`, `latch`, `cdc`
    - estimate and build checks: `timing`, `fit`, `check-failed`
    - rewrite rules: `rule-unsound`, `rule`, `rule-example`
    - the script's passes: `lint` (from `g.warn/error/info`), `pass-failed`, `pass-readonly`
    - IR and configuration: `ir-invariant`, `validate`, `compile-config`, `emit`

    Each diagnostic carries `pass` and, when its node has an origin, `line/col/src`.
- **B → C, D (exports).**
  - `passes.js`:
    - `runExplore(explore, recompile, { onPoint, limit })` and `exploreHtml(explore)`
    - `traceGraph(g, { cycles, seed, input(n, cycle) })`: a reference cycle evaluator for one Graph. Its
      semantics match sim.js; `.validate()` uses it.
    - `evalNodeOp`, `checkRule(rule)`, `explainPath`
  - `verilog.js`: `emitVerilog(compiled) → [{ path, text, top? }]`, plus `sanitize` and
    `encodeValue(v, T)` (the bit pattern of struct and vec values).
- **A → C (poke on input ports).** A module input port that is pin-bound or `.wire()`d is a `probe` node with
  `attrs.input = true` (pin-bound: after the two synchronizer flops; wired: driven by the source port), and
  the module's logic reads through that probe. Only unconnected inputs are `in` nodes. F-02 "wraps below
  zero" pokes `counter.down` (pin-bound) and `counter.en` (wired), so `poke(path)` on a probe with
  `attrs.input` must force it like an `in` (the generated code uses the forced value until `release`).
- **B (pipeline.cut also balances).** A path within 10% of its clock period can contain an add/sub chain.
  Before pipeline.cut cuts anything, it rebuilds such a chain as a tree that combines the earliest-arriving
  terms first.
  - The values are exact under D1 and the root keeps its type.
  - Latency does not change, so this applies with or without `.pipelined()`.
  - It brings F-17's biquad to 9.08 ns at 100 MHz, from 10.2 ns.
  - It keeps every register value the same in validation and in Verilog co-simulation.
- **C → B (levels).** `runScenario(c, name, { level })` simulates `compiled.levels[level].domains` or the last
  `stages[]` entry of that level with `snapshot.domains` (`{ [domain]: { hz, graph } }`, cloned graphs). Until
  B provides one it runs at dag and says so in a step note. `runAcrossLevels(c, name)` (scenario.js) runs
  every level in `scenario.opts.levels`; when one fails, it re-runs each stage snapshot in order and
  reports the first failing stage as `culprit` (F-14's "a mismatch names the pass").
- **C (semantics worth knowing).**
  - `poke` forces `in`, `probe` and `out` nodes until `release`, and deposits into a register (F-10 pokes
    `physics.x` and expects it to keep moving).
  - Events raised during an edge (irq, assert, uart, frame) are delivered after that edge's registers
    commit, so a host handler's knob write is never overwritten by the same edge.
  - A "latest" xfifo push of the value it already holds is a no-op: no beat, no wake.
  - Stream fires do not block quiescence: a skipped cycle repeats the quiet edge exactly, and its beats are
    credited to the stream log.
  - `sim.setWaves(false)` switches each domain to a lean edge that computes only the cone feeding state,
    pins, streams, cells, asserts and crossings. Scenarios run lean; `settle()` (every peek) evaluates
    everything.
  - Rollback status: `canary → rolling-back → rolled-back`. "rolled-back" is reported once the restored
    design has run clean for 20 ms.
- **C → D (agents in scenarios).** `runScenario(c, name, { agentRuntime: { propose({ agent, trigger, compiled,
  sim, pipeline }) → Promise<change() builder | null> } })`:
  - `expectProposal(agent)` and `approve()` after an escalation ask the runtime for a change.
  - The change is submitted as `fromAgent`, waits in `awaiting-approval`, and `approve()` releases it into
    the pipeline. `trigger` is `{ kind: "build", build }` (F-18) or `{ kind: "escalation", group, agent,
    resets }` (F-19).
  - Without `agentRuntime` these steps return skip, "needs Claude".
- **C → D (live changes in the Lab).** Create `new ChangePipeline({ compiled, sim, onChange })` once per
  running design, and call `pipeline.poll()` after every `sim.advance()`; canary windows and rollback
  confirmation run on simulated time.
  - `pipeline.submit(change())` takes the example's change builders.
  - `pipeline.submitDesign(newCompiled, { name, canary: "300ms" })` takes an edited script that is
    already compiled: lint, then a canary swap with registers carried by path, then commit or roll back.
  - `pipeline.changes[]` items: `{ id, name, kind, status, history: [{ status, time, note }], reason, region,
    fromAgent, agent }`. `pipeline.current` is the compiled design that is live.
  - `approve(id)` / `reject(id)`, and `pendingApproval()`.
