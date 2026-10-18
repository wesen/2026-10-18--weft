# STATUS-A — compiler front and middle (dsl, boards, std, front, lower, compile)

Run: `node app/test/compile.test.mjs [F-07] [--raw] [--print] [--diags]` (`--raw` skips B's passes) and
`node app/test/scenarios-a.mjs [F-07] [--steps]` (every scenario on C's simulator at level dag).

## What compiles

All 19 examples compile with B's pipeline. F-03 reports its deliberate capture errors — `gamma` at 21:23
and, transitively, `GAMMA` at 12:20 — and still builds (captured values are used as if shipped, so its
scenario runs). Fixing it with `.lib({ GAMMA, gamma })` compiles clean; shipping only `gamma` reports
`GAMMA` at 12:20. `verify()` finds no structural errors in any graph. 456 truncated/mutated scripts and
17 odd ones never make `compile()` throw.

| example | ok | nodes/regs after passes | raw (`--raw`) | ms |
| --- | --- | --- | --- | --- |
| F-01 | ok | sys 13/2 | sys 13/2 | 34 |
| F-02 | ok | sys 26/5 | sys 33/5 | 32 |
| F-03 | capture (expected) | sys 12/4 | sys 12/4 | 42 |
| F-04 | ok | sys 122/19 | sys 129/19 | 73 |
| F-05 | ok | sys 51/8 | sys 58/8 | 33 |
| F-06 | ok | sys 154/19 | sys 180/19 | 81 |
| F-07 | ok | sys 456/78 | sys 542/78 | 170 |
| F-08 | ok | sys 84/11 | sys 88/11 | 52 |
| F-09 | ok | sys 75/12 | sys 77/12 | 47 |
| F-10 | ok | sys 49/5 · pix 89/10 | sys 63/5 · pix 104/10 | 75 |
| F-11 | ok | sys 85/7 | sys 86/7 | 43 |
| F-12 | ok | sys 64/10 | sys 71/10 | 42 |
| F-13 | ok | sys 10/1 | sys 12/1 | 31 |
| F-14 | ok (B's 48-bit lint warn) | sys 394/65 | sys 330/65 | 366 (B's saturate) |
| F-15 | ok | sys 136/31 | sys 139/31 | 154 |
| F-16 | ok | sys 66/8 (pico; dev/big same) | sys 76/8 | 56 |
| F-17 | ok | sys 91/13 | sys 93/13 | 49 |
| F-18 | ok (B's timing warn, intended) | fast 21/0 | fast 24/0 | 56 |
| F-19 | ok | sys 333/30 · pix 175/11 | sys 404/30 · pix 235/11 | 237 |

## Scenarios on C's simulator (level dag)

Every scenario passes except those that need Claude, which skip: F-01 to F-17 (all scenarios), F-18
"still blends", and F-19's four simulated scenarios (serve/rally/point 45 s, paddles 17 s, stuck encoder
15 s, night mode 0.6 s of wall time). F-18 "closes timing" and F-19 "the mechanic on call" skip (needs
Claude). F-11's proof (C's formal) proves all three asserts and covers the sequence; its broken variant
fails "served within". F-17 passes with B's pipeline.cut balancing (biquad 9.08 ns, slack +0.92).
F-09 also passes with `.stall("global")`, with a fourth stage, and as one stage
(`.stall("skid")` puts a skid buffer at each boundary, R6.13). Also checked: F-07 with depth 512 (block RAM FIFO), depth 100 drop-oldest (block RAM) and
depth 3 all pass; Verilog emits for all 19.

## Shapes beyond ARCH §3 (additions, nothing removed)

- `streams[]` (C's contract item 2): `signals` are the beats as the consumer sees them, in `domain`
  (the consumer's domain); `push` is the producer side when a same-domain buffer separates them;
  `sides: { push, pop }` (each with its `domain`) always; `pushDomain`; `views[consumerPath]` per consumer
  (forks); `mode` (wire|buffer|cross|unsync), `impl` (wire|register|skid|flip-flops|lut-ram|block-ram|
  xfifo), `typeName`, `declared`. Paths: `S.valid/data/ready` (producer side), `S.out.valid/data/ready`
  (consumer side when buffered), buffer registers `S.main`, `S.skid`, `S.e0…`, `S.head`, `S.count`,
  `S.dropped`. Edge streams use `in` nodes with src `"port"`.
- Every stream with a producer and a consumer in the design gets a buffer at its producer (book R6.7):
  depth 2 skid by default. Edge streams (testbench-driven) stay plain handshakes. Undeclared sinks have
  ready = probe of const 1 (R6.5). Drop counters are u16 saturating (R6.9) and are listed in `knobs` as
  kind `status`, path `<stream>.dropped`.
- Input ports that are pin-bound or wired are `probe` nodes with `attrs.input` (C forces them on poke);
  pin inputs pass two sync flops `<port>.sync1/.sync2`. Pin outputs are `out` nodes with path
  `pin:<resources>`; no-board designs get `out` nodes `port:<inst>.<port>` for unconsumed outputs.
- `instances[]` modules also carry `ports[].store/node`, `rams`, `lib` names, `blocks`, `memo` key,
  `budget`, `hints`, `pipelined`, `migrate`; fsm: `states`, `initial`, `encoding`, `stateNode`,
  `transitions`, `step`; pipeline: `pipeline: { stages, live, latency, stall }`; `supervise:
  { watchdog: { ms, cycles, node, counter }, reset }`; `probe: { signals, depth, keep, nodes }`.
- State register `inst.state` holds the state index, with `attrs.states` (names) and `attrs.fsm = { states,
  encoding (requested: "auto" unless .encode()), initial }`; `instances[].encoding` is the request too. Prescalers:
  `inst.every…` with `attrs.prescaler = { period, label }` and a `…tick` probe. Monitors: `inst.pastN`,
  `inst.withinN`, `inst.seqN` regs. Asserts: probe `inst.<kind>.<name>`.
- Cells: `cells[].node` (a `cell` op node reading the cell's inputs); hdmi `params.timing` and
  `params.serialHz`; xfifo `params { depth (default 4), policy, from, to, type, stages, stream }`.
- Top level: `target`, `targets[].board`, `clocks` (per domain: hz, kind, pll solution), `main`,
  `bootBackground`, `emits`, `script`, `file`; non-enumerable `peek`, `elab` and `levels` (B's
  `{ lower, dag, net }`, each `{ [domain]: Graph }` plus a non-enumerable `.domains` in the compiled shape). `compileCfg` is the raw
  lambda (B's request). `changes` holds every change applied by a scenario step, by name.
- `compileDesign(design, { script, file, peek, header, overrides, target, passes })`; `opts.overrides`
  takes `"inst.PARAM"` and `"clock.<domain>"`; `opts.target` picks a `.boards()` target; `opts.passes =
  false` skips runPipeline. `Design.replaceModule(name, mod)` / `.patchModule(name, { lib, params })`.
- `front.parseExpr(fnOrSrc)` → `{ params, body, src }`, body a tree of `{k:"var"|"const"|"bin"|"un"|"mux"|
  "call"|"member"}` with DAG opcode names.

## Known gaps

- `.on(s)` with `$.has/$.take` on the same stream is not rejected (R6.10); the ready→valid structural
  check (R6.3) is left to B.
- xfifo depth defaults to 4 when a crossing stream has no `.buffer()`.
- Several consumers get an eager fork (taken flags); no example exercises it.
- The hdmi "pix × 5" serial clock is recorded as `params.serialHz`, not as a domain.
