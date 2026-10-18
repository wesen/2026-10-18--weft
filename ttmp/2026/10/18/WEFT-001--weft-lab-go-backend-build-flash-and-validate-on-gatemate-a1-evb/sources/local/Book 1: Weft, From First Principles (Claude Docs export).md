# Weft, From First Principles

Oct 18, 2026 · @Manuel Odendahl

## Preface

Weft is a proposed JavaScript API for designing FPGA hardware. A Weft script is a program that builds a circuit; a multi-pass compiler turns that circuit into a bitstream. This book explains why each part of the API has the shape it has, one example at a time, from a blinking LED (F-01) to a two-player game with live patching and an agent on call (F-19).

Weft is a design, not a shipped tool. Code from the nineteen example files is quoted verbatim, and the few sketches written for the book are labelled as sketches. Every IR listing, cycle table and diagnostic is worked out by hand from the semantics the examples imply. Where the book describes an algorithm the compiler would run, the algorithm is real and named; where it describes Weft's own behavior, it is describing a specification.

### What a hardware description is

An FPGA (field-programmable gate array) is a chip made of many small configurable parts: lookup tables that compute any Boolean function of a few inputs, flip-flops that hold one bit from one clock edge to the next, blocks of RAM, multipliers, and a programmable network of wires between them. A *bitstream* is the file that sets every one of those configuration bits. Nobody writes a bitstream by hand. You write a description of the circuit, and tools turn the description into the bitstream.

The description is itself a program, and it runs before the hardware exists. A loop in it that stamps out eight PWM channels does not loop at runtime; it produces eight copies of a circuit. That is the central fact of hardware description, and most of Weft's design follows from taking it seriously. There are two times in a hardware program: the time when the circuit is being built, and the time when the circuit runs. Weft adds a third: the time when software talks to the running circuit.

### Three kinds of lambda

Weft code is full of small functions, and each one belongs to exactly one of those three times. The examples never mark which is which; the method a lambda is passed to decides. The table is the most important one in the book.

| Kind | Example from the files | When it runs | What it can see | What it produces |
| --- | --- | --- | --- | --- |
| Builder lambda | `({ BITS }) => u(BITS)`, `b => b.luts(120)`, `i => Math.round(2047 * Math.sin(...))` | Once, while the design is built (*elaboration*) | Anything in JavaScript | Part of the circuit's description |
| Hardware lambda | `$ => { $.phase += 1; $.pwm = $.phase < $.duty; }` | Never called: its source is parsed into the compiler's IR | `$`, its own parameters, a small prelude, the module's params and whatever `.lib()` ships | Hardware: adders, comparators, multiplexers, registers |
| Runtime lambda | `async tb => { … }`, `async dev => { … }`, `old => ({ … })` | While the simulator or the board runs | Anything in JavaScript, plus handles to the hardware | Stimulus, checks, register writes, migrated state |

The hardware lambda is the unusual one. It looks like JavaScript and is written with JavaScript's operators, but it is never executed. The compiler reads its source text and translates `+` into an adder and `if` into a multiplexer. Because it is translated rather than run, it cannot see the variables around it, and the compiler checks that it does not try. Chapter 3 is about that rule.

### The compiler in one picture

Between the script and the bitstream sit four intermediate representations (IRs), each making one thing explicit that the one before left implicit. HIR keeps the design's hierarchy and its parsed lambdas. The DAG flattens each clock domain into one dataflow graph whose cycles are all broken by registers. The netlist maps that graph onto the part's real cells. The physical IR places and routes them. Passes move the design down these levels, and every node remembers the source line it came from.

&#91;embedded content: Weft's three kinds of lambda and the compiler's IR levels\]

Builder and hardware lambdas both enter the compiler at HIR, one by running and one by being parsed. Runtime lambdas never enter it: they reach the simulator or the board only through handles.

### The opinions

Weft is opinionated: it refuses some legal hardware because that hardware is usually a bug. Each opinion is enforced by a pass and taught in a chapter.

| Opinion | What it prevents | Chapter |
| --- | --- | --- |
| Arithmetic grows; narrowing must say `wrap()` or `sat()` | A lost carry bit that no tool reports | 2 |
| Where a signal is written decides whether it is a register or a wire | Accidental latches and mismatched blocking semantics | 2 |
| Hardware lambdas see only what is shipped to them | Build-time values silently frozen into hardware, or not | 3 |
| A pin is bound by exactly one module | Two drivers fighting over one wire | 5 |
| A stream that crosses clock domains says `.cross()` | Metastable data entering logic | 10 |
| Latency may change only on a stream path marked `.pipelined()` | Retiming that breaks a cycle-exact interface | 15 |

### How to read this book

Each chapter follows one example file, F-01 through F-19, and is best read with the file open beside it. Chapters 1–4 cover the foundations: the FPGA, widths, the three lambdas and elaboration. Chapters 5–9 build components: events, state machines, queues, memories and pipelines. Chapters 10–12 cover clock domains, verification and runtime registers. Chapters 13–16 open the compiler. Chapters 17–19 cover hardware that changes while it runs and a whole design that uses everything. Appendix A lists the grammar; Appendix B lists the papers behind the algorithms.

The grammar borrows its shape from the presets of octavo-lab, a browser playground for operating systems built from isolated JavaScript worlds: builder lambdas versus shipped runtime lambdas, `.lib()` as the only way across, a change pipeline with canaries and rollback, supervision groups, and agents that propose changes through the same pipeline as people. Those ideas carry over to hardware with less translation than one would expect.

## Chapter 1 · Blinky

Follows **F-01** (`F-01-blinky.js`).

This chapter explains what an FPGA is made of, why almost every FPGA design is synchronous, and what Weft builds from four lines that blink an LED. By the end you should be able to say which hardware the line `.every("250ms", $ => { $.led = !$.led; })` becomes, and why it becomes a counter rather than a slower clock.

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

### 1.1 What the chip contains

An FPGA is a grid of a few kinds of configurable cell joined by a programmable routing network. The most numerous cell is the *lookup table* (LUT). A k-input LUT is a 2^k-bit memory whose address lines are the inputs, so it computes any Boolean function of k inputs: a LUT4 stores 16 bits and a LUT6 stores 64. Lattice's iCE40 family uses LUT4s; Xilinx 7-series parts use LUT6s.

Next to each LUT sits a *flip-flop*, a cell that copies its input D to its output Q at the rising edge of its clock and holds Q until the next edge. Flip-flops are where all state lives. Around these two sit specialized cells: carry chains for fast addition, block RAMs, DSP blocks with hardware multipliers, I/O cells, and phase-locked loops (PLLs) that make new clock frequencies from an input clock.

Every one of those cells, and every switch in the routing, is set by configuration memory loaded at power-up. The file that fills it is the bitstream. A Weft design ends up as one: the compiler chooses which LUTs compute what, which flip-flops hold which bits, and which routing switches connect them.

### 1.2 Why the design is synchronous

A *synchronous* design clocks every flip-flop from the same edge of the same clock, with combinational logic (LUTs and wires, no state) between them. This discipline turns a physical circuit into a function you can reason about one cycle at a time: the state after an edge is a function of the state and the inputs before it.

The discipline has one price, a timing constraint. A signal leaving a flip-flop must cross its logic and arrive at the next flip-flop a setup time before the next edge:

```latex
T_{clk} \ge t_{clk \to q} + t_{logic} + t_{route} + t_{setup}
```

The compiler checks this inequality on every path between two flip-flops; that is static timing analysis, and Chapter 13 shows how it is computed. A design that satisfies it behaves exactly like its cycle-by-cycle model. A design that does not may capture a half-settled value, and no simulation will show it.

This is why Weft has no way to write `always @(posedge led)` or to clock a register from a signal computed in logic. A clock made by logic arrives late and with skew relative to the real clock, so registers on it form a new, unrelated timing domain. Chapter 10 covers the one sanctioned way to have several clocks.

### 1.3 A register written in a timed block

The register-transfer level (RTL) describes a synchronous design as registers plus the next-state function of each. Weft states that function inside blocks that run once per clock edge: `.seq()`, `.every()`, `.on()` and the states of an `fsm()`. A signal written in one of those blocks is a register. Writing `$.led = !$.led` therefore says: on each edge where this block runs, the next value of `led` is the inverse of its current one.

The `.out("led", bit)` declaration gives the port a type and nothing else. It does not say whether `led` is a register. Weft infers that from where `led` is written, a rule Chapter 2 develops. Reading `$.led` on the right-hand side reads the register's current value, the Q output; the assignment sets its D input.

### 1.4 `.every()` is a counter, not a clock

The board's oscillator runs at 12 MHz, and the block should run every 250 ms. The compiler divides one by the other and builds a *prescaler*: a counter that counts clock cycles and enables the block on the cycle it reaches its terminal count. The arithmetic decides the counter's width.

```latex
N = 12\,000\,000 \times 0.25 = 3\,000\,000, \qquad \lceil \log_2 N \rceil = 22
```

Written by hand in Weft, the generated logic is the module below. This is a sketch of what the `every.lower` step produces, not code from the examples, but each line maps to one piece of hardware: a 22-bit register, an incrementer, an equality comparator, and a multiplexer that picks between holding `led` and inverting it.

```js
module("blink")
  .out("led", bit)
  .regs({ count: u(22) })
  .seq($ => {
    if ($.count === 2_999_999) { $.count = 0; $.led = !$.led; }
    else $.count += 1;
  });
```

The enable approach keeps every flip-flop on the 12 MHz clock. The slow event is a one-cycle pulse that gates when `led` may change, not a new clock. Timing analysis sees one clock, and the 22-bit counter is the only extra cost. The table traces the cycles around one terminal count.

| Cycle | `count` before the edge | Terminal? | `led` before | `led` after |
| --- | --- | --- | --- | --- |
| 2 999 998 | 2 999 998 | no | 0 | 0 |
| 2 999 999 | 2 999 999 | yes | 0 | 1 |
| 3 000 000 | 0 | no | 1 | 1 |
| 5 999 999 | 2 999 999 | yes | 1 | 0 |

The compiler can only do this division because the module's clock has a known frequency. A module whose domain has none, such as an IP block clocked from outside, gets a compile error on `.every()` that asks for the frequency. A duration is a number of cycles only once the clock is known.

### 1.5 Binding to the board

A *board profile* names the resources on a circuit board and maps each to a package pin and an I/O standard. The profiles in the examples (`pico`, `dev`, `studio`) are fictional; `pico` is modeled on a small board with an iCE40 UP5K, a 12 MHz oscillator, an RGB LED, one button and a UART. `.bind({ led: "led:0" })` connects the module's port to the resource, and the compiler writes the pin constraints the place-and-route tool needs (a PCF file for nextpnr on iCE40, an XDC file for Vivado on 7-series).

Binding is also a claim of ownership. Two modules that bind outputs to the same pin would drive one wire from two places, so the link pass rejects the second binder. Chapter 5 returns to this check.

### 1.6 The scenario

A scenario drives the simulated board and checks what it sees. `.wait("1.1s")` runs the simulator for 13.2 million cycles of the 12 MHz clock. `.expectToggles("led:0", n => n === 4)` counts the edges on the pin. The LED toggles at 0.25, 0.5, 0.75 and 1.0 seconds, so four edges fall inside the window and the fifth, at 1.25 seconds, does not.

Simulation is deterministic: the same design and the same scenario produce the same trace on every run. That property matters more later, when random stimulus is seeded (Chapter 11) and recorded traffic is replayed against a change (Chapter 17).

### Key points

- An FPGA is LUTs, flip-flops, specialized blocks and programmable routing, all set by a bitstream.
- A synchronous design clocks all state from one edge, which makes behavior a per-cycle function and makes timing a checkable inequality.
- A signal written in `.every()`, `.seq()`, `.on()` or an fsm state is a register; the port declaration only gives its type.
- `.every("250ms")` becomes a 22-bit prescaler that enables the block for one cycle, never a derived clock.
- Binding a port to a board resource is an exclusive claim that the compiler checks.

Blinky has one register and no arithmetic worth the name. Chapter 2 adds arithmetic, and with it the first real question a hardware language must answer: how wide is the result of `a + 1`?

## Chapter 2 · Counter

Follows **F-02** (`F-02-counter.js`).

This chapter settles two questions every hardware language must answer. How wide is the result of an operation, and what happens when it does not fit where it is stored? Which signals are registers and which are wires? Weft answers the first with types that grow and narrowing that must be spelled out. It answers the second with one rule: the kind of block a signal is written in decides what it is.

```js
const ticker = module("ticker")
  .out("tick", pulse)                               // a pulse is a bit that falls back to 0 on its own
  .every("100ms", $ => { $.tick = 1; });

const counter = module("counter")
  .in({ en: bit, down: bit })
  .out({ value: u(8), zero: bit })
  .seq($ => {                                       // written here, value is a register: reset to 0, synchronous
    if ($.en) $.value = wrap($.down ? $.value - 1 : $.value + 1);
  })
  .comb($ => { $.zero = $.value === 0; });         // written here, zero is a wire
```

### 2.1 Bits as numbers

A bundle of n wires carries one of 2^n patterns. A type says which numbers those patterns stand for. `u(n)` reads them as an unsigned integer from 0 to 2^n − 1. `s(n)` reads them in two's complement, from −2^(n−1) to 2^(n−1) − 1, where the top bit has weight −2^(n−1) instead of +2^(n−1).

Two's complement is used because addition then needs no special case for signs. The same adder circuit adds two unsigned numbers or two signed ones; only the interpretation of the top bit differs. Subtraction is addition of the inverted operand plus one. That is why `$.value - 1` costs the same as `$.value + 1`.

### 2.2 Arithmetic grows

The sum of two 8-bit unsigned numbers can reach 255 + 255 = 510, which needs nine bits. Weft gives every expression a type wide enough for every value its operands' types allow. The rules work on types, not on the values a particular design happens to produce, so they are predictable from the source alone.

| Expression (operands `a: w_a`, `b: w_b`) | Result type | Why |
| --- | --- | --- |
| `a + b`, both unsigned | `u(max(w_a, w_b) + 1)` | The carry needs one more bit |
| `a - b`, both unsigned | `s(max(w_a, w_b) + 1)` | The result can be negative |
| `a * b` | `w_a + w_b` bits | The product of the two maxima |
| `-a`, `a: s(n)` | `s(n + 1)` | −(−2^(n−1)) does not fit in n bits |
| `a << k`, `k` constant | `w_a + k` bits | No bits fall off the top |
| `a & b`, `a \| b`, `a ^ b` | `max(w_a, w_b)` bits | Bitwise, no carry |
| `a === b`, `a < b`, `!a`, `a && b` | `bit` | A yes or no |
| A constant `k` | The narrowest type holding `k` | `1` is `u(1)`, `-1` is `s(1)` |
| `u(n)` mixed with a signed operand | Treated as `s(n + 1)` | A zero sign bit keeps its value |

Apply the rules to the counter. `$.value + 1` is `u(9)`. `$.value - 1` is `s(9)`. The conditional `$.down ? … : …` must hold both, and the type that holds every `u(9)` and every `s(9)` value is `s(10)`.

### 2.3 Narrowing must be spelled out

The register `value` is `u(8)`, and the expression is `s(10)`. Something must decide what happens to the values that do not fit. Weft refuses to decide silently and offers two words.

- `wrap(x)` keeps the low bits, which is arithmetic modulo 2^n. `wrap(-1)` into `u(8)` is the pattern `1111 1111`, which reads as 255.
- `sat(x, T)` clamps to the range of `T`. `sat(-1, u(8))` is 0 and `sat(300, u(8))` is 255; in hardware it is two comparisons and a multiplexer.

Verilog takes the other path. The width of `sum = a + b` is set by its context, the widest of the operands and the left-hand side, so an 8-bit `sum` silently drops the carry. Lint tools can warn about it, but the language accepts it. Weft makes the same line a compile error from the `widths` pass. The message names the line and offers both words.

Compound assignments are the one exception. `$.phase += 1` means `$.phase = wrap($.phase + 1)`. Counters, phase accumulators and ring-buffer pointers are modular by intent, and making each of them say so would bury the cases where wrapping is a bug. Writing `$.value = $.value + 1` instead is the error the example's try line invites.

### 2.4 Where a signal is written decides what it is

Every signal in a module is written in at most one kind of block. The kind decides the hardware.

| Written in | It becomes | Reads of it see | Paths that do not assign it |
| --- | --- | --- | --- |
| `.seq()`, `.every()`, `.on()`, an fsm state | A register | Its current value, Q | Hold the old value |
| `.comb()` | A wire | Earlier assignments in the same lambda, in program order | Compile error, unless it has a default |

The register rule produces a multiplexer per register. For `value`, the next state is the new value when `en` is high and the old one otherwise; a path that does not assign `value` feeds Q back to D. The wire rule forbids that feedback. A wire with no assignment on some path would have to remember its last value, which is a latch, and the `checks.latches` pass rejects it.

This replaces Verilog's two assignment operators. In Verilog, `<=` inside a clocked block and `=` inside a combinational block mean different things, and mixing them is a well-known source of simulation and synthesis disagreeing. Weft has one assignment operator, and the block kind carries the meaning.

`pulse` is a type that changes the hold rule. A `pulse` written in a timed block is a register whose unassigned paths load 0 instead of holding. `ticker.tick` is therefore 1 for exactly one cycle after each 100 ms terminal count. Without it, the ticker would need a second block to clear the bit, and that second block would have to be declared after the first to win, by the rule below.

Several clocked blocks may write the same register. F-05 writes `leds` in two `.on()` handlers, and F-06's greeter writes `go` in `.every()` and in `.seq()`. The rule: all clocked blocks of a module (`.seq()`, `.every()`, `.on()` handlers, fsm states, pipeline stages) merge into one next-state function in declaration order. For each register, the last block in declaration order whose path guard holds on a cycle wins. Inside one lambda the last assignment in program order wins. With no writer the register holds, and a pulse loads 0.

Overlapping writers are usually a mistake, so the compiler warns `multi-writer` when a SAT check on the two blocks' guards finds a cycle on which both can hold, and it prints that cycle's inputs as a witness. Writing one signal in a clocked block and in `.comb()` is an error, because the signal would be both a register and a wire.

### 2.5 What the compiler builds

Here is the counter after the `lower` stage, worked by hand in the DAG notation Chapter 13 uses. Each line is one node, and `%v.next` is the register's D input.

```text
%v    = reg value : u8          ← written in .seq
%en   = in en : bit
%dn   = in down : bit
%dec  = sub %v, 1 : s9          ← $.value - 1
%inc  = add %v, 1 : u9          ← $.value + 1
%sel  = mux %dn, %dec, %inc : s10
%w    = wrap %sel : u8          ← wrap(...)
%v.next = mux %en, %w, %v : u8  ← if ($.en); otherwise hold
%z    = eq %v, 0 : bit          ← written in .comb: a wire
zero  = %z
```

The `wrap` node costs nothing: it selects eight of ten wires. The optimizer later notices that only the low eight bits of `%sel` are used and narrows `%dec`, `%inc` and the mux to eight bits. The width rule protects the programmer's intent; the optimizer recovers the area.

### 2.6 Reset

Every register resets to its initial value, zero unless the declaration says `.init(v)`, as in `bit.init(1)` in later examples. The default reset is synchronous and active-high: the reset signal is one more input to each register's next-state multiplexer, sampled at the clock edge.

A synchronous reset is ordinary data to timing analysis. An asynchronous reset acts immediately, but its release must still be synchronized to the clock, or flip-flops can leave reset on different cycles. Choosing synchronous by default removes that hazard from every module. Chapter 19 returns to reset as a tree of local resets, released in order.

### 2.7 Two kinds of scenario

The first scenario works at the board level. It waits, flips a switch and reads the LEDs, the way a person would.

| Time | Event | `value` after |
| --- | --- | --- |
| 100 ms | tick, counting up | 1 |
| 200 ms | tick | 2 |
| 300 ms | tick | 3 |
| 350 ms | `expectPins("led:0..7", 3)`; `sw:0` turned on | 3 |
| 400, 500, 600 ms | ticks, counting down | 2, 1, 0 |
| 650 ms | `expectPins("led:0..7", 0)` | 0 |

The second works at the signal level. `.poke("counter.down", 1)` and `.poke("counter.en", 1)` force two inputs, overriding the ticker's wire, and `.step()` advances one clock edge. From 0, the next value is `wrap(0 - 1)`, which is 255, and `zero` falls to 0. Signal-level scenarios test one module's arithmetic without waiting for its surroundings.

### Key points

- Every expression's type is wide enough for every value its operand types allow, so no operation can lose information by itself.
- Narrowing a value into a smaller register is an error unless the code says `wrap()` or `sat()`; compound assignments wrap by definition.
- A signal written in a clocked or timed block is a register that holds on unassigned paths; a signal written in `.comb()` is a wire that must be assigned on every path.
- The `pulse` type is a register that returns to 0 on its own, which makes one-cycle events a single write.
- Registers reset synchronously to zero or to their `.init()` value, which keeps reset inside ordinary timing analysis.

The counter used two kinds of lambda without naming them: the hardware lambdas inside `.seq()` and `.comb()`, and the scenario's builder lambda. Chapter 3 names all three kinds and shows the rule that keeps them apart.

## Chapter 3 · Three kinds of lambda

Follows **F-03** (`F-03-lambdas.js`).

This chapter explains why Weft parses hardware lambdas instead of running them, what that costs, and the one rule that pays for it: a hardware lambda may use only what is shipped to it. F-03 ships with the mistake this rule exists to catch. By the end of the chapter you should be able to look at any lambda in the examples and say when it runs and what it may see.

```js
const GAMMA = Array.from({ length: 256 }, (_, i) => Math.round(255 * (i / 255) ** 2.2));   // build-time JS
const gamma = v => GAMMA[v];

const dimmer = module("dimmer")
  .in("level", u(8))
  .out("pwm", bit)
  .regs({ phase: u(8) })
  .budget(b => b.luts(120).brams(0))                // builder lambda: runs now, while the graph is built
  .seq($ => {                                       // hardware lambda: parsed into IR nodes, never called
    $.phase += 1;
    $.pwm = $.phase < gamma($.level);              // ✕ captures the JS binding `gamma`
  });
  // the fix: .lib({ GAMMA, gamma }). GAMMA becomes a 256 × 8 ROM; gamma is re-parsed and inlined at the call
```

### 3.1 Two programs in one file

A hardware description runs in two stages. The first stage is the script: it runs in JavaScript, now, and computes a circuit. The second stage is the circuit: it runs later, in silicon or in a simulator, once per clock edge. Languages that mix code for two stages are called multi-stage languages, and their central problem is marking which code belongs to which stage. MetaML did it with explicit brackets around later-stage code.

Weft marks the stage by position. A lambda passed to `.seq()`, `.comb()`, `.every()`, `.on()`, `.state()`, `.stage()`, `.assert()`, `.assume()`, `.cover()`, a watchdog's condition, or a rewrite's `.from()` and `.to()` is later-stage code. A lambda passed to almost anything else runs now. There is no bracket syntax to learn, and the method name is always next to the lambda.

### 3.2 Tracing or parsing

There are two ways to turn later-stage code into a circuit. The first is *tracing*: call the function with stand-in objects that record every operation applied to them. Chisel (Scala), SpinalHDL (Scala) and Amaranth (Python) work this way, and it depends on operator overloading, so that `a + b` on two stand-ins records an adder.

Tracing has a known gap: host-language control flow runs at build time. An `if` on a stand-in evaluates the stand-in's truthiness once, while the circuit is built, and records only one branch. That is why those languages provide their own conditional constructs, such as Chisel's `when` and Amaranth's `with m.If`. JavaScript has the further problem that it has no operator overloading: `a + b` on two objects calls `valueOf()` and yields a number or a string. A traced JavaScript HDL would have to write `a.add(b)` and `when(c, …)` everywhere.

The second way is *parsing*. Every JavaScript function has its source text available through `Function.prototype.toString()`. The compiler parses that text into a syntax tree and translates the tree. Real operators and real `if` statements become hardware, because the translator sees them as syntax rather than executing them.

| JavaScript in a hardware lambda | Becomes |
| --- | --- |
| `a + b`, `a - b`, `a * b` | An adder, a subtractor, a multiplier |
| `&`, `\|`, `^`, `~`, and shifts by constants | Gates; constant shifts are only rewiring |
| `===`, `!==`, `<`, `>=` | Comparators |
| `c ? a : b` and `if … else` | Multiplexers, one per assigned signal |
| `const x = …` | A named wire |
| `for` with constant bounds | Unrolled copies of the body |
| `$.x = v` | An assignment; the block kind decides register or wire (Chapter 2) |
| `return v` | The next state, the output beat or the value of an inlined helper, by context |
| Loops with data-dependent bounds, recursion, new objects, closures | Rejected with a diagnostic |

An `if` statement becomes multiplexers through *path conditions*. Each assignment is guarded by the conjunction of the conditions on the path that reaches it. The final value of a signal is a priority multiplexer over its guarded assignments, with the last assignment in program order winning. In F-03, `$.phase += 1` sits on the unconditional path, so its guard is true and the register simply increments.

### 3.3 The capture rule

Parsing has one cost. A parsed lambda is not a closure. The translator sees the identifier `gamma` but has no environment in which `gamma` means anything. The function object exists in the JavaScript heap at build time; the circuit needs it as hardware, and nothing has translated it.

So Weft states a rule and checks it. A hardware lambda may refer only to `$`, its own parameters, the prelude (`wrap`, `sat`, `u`, `s`, `clog2`, `past`, `within`, `sequence` and a few more), the module's params, and the names shipped by `.lib()`. Anything else is a capture error. The check is a free-variable computation, the same one the octavo-lab compiler runs on its shipped handlers.

```text
freeVars(fn):
  bound = parameters(fn) ∪ every name declared inside fn
  used  = every identifier read inside fn, excluding property names after a dot
  return used − bound

checkCaptures(fn, module):
  allowed = {$} ∪ prelude ∪ keys(module.params) ∪ keys(module.lib)
  for v in freeVars(fn) − allowed:
    error at v's line: "captures the JS binding v"
  for each function h shipped by module.lib:
    checkCaptures(h, module)          // helpers obey the same rule
```

Run it on F-03's `.seq()` lambda. Its parameter is `$`; it declares nothing; it reads `$` and `gamma`. The free set is {`gamma`}, and `gamma` is not allowed, so the compiler reports:

```text
F-03-lambdas.js:21  error capture
  the hardware lambda in dimmer.seq uses the JS binding `gamma`
  hardware lambdas are parsed, never called, so they cannot see the variables around them
  fix: .lib({ gamma }); gamma reads GAMMA, so ship that too: .lib({ GAMMA, gamma })
```

The last line comes from the recursive call. Shipping `gamma` alone would fix this lambda and break the helper: `gamma`'s body reads `GAMMA`, which is free in it. The example's second try line asks exactly this question.

### 3.4 Why not capture automatically

The compiler could find `gamma` in the build-time environment and ship it silently. Weft refuses for four reasons.

- The build-time environment is not visible to a parser. `toString()` gives text, not the closure's bindings, so automatic capture would need a second mechanism that runs the script and inspects scopes.
- Values change. If the script modified `GAMMA` after defining the module, an automatic capture would have to pick a moment, and either choice surprises someone.
- Many JavaScript values have no hardware meaning: a `Map`, a class instance, a function that closes over mutable state. An explicit list gives the compiler one place to reject them.
- An explicit boundary can be read, diffed and patched. Chapter 17's changes patch a module's `.lib()` (`{ lib: { GAIN: 4 } }`), which is possible only because the shipped values are named in one place.

Params cross automatically because they are declared on the same builder and are constant for each specialization by definition. Chapter 4 shows how they are evaluated.

### 3.5 What `.lib()` does with each value

| Shipped JavaScript value | Hardware |
| --- | --- |
| A number or boolean | A constant of the narrowest type that holds it |
| A string | A constant name, usable where Weft expects a name, such as the stream in `$.push(Q, …)` (F-07) |
| An array of numbers | A ROM, indexed by the expression in brackets |
| An array of plain objects | A ROM of structs, indexed by a signal, such as F-19's `PALETTES` |
| An array of strings | A compile-time list, usable where the index is constant (an unrolled loop) |
| A plain object of the above | A struct of constants |
| A `rom()` builder | A memory instanced in this module |
| A function | Its source, re-parsed and inlined at each call site; its free names must also be shipped |
| Anything else | Rejected at compile time |

With the fix applied, `GAMMA` becomes a 256-entry, 8-bit ROM, 2048 bits in all. The budget `b.luts(120).brams(0)` forbids block RAM, so the compiler builds the ROM from LUTs. On the dev board's 7-series part a LUT6 is a 64-by-1 ROM, so each output bit needs four LUT6s joined by the slice's dedicated F7 and F8 multiplexers: 32 LUT6s for the table. Add a few for the 8-bit comparator and the counter, and the module fits under 120.

### 3.6 Runtime lambdas are ordinary JavaScript

The scenario's lambda is the third kind. It runs while the simulator runs, in the same JavaScript process, so it is an ordinary closure. It reads `GAMMA` directly, and nothing objects.

```js
  .scenario("half the switches, a fifth of the light", async tb => {   // runtime lambda: plain async JS
    await tb.set("sw:0..7", 128);
    const duty = await tb.measure("led:0", { over: "1ms" });          // the fraction of time it was high
    tb.expect(Math.abs(duty - GAMMA[128] / 256) < 0.01);              // runtime lambdas may use JS values freely
  });
```

The arithmetic behind the expectation is short. `GAMMA[128]` is round(255 × (128/255)^2.2) = 56, so `pwm` is high while `phase` is below 56: 56 cycles of every 256, a duty of 0.219. A runtime lambda's limit is not what it can see but what it can touch. It reaches the hardware only through handles: `tb.set`, `tb.poke`, `tb.measure` in simulation, and register handles on a real board (Chapter 12).

### 3.7 Builder lambdas run now

`.budget(b => b.luts(120).brams(0))` calls its lambda immediately, with a small recorder object, and stores what was recorded. Builder lambdas can use any JavaScript at all. They exist instead of option objects for three reasons: the vocabulary is scoped (`b.luts` exists only inside `.budget()`), a builder lambda can be deferred until parameters are known (Chapter 4), and a lambda is a value that can be stored and reused across modules.

The table classifies every function in F-03.

| Function | Kind | Runs |
| --- | --- | --- |
| `(_, i) => Math.round(255 * (i / 255) ** 2.2)` | Plain JavaScript, not passed to Weft | Once per index, before the module exists |
| `v => GAMMA[v]` | A hardware helper, once shipped | Never; inlined into the lambda that calls it |
| `b => b.luts(120).brams(0)` | Builder | Immediately, when `.budget()` is called |
| `$ => { … }` in `.seq()` | Hardware | Never; parsed into IR |
| `async tb => { … }` | Runtime | During simulation |

### Key points

- Weft marks later-stage code by the method a lambda is passed to, not by special syntax.
- Hardware lambdas are parsed rather than traced, so JavaScript's own operators and `if` statements become hardware.
- A parsed lambda is not a closure; it may use only `$`, its parameters, the prelude, the module's params and what `.lib()` ships.
- `.lib()` translates numbers to constants, arrays to ROMs and functions to inlined helpers, and rejects values with no hardware meaning.
- Runtime lambdas are ordinary closures that touch hardware only through handles.

One kind of builder lambda was left for later: the lambda of parameters, such as `({ BITS }) => u(BITS)`. Chapter 4 shows why builders are values, how one module becomes many, and what elaboration does with a loop.

## Chapter 4 · Builders as values

Follows **F-04** (`F-04-generators.js`).

This chapter explains why every Weft builder call returns a new value instead of changing the one it was called on, and what that buys. One module description becomes a family of circuits, specialized by parameters and stamped out by ordinary JavaScript. By the end you should be able to say exactly what the elaborator evaluates, what it leaves for the hardware, and why `generate` blocks have no place in the grammar. Weft is a proposed design; the listings below are worked by hand from its semantics.

### 4.1 Every call returns a new builder

Look at the line that builds the LED bank in F-04:

```js
const bank = Array.from({ length: 8 }, (_, i) => pwm.as(`pwm-${i}`));   // eight instances of one value
```

`pwm.as("pwm-3")` must not rename `pwm`. If it did, the loop would rename one object eight times, and the bank would hold eight references to a single module called `pwm-7`. The octavo-lab grammar that inspired Weft returns `this` from every call, which is fine when each component is written once and used once. Weft's modules are written once and used many times, so its builders are immutable: a call produces a new builder and leaves its receiver untouched.

Immutability is cheap because builders are persistent data structures. A builder is a small record holding the method that made it, that method's arguments, and a pointer to the builder it was called on. `pwm.as("pwm-3")` allocates one record whose parent is `pwm`, and the eight builders in `bank` share every record above their own. Nothing is copied until elaboration walks each chain from its root and folds the recorded calls into a module definition.

| Expression | New records | Shared records |
| --- | --- | --- |
| `pwm` | 6 (`module`, `params`, `in`, `out`, `regs`, `seq`) | none |
| `pwm.as("pwm-0")` | 1 | the 6 of `pwm` |
| `pwm.with({ BITS: 12 })` | 1 | the 6 of `pwm` |
| `breathe.with({ N: 8 })` | 1 | all of `breathe` |

The same property makes builders safe to pass around. A function that receives a module cannot damage it for its other users, so a library can hand out `std.debounce` or a shared `pwm` without defensive copies.

### 4.2 Parameters, and lambdas of parameters

`.params({ BITS: 8 })` declares a parameter and its default. The interesting part is how the rest of the description uses it:

```js
const pwm = module("pwm")
  .params({ BITS: 8 })
  .in("duty", ({ BITS }) => u(BITS))                // a builder lambda of params: runs per specialization
  .out("out", bit)
  .regs(({ BITS }) => ({ phase: u(BITS) }))
  .seq($ => {
    $.phase += 1;
    $.out = $.phase < $.duty;
  });
```

The type of `duty` is not `u(8)`. It is a function from parameters to a type. When `.in()` is called, the final value of `BITS` is not yet known, because a later `.with({ BITS: 12 })` may change it. A builder lambda of parameters defers the decision to elaboration, where each specialization calls it once with its own resolved parameters. Any builder argument may take this form: a port type, a register map, a `.lib()` table, a hint.

| Specialization | `duty` | `phase` | Comparator |
| --- | --- | --- | --- |
| `pwm` | `u(8)` | `u(8)` | 8-bit less-than |
| `pwm.with({ BITS: 12 })` | `u(12)` | `u(12)` | 12-bit less-than |

Parameters also reach hardware lambdas, as constants. Chapter 3 established that a hardware lambda sees only `$`, its arguments, the prelude and what `.lib()` ships. Parameters are shipped automatically, so `breathe` can name `N` inside its `.comb()` without a capture error.

### 4.3 Elaboration is partial evaluation

Partial evaluation specializes a program with respect to the inputs known early, producing a residual program over the inputs known late. Elaboration is exactly this. Parameters, `.lib()` data, loop indices and every builder lambda are known at build time; signals are known only while the circuit runs. The elaborator evaluates the first group completely and leaves a residual circuit that depends only on the second.

The moment at which a value becomes known is its binding time, and the parser assigns one to every expression. In `breathe` the loop bound `N` and the index `i` are static, and `$.level` is dynamic:

```js
  .comb($ => {
    for (let i = 0; i < N; i++) $.duty[i] = wrap($.level + i * 32);   // N is a constant here, so the loop unrolls
  });
```

With `N = 8`, the residual is eight assignments, each with its constant folded:

```
$.duty[0] = wrap($.level + 0)
$.duty[1] = wrap($.level + 32)
$.duty[2] = wrap($.level + 64)
  …
$.duty[7] = wrap($.level + 224)
```

This is why a loop in a hardware lambda must have a static bound. A loop describes replicated circuitry, not repetition in time. `for (let i = 0; i < $.level; i++)` has no residual form, because the number of copies would depend on a value that exists only at run time, so the parser rejects it at the loop's line. Repetition in time is a register and a state machine, the subject of Chapter 6.

Partial evaluation pays off again after unrolling. Adding `i * 32` modulo 256 changes only bits 7 to 5 of `level`. The low five bits pass through as wires, and each channel needs only a 3-bit adder with a constant operand. The optimizer finds this without help (Chapter 13), because after elaboration every constant is a literal node in the graph.

### 4.4 Generate is just JavaScript

Verilog has `generate` blocks and `genvar`; VHDL has `for … generate`. Both exist because those languages need a restricted sublanguage that runs during elaboration. Weft's elaboration language is JavaScript itself, so the same work is done with `Array.from`, `map` and template strings:

```js
return design("breathing")
  .board("dev")
  .use(breathe.with({ N: bank.length }), ...bank)
  .wire(bank.map((p, i) => [`breathe.duty[${i}]`, `${p.name}.duty`]))
  .pins(Object.fromEntries(bank.map((p, i) => [`${p.name}.out`, `led:${i}`])))
```

`.wire()` accepts a list of pairs and `.pins()` an object, precisely so that plain collection code can produce them. Evaluated, the two calls are sixteen ordinary connections:

| i | Wire | Pin |
| --- | --- | --- |
| 0 | `breathe.duty[0]` → `pwm-0.duty` | `pwm-0.out` → `led:0` |
| 1 | `breathe.duty[1]` → `pwm-1.duty` | `pwm-1.out` → `led:1` |
| … | … | … |
| 7 | `breathe.duty[7]` → `pwm-7.duty` | `pwm-7.out` → `led:7` |

Note `breathe.with({ N: bank.length })`. The width of `breathe`'s output vector follows the length of a JavaScript array, so a ninth channel is one edit. In a language with a separate generate sublanguage, the array length and the vector width would be two facts kept in step by hand.

### 4.5 Instance identity and hash-consing

Eight instances of `pwm` should not cost eight elaborations. The elaborator computes a structural key for every specialization: a hash of the module's recorded calls, with parameters resolved and instance names left out. Specializations with equal keys share one elaborated definition, and each instance is a name plus a pointer to it. Constructing a value only when no structurally equal value exists is called hash-consing. The same technique returns in Chapter 13, applied to individual operations in the dataflow graph.

Worked by hand, the instance tree for F-04 has two definitions and nine instances (the hashes are illustrative):

```
def pwm#3f1a      params { BITS: 8 }   ports duty:u8 → out:bit
def breathe#c27e  params { N: 8 }      ports → duty:vec(u8, 8)

inst breathe : breathe#c27e
inst pwm-0   : pwm#3f1a
inst pwm-1   : pwm#3f1a
  …
inst pwm-7   : pwm#3f1a
```

Three consequences follow. Elaboration time grows with the number of distinct specializations, not the number of instances. A Verilog emitter run on HIR keeps one `module` per definition and instantiates it eight times, which is what a reviewer expects to read; the DAG and netlist emitters of Chapter 16 print flat logic instead. And the build cache of Chapter 13 keys on the same hash, so editing `breathe` leaves the cached `pwm#3f1a` untouched.

Elaboration is also demand-driven: only builders reachable from `design().use()` are elaborated. `breathe` with its default `N: 4` is declared but never used, so it never becomes a definition. A common misreading is that `.with()` edits the default. It does not: it returns a sibling value, and the original stays available, unchanged, to anyone else who uses it.

### 4.6 Checking the scenario

The scenario samples the duty vector after 300 ms and asks whether all eight values differ:

```js
  .scenario("eight different phases", sc => sc
    .wait("300ms")
    .expectSignal("breathe.duty", d => new Set(d).size === 8));
```

`level` starts at 0 with `up` set, and the 4 ms timer has fired 75 times by 300 ms, so `level` is 75. The channels hold 75 + 32i modulo 256: 75, 107, 139, 171, 203, 235, 11 and 43. All eight differ. The expectation is a runtime lambda, ordinary JavaScript run against the sampled vector, so it may use `Set` freely.

### Key points

- Every builder call returns a new builder and never changes its receiver, so one module can be shared, renamed and specialized safely.
- Builders are persistent: a call allocates one small record that points at its parent, and elaboration folds the chain into a definition.
- A builder argument may be a lambda of the parameters, evaluated once per specialization after `.with()` has fixed their values.
- Elaboration is partial evaluation: static values are computed, and the residual circuit depends only on signals.
- Loops in hardware lambdas need static bounds because they describe copies of circuitry, not steps in time.
- Specializations with equal structural keys share one definition, so eight instances cost one elaboration.

With modules as values, the next question is how separately written modules find each other. Chapter 5 answers it with streams: named, handshaked connections that the link pass resolves without a line of wiring.

## Chapter 5 · Events and streams

Follows **F-05** (`F-05-buttons.js`).

This chapter follows a button press from a bouncing contact to a change on eight LEDs. Along the way it defines the two kinds of event a Weft handler responds to, a beat on a stream and an edge on a port. It sets out the valid/ready handshake that every stream obeys, and the link pass that connects producers to consumers by name. It ends with the rule that keeps two modules from driving the same pin.

### 5.1 A press is not a clean edge

A push button is two metal contacts. When they close they collide, separate and collide again before settling, so the raw signal toggles for a short interval, often a few milliseconds, before it holds. This is contact bounce. Sampled at 100 MHz, one press can look like a dozen. The scenario models it explicitly with `{ bounce: "3ms" }`.

A raw button has a second problem: it is asynchronous. It changes with no relation to the clock, so a flip-flop sampling it can be caught mid-transition. Chapter 10 treats this properly. For now the rule is that every board input passes through a two-flip-flop synchronizer before any logic sees it, and Weft inserts that synchronizer when a module binds an input pin.

Debouncing is a filter with a settle window: the output adopts a new level only after the input has held that level for the whole window. Here is the core of `std.debounce` written as a hardware lambda. It is a sketch of the component's behavior, not its source:

```js
// sketch, not from the examples: the core of std.debounce
// per button: sync is the synchronized raw input, stable is the debounced level
.seq($ => {
  if ($.sync === $.stable) $.count = 0;               // nothing pending
  else if ($.count === SETTLE) { $.stable = $.sync; $.count = 0; }
  else $.count += 1;                                  // a change is pending; keep timing it
})
```

`SETTLE` comes from `.settle("10ms")` and the clock, exactly as the UART divider does in Chapter 6. On the dev board's 100 MHz clock, 10 ms is 1,000,000 cycles, so `count` needs 20 bits (2^20 = 1,048,576). Any bounce resets the count, because for a moment the input equals `stable` again.

A press that bounces for 3 ms, traced in milliseconds with `stable` starting at 0 (the bounce times are illustrative):

| Time | `sync` | `count` | `stable` | Note |
| --- | --- | --- | --- | --- |
| 0.0 ms | 1 | counting | 0 | first contact |
| 0.4 ms | 0 | 0 | 0 | bounce resets the count |
| 0.9 ms | 1 | counting | 0 | contact again |
| 2.2 ms | 0 | 0 | 0 | bounce |
| 3.0 ms | 1 | counting | 0 | contacts settle |
| 13.0 ms | 1 | 0 | 1 | held for 10 ms: one rising edge |

The chatter produces exactly one change of `stable`, 10 ms after the contacts settle. That latency is the price of the filter, and it is why the scenario waits 20 ms before checking the LEDs.

`.longPress("500ms")` adds a second counter that times how long `stable` stays high. On release the component emits one beat `{ id, long }` on its provided stream, with `long` set if the press lasted 500 ms or more. Emitting on release adds the press duration to the latency. The alternative, emitting a long press the moment 500 ms elapse, needs a second event type, and the std component takes the simpler shape.

### 5.2 An edge is a register and a gate

The second kind of event is an edge on an input port. `.on("invert.rise", …)` desugars to one register holding last cycle's value and one gate comparing it with this cycle's:

```js
// what .on("invert.rise", body) becomes (sketch)
.regs({ invert_q: bit })
.seq($ => {
  $.invert_q = $.invert;
  if ($.invert && !$.invert_q) { /* body */ }
})
```

F-05 has two handlers that write `leds`. When an edge on `invert` arrives on the same cycle as a press, both fire. By Chapter 2's merge rule, `.on("invert.rise")` is declared later, so its write wins and that cycle's press is lost. The compiler's `multi-writer` warning points at exactly this pair. A design that must keep both would handle the press and the inversion in one lambda.

The condition is true for exactly one cycle per rising transition: the cycle in which the new value has arrived and the register still holds the old one. The cost is one flip-flop and one term in a LUT, and `.fall` is the same with the inputs swapped. Edge detection only means something on a synchronized signal. On a raw pin, the two samples could disagree about a transition still in progress.

### 5.3 The valid/ready handshake

A stream is three signal groups between one producer and its consumers. `data` and `valid` travel forward, and `ready` travels backward. A transfer, called a beat, happens on a clock edge where `valid` and `ready` are both high. The rules are those of the AMBA AXI4-Stream protocol, and they are short:

1. A beat transfers on any rising clock edge where `valid` and `ready` are both 1.
2. Once the producer raises `valid`, it holds `valid` and `data` unchanged until a beat transfers.
3. `valid` must not depend combinationally on `ready`; `ready` may depend on `valid`.

Rule 2 means a producer never retracts an offer, so a consumer may take its time. Rule 3 prevents a loop. If the producer's `valid` waited for `ready` while the consumer's `ready` waited for `valid`, the two would form a combinational cycle across a module boundary, which `checks.loops` rejects. With rule 3 in force, any producer can be connected to any consumer without inspecting either one's internals.

A worked trace with the consumer briefly not ready:

| Cycle | `valid` | `data` | `ready` | Beat |
| --- | --- | --- | --- | --- |
| 0 | 0 | – | 1 | none |
| 1 | 1 | A | 1 | A |
| 2 | 1 | B | 0 | none: B is held |
| 3 | 1 | B | 0 | none: B is held |
| 4 | 1 | B | 1 | B |
| 5 | 1 | C | 1 | C |
| 6 | 0 | – | 1 | none |

The handler syntax hides all three signals. `.on("presses", ($, p) => …)` drives the module's `ready` for `presses`, binds `p` to `data`, and runs the body only on cycles where a beat fires:

```js
  .on("presses", ($, p) => {                        // runs on the cycle a beat arrives; ready is handled for you
    $.leds = p.long ? 0 : $.leds ^ (1 << p.id);
  })
```

Here `ready` is simply 1. If a body pushed to a stream of its own, its `ready` would become that push's acceptance, so backpressure propagates without being written. The lower-level verbs used in Chapters 6 and 7 expose the same signals directly: `$.has(s)` reads `valid`, and `$.take(s)` raises `ready` for this cycle and returns `data`.

### 5.4 Linking by name

Neither module in F-05 mentions the other. `buttons` declares `.provides("presses")`, `lights` declares `.needs("presses")`, and the design says only `.use(buttons, lights)`. The link pass resolves the connection.

The link pass builds a bipartite graph with producers on one side and consumers on the other, joined where names match. In practice it is a hash map from stream name to its producers and consumers, filled in one pass over every module's declarations and checked in a second, so its cost is linear in the number of declarations. The checks are what make name-based linking safe:

| Situation | Result |
| --- | --- |
| One producer, one or more consumers | Linked. With several consumers, a fork is inserted that delivers each beat to all of them and holds it until every one has taken it. |
| A need with no producer | Error at the `.needs()` line: an unmet need, with the stream's name. |
| Two producers of one name | Error naming both `.provides()` lines. |
| A provided stream nobody needs | Warning; dead-code elimination removes it. |
| Producer and consumer disagree on the beat type | Error from the widths pass, at the `.push()` that produced the wider type. |

Linking by name decouples modules the way octavo-lab's channels do: a module states what it offers and what it requires, and the composition is checked as a whole. `.wire()` remains for port-to-port connections, as in F-02 and F-04, where there is no handshake to manage.

### 5.5 One owner per output pin

`.bind({ invert: "sw:0", leds: "led:0..7" })` connects ports to board resources, and the range `led:0..7` expands to eight resources, one per bit. Binding an output claims ownership. The link pass keeps a map from resource to owner and rejects a second claim, naming both binding lines.

The rule follows from the fabric. Inside a modern FPGA there are no internal tri-state buses, so two drivers on one net cannot be resolved into one value. Synthesis tools report this as a multiple-driver error, usually far from the code that caused it; Weft reports it during elaboration, at the source line. Inputs carry no such restriction. Any number of modules may read `sw:0`, because fan-out from one driver to many loads is ordinary wiring.

### 5.6 The scenario, step by step

Each step of the scenario exercises one mechanism from this chapter:

| Step | What arrives at `lights` | `leds` after |
| --- | --- | --- |
| press `btn:2` | one beat `{ id: 2, long: 0 }` | `0b0000_0100` |
| press `btn:0` with 3 ms of bounce | one beat `{ id: 0, long: 0 }`; the chatter is filtered | `0b0000_0101` |
| toggle `sw:0` | a rising edge on `invert` | `0b1111_1010` |
| hold `btn:1` for 600 ms | one beat `{ id: 1, long: 1 }` | `0` |

The XOR `$.leds ^ (1 << p.id)` stays 8 bits wide, because `1 << p.id` is at most `0b1000`, so no `wrap()` is needed. The inversion `~$.leds` is 8 bits wide as well. The width rules of Chapter 2 apply to every expression here, including the ones the reader never has to think about.

### Key points

- Debouncing is a filter: the output changes only after the synchronized input has held a new level for the whole settle window.
- An edge event is one register and one gate, and it only means something on a synchronized signal.
- A stream beat transfers when `valid` and `ready` are both high; the producer holds its offer, and `valid` never depends on `ready`.
- `.on(stream, …)` manages `ready` and runs its body only on cycles where a beat fires.
- The link pass matches producers to consumers by name and reports unmet needs and duplicate producers at their source lines.
- An output pin has exactly one owner, because the fabric cannot resolve two drivers on one net.

The `presses` stream carried one event at a time to a module that reacted within a cycle. Chapter 6 takes on a module that must remember where it is in a longer sequence: a UART transmitter written as a state machine.

## Chapter 6 · State machines

Follows **F-06** (`F-06-fsm.js`).

This chapter explains how Weft describes sequential behavior: a machine that is in one of a fixed set of states and moves between them as inputs arrive. It shows why each state is written as a lambda that returns its successor, how the compiler recovers the transition graph from those returns, and how it chooses the bits that represent each state. The running example is a UART transmitter, and the chapter ends by working one frame of it through, bit by bit.

### 6.1 Moore and Mealy

A finite-state machine is a set of states S, an initial state s0, a next-state function δ and an output function λ. A Moore machine's outputs depend on the state alone; a Mealy machine's outputs depend on the state and the current inputs:

```latex
s_{t+1} = \delta(s_t, x_t) \qquad y_t = \lambda(s_t) \ \text{(Moore)} \qquad y_t = \lambda(s_t, x_t) \ \text{(Mealy)}
```

In hardware both are the same three parts: a state register, combinational logic computing δ, and combinational logic computing λ. The difference shows at the outputs. A Mealy output can change in the middle of a cycle when an input changes, and it can glitch while its logic settles; a Moore output changes only after a clock edge.

Weft goes one step further. An output written inside a state lambda is written in a clocked block, so by Chapter 2's rule it is a register. It changes exactly at a clock edge and never glitches. For a UART line this is the property that matters, because a brief low glitch on an idle line is read by the receiver as a start bit. The cost is one cycle of latency: `$.line = 0` in `start` takes effect one cycle after the machine enters `start`. Every bit is delayed by the same cycle, so the bit periods are unchanged.

### 6.2 A state is a lambda that returns its successor

Here is the transmitter:

```js
const tx = fsm("uart-tx")
  .params({ BAUD: 115_200 })
  .needs("bytes")
  .out("line", bit.init(1))                         // a UART line idles high
  .regs({ shift: u(8), n: u(3), wait: u(16) })
  .lib(({ BAUD }, { clock }) => ({ DIV: Math.round(clock.hz / BAUD) - 1 }))   // builder lambda: params and clock
  .lib({ baud })
  .initial("idle")
  .state("idle", $ => {
    $.line = 1;
    if ($.has("bytes")) { $.shift = $.take("bytes"); $.wait = DIV; return "start"; }
  })
  .state("start", $ => { $.line = 0; if (baud($)) return "data"; })
  .state("data", $ => {
    $.line = $.shift[0];
    if (!baud($)) return;
    $.shift >>= 1;
    $.n += 1;                                       // wraps back to 0 after the eighth bit
    if ($.n === 7) return "stop";
  })
  .state("stop", $ => { $.line = 1; if (baud($)) return "idle"; });
```

Each state is the code that runs while the machine is in it. It drives outputs, updates registers and returns the name of the next state; returning nothing stays put. The three common ways to write a state machine put the transitions in different places:

| Style | Where a transition lives | Typical failure |
| --- | --- | --- |
| A transition table of `{ from, to, when }` | Apart from the actions | Conditions and actions drift apart as the machine grows |
| A Verilog `case` assigning `next` in a combinational block | In the case arm | A path that forgets to assign `next` infers a latch |
| A lambda per state (Weft) | In the state's own code | A path that returns nothing stays, by definition |

The third row is the reason for the design. The state register holds its value unless a transition fires, so a missing `return` is a self-loop by construction, and no path can infer a latch. A state's outputs, register updates and exits are also in one place.

The helper `baud($)` is shipped by `.lib({ baud })` and inlined at each call. It counts `wait` down to zero, reloads it with `DIV`, and returns 1 on the reload cycle. Only one state is active at a time, so the three inlined copies write `wait` under mutually exclusive conditions and merge into one decrement-or-reload circuit.

### 6.3 Recovering the transition graph

`fsm.extract` reads the transition graph out of the code. It is a control-flow analysis over each state's parsed lambda, after helpers are inlined. Every path from the lambda's entry to a `return`, or to its end, is collected with its path condition: the conjunction of the branch conditions taken along it. A path ending in `return "x"` becomes an edge to x guarded by that condition, and a path ending without a name becomes a self-loop.

For `data`, with `baud($)` inlined, the call returns 1 exactly when `wait` is 0:

| Path | Condition | Ends in | Edge |
| --- | --- | --- | --- |
| 1 | wait ≠ 0 | `return;` | data → data |
| 2 | wait = 0 ∧ n ≠ 7 | end of lambda | data → data |
| 3 | wait = 0 ∧ n = 7 | `return "stop"` | data → stop |

Done for all four states, the analysis yields the machine's edges; every other path is a self-loop:

| From | To | Guard |
| --- | --- | --- |
| idle | start | `has("bytes")` |
| start | data | wait = 0 |
| data | stop | wait = 0 ∧ n = 7 |
| stop | idle | wait = 0 |

&#91;embedded content: uart-tx state graph · 4 states, 4 guarded transitions, a self-loop on every other path\]

Each arrow between states is one path that ends in a `return`; every other path ends without a name and is the self-loop marked stay.

The next-state function δ is then a multiplexer per state, selecting among its guarded successors in program order. The first `return` a path reaches wins, which is exactly what the JavaScript reading of the lambda says.

The analysis needs successor names to be literals. `return "stop"` names a state the compiler can check, while `return NEXT[$.n]` would make the successor a run-time value and the graph unknowable, so the parser rejects any `return` that is not a string literal. With the graph in hand, the pass checks it. A name that is not a declared state is an error at the `return`'s line, a state unreachable from `initial` is a warning, and a state with no way out is reported so the author can confirm it is meant to be terminal. The guards also feed the formal tools of Chapter 11, which can ask whether two guards leaving one state are ever true together.

### 6.4 Choosing an encoding

The four states must be represented in flip-flops, and `fsm.encode` chooses how. The example's try line forces one choice with `.encode("onehot")`.

| Encoding | uart-tx codes | Flip-flops for N states | Next-state logic | Trade-off |
| --- | --- | --- | --- | --- |
| Binary | idle 00, start 01, data 10, stop 11 | ⌈log2 N⌉ | Each bit depends on every state bit and the guards | Fewest flip-flops; decoding deepens as N grows |
| One-hot | 0001, 0010, 0100, 1000 | N | Each bit is the OR of its incoming edges | Shallow, fast logic; 2^N − N illegal patterns |
| Gray | 00, 01, 11, 10 in cycle order | ⌈log2 N⌉ | As binary | Each step along the cycle flips exactly one bit |

Gray suits uart-tx well. The machine walks a single cycle, idle → start → data → stop → idle, so ordering the codes 00, 01, 11, 10 along it makes every transition a one-bit change. That reduces switching, and it matters if the state is ever sampled from another clock domain (Chapter 10), where a two-bit change can be caught half done.

On FPGAs, flip-flops are plentiful: an iCE40 logic cell pairs each LUT4 with a flip-flop, and a 7-series slice has four LUT6s and eight flip-flops. One-hot spends those cheap flip-flops to keep next-state logic within one LUT level, which is why synthesis tools commonly choose it for larger machines. Weft's proposed `auto` rule uses Gray for a machine whose transitions form a single cycle, binary for other machines of up to four states, and one-hot above that; a LUT6 decodes more state bits in one level than a LUT4, so the threshold can move with the part. One caution applies to one-hot: its illegal patterns have no exits. `fsm.encode` can add recovery logic that returns any illegal pattern to the initial state, at the cost of a few LUTs.

### 6.5 UART framing and the baud divider

A UART line in 8N1 format idles at 1. A frame is a start bit (0), eight data bits sent least-significant first, no parity bit, and one stop bit (1). Every bit lasts one bit period, which at 115,200 baud is 8.68 µs.

The bit period is counted in clock cycles, so the divider depends on the clock. The builder lambda receives the parameters and the module's environment, computes the divider once per specialization, and ships it as the constant `DIV`:

```latex
\mathit{DIV} = \operatorname{round}\!\left(\frac{f_{clk}}{\mathit{baud}}\right) - 1 = \operatorname{round}\!\left(\frac{12\,000\,000}{115\,200}\right) - 1 = \operatorname{round}(104.17) - 1 = 103
```

`baud($)` counts `wait` from 103 down to 0 and reloads, so each bit lasts DIV + 1 = 104 cycles. The same source on a different board computes a different divider without an edit:

| Board | Clock | DIV | Cycles per bit | Actual rate | Error |
| --- | --- | --- | --- | --- | --- |
| pico | 12 MHz | 103 | 104 | 115,384.6 baud | +0.16 % |
| dev | 100 MHz | 867 | 868 | 115,207.4 baud | +0.0064 % |

A receiver resynchronizes on every start bit's falling edge and samples each bit near its middle. By the middle of the stop bit, a +0.16 % rate error has accumulated to about 1.5 % of one bit period, far inside the half-bit margin of a mid-bit sampler.

Here is one frame for the byte `h` (0x68, binary 0110 1000), one row per bit period of 104 cycles:

| Bit period | State | `line` | `shift` | `n` |
| --- | --- | --- | --- | --- |
| start | start | 0 | 0x68 | 0 |
| d0 | data | 0 | 0x68 | 0 |
| d1 | data | 0 | 0x34 | 1 |
| d2 | data | 0 | 0x1A | 2 |
| d3 | data | 1 | 0x0D | 3 |
| d4 | data | 0 | 0x06 | 4 |
| d5 | data | 1 | 0x03 | 5 |
| d6 | data | 1 | 0x01 | 6 |
| d7 | data | 0 | 0x00 | 7 |
| stop | stop | 1 | 0x00 | 0 |

The `line` column reads 0 0 0 1 0 1 1 0 across d0 to d7, which is 0x68 least-significant bit first. At the end of d7, `n` is 7, so the guard wait = 0 ∧ n = 7 holds and the machine leaves for `stop` while `n` wraps to 0. After the stop period, `idle` spends one cycle seeing the next byte, so back-to-back frames have a stop bit one cycle longer than 104. Receivers accept that, because a stop bit may last any length of at least one period. A frame takes 1,040 cycles, about 86.7 µs, and all of `hello\r\n` about 0.61 ms, well inside the scenario's 1.1 s windows.

The greeter feeds the transmitter. `MSG` is an array of seven numbers, so `.lib()` turns it into a 7-entry ROM indexed by `i`. `$.go && $.push("bytes", MSG[$.i])` offers a beat only while `go` is set, and `push()` returns 1 on the cycle the beat transfers, so `i` advances only on a delivered byte. The eight-entry `bytes` buffer holds the whole message, so the greeter finishes in seven cycles and the transmitter drains it at one byte per frame. `go` is written in two blocks: `.every()` sets it and `.seq()` clears it after the last byte. `.seq()` is declared second, so by Chapter 2's merge rule its clear would win on a shared cycle. That never happens here, because the message ends seven cycles after the tick, but the SAT check sees only the guards, so the compiler still warns.

### Key points

- An output written in a state lambda is a register, so the machine's outputs are glitch-free at the cost of one cycle of latency.
- A state is a lambda that returns its successor; returning nothing is a self-loop, so no path can infer a latch.
- `fsm.extract` recovers the transition graph by collecting each path to a `return` with its path condition, and it requires successor names to be literals.
- Binary, one-hot and Gray encodings trade flip-flops against next-state logic depth; Gray makes every step of a cyclic machine a one-bit change.
- The baud divider is computed by a builder lambda from the parameters and the clock, so the same source is correct on every board.

The transmitter consumed its input through an eight-entry buffer declared with `overflow: "block"`. Chapter 7 explains what that declaration means, what the alternatives are, and what each one does to a producer that runs faster than its consumer.

## Chapter 7 · Backpressure

Follows **F-07** (`F-07-backpressure.js`).

This chapter is about a producer that offers data faster than its consumer takes it. A buffer absorbs a short mismatch, but a sustained one must be resolved by a policy, and Weft's four policies make four different promises about loss, order and the producer's progress. The chapter also explains how the compiler builds each buffer, and why a registered `ready` needs a two-entry skid buffer.

### 7.1 Rates, buffers and Little's law

In F-07 each producer offers one beat per cycle and each consumer takes one beat every four cycles. A buffer hides such a mismatch only for a while. If arrivals exceed departures on average, any finite buffer fills, and from then on either the producer waits or data is lost.

Little's law relates the quantities that matter. For any stable queue, whatever its arrival pattern, the average number of items in it equals the average throughput times the average time each item spends inside:

```latex
L = \lambda W
```

Apply it to `q.block` once it is full. L is 16 entries, and λ is 0.25 beats per cycle, because the consumer's rate now sets everyone's rate. So W = 16 / 0.25 = 64 cycles: every value waits 64 cycles between its push and its take. Under sustained overload, a deeper buffer buys nothing but latency. Buffers are for bursts: they let a producer run ahead for a while when its average rate is no higher than the consumer's.

### 7.2 Four overflow policies

F-07 declares its four queues from a table, with a generator loop of the kind Chapter 4 described:

```js
const policies = {
  "q.block":  { depth: 16, overflow: "block" },
  "q.oldest": { depth: 16, overflow: "drop-oldest" },
  "q.newest": { depth: 16, overflow: "drop-newest" },
  "q.latest": { depth: 1,  overflow: "latest" },      // a register: the consumer always sees the freshest value
};
const names = Object.keys(policies);

const queues = names.map(n => stream(n)             // depth 1 → a register, 16 → LUT RAM, ≥ 64 → block RAM
  .of(u(16))
  .buffer(policies[n].depth, { overflow: policies[n].overflow }));
```

The policies differ only in what happens when a beat arrives at a full buffer:

| Policy | `ready` to the producer | Full buffer, beat arrives | The consumer sees | Lost beats |
| --- | --- | --- | --- | --- |
| `block` | low while full | The producer holds the beat (rule 2 of Chapter 5) | Every value, in order | None |
| `drop-oldest` | always high | The head is discarded and the beat appended | The 16 most recent values | Counted |
| `drop-newest` | always high | The arriving beat is discarded | The backlog, in order, then a jump | Counted |
| `latest` | always high | The single entry is overwritten | The freshest value | Counted, one per overwrite |

Each suits a different kind of data. `block` is for events that must all arrive, such as the bytes of a message or commands. `drop-oldest` suits telemetry where recent history matters, and `drop-newest` suits capture, where the start of a burst is the valuable part. `latest` is for state rather than events, such as a position or a sensor reading; Chapter 10 uses it for a sprite's coordinates.

The producers and consumers are generated too. A producer advances its sequence number only when a push is accepted, and a consumer takes on one cycle in four and counts gaps in the sequence:

```js
const producers = names.map(n => module(`fast-${n.slice(2)}`)
  .provides(n)
  .lib({ Q: n })                                    // a constant string names the stream inside the lambda
  .regs({ seq: u(16) })
  .seq($ => { if ($.push(Q, $.seq)) $.seq += 1; })); // a lossy stream always accepts; "block" may not

const consumers = names.map(n => module(`slow-${n.slice(2)}`)
  .needs(n)
  .lib({ Q: n })
  .regs({ last: u(16).init(0xffff), gaps: u(16), busy: u(2) })
  .seq($ => {
    $.busy += 1;                                    // ready on one cycle in four
    if ($.busy === 0 && $.has(Q)) {
      const v = $.take(Q);
      if (v !== wrap($.last + 1)) $.gaps += 1;
      $.last = v;
    }
  }));
```

`last` starts at 0xFFFF so that the first value, 0, is its wrapped successor and is not counted as a gap. The values each consumer takes in the first 32 cycles follow. They come from a small cycle model of these semantics, worked by hand in JavaScript, not from a simulator:

| Cycle | slow-block | slow-oldest | slow-newest | slow-latest |
| --- | --- | --- | --- | --- |
| 4 | 0 | 0 | 0 | 3 |
| 8 | 1 | 1 | 1 | 7 |
| 12 | 2 | 2 | 2 | 11 |
| 16 | 3 | 3 | 3 | 15 |
| 20 | 4 | 4 | 4 | 19 |
| 24 | 5 | 8 | 5 | 23 |
| 28 | 6 | 12 | 6 | 27 |
| 32 | 7 | 16 | 7 | 31 |

The three 16-deep queues behave identically until they fill, around cycle 19. After that, `drop-oldest` jumps ahead by four per take, because four newer values have pushed four older ones out in the meantime. `drop-newest` keeps delivering its backlog in order, so its values are in sequence but old. `latest` delivers whatever arrived most recently, every fourth value. Over the scenario's 4,000 cycles the same model gives 999 takes for every consumer. `q.block` drops nothing, and its producer issued only 1,015 values: 999 taken and 16 still queued. `q.oldest` and `q.newest` each drop 2,985 of 4,000 offers, and `q.latest` overwrites 3,000, consistent with the scenario's `expectDropped("q.newest", n => n > 2000)`.

### 7.3 What block does to the producer

Under `block`, `$.push(Q, $.seq)` returns 1 only on cycles where the queue has room. In steady state that is one cycle in four, so the producer's `seq` advances at the consumer's pace. The producer has slowed down without any code that mentions slowing down.

The wait propagates upstream. Chapter 5 noted that a handler which pushes ties its own input `ready` to the push's acceptance, so a producer that is itself a consumer passes the stall back to its source. Backpressure travels one module at a time until it reaches a source that can wait, or a lossy policy that absorbs it.

A producer that feeds several streams and waits whenever any of them is full suffers head-of-line blocking: the slowest consumer sets the rate for all of them. octavo-lab's preset O-07, which F-07 follows, used one producer for four channels, and its blocking channel slowed the other three. F-07 avoids this by giving each queue its own producer through the generator loop, so `block` throttles only its own path.

Blocking streams that form a cycle can deadlock when every buffer in the cycle is full and every module waits to push before it takes. The link pass already holds the stream graph from Chapter 5, so Weft reports any cycle made entirely of blocking streams for the author to examine.

### 7.4 How stream.lower builds a buffer

A buffer of depth D = 2^k is a circular array with a write pointer and a read pointer. Each pointer has k + 1 bits, one more than the address needs. The extra bit distinguishes a full buffer from an empty one, since both have equal addresses. Sketched as a hardware lambda for D = 16 (this is not std's source):

```js
// sketch, not from the examples
// write and read pointers of a 16-deep FIFO: 4 address bits plus a wrap bit
.regs({ wp: u(5), rp: u(5) })
.comb($ => {
  $.empty = $.wp === $.rp;
  $.full = $.wp.bits(3, 0) === $.rp.bits(3, 0) && $.wp[4] !== $.rp[4];
})
```

The four policies change one decision. `block` drives `ready` as the inverse of `full`. `drop-oldest` advances `rp` together with `wp` when full, `drop-newest` suppresses the write and counts it, and `latest` needs no pointers at all, because it is a single register with a valid bit.

`stream.lower` chooses the storage from the depth, the width and the part. The thresholds below are Weft's proposed defaults, and a stream can override them:

| Depth | dev board (xc7a35t) | pico (iCE40 UP5K) |
| --- | --- | --- |
| 1 | A register | A register |
| 2 | Two registers: a skid buffer (7.5) | Two registers |
| 3 to 63 | LUT RAM, or flip-flops when tiny | Flip-flops, or one EBR when wide |
| 64 and up | Block RAM, 18 or 36 Kbit | EBR, 4 Kbit each |

The split follows the fabric. On 7-series parts, LUTs in SLICEM slices can be written as memory, and a LUT6 holds 64 bits. The 256 bits of a 16 × 16 queue therefore fit in a handful of LUTs plus pointer logic, while a 36 Kbit block RAM would sit almost empty. The iCE40 has no LUT RAM, so its small queues are flip-flops, from a pool of 5,280, or a share of one of its thirty 4 Kbit EBR blocks.

### 7.5 Skid buffers

`ready` travels backward, and that makes it a timing hazard. If each stage of a chain computes its `ready` combinationally from the next stage's, the signal crosses every stage within one cycle, and the critical path grows with the chain. Registering `ready` cuts the path but delays it by a cycle. When the consumer lowers `ready`, the producer sees it one cycle late, and in that cycle it has already sent one more beat. That beat needs somewhere to go, so a stage with a registered `ready` needs a second entry. The pair is called a skid buffer: a main register that drives the output, and a skid register that catches the extra beat.

A trace, with each row showing the registers at the start of the cycle:

| Cycle | Main | Skid | `ready` to upstream | Upstream offers | Downstream `ready` | Transfers |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | – | – | 1 | A | 1 | A in |
| 1 | A | – | 1 | B | 0 | B in, to skid |
| 2 | A | B | 0 | C, held | 0 | none |
| 3 | A | B | 0 | C, held | 1 | A out; B moves to main |
| 4 | B | – | 1 | C | 1 | B out, C in |
| 5 | C | – | 1 | – | 1 | C out |

Cycle 1 is the reason for the design. The stage's `ready` was registered as 1 at the end of cycle 0, when the skid was empty, so B arrives even though downstream has just stopped. Without the skid register, B would be lost, or `ready` would have to be combinational again. This is the trade `.stall("skid")` makes in Chapter 9: a few registers for a shorter critical path.

### 7.6 Drop counters

Loss that cannot be observed cannot be debugged. Every lossy buffer therefore carries a 16-bit counter that increments on each dropped beat. Weft's proposed choice is to saturate at 65,535 rather than wrap, so a large loss never reads as a small one. The counter is a saturating kind of Chapter 12's status register: the host reads it through the register map but never subtracts two readings, as it would with a wrapping counter, and a scenario checks it with `expectDropped`. A `block` stream's counter is 0 by construction, which is what `expectDropped("q.block", 0)` asserts. The cost is 16 flip-flops and a short carry chain.

### Key points

- A buffer absorbs bursts, but under sustained overload it only adds latency, as Little's law (L = λW) makes exact.
- The four policies differ only at a full buffer: `block` makes the producer wait, and the others keep accepting and count what they lose.
- Under `block`, backpressure propagates upstream module by module; one producer feeding several streams suffers head-of-line blocking.
- `stream.lower` builds a register for depth 1, a skid buffer for depth 2, LUT RAM or flip-flops for small depths, and block RAM for deep buffers.
- A registered `ready` arrives one cycle late, so the stage needs a second entry to catch the beat sent in that cycle.
- Lossy buffers count their drops in hardware, where the host and the scenarios can read them.

Deep buffers become block RAM, and block RAM has rules of its own: its reads take a cycle, and its size comes in fixed blocks. Chapter 8 takes up memories and tables, starting with a ROM filled by a builder lambda.

## Chapter 8 · Tables and memories

Follows **F-08** (`F-08-memories.js`).

This chapter explains where a design keeps numbers it cannot compute in one cycle, and why Weft makes the cost of reading them visible in the grammar. F-08 has two kinds of storage. One is a sine table whose contents are fixed when the design is built. The other is a delay line whose contents change 48,000 times a second. They end up in the same kind of silicon for different reasons, and the chapter follows both. As in the rest of this book, Weft is a proposed design: the traces below are worked by hand from its rules, not printed by a tool.

### 8.1 A table is a function written out

The sine table is built by a builder lambda that runs 1,024 times while the design is being built:

```js
const sine = rom("sine")
  .of(s(12))
  .from(1024, i => Math.round(2047 * Math.sin((2 * Math.PI * i) / 1024)));   // builder lambda, called 1024 times now
```

Nothing about sines reaches the hardware. The lambda produces 1,024 integers between −2047 and 2047, and the ROM stores them. This is the general pattern for anything expensive to compute but cheap to look up: do the arithmetic in JavaScript, at build time, with full floating-point precision, and ship only the results.

The same reasoning explains a rule from Chapter 3: an array shipped with `.lib()` becomes a ROM. Inside a hardware lambda, `SINE[i]` with a constant `i` folds to a constant. With a signal as the index it is a function from a 10-bit address to a 12-bit value. Hardware has exactly two ways to build an arbitrary function of a variable: a tree of logic that encodes the table, or a memory that stores it. Either way it is a ROM, so the grammar says so.

### 8.2 Where a table lives

The pass that chooses between those two forms is `mem.infer`. Its choice follows from what the parts offer, so it pays to know the numbers.

| Storage | iCE40 UP5K | Xilinx 7-series | Read timing |
| --- | --- | --- | --- |
| Logic (LUT ROM) | 5,280 LUT4s in total | LUT6s, 64 bits each | Combinational |
| Block RAM | 30 × 4 Kbit EBR (256×16, 512×8, 1024×4 or 2048×2) | 36 Kbit blocks, each splittable into two 18 Kbit halves | Synchronous: one clock edge |
| Large RAM | 4 × 256 Kbit SPRAM (16K × 16, single port) | none on the part used here | Synchronous |

A 1,024 × 12 table in LUT6s costs 16 LUTs per output bit just to hold the contents, plus a 16-to-1 multiplexer to pick among them, so roughly 250 LUT6s for the whole table. In block RAM it fits in one 18 Kbit half of a 36 Kbit block, configured 1K × 18. On the iCE40 it needs three 4 Kbit EBRs set to 1024 × 4. The block RAM is the obvious winner, with one condition: it cannot answer in the same cycle.

`mem.infer` therefore asks three questions of each table. How many bits does it hold? Is its result registered anyway? Does the module's `.budget()` allow block RAM? In F-08 the read happens inside `.every("48 kHz")` and the result goes straight into `$.push()`, whose output is a register. The register the block RAM needs already exists in the design, so the table goes to block RAM at no cost in latency. In F-03, `.budget(b => b.luts(120).brams(0))` forbids block RAM, and the 256 × 8 gamma table is built from LUTs instead.

### 8.3 Synchronous reads, made explicit

A block RAM is an array of static memory cells with a registered address in front and sense amplifiers behind. The address is captured on a clock edge, the data is valid shortly after that same edge, and the logic that uses it captures it at the next one. An optional output register, which the 7-series and ECP5 blocks offer, adds a second cycle in exchange for a faster clock. The one cycle of the registered address is not an implementation detail that a better tool could remove. It is how the block is built.

Verilog leaves this to pattern matching. Write `always @(posedge clk) q <= mem[addr];` and the synthesizer recognizes a block RAM. Write the read as combinational logic and it quietly builds LUT RAM, or a pile of flip-flops, and the designer learns about it from a utilization report. Weft takes the opposite position: a RAM read is two statements, separated by a clock edge, and the grammar spells both.

```js
const echo = module("echo")
  .needs("dry").provides("wet")
  .ram("delay", { of: s(12), words: 8192 })         // 8192 × 12 bits
  .regs({ at: u(13) })
  .on("dry", ($, x) => {
    const back = $.delay.q;                         // what the last read() returned: reads take a cycle
    const y = sat(x + (back >> 1), s(12));          // 13 bits back into 12 by saturating, never by accident
    $.delay.write($.at, y);
    $.delay.read(wrap($.at + 1));                   // the oldest sample, ready by the next beat
    $.at += 1;
    $.push("wet", y);
  });
```

`$.delay.read(addr)` issues a read this cycle. `$.delay.q` is the value that the previous `read()` asked for. There is no way to write a combinational read of `delay`, so there is no way to get LUT RAM by accident. The reader of the code sees the latency where it happens.

### 8.4 The echo as a circular buffer

The delay line holds the last 8,192 output samples. `$.at` is a 13-bit write pointer, and because 2^13 = 8192, `$.at += 1` wraps from 8191 back to 0 with no comparison. Each beat writes the new sample at `$.at` and asks for the slot after it, which is the oldest sample in the buffer. By the next beat that slot's value has arrived in `$.delay.q`, and it is overwritten in the same beat that consumes it.

| Beat | `$.at` | `back` (= `$.delay.q`) | Write | Read issued |
| --- | --- | --- | --- | --- |
| n | 100 | y from beat n − 8192 | `delay[100] ← y_n` | address 101 |
| n + 1 | 101 | `delay[101]` = y from beat n − 8191 | `delay[101] ← y_n+1` | address 102 |
| n + 2 | 102 | `delay[102]` = y from beat n − 8190 | `delay[102] ← y_n+2` | address 103 |

The read of a slot always happens one beat before the write to it, so the two never collide. At 48 kHz, 8,192 samples is a delay of 170.7 ms. Because the buffer stores outputs rather than inputs, the echo feeds back on itself:

```latex
y[n] = \operatorname{sat}\left(x[n] + \tfrac{1}{2}\, y[n-8192]\right)
```

Each repeat is half as loud as the one before it. A feedback gain below 1 is what keeps this recursion stable; Chapter 17 meets a filter where a careless change pushes the gain inside the loop above 1.

### 8.5 Direct digital synthesis

The oscillator is a phase accumulator: a 32-bit register that adds a constant every sample and wraps on overflow.

```js
const osc = module("osc")
  .params({ HZ: 440 })
  .provides("dry")
  .lib({ SINE: sine })                              // a rom shipped by .lib() is instanced in this module
  .lib(({ HZ }) => ({ STEP: Math.round((HZ * 2 ** 32) / 48_000) }))   // the tuning word, computed at build time
  .regs({ phase: u(32) })
  .every("48 kHz", $ => {
    $.phase += STEP;
    $.push("dry", SINE[$.phase.bits(31, 22)]);      // the top ten bits index the table
  });
```

The register stands for a phase between 0 and 2π, scaled so that 2^32 is one full turn. Wrapping on overflow is exactly right here: the phase after a full turn is the phase before it. The output frequency and the tuning word are related by

```latex
f_{\text{out}} = \frac{\text{STEP} \cdot f_s}{2^{32}}, \qquad \text{STEP} = \operatorname{round}\!\left(\frac{f \cdot 2^{32}}{f_s}\right), \qquad \Delta f = \frac{f_s}{2^{32}}
```

For 440 Hz at 48 kHz, STEP = 39,370,534 and the true output is 440.000005 Hz. The resolution Δf is about 11 µHz. A wider accumulator costs one adder bit per bit of resolution, which is why 32 bits is common.

Only the top ten bits of the phase index the table. Dropping the other 22 is called phase truncation, and it makes the phase error periodic, which puts spurious tones into the output. A standard rule of thumb puts the spurious-free dynamic range near 6.02 dB per address bit, so about 60 dB for a 1,024-entry table. The 12-bit amplitude sets a separate limit of about 74 dB of signal to quantization noise. Storing only a quarter wave and mirroring it, the first item on F-08's try line, keeps both limits and saves three quarters of the storage.

### 8.6 Wrapping and saturating

Both operations shorten a value that has grown, and the difference between them is the difference between a phase and a sound. In the echo, `x` is `s(12)` and `back >> 1` is `s(11)`, so their sum is `s(13)`. Take x = 2000 and back = 1000. The sum is 2500, which does not fit in 12 bits.

| Operation | Result | What the listener hears |
| --- | --- | --- |
| `wrap(2500)` to `s(12)` | 2500 − 4096 = −1596 | A loud click: the waveform jumps from near the top to near the bottom |
| `sat(2500, s(12))` | 2047 | A slightly flattened peak |

Wrapping is the correct arithmetic for counters and phases, where values live on a circle. Saturation is correct for signals, where values live on a line. In hardware, saturation is cheap: the value overflowed exactly when the bits above the target width are not all equal to the new sign bit, and a multiplexer then picks 2047 or −2048 by the original sign. Weft makes the designer choose because the compiler cannot know which kind of number a register holds.

### 8.7 One bit of output: the sigma-delta DAC

The dev board's audio pin is a single digital output behind a resistor-capacitor filter. `std.sigmaDelta` turns 12-bit samples into a one-bit stream at the 100 MHz system clock. A first-order modulator is an accumulator whose carry-out is the output bit. On average the carry fires at a rate proportional to the input. A 3-bit accumulator with input 3 shows the pattern:

| Cycle | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| acc + 3 | 3 | 6 | 9 → 1 | 4 | 7 | 10 → 2 | 5 | 8 → 0 |
| out | 0 | 0 | 1 | 0 | 0 | 1 | 0 | 1 |

Three ones in eight cycles is 3/8, the input as a fraction of full scale. The error between the ideal level and the one-bit output is carried forward in the accumulator, so it is differenced from cycle to cycle. Differencing suppresses low frequencies and amplifies high ones: the quantization noise is pushed far above the audio band, where the board's filter removes it. With about 2,083 clock cycles per 48 kHz sample, there is a great deal of room up there.

### Key points

- An array indexed by a signal is a ROM, because a lookup structure is the only hardware that implements an arbitrary table.
- `mem.infer` puts a table in block RAM when it is large and its result is registered anyway, and in LUTs when it is small or the budget forbids block RAM.
- A block RAM read takes a clock edge, so Weft splits it into `read(addr)` and `.q`, and a combinational RAM read cannot be written; a ROM read is written combinationally and goes to block RAM only when its result is registered.
- A power-of-two buffer with a wrapping pointer is a circular buffer, and reading a slot one beat before overwriting it avoids a read-write collision.
- A phase accumulator wraps on purpose, and a signal saturates on purpose; the grammar makes each a stated choice.
- A first-order sigma-delta modulator trades bits for clock rate and moves its quantization noise to frequencies an analog filter can remove.

The echo already shows the theme of the next chapter. A value produced in one cycle and consumed in a later one has to be held somewhere, and the hardware must be told where. Chapter 9 turns that into the main subject: pipelines, where the compiler works out for itself which values need to be held between stages.

## Chapter 9 · Pipelines

Follows **F-09** (`F-09-pipelines.js`).

This chapter explains how a computation too long for one clock cycle is split across several, and why Weft lets the compiler decide which values to carry between the pieces. The example converts RGB pixels to luma in three stages. By the end you should be able to say which registers the compiler inserts, why it inserts no others, and what happens when the consumer stops accepting results. The cycle tables are worked by hand from Weft's rules.

### 9.1 Latency, throughput and the critical path

A synchronous circuit can be clocked only as fast as its slowest path between two registers allows. A signal leaves a flip-flop on one edge, passes through logic and routing, and must arrive at the next flip-flop a setup time before the following edge:

```latex
T_{\text{clk}} \ge t_{\text{clk}\to q} + t_{\text{logic}} + t_{\text{route}} + t_{\text{setup}}
```

The longest such path is the critical path. Putting a register in the middle of it roughly halves the logic each cycle must finish, so the clock can run faster. The work for one input now takes more cycles. That number is the latency. The number of results produced per cycle is the throughput, and for a pipeline that accepts a new input every cycle it is one. Pipelining trades latency for throughput, and in video, audio and networking throughput is usually what the specification fixes.

### 9.2 Stages, written as lambdas

In F-09 each stage is a hardware lambda, and the stages run in the order they are declared:

```js
const rgb = struct({ r: u(8), g: u(8), b: u(8) });
const W = [0.299, 0.587, 0.114].map(w => Math.round(w * 256));   // [77, 150, 29] in Q0.8, computed now

const luma = pipeline("luma")
  .needs("rgb").provides("gray")
  .lib({ W })
  .stall("skid")
  .stage("weigh", ($, px) => {                      // the first stage receives the beat
    $.r = px.r * W[0];
    $.g = px.g * W[1];
    $.b = px.b * W[2];
  })
  .stage("sum", $ => { $.y = $.r + $.g + $.b; })    // as wide as it needs to be
  .stage("round", $ => sat(($.y + 128) >> 8, u(8)));   // the last stage's return value is the output beat
```

No pipeline register is written anywhere. A stage writes `$.r`, a later stage reads `$.r`, and the meaning is "the value this beat had when it passed through the earlier stage." In hand-written RTL the designer declares `r_s1`, `g_s1`, `b_s1` and `y_s2` and must remember to delay every value that a later stage needs. Forgetting one, or delaying it by the wrong number of cycles, pairs data from two different pixels. That bug produces no error. It produces a wrong picture.

### 9.3 Which values cross a boundary: liveness

The pass `pipeline.registers` decides where registers go with the same analysis a software compiler uses to allocate machine registers. A value is live at a boundary if it was defined at or before that boundary and is used after it. Only live values need storage. Computed backwards from the last stage, with def(s) the values a stage writes and use(s) the values it reads:

```latex
\text{live}_{\text{out}}(s) = \text{live}_{\text{in}}(s+1), \qquad \text{live}_{\text{in}}(s) = \text{use}(s) \cup \big(\text{live}_{\text{out}}(s) \setminus \text{def}(s)\big)
```

For the luma pipeline the analysis gives the following, with widths from the rules of Chapter 2. A product's width is the sum of its operands' widths, and the constants 77, 150 and 29 need 7, 8 and 5 bits.

| Boundary | Live values | Register bits |
| --- | --- | --- |
| input → weigh | `px` (r, g, b) | the input stream's own register |
| weigh → sum | `r` (15 bits), `g` (16), `b` (13) | 44 + 1 valid |
| sum → round | `y` (18 bits) | 18 + 1 valid |

`px` is used only in `weigh`, so it is not live at any later boundary and is never carried. A designer who copies the whole pixel down the pipe out of caution spends 24 flip-flops per stage on nothing. A liveness analysis never does.

The width of `y` deserves a note. The rule that each addition grows by one bit gives 18 bits. The true maximum is 255 × 256 = 65,280, which fits in 16. A range analysis that tracks the interval of each value could prove this and save two flip-flops. The rule is deliberately conservative: it can never be wrong, and narrowing is an optimization the compiler may add later.

### 9.4 Three pixels through the pipe

Take three pixels: A = white (255, 255, 255), B = pure red (255, 0, 0) and C = (40, 80, 120). Each row is one clock cycle, and each cell shows which pixel a stage works on and what it computes.

| Cycle | weigh | sum | round | Output beat |
| --- | --- | --- | --- | --- |
| 1 | A: 19635, 38250, 7395 | – | – | – |
| 2 | B: 19635, 0, 0 | A: y = 65280 | – | – |
| 3 | C: 3080, 12000, 3480 | B: y = 19635 | A: (65280 + 128) >> 8 = 255 | A = 255 |
| 4 | – | C: y = 18560 | B: 77 | B = 77 |
| 5 | – | – | C: 73 | C = 73 |

Each pixel spends three cycles inside the pipe, and once it is full one pixel leaves per cycle. White comes out at exactly 255 because the three weights add up to 256.

### 9.5 When the consumer stops: stalls and skid buffers

The output is a valid/ready stream, introduced in Chapter 5. When the consumer drops `ready`, every stage must hold its beat, or beats are lost. The simplest scheme, `.stall("global")`, drives every stage's register enable from the output's `ready`, and passes the same signal back to the input as the pipeline's own `ready`. It is correct and cheap in flip-flops. Its cost is a combinational path from the far end of the pipeline, through every stage's enable, back to whoever feeds the input. In a deep pipeline that path, with its large fanout, becomes the critical path the pipeline was built to remove.

`.stall("skid")` breaks the path at every boundary by registering `ready`. The price is that a stage learns about a stall one cycle late, and in that cycle one more beat arrives. A second register, the skid register, catches it. The trace shows one boundary, with each row the state at the start of the cycle:

| Cycle | Sink ready | Main | Skid | Ready seen upstream | What happens |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 | A | – | 1 | A is sent; B is accepted into main |
| 2 | 0 | B | – | 1 | Nothing sent; C was already in flight and lands in skid |
| 3 | 0 | B | C | 0 | Upstream now sees the stall and holds D |
| 4 | 1 | B | C | 0 | B is sent; C moves from skid to main |
| 5 | 1 | C | – | 1 | C is sent; D is accepted |

No beat is lost or duplicated, and the sink's `ready` never travels further than one stage in a cycle. For F-09 the skid registers double the pipeline's storage, about 63 more flip-flops plus a multiplexer per boundary. A pipeline this short could use either scheme. The skid form is the default because it keeps timing independent of depth.

### 9.6 Fixed-point weights

The luma weights are fractions, and the hardware has only integers. Fixed-point arithmetic stores a fraction as an integer with an agreed scale. In Q*m*.*n* format a value has *m* integer bits and *n* fractional bits and means the integer divided by 2^*n*. The weights in F-09 are Q0.8:

```latex
W_i = \operatorname{round}(256 \cdot w_i), \qquad (0.299,\ 0.587,\ 0.114) \to (77,\ 150,\ 29), \qquad 77 + 150 + 29 = 256
```

The array is computed in JavaScript by a builder lambda, so the rounding happens once, at build time, in double precision. The sum being exactly 256 matters more than any single weight. A gray pixel with r = g = b = v must map to v, and it does only if the weights sum to one.

The final stage divides by 256 by shifting right eight places. A plain shift truncates, so every result would be biased low by half a unit on average. Adding 128, which is half of 256, before the shift rounds to nearest instead. The `sat(…, u(8))` around it never fires for valid inputs, since the maximum is 255. The width rules cannot prove that, so they require a stated narrowing, and saturation is the safe one.

The weights carry their own error. Pure red gives 77 in hardware, while the ideal 0.299 × 255 is 76.245. The difference comes from 77/256 = 0.3008 instead of 0.299. Each weight is off by at most 1/512, so for 8-bit inputs the coefficient error is under half a unit for each channel.

### 9.7 The reference model is an oracle

The first scenario is a runtime lambda. It pushes 64 random pixels, pulls 64 results, and compares each with a JavaScript model:

```js
  .scenario("matches the JS model", async tb => {   // runtime lambda: async JS beside the simulator
    const px = Array.from({ length: 64 }, () =>
      ({ r: tb.random.int(0, 255), g: tb.random.int(0, 255), b: tb.random.int(0, 255) }));
    await tb.push("rgb", px);
    const ys = await tb.pull("gray", px.length);
    px.forEach((p, i) =>
      tb.expectEqual(ys[i], Math.min(255, (p.r * W[0] + p.g * W[1] + p.b * W[2] + 128) >> 8), `pixel ${i}`));
  })
```

The model performs the same integer arithmetic as the hardware, with the same weights and the same rounding. That is what makes it an oracle: any disagreement is a bug in the design, not a difference of opinion about rounding. A model written in floating point, `Math.round(0.299 * r + 0.587 * g + 0.114 * b)`, would report pure red as 76 and fail against a correct design. Bit-exact models check the implementation; a separate test with a tolerance checks that the algorithm is close enough to the ideal. The two questions are different and deserve different tests.

The second scenario throttles the sink to accept on 30% of cycles and checks that all 500 beats arrive. It exercises exactly the stall logic of section 9.5, which a test at full speed never touches.

### Key points

- Registers inserted into a long path raise the clock rate and the throughput at the cost of more cycles of latency.
- Weft stage lambdas never name pipeline registers; `pipeline.registers` inserts them by liveness, so only values used later are carried.
- Width rules are conservative by design, and range analysis is the optimization that narrows them.
- A global stall is cheap in registers but creates a long combinational `ready` path; a skid buffer registers `ready` and catches the one beat in flight.
- Fixed-point weights should be rounded so their sum is exact, and rounding a shift requires adding half a unit first.
- A reference model must repeat the hardware's integer arithmetic to be an oracle; closeness to ideal math is a separate test.

Every register in this chapter shared one clock. The next chapter drops that assumption. When a value moves between two clocks with no fixed phase relation, the timing equation of section 9.1 can no longer be satisfied, and Chapter 10 explains what the hardware does instead.

## Chapter 10 · Clock domains

Follows **F-10** (`F-10-clock-domains.js`).

This chapter explains why a signal cannot simply be wired from one clock to another, what hardware makes the crossing safe, and how Weft's compiler finds every crossing that lacks it. In F-10 a sprite moves in the 100 MHz system domain and is drawn in a 25.175 MHz pixel domain. One stream joins them. The diagnostics and tables below are worked by hand from Weft's rules.

### 10.1 Two clocks with no common edge

Chapter 9's timing equation assumes that the launching and capturing registers share a clock, so the time between their edges is known. Between 100 MHz and 25.175 MHz there is no such number. The phase between the two clocks drifts continuously, so some edge of the pixel clock will eventually fall arbitrarily close to a change in a signal from the system domain. No placement, routing or slower logic can prevent it. The timing analyzer can only declare such paths unanalyzable, and the design has to cope with what happens when the capture goes wrong.

A clock domain is the set of registers driven by one clock, together with the logic between them. F-10 declares two:

```js
  .clocks(c => c
    .pin("sys", "clk")                              // 100 MHz from the board
    .pll("pix", { from: "sys", hz: "25.175 MHz", tolerance: "0.5%" }))   // the compiler solves the dividers
```

Modules join the `sys` domain by default; `.domain("pix")` moves the raster and the two video components to the other.

### 10.2 Metastability

A flip-flop guarantees a clean 0 or 1 only if its input is stable for a setup time before the clock edge and a hold time after it. If the input changes inside that window, the flip-flop can enter a metastable state, with its output between the logic levels. It leaves that state eventually, but the time it takes is unbounded. The probability that it is still unresolved after time t falls exponentially, as e^(−t/τ), where τ is a property of the flip-flop's circuit.

A wrong value is bad. A value that resolves late is worse, because downstream logic may read it as 0 in one place and as 1 in another. The standard measure of the risk is the mean time between failures:

```latex
\text{MTBF} = \frac{e^{\,t_r / \tau}}{T_0 \cdot f_{\text{clk}} \cdot f_{\text{data}}}
```

Here t\_r is the time the design allows for resolution, f\_clk is the capturing clock and f\_data is the rate at which the input changes. τ and T\_0 are device constants that vendors characterize. The denominator counts the opportunities to fail per second; the numerator is how rarely each one fails. The exponent dominates everything.

### 10.3 The two-flop synchronizer

The standard remedy is to capture the foreign signal in one flip-flop and use it only after a second flip-flop in the destination domain has sampled it. The first flip-flop may go metastable. It then has a whole clock period to resolve before the second one samples it, so t\_r grows by one period less the second flip-flop's own clock-to-output and setup times, and the MTBF is multiplied by e^((T\_clk − t\_cq − t\_su)/τ). Since T\_clk is many times τ, one extra stage turns an MTBF of days into one of geological length. Fast clocks shrink T\_clk, which is why designs above a few hundred megahertz sometimes use three stages.

The chart below makes this concrete with illustrative parameters, not measurements of any part: τ = 60 ps, T\_0 = 100 ps, a 10 MHz data rate, and 0.5 ns of each period lost to clock-to-output and setup times.

&#91;embedded content: computed from the MTBF formula above · illustrative parameters · 200–600 MHz\]

With these parameters a single flip-flop falls below one year near 430 MHz, and the second stage, which loses the same 0.5 ns per period, adds between 8 and 33 decades across the frequencies shown.

The two-flop synchronizer is correct only for a single bit. A 10-bit position sampled through ten separate synchronizers resolves each bit independently, so when the value changes from 511 to 512 the destination can see any mixture of the two, such as 1023 or 0. The value must either change one bit at a time or be held still while it crosses.

### 10.4 Crossing a "latest" value with a handshake

F-10 holds the value still:

```js
const position = stream("sprite.pos")
  .of(struct({ x: u(10), y: u(10) }))
  .buffer(1, { overflow: "latest" })                // only the newest position matters…
  .cross({ from: "sys", to: "pix" });               // …so the crossing is a handshake synchronizer, not a FIFO
```

The crossing pass builds a two-phase handshake, in which each transfer is signalled by a toggle rather than a pulse. The source puts the 20-bit position in a register and toggles a request bit. Only the request bit passes through a two-flop synchronizer. When the destination sees it change, the data register has been stable for at least two destination cycles, so all 20 bits can be captured directly. An acknowledge bit returns the same way. One transfer takes a few cycles of each clock, so the handshake carries at most a few million updates a second. The sprite moves once every 8 ms, which is 125 updates a second.

The `"latest"` policy fixes what happens when the source updates during a transfer: the newer position overwrites the waiting one, and only the freshest value crosses. That is right for a position, and wrong for a stream of audio samples, which is why the policy is stated on the stream rather than chosen by the compiler.

### 10.5 Crossing every beat: the asynchronous FIFO

A stream that must deliver every beat at full rate needs a FIFO whose two ends run on different clocks. The design that `.cross()` emits for a deeper buffer is the one described by Cummings: a dual-port RAM, a write pointer owned by the write domain, and a read pointer owned by the read domain. Each side compares its own pointer with a synchronized copy of the other's to decide whether the FIFO is full or empty.

&#91;embedded content: asynchronous FIFO · the structure described by Cummings (SNUG 2002)\]

Each side drives the RAM with its own binary pointer. Only the registered Gray copies cross, each through two flip-flops clocked by the other side.

The pointers cross in Gray code, in which consecutive numbers differ in exactly one bit:

| Binary | 000 | 001 | 010 | 011 | 100 | 101 | 110 | 111 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Gray (n xor n >> 1) | 000 | 001 | 011 | 010 | 110 | 111 | 101 | 100 |

When a pointer advances, only one bit changes, so a synchronizer can only capture the old value or the new one. The synchronized copy is therefore always a value the pointer really held, at most a few cycles stale. Staleness errs on the safe side: the writer may believe the FIFO is fuller than it is, and the reader may believe it emptier, so it never overflows or underflows. Each pointer has one bit more than the address needs, which distinguishes a full FIFO from an empty one when the addresses are equal.

### 10.6 How checks.cdc finds missing crossings

After `flatten`, every register belongs to the domain of its clock. The pass `checks.cdc` propagates domains forward through the combinational logic. Each combinational node takes the set of domains of the registers in its fan-in. A node whose set contains two domains mixes signals with no defined timing relation. A register whose input set contains a domain other than its own captures a foreign signal. Both are errors unless the edge passes through a crossing cell, which only `.cross()` and `std.cdc` can create. The pass visits each node and edge once, so it costs time linear in the size of the graph.

With `.cross()` deleted from F-10, the check would report the stream by name. The message below is written by hand to show the intended form:

```text
error checks.cdc: stream "sprite.pos" is produced in sys (100 MHz) and consumed in pix (25.175 MHz)
  producer  physics   $.push("sprite.pos", { x: $.x, y: $.y })
  consumer  raster    .on("sprite.pos", ($, p) => { … })
  fix       add .cross({ from: "sys", to: "pix" }) to stream("sprite.pos"), or put both modules in one domain
```

The same pass flags reconvergence: two bits synchronized separately and then combined in the destination domain. Each is individually safe, but they can arrive one cycle apart, so their combination can be a state that never existed in the source.

### 10.7 Solving for the pixel clock

VGA's 640 × 480 mode at 60 Hz scans 800 pixel times per line, of which 640 are visible, and 525 lines per frame, of which 480 are visible. 800 × 525 × 59.94 Hz gives the standard pixel clock of 25.175 MHz.

The `.pll()` call names a target and a tolerance, and the compiler finds the dividers. On a 7-series part the clock generator is an MMCM:

```latex
f_{\text{out}} = f_{\text{in}} \cdot \frac{M}{D \cdot O}, \qquad 600\ \text{MHz} \le f_{\text{in}} \cdot \frac{M}{D} \le 1200\ \text{MHz}
```

M ranges from 2 to 64 and O from 1 to 128, both in steps of 1/8, and D is an integer from 1 to 106. The middle quantity is the oscillator's own frequency, the VCO, whose legal range depends on the speed grade; the figures above are for the slowest grade. The search space is small enough to enumerate. For a 100 MHz input it holds about 1.4 million legal settings with D up to 10. For the pixel clock alone the best is M = 9, D = 1, O = 35.75: a 900 MHz VCO and 25.1748 MHz, 0.0007% from the target. F-10 needs more, because the HDMI encoder asks for pix × 5 from the same VCO. The two dividers must then satisfy O\_pix = 5 · O\_5x, and only CLKOUT0 may be fractional, so O\_5x is an integer. Under those constraints the best setting is M = 17.625, D = 2, O = 35 and 7: a VCO of 881.25 MHz giving 25.1786 MHz and 125.893 MHz, 0.014% from the target and well inside the 0.5% tolerance F-10 asks for. An iCE40 PLL has a different formula and different ranges; the search is the same.

### 10.8 Why unsigned minus unsigned is signed

The raster tests whether the beam is inside the sprite:

```js
  .on("beam", ($, b) => {
    const dx = b.x - $.sx, dy = b.y - $.sy;         // u10 − u10 is s11: left of the sprite stays negative
    const inside = dx >= 0 && dx < 16 && dy >= 0 && dy < 16;
    $.push("pixels", inside ? { r: 255, g: 200, b: 0 } : { r: 0, g: 0, b: b.y.bits(8, 1) });
  });
```

The difference of two 10-bit unsigned numbers ranges from −1023 to 1023, which needs 11 signed bits. If Weft kept the result unsigned, the beam at x = 5 against a sprite at x = 10 would give 1019, and `dx >= 0` would be true for every value. The code might still work through wraparound, but the reader could no longer tell whether it was meant to. Making subtraction signed keeps each comparison's meaning equal to its text.

### Key points

- Two clocks with no fixed phase relation make the setup and hold equations unsatisfiable for signals between them.
- Metastability cannot be prevented, only given time to resolve, and MTBF grows exponentially with that time.
- A two-flop synchronizer is safe for one bit; a multi-bit value must either change one bit at a time, as Gray-coded pointers do, or be held still while a handshake crosses.
- `checks.cdc` propagates each register's domain through the graph and rejects any edge between domains that does not pass through a crossing cell.
- A PLL target is met by searching a small space of divider settings under the VCO's frequency limits.

Every crossing in this chapter is correct by construction, but construction is not proof. Chapter 11 turns to verification: how to state what a design must do, and how a simulator and a formal engine check it.

## Chapter 11 · Proofs and testbenches

Follows **F-11** (`F-11-proofs.js`).

This chapter explains how a design states what it must do, and how two very different engines check that statement. A simulator runs the design on chosen inputs and watches. A formal engine reasons about all inputs at once and either proves the property or produces a trace that breaks it. F-11 is a round-robin arbiter with its properties written beside it, a proof script and a randomized testbench. The traces are worked by hand from Weft's rules.

### 11.1 Three kinds of statement

The arbiter carries three kinds of property, each a hardware lambda that reads signals through `$`:

| Statement | Meaning | In simulation | In a formal proof | On the chip |
| --- | --- | --- | --- | --- |
| `.assert(name, $ => …)` | The design guarantees this on every cycle | Checked every cycle; a failure stops the run | Proved for all inputs allowed by the assumptions | Optional monitor that raises an error flag |
| `.assume(name, $ => …)` | The environment promises this | Checked every cycle; a failure is a testbench or assumption bug | Restricts which inputs the engine considers | Optional monitor on the inputs |
| `.cover(name, $ => …)` | This situation must be reachable | Hits are counted for coverage | The engine searches for a trace that reaches it | Optional hit counter |

The same lambda serves all three uses because each compiles to ordinary logic over the design's signals. That logic can be simulated, translated into a formula, or placed on the FPGA. A property written once cannot drift out of step with copies of it written for different tools.

### 11.2 The arbiter

An arbiter picks one requester to serve each cycle. A fixed-priority arbiter always prefers the lowest-numbered port, so a busy port 0 can starve port 3 forever. Round-robin rotates the priority so that the port after the one served last comes first.

```js
const arbiter = module("arbiter")
  .params({ N: 4 })
  .require(({ N }) => (N & (N - 1)) === 0 || "N must be a power of two")   // checked per specialization
  .in("req", ({ N }) => u(N))
  .out("grant", ({ N }) => u(N))
  .regs(({ N }) => ({ last: u(clog2(N)) }))
  .comb($ => {
    $.grant = 0;
    for (let k = N; k >= 1; k--) {                  // unrolled; the last match wins, so walk from the far end
      const i = wrap($.last + k, u(clog2(N)));      // wrapping to clog2(N) bits is modulo N for free
      if ($.req[i]) $.grant = 1 << i;
    }
  })
  .seq($ => { for (let i = 0; i < N; i++) if ($.grant[i]) $.last = i; })
```

The loop unrolls into four conditional assignments. In a combinational lambda a later assignment overrides an earlier one, so the four become a chain of multiplexers in which the last test has the highest priority. Walking k from N down to 1 makes port last + 1 the final test. The `.require()` builder lambda is there because `wrap` computes modulo 2^bits, which equals modulo N only when N is a power of two. A specialization with N = 6 is rejected at build time with that message.

The trace below starts from reset, with `last` = 0 and requests written with port 3 on the left:

| Cycle | `req` | `last` | Priority order | `grant` | Port served |
| --- | --- | --- | --- | --- | --- |
| 1 | 1111 | 0 | 1, 2, 3, 0 | 0010 | 1 |
| 2 | 1111 | 1 | 2, 3, 0, 1 | 0100 | 2 |
| 3 | 1111 | 2 | 3, 0, 1, 2 | 1000 | 3 |
| 4 | 1111 | 3 | 0, 1, 2, 3 | 0001 | 0 |
| 5 | 0101 | 0 | 1, 2, 3, 0 | 0100 | 2 |
| 6 | 0001 | 2 | 3, 0, 1, 2 | 0001 | 0 |

Under full load every port is served once every four cycles. That bound is what the third assertion states.

### 11.3 SAT and SMT

A formal engine reduces each question to satisfiability. A SAT solver takes a Boolean formula, usually as a conjunction of clauses, and either finds values for its variables that make it true or proves that none exist. The problem is NP-complete, yet solvers based on conflict-driven clause learning handle formulas with millions of clauses arising from hardware. They learn a new clause from every contradiction they reach and use it to prune the rest of the search.

SMT, satisfiability modulo theories, extends SAT with theories such as fixed-width bit-vectors and arrays. A constraint like `grant & (grant - 1) == 0` over 4-bit words can then be stated directly instead of being spelled out gate by gate. Bit-vector solvers often reduce such terms to SAT internally, a step called bit-blasting, but they keep word-level structure where it helps. `.engine("smt")` in F-11 selects an engine of this kind.

### 11.4 Bounded model checking

The design is a transition system: an initial-state predicate I, a transition relation T between the state in one cycle and the next, and a property P. Bounded model checking unrolls k cycles and asks the solver whether any trace of that length violates P:

```latex
I(s_0) \wedge \bigwedge_{i=0}^{k-1} T(s_i, s_{i+1}) \wedge \bigwedge_{i=0}^{k} A(s_i) \wedge \bigvee_{i=0}^{k} \neg P(s_i)
```

A(s) is the conjunction of the assumptions. If the formula is satisfiable, the solver's answer is a counterexample: a concrete value for every input on every cycle, which the tool turns into a waveform. If it is unsatisfiable, no violation exists within k cycles. `.bmc(24)` in F-11 asks for 24. The method finds shallow bugs quickly and with a perfect trace, and it says nothing at all about cycle 25.

### 11.5 k-induction, and why it can fail

Induction closes the gap. The base case is a bounded check to depth k. The step asks whether any k consecutive states that satisfy P and are connected by T can be followed by a state that violates it. The states in the step are not required to be reachable from reset. If no such path exists, P holds in every reachable state at every depth:

```latex
\bigwedge_{i=0}^{k-1} \big(P(s_i) \wedge T(s_i, s_{i+1})\big) \;\Rightarrow\; P(s_k)
```

That last freedom is where induction fails. Take a 3-bit counter that counts 0, 1, 2, 3, 4 and then returns to 0, and the true property `count != 7`. With k = 1 the step fails: the state 6 satisfies the property and its successor is 7. State 6 is unreachable, but the step does not know that. With k = 3 the step needs three good states in a row before 7, which would be 4, 5, 6, and 4 is followed by 0, so the proof goes through. The alternative is to strengthen the property with an invariant such as `count <= 4`, which is inductive at k = 1 and implies the original. Writing such invariants as further `.assert()` lines is the usual way to help a failing induction.

### 11.6 Temporal helpers become monitors

The arbiter's properties use three helpers from the hardware prelude:

```js
  .assume("a request waits for its grant", $ => !(past($.req[0]) && !past($.grant[0])) || $.req[0])
  .assert("at most one grant", $ => ($.grant & ($.grant - 1)) === 0)
  .assert("grants go to requesters", $ => ($.grant & ~$.req) === 0)
  .assert("served within N cycles", $ => !$.req[0] || within(N, $.grant[0]))
  .cover("every port served in turn", $ => sequence($.grant === 1, $.grant === 2, $.grant === 4, $.grant === 8));
```

Each helper compiles to a small piece of hardware. `past(x)` is a register holding last cycle's value of x, and `past(x, n)` is a shift register n deep. `within(N, c)` is a counter. Each cycle the antecedent holds starts an obligation, but all open obligations are discharged by the same event, so only the oldest one matters. One counter counts cycles since the oldest open obligation, clears when `grant[0]` rises, and flags a failure when it reaches N. `sequence(a, b, c, d)` is a chain of match flags: a register records that a held last cycle, the next records that a was followed by b, and so on. The cover is hit when the last flag sets.

"At most one grant" uses a standard identity: x & (x − 1) clears the lowest set bit, so it is zero exactly when x has at most one bit set.

The assumption is needed by the third assertion. Without it, the engine could raise `req[0]` for one cycle while another port is served, drop it, and wait. The arbiter correctly never grants a port that is not requesting, so `within` would fail. The assumption encodes the protocol rule that a request stays up until it is granted. It does not weaken the arbiter's obligations; it states the environment's.

### 11.7 Running the proof and the test

```js
  .prove(p => p
    .module("arbiter")
    .bmc(24)                                        // no counterexample in 24 cycles…
    .induction()                                    // …then k-induction for every depth
    .engine("smt"))
```

The randomized testbench is a runtime lambda:

```js
  .scenario("fair under random load", async tb => {
    const served = [0, 0, 0, 0];
    let req = 0, grant = 0;
    for (let t = 0; t < 10_000; t++) {
      req = (req & ~grant) | tb.random.int(0, 15);  // pending requests stay up, as the assume demands
      await tb.poke("arbiter.req", req);
      await tb.step();
      grant = await tb.peek("arbiter.grant");
      if (grant) served[Math.log2(grant)]++;
    }
    tb.expect(Math.min(...served) > 2000, `shares: ${served}`);   // seeded: a failure replays exactly
    tb.expectCoverage("all");                       // every .cover() was hit at least once
  });
```

Three ideas from verification practice appear in these lines. The stimulus is constrained random: random, but only within the protocol. The expression `(req & ~grant) | random` keeps every ungranted request up, which is the assumption written as a generator. The random source is seeded, so a failing run replays exactly with the same seed. The `served` array is a scoreboard: it records outcomes during the run, and a check at the end compares them with expectations. With 10,000 cycles and nearly every cycle granted, each port should receive about 2,500 grants, and the test demands more than 2,000.

`expectCoverage("all")` closes the loop with the cover statements. Coverage measures what a test exercised, not what it checked. A test that never reaches "every port served in turn" has not tested rotation, whatever its assertions say.

### 11.8 Why assumptions are checked in simulation too

An assumption is a promise that the proof takes on trust. If it is stronger than what the real environment does, the proof covers inputs that never occur and misses ones that do. If two assumptions contradict each other, no input satisfies them, and every assertion holds vacuously. Weft guards against both. Simulation checks every `.assume()` on every cycle, so a testbench or a real input that breaks the protocol is reported at once. Cover statements catch vacuity in formal runs: a cover that the engine cannot reach under the assumptions means those assumptions have excluded behavior the design must handle.

Formal proof and simulation are complementary. The proof is exhaustive within its model and its assumptions. The simulation runs the whole design for longer, includes parts the formal model abstracts away, and measures with coverage what was actually exercised.

### Key points

- One property lambda serves as a simulation check, a formal obligation and an optional on-chip monitor, because it compiles to ordinary logic.
- Bounded model checking finds every violation within k cycles and returns a concrete trace; it proves nothing beyond k.
- k-induction proves properties for all depths, but its step considers unreachable states, so true properties may need a larger k or strengthening invariants.
- `past`, `within` and `sequence` compile to shift registers, counters and chains of match flags.
- Assumptions describe the environment; checking them in simulation and pairing them with covers keeps proofs from passing vacuously.
- Seeded constrained-random stimulus, a scoreboard and functional coverage together say what was tested, what was checked and how to reproduce a failure.

The arbiter's behavior is fixed when the design is built. Chapter 12 makes part of a design adjustable while it runs, and shows how the compiler gives the host a safe way to change it.

## Chapter 12 · Knobs

Follows **F-12** (`F-12-knobs.js`).

A knob is a register that hardware reads and a host program writes. This chapter explains how a handful of `.knob()`, `.status()` and `.irq()` declarations become a register map, a bus bridge, a C header, a typed JS driver and a page of documentation, all from one description. It also explains why the bounds on a knob are enforced by the chip rather than by the driver. The design rule underneath is simple: anything the host may change at runtime must be declared in the module that owns it, so the compiler can see every path by which the outside world reaches in.

As elsewhere in this book, Weft is a proposed design. The register map, the frame format and the generated header below are worked by hand from the rules the chapter states; they are not output from a running tool.

### 12.1 What a knob is

In F-12, the synthesizer declares three things the host may touch:

```js
const synth = module("synth")
  .provides("samples")
  .knob("hz", u(14), { reset: 440, min: 20, max: 8000 })   // a write outside the bounds saturates, in hardware
  .knob("volume", u(4), { reset: 8 })
  .status("clipped", u(16))                         // hardware writes it, the host reads it
  .irq("clip")                                      // a pulse here arrives at the host as an event
```

Inside the module, `$.hz` reads like any other register, and the hardware lambda never writes it. Outside the module, the host writes it through the bus. That asymmetry is the definition. A `status` is the mirror image: hardware writes, the host only reads. An `irq` is a one-cycle pulse that the hardware raises and the host learns about as an event.

Why declare these on the module instead of in a separate register file? Because the owner knows the meaning. The synth author knows that 440 is a sensible reset pitch and that pitches above 8000 Hz make no sense at this sample rate. Moving that knowledge into a central file would separate a register from the only code that knows what it is for.

### 12.2 Laying out the map

The `csr.collect` pass (Chapter 13 places it in the `lower` stage) walks every module, gathers its knobs, statuses and interrupts, and assigns addresses. Weft's allocation rule has three parts, each chosen to make the address decoder cheap:

- Every register gets its own 32-bit word at a 4-byte-aligned offset. A host write never has to read, merge and write back a shared word, so two writers cannot overwrite each other's fields.
- Each module gets a window whose size is a power of two and whose base is aligned to that size. The top address bits then select the module and the low bits select the register, so decoding is a prefix compare and a small multiplexer.
- A system block at address 0 holds the map's identity and the shared interrupt registers. The only packed fields in the map are interrupt bits, because one bit per source is exactly what a pending register needs.

Applied to F-12 by hand, the rule gives this map:

| Offset | Name | Access | Type | Reset | Notes |
| --- | --- | --- | --- | --- | --- |
| 0x0000 | sys.id | ro | u32 | map hash | first 32 bits of a hash of the map description |
| 0x0004 | sys.irq\_pending | w1c | u32 | 0 | bit 0 = synth.clip |
| 0x0008 | sys.irq\_enable | rw | u32 | 0 | same bit layout |
| 0x0100 | synth.hz | rw | u14 | 440 | writes saturate to 20…8000 |
| 0x0104 | synth.volume | rw | u4 | 8 |  |
| 0x0108 | synth.clipped | ro | u16 | 0 | wraps at 65 536 |

The `sys.id` word is worth a sentence. The generated driver carries the same hash. On connect it reads `sys.id`, and a mismatch means the bitstream and the driver were built from different descriptions, which is the most common way register tools go wrong in practice. The driver refuses to talk rather than writing volume into the pitch register.

Values wider than the bus need one more rule. A 48-bit counter read as two 32-bit halves can tear if the counter carries between the two reads. The usual fix, and Weft's, is a shadow latch: reading the low word copies the high word into a holding register, and the next read returns that copy.

### 12.3 Bounds belong to the hardware

The `hz` knob declares `min: 20, max: 8000`. Weft enforces that bound on the write path inside the chip. For each bounded knob, `csr.collect` generates two comparators against constants and a three-way select:

```text
on bus write to 0x0100 with data d:
  if d < 20        then hz ← 20
  else if d > 8000 then hz ← 8000
  else                  hz ← d[13:0]
```

A check in the JS driver would be cheaper to write, but it protects only callers who use that driver. A shell script, a second host, an agent, or a raw packet on the bridge would all bypass it. In hardware, the invariant holds for every writer, because there is no other path to the register.

There is a second payoff. Because the bound is a fact about every reachable state, the compiler may use it. The formal tools can assume 20 ≤ `hz` ≤ 8000 when proving properties of `synth`, and width analysis may note that 8000 fits in 13 bits. A bound that lives in a driver is invisible to both.

Why saturate instead of reject? Rejection needs an error channel back to the writer, and a UART bridge has no natural place for one. Saturation keeps the protocol one-way and makes the outcome observable by reading back. That is exactly what the first scenario in F-12 checks:

```js
  .scenario("bounds hold in hardware", sc => sc
    .write("synth.hz", 50_000).expectKnob("synth.hz", 8000)
    .write("synth.hz", 3).expectKnob("synth.hz", 20))
```

### 12.4 Status counters and write-one-to-clear

The `clipped` status is a 16-bit counter written by `$.clipped += 1`. Chapter 2's rule says compound assignment wraps, so after 65 535 it reads 0. A host that wants a rate keeps the previous reading and computes the difference modulo 2^16. That works as long as it reads at least once per 65 536 events, which is the standard contract for free-running hardware counters.

Interrupt pending bits use a different access mode, write-one-to-clear (w1c). Writing a 1 to a bit clears it; writing a 0 leaves it alone. Consider the alternative, a plain read-write register. The host reads the pending word, sees bit 0, handles it, and writes back the word with bit 0 cleared. If bit 1 was set by hardware between the read and the write, the write-back clears it too, and that event is lost. With w1c the host writes exactly the bits it saw, so bits that arrived in between survive.

### 12.5 Interrupts: a pulse, a latch, a level

In the synth, `$.clip = 1` is a pulse: one cycle, 10 ns at 100 MHz. No host can see a 10 ns pulse through a serial link. So the generated logic turns the pulse into state:

1. The pulse sets the pending bit for `synth.clip`. The bit is sticky and stays set until the host clears it.
2. The interrupt level is the OR, over all sources, of pending AND enable.
3. The UART bridge watches that level. On a rising edge it sends an event frame naming the sources whose pending bits are set.
4. The host driver dispatches the event to the matching runtime lambda, then writes those bits back to `sys.irq_pending` to clear them.

One consequence follows directly. Ten clips between two host reads produce one pending bit and one event. Events say "at least once"; counters say how many. That is why F-12 declares both `irq("clip")` and `status("clipped")`, and why the panel's handler reads the counter:

```js
  .on("synth.clip", async dev => {
    await dev.knob("synth.volume").update(v => Math.max(v - 1, 0));
    dev.log("clipped", await dev.status("synth.clipped").read(), "times; volume down");
  });
```

### 12.6 The bridge as a tiny protocol

`std.bridge.uart("bridge")` turns serial bytes into bus transactions. Any such bridge needs framing, an operation code, an address, data, and an integrity check. A frame layout a bridge like this might use:

| Byte | Field | Meaning |
| --- | --- | --- |
| 0 | sync | 0xA5 marks the start of a frame |
| 1 | op | 0x01 read, 0x02 write, 0x80 event (device to host) |
| 2–3 | address | register offset |
| 4–7 | data | write data, read reply, or event source bits |
| 8 | crc | CRC-8 over bytes 1–7 |

A UART byte costs 10 bit times (start, 8 data, stop). At the example's 1 Mbaud, a 9-byte write takes 90 µs. The panel writes `synth.hz` every 20 ms, so it uses well under 1 % of the link. This arithmetic is worth doing for every bridge, because it tells you what a host can control: anything that changes every few milliseconds, and nothing that changes every few cycles.

### 12.7 One description, many artifacts

The compile block emits three more files from the same map:

```js
  .compile(c => c
    .emit("c-header", { to: "fw/siren_regs.h" })
    .emit("host-js", { to: "host/siren.js" })      // dev.knob("synth.hz"), typed, with bounds and docs
    .emit("register-doc", { to: "docs/registers.md" }))
```

The header for the map in 12.2 would look like this:

```c
#define SIREN_SYS_ID           0x0000u  /* ro: map hash */
#define SIREN_SYS_IRQ_PENDING  0x0004u  /* w1c */
#define SIREN_SYS_IRQ_ENABLE   0x0008u  /* rw */
#define SIREN_SYNTH_HZ         0x0100u  /* rw u14, reset 440, saturates to 20..8000 */
#define SIREN_SYNTH_VOLUME     0x0104u  /* rw u4, reset 8 */
#define SIREN_SYNTH_CLIPPED    0x0108u  /* ro u16, wraps */
#define SIREN_IRQ_SYNTH_CLIP   (1u << 0)
```

The point is not the format. It is that the HDL, the firmware header, the host driver and the documentation cannot disagree, because none of them was written by hand. Register maps maintained in a spreadsheet and copied into four places drift, and the drift shows up as a write to the wrong address. Generating every view from the declarations removes that class of error.

### 12.8 The boundary between host and hardware

The panel's lambdas are runtime lambdas in the sense of Chapter 3. They are ordinary JS running on the host, they may capture any JS value, and they reach the hardware only through handles: `dev.knob(...)`, `dev.status(...)`, interrupt events and the clock. They cannot read `$.phase`, because `phase` was never declared as a status. They cannot change logic, because the bitstream is fixed. They cannot act within a cycle, because every operation crosses a serial link.

The same panel runs against the simulator in a scenario (`.run("panel")`) and against the board over a real serial port. The simulated bridge speaks the same frames, so a panel tested in simulation needs no changes on hardware. When a knob is read by a module in another clock domain, the compiler inserts the synchronizer described in Chapter 10. F-19 relies on this for its palette knob.

### Key points

- A knob is declared on the module that reads it, so the meaning of every register lives next to the logic that uses it.
- The register map is allocated by rule: one word per register, power-of-two windows per module, and a map hash at address 0 that driver and bitstream must agree on.
- Bounds are enforced on the write path in hardware, where they hold for every writer and become facts the compiler and the prover can use.
- Interrupt pulses set sticky pending bits cleared by write-one-to-clear, so events mean "at least once" and counters carry the count.
- The C header, the JS driver and the documentation are generated from the same declarations, so they cannot drift apart.

Every chapter so far has described what the designer writes. Chapter 13 turns to what the compiler does with it: the pass pipeline that F-13 spells out, from parsed lambdas to placed and routed cells.

## Chapter 13 · The pass pipeline

Follows **F-13** (`F-13-pass-pipeline.js`).

Every Weft design is compiled by a sequence of passes over an intermediate representation, an IR. This chapter explains why the IR has four levels, why the middle level is a directed acyclic graph cut at registers, and what each stage of the default pipeline does to it. F-13 writes that default pipeline out in full, so the chapter can follow it line by line. By the end you should be able to say, for any check or optimization in the book, which level it runs on and why it could not run earlier.

The IR listings and traces below are worked by hand from the semantics in Chapters 2 and 3. Weft is a proposed design, and no tool printed them.

### 13.1 Why an IR, and why four levels

The builders of Chapters 1 to 12 produce a description: modules, ports, lambdas, streams, knobs. A compiler needs something else, a representation in which each question it asks is easy to answer. "Which module owns this name?" is easy on a hierarchy. "Which values does this adder depend on?" is easy on a dataflow graph. "Which LUT holds this function?" is easy on a netlist. "How long is this wire?" is easy only once cells have positions. No single representation makes all four easy, so Weft uses four, and each stage lowers one into the next.

| Level | What it makes explicit | What it has forgotten | Typical passes |
| --- | --- | --- | --- |
| hir | modules, instances, names, parsed lambdas, streams, knobs | nothing yet | parse, elaborate, link |
| dag | every operation and its operands, one graph per clock domain, exact widths | hierarchy, statement order | widths, checks, constFold, cse, dce, retime |
| net | the part's cells (LUT6, CARRY4, DSP48E1, block RAM) and the nets between them | arithmetic as operations | techmap, dsp.pack, mem.infer |
| phys | a site for every cell and a routed path for every net | nothing about placement is left open | place, route, timing |

This is the same layering that LLVM uses for software and that CIRCT, built on MLIR, uses for hardware: high-level dialects lowered step by step into ones closer to the target. FIRRTL, the IR under Chisel, has the same shape, with its own "high", "mid" and "low" forms. The lesson they share is that a pass should run at the highest level where it can still see what it needs, because each lowering throws information away.

&#91;embedded content: the default pipeline of F-13 · 6 stages, 4 IR levels\]

Only front, lower, map and back change the level; optimize and time rewrite the dag in place, which is why most passes in this book run there.

### 13.2 A synchronous circuit is a DAG between registers

Here is the `mac` module from F-13:

```js
const mac = module("mac")
  .in({ a: s(18), b: s(18), clear: bit })
  .out("acc", s(48))
  .seq($ => {
    if ($.clear) $.acc = 0;
    else $.acc += $.a * $.b;                        // 18 × 18 → 36 bits; dsp.pack folds the multiply-add into one DSP
  });
```

And here is its DAG after the `optimize` stage, as the example's comment shows it:

```text
%1 = in a : s18
%2 = in b : s18
%3 = in clear : bit
%4 = reg acc : s48                       ← .out("acc", s(48)), written in .seq
%5 = mul %1, %2 : s36                    ← $.a * $.b
%6 = add %4, sext(%5) : s48 wrap         ← +=
%7 = mux %3, 0, %6 : s48                 ← if ($.clear)
%4.next = %7
```

The register `%4` appears twice. Its current value is a source: `%6` reads it. Its next value is a sink: `%4.next = %7`. The edge from `%7` back to `%4` is not a combinational edge; it takes effect at the next clock edge. If you delete that one edge from every register, what remains has no cycles. Every combinational path starts at an input port or a register output and ends at an output port or a register input.

That fact is the foundation of everything in this stage. Topological order exists, so widths can be inferred in one forward sweep, timing can be computed in one forward and one backward sweep, and simulation can evaluate each node once per cycle. A cycle that does not pass through a register is a combinational loop. Its value depends on itself within one cycle, so it either settles to something that depends on gate delays or oscillates. `checks.loops` finds such cycles with a depth-first search and reports them as errors, with the source lines of every node on the cycle.

### 13.3 Hash-consing makes sharing the default

Weft builds DAG nodes through an interning table. A node's key is its operation, its operands' ids, its width and its attributes. Asking for a node that already exists returns the existing one:

```js
// sketch, not from the examples: how the IR interns a node
function intern(op, args, width, attrs) {
  const key = hashOf(op, args.map(a => a.id), width, attrs);
  if (!table.has(key)) table.set(key, makeNode(op, args, width, attrs));
  return table.get(key);
}
```

This is hash-consing, also called structural hashing; AIG-based logic tools such as ABC are built on it. Its consequence is that common subexpression elimination costs almost nothing. If two lambdas both compute `$.a * $.b`, the second request returns `%5`, and one multiplier is built. The `cse` pass still exists, because other passes rewrite nodes and can create duplicates after the fact, but most sharing happens at construction.

Not every node can be interned. Ports, memories and registers have identity: two registers with the same input are two pieces of state unless the compiler proves they always agree. Weft merges registers only when their next-state node and reset value are both identical, which is the rule Yosys's `opt_merge` follows for flip-flops.

### 13.4 Widths: infer, then enforce

Each operation has a width rule from Chapter 2. For two operands of widths a and b:

| Operation | Result width |
| --- | --- |
| `+` (unsigned) | max(a, b) + 1 |
| `-` (unsigned − unsigned) | max(a, b) + 1, signed |
| `*` | a + b |
| `<< k` (constant k) | a + k |
| `&`, `\|`, `^`, `?:` | max(a, b) |
| comparisons | 1 |

The `widths` pass computes these in topological order. Ports and registers carry declared types, so the only unknowns are intermediate nodes and locals, and one forward sweep settles them. In HIR, before flattening, the same rules run as an iteration over a lattice: each width starts unknown, each rule can only raise it, and widths are bounded, so the iteration reaches a fixpoint. On the DAG that fixpoint arrives in a single pass.

Enforcement is a separate step and is where Weft's opinion lives. At every assignment, the source width must fit the target, unless the source is wrapped in `wrap()` or `sat()`, or the assignment is compound. In `mac`, `%6` is computed at 49 bits (max(48, 36) + 1) and assigned to a 48-bit register, which is legal only because `+=` wraps by definition. Written as `$.acc = $.acc + $.a * $.b`, it fails with a diagnostic of this form (illustrative wording):

```text
F-13:17  49-bit value assigned to 48-bit register acc.
         Say how to narrow it: wrap(…), sat(…), or +=.
```

### 13.5 Optimizing to a fixpoint

The `optimize` stage runs four passes and repeats them:

```js
    .stage("optimize", s => s
      .pass(std.passes.constFold, std.passes.cse, std.passes.muxTree, std.passes.dce)
      .fixpoint({ max: 8 }))                        // repeat until the graph's hash stops changing
```

- `constFold` evaluates nodes whose operands are constants and applies identities such as x + 0 = x and x & 0 = 0. A folded node is replaced by an interned constant.
- `cse` re-interns every node, merging duplicates that earlier rewrites created.
- `muxTree` flattens chains of `if`/`else` into multiplexer trees. When the conditions are mutually exclusive (a `switch` on one value, for instance), it builds a balanced tree instead of a priority chain, cutting depth from n to log2 n.
- `dce` marks every node reachable backwards from an output port or a register's next-state, then deletes the rest.

The passes feed each other. Folding a condition to a constant turns a mux into a wire, which leaves one of its inputs dead, which `dce` then removes. That is why the stage repeats. It stops when a full round leaves the graph's hash unchanged.

Why must it stop? Each of these passes either leaves the graph unchanged or lowers a cost that cannot fall below zero: the node count, and among graphs of equal count, the total mux depth. A strictly decreasing sequence of non-negative integers is finite. The `max: 8` bound guards against a bug that breaks this argument, such as two passes that undo each other. Hitting it produces a warning naming the passes that changed the graph in the last round.

### 13.6 Checking the IR after every pass

`.verifyEach()` re-runs the IR verifier after every pass, the same idea as LLVM's `-verify-each`. The invariants are cheap to check, linear in the number of nodes, and each one is something a buggy pass could break:

- The graph is acyclic once register next-state edges are removed.
- Every operand exists, and every node's width matches its operation's rule.
- Every signal has exactly one driver, and every node belongs to exactly one clock domain unless it is a declared crossing.
- Every node carries a provenance record (13.10).

Without `verifyEach`, a pass that breaks an invariant fails later, in some other pass, with a message about the wrong thing. With it, the failure names the pass that caused it.

### 13.7 Mapping onto the part

The `map` stage lowers the DAG to the cells the part actually has. On Xilinx 7-series parts those are 6-input LUTs, flip-flops, CARRY4 chains, DSP48E1 slices and block RAMs.

**Technology mapping** covers the DAG's logic with LUTs. A k-input LUT can compute any function of k inputs. So the question for each node is which set of at most k earlier signals, a k-feasible cut, it can be computed from. Choosing cuts for every node to cover the graph is the mapping problem. FlowMap (Cong and Ding, 1994) showed that the mapping with minimum depth, the fewest LUT levels on the longest path, can be found in polynomial time by labelling nodes in topological order and using a max-flow computation to find each node's lowest-height cut. Modern mappers, including the ABC system that Yosys calls, enumerate a bounded set of priority cuts per node and then recover area without increasing depth.

**DSP packing** recognizes patterns that match a hard block. A DSP48E1 contains a 25 × 18 signed multiplier, a 48-bit adder/accumulator and pipeline registers. The `mac` DAG, `%5` feeding `%6` feeding `%7` into register `%4`, is exactly a multiply-accumulate with a synchronous clear. `dsp.pack` maps all of it into one slice, and the `check("one DSP", …)` line in F-13 asserts that it did.

**Memory inference** (`mem.infer`) decides whether each ROM or RAM becomes LUTs, distributed RAM or block RAM. Its main input is size. Its second input is whether every read result is registered, because block RAM reads are synchronous. For a RAM the grammar makes you say so (Chapter 8); a ROM read is written combinationally and goes to block RAM only when its result is registered.

### 13.8 Placement and routing

The `back` stage gives every cell a site and every net a path.

Placement minimizes an estimate of wiring and delay. Simulated annealing placement predates FPGAs (TimberWolf, 1985), and VPR (Betz and Rose, 1997) made it, with an adaptive cooling schedule, the standard in FPGA research: start from a random legal placement, propose swaps, accept every improvement and some worsening moves with a probability that falls as a temperature parameter cools. Accepting some bad moves early lets the search escape local minima. Analytic placers, such as nextpnr's HeAP, instead solve for positions that minimize a quadratic wire-length function and then legalize the result onto real sites; they scale better to large designs.

Routing connects the placed pins through the part's switch matrix. PathFinder (McMurchie and Ebeling, 1995) routes every net by shortest path, allowing nets to share wires at first. It then raises the cost of every overused wire and routes again:

```text
repeat:
  for each net n: rip up n; route n by cheapest path, where
      cost(wire) = (base(wire) + history(wire)) × present(wire)
  for each overused wire w: history(w) += step
until no wire is used by more than one net
```

The present term penalizes sharing now; the history term remembers wires that have been contested before. Nets that have alternatives move away, and nets that do not keep the scarce wires. Most FPGA routers, including nextpnr's, are variations on this negotiation.

### 13.9 Static timing analysis

The `timing` pass asks whether every register-to-register path fits in a clock period. On a DAG this is a longest-path problem, solvable in linear time. For each node v, with d(u, v) the delay of the cell and wire from u to v:

```latex
\mathrm{AT}(v) = \max_{u \to v} \big( \mathrm{AT}(u) + d(u, v) \big), \qquad \mathrm{RT}(v) = \min_{v \to w} \big( \mathrm{RT}(w) - d(v, w) \big), \qquad \mathrm{slack}(v) = \mathrm{RT}(v) - \mathrm{AT}(v)
```

Arrival times (AT) start at each register output with the clock-to-output delay and propagate forward. Required times (RT) start at each register input with the period minus the setup time and propagate backward. Negative slack anywhere means the clock is too fast for that path. The worst path is recovered by walking back from the worst endpoint along the predecessor that set each maximum.

Weft also runs an estimate on the DAG, before placement, using per-operation delays for the part. It is less accurate, but it lets passes like `pipeline.cut` (Chapter 15) and `split-fanout` (Chapter 14) make timing-aware decisions early.

### 13.10 Provenance: every node remembers where it came from

Every DAG node carries an origin: the example, the lambda and the source span that produced it. Passes preserve it. A node created by folding or merging takes the union of its parents' origins, and a LUT records the DAG nodes it covers. That is what lets the second check in F-13 report a failing path in source terms:

```js
    .check("meets 250 MHz", r => r.timing.slack("sys") >= 0 || r.timing.worst("sys").explain())   // path → source
```

Asked for 400 MHz, `explain()` would print something like this (illustrative, with no real delays):

```text
worst path in sys: negative slack
  %1  in a          F-13:13  .in({ a: s(18), b: s(18), clear: bit })
  %5  mul           F-13:17  $.a * $.b
  %6  add           F-13:17  +=
  %7  mux           F-13:16  if ($.clear)
  %4  reg acc (D)   F-13:14  .out("acc", s(48))
```

Four lowerings separate the source from the routed netlist. Without provenance, a timing report names cells like `DSP48E1_X0Y12`, and the designer has to guess which line of JS produced them. Chapter 18's agent depends on the same records.

### 13.11 Content-addressed caching

`.cache(".weft/cache")` makes builds incremental. Each node's hash is computed from its operation, its attributes and its operands' hashes, so it identifies the whole cone of logic beneath it. One subtlety: a register's hash uses its name, type and reset value, not its next-state, because next-state edges form cycles and a hash cannot depend on itself.

A pass result is cached under the pass's name, its parameters and the hash of its input. An edit changes the hashes of the nodes it touches and of everything that depends on them, and nothing else. Unchanged modules hit the cache through `map`. Placement and routing are global problems, so they are incremental only where the floorplan locks a region, which is the mechanism Chapter 17 uses for partial reconfiguration.

### Key points

- Weft compiles through four IR levels, hir, dag, net and phys, and each pass runs at the highest level that still shows what it needs.
- Removing register next-state edges leaves a DAG, so widths, timing and simulation each need only one or two topological sweeps, and any remaining cycle is a combinational loop.
- Hash-consed construction makes structural sharing the default, which is why common subexpression elimination is nearly free.
- The optimize stage runs to a fixpoint and terminates because each pass either changes nothing or lowers a non-negative cost; `max` only catches bugs.
- Mapping covers the DAG with the part's cells, placement and routing give them sites and wires, and static timing analysis is a longest-path computation on the result.
- Provenance on every node lets a failing path, after four lowerings, be explained in terms of the source lines that produced it.

F-13 used only built-in passes. Chapter 14 writes new ones: an analysis, a transform, a lint, and rewrite rules that the compiler checks before it trusts them.

## Chapter 14 · Your own passes

Follows **F-14** (`F-14-own-passes.js`).

A compiler you cannot extend forces every project-specific rule into the source, or into a script that edits the output. This chapter shows how Weft lets you add to the pipeline instead: an analysis that computes a fact, a pass that changes the graph, a lint that only reports, and rewrite rules written in the same lambda syntax as the hardware they rewrite. Along the way it covers three ideas from compiler research that make such extension safe. Analyses are cached and invalidated by declaration. Rewrites run in an e-graph, so the order of rules stops mattering. Every rule is proved before it is trusted.

As before, the plans, e-graphs and diagnostics below are worked by hand. Weft is a proposed design.

### 14.1 Passes are values

In F-14 a pass is built the same way as a module: a builder function, a chain of calls, a value at the end. That has the same consequences Chapter 4 described for modules. A pass can be stored in a variable, shared between designs, and specialized with `.with()` without being copied:

```js
    .before("techmap", s => s.pass(splitFanout.with({ limit: 16 })))
```

There are four kinds, and they differ in what they are allowed to do:

| Kind | Built with | May change the IR | Produces |
| --- | --- | --- | --- |
| analysis | `analysis(name).run(g => …)` | no | a value other passes can require |
| pass | `pass(name).visit(…)` or `.run(…)` | yes | a changed graph |
| lint | `pass(name).readonly().visit(…)` | no | diagnostics at source lines |
| rewrite | `rewrite(name).from(…).to(…)` | through a rewriting pass | equalities between subgraphs |

The lambdas inside a pass are builder lambdas in the sense of Chapter 3. They run in JS, at compile time, over the IR, and may capture anything. Only the `from` and `to` lambdas of a rewrite are parsed like hardware lambdas, because they describe hardware.

### 14.2 Analyses and invalidation

An analysis computes a fact about a graph. F-14's `fanout` maps each node to its number of users:

```js
const fanout = analysis("fanout")
  .on("dag")
  .run(g => new Map(g.nodes().map(n => [n.id, n.users.length])));
```

Computing it is linear in the graph size, but a pipeline may ask for it many times. So the pass manager caches each analysis result under the analysis name and the graph's hash from Chapter 13. A second request against the same graph is a lookup.

The hard part is knowing when a cached result has gone stale. A pass that changes the graph changes its hash, so a hash-keyed cache can never return a stale value. But throwing every analysis away after every change wastes work, because many changes leave many facts intact. So a pass declares what it keeps:

```js
  .preserves("widths", "domains")                   // everything else is invalidated when this pass edits the graph
```

When `split-fanout` changes the graph, the manager carries the `widths` and `domains` results forward to the new hash and drops the rest. A `readonly()` pass preserves everything by construction. This is the design of LLVM's new pass manager, where a pass returns a `PreservedAnalyses` set. It has the same failure mode: a pass that claims to preserve an analysis it actually breaks produces wrong answers downstream. Weft's `verifyEach` from Chapter 13 can recompute preserved analyses and compare, which is slow but catches that bug at the pass that caused it.

### 14.3 The pass list is a DAG

`split-fanout` declares what it needs:

```js
  .requires(fanout, std.analyses.timing)            // estimated on the DAG, long before placement
```

Analyses may require other analyses; the timing estimate needs widths, for example. Together with the order of transform passes that you write, these requirements form a DAG: transform passes in your order, each preceded by whatever analyses it requires, each analysis preceded by its own requirements. The manager schedules that DAG topologically and runs an analysis only if the cache does not already hold a fresh result. Independent analyses have no edge between them, so they may run in parallel.

`.explainPlan()` prints the decisions. Around `split-fanout`, the plan would read something like this:

```text
before split-fanout
  widths            cached (preserved by every pass since lower)
  fanout            not cached for this graph → run
  timing.estimate   cached by pipeline.cut, but retime changed the graph → run
after split-fanout (preserves widths, domains)
  widths, domains   carried forward
  fanout, timing    dropped
```

### 14.4 Visitors

Most passes act on one kind of node at a time. `.visit(op, fn)` calls `fn` once per node of that operation, with the node, the graph and the required analyses plus parameters:

```js
  .visit("reg", (n, g, { fanout, timing, limit }) => {
    const users = fanout.get(n.id);
    if (users > limit && timing.slack(n) < 0.5) g.duplicate(n, { copies: Math.ceil(users / limit), split: "users" });
  });
```

The manager visits in topological order and queues the edits. They are applied after the walk, so every call sees the same consistent graph. Without that rule, the outcome would depend on which nodes the visitor reached first.

The pass itself encodes a standard timing fix. A register that drives hundreds of loads drives a long, heavily loaded net, and that net is slow. Duplicating the register into several copies, each driving a share of the loads, trades flip-flops for delay. The slack condition limits the trade to registers that are actually on slow paths.

In F-14 the pass has a register to split because `scaler` registers its enable once: `.regs({ go: bit })` and `$.go = $.en`. That one flip-flop drives the enables of all 64 words of `y`. That is 1280 bits, but the fanout analysis counts users in the word-level DAG, 64 here, so with a limit of 16 the pass makes 4 copies of 16 users each. Visiting the port `en` directly would not work, because an input port has no driver inside the module to copy. That is one reason modules register their inputs at a boundary.

### 14.5 Rewrite rules are patterns on the DAG

A rewrite is a pair of lambdas and a guard:

```js
  rewrite("multiply by a power of two")
    .from((x, k) => x * k)                          // a pattern: x and k match any node…
    .where(({ k }) => k.isConst && isPow2(k.value)) // …and this builder lambda narrows the match
    .to((x, k) => x << clog2(k))
    .examples([[x => x * 8, x => x << 3], [x => x * 6, null]]),   // null: must not match
```

The compiler parses `from` into a pattern: a `mul` node whose two operands are pattern variables `?x` and `?k`. Matching is structural. At each `mul` node in the DAG, bind `?x` and `?k` to its operands, then run the `where` guard with those bindings. The guard is a builder lambda, so it runs at compile time and may call any JS function, such as `isPow2`. The `to` lambda is parsed into a template, and since `k` is a constant, `clog2(k)` is evaluated at build time.

Widths make one detail less obvious than it looks. In `scaler`, `($.x ^ i) * 8` has 20 bits: 16 for the operand and 4 for the constant 8. The replacement `<< 3` has 19. Equal as integers is not equal as bit vectors, so the rewriting pass extends the replacement to the original node's type. For a signed operand that extension must be a sign extension. Getting this wrong is the most common bug in hand-written rules, and 14.7 shows how Weft catches it.

The `examples` line is a unit test. The first pair must match and rewrite to the given form; the second must not match at all. The compiler runs them before using the rule.

### 14.6 Order dependence, and e-graphs

Applying rules greedily, one at a time, destroys the original expression each time. The result then depends on which rule fired first. Take `c ? a * 8 : a * 5` and two rules: the power-of-two rule above, and a factoring rule `c ? x * y : x * z → x * (c ? y : z)`.

- If the power-of-two rule fires first, the result is `c ? (a << 3) : a * 5`. The factoring rule no longer matches, because one arm is now a shift.
- If the factoring rule fires first, the result is `a * (c ? 8 : 5)`. The power-of-two rule no longer matches, because the multiplier is now a mux.

Which of the two is cheaper depends on the width of `a` and on the part. A greedy rewriter never compares them; it keeps whichever its order produced.

An e-graph keeps both. It stores e-classes, sets of nodes known to compute the same value. Each node's operands are e-classes, not nodes. A rewrite adds the right-hand side to the left-hand side's e-class instead of replacing it. After both rules have run, the expression above looks like this:

```text
e1 = { a }    e2 = { 8 }    e3 = { 5 }    e4 = { c }
e5 = { mul(e1, e2), shl(e1, 3) }           ← power-of-two rule added shl
e6 = { mul(e1, e3) }
e8 = { mux(e4, e2, e3) }
e7 = { mux(e4, e5, e6), mul(e1, e8) }      ← factoring rule added the factored form
```

The structure has two maintenance steps. A union-find structure merges e-classes. Congruence closure then restores the invariant that equal operands make equal nodes: after merging two classes, any two parent nodes that have become identical are merged too. The egg library (Willsey et al., 2021) made this fast enough for routine compiler use by deferring that repair to a single rebuild step after each round of rule applications.

Equality saturation runs every rule against every e-class until a round adds nothing new, or until a limit is reached; F-14 sets that limit:

```js
    .after("optimize", s => s.pass(std.passes.saturate(peephole, { iters: 6, cost: "luts" })))   // e-graph, cheapest wins
```

Extraction then picks one node per e-class to build the output graph. With a cost per node, it works bottom-up: an e-class costs the minimum, over its nodes, of the node's own cost plus its operands' costs. That sum counts shared subgraphs once per use, so it is an approximation. Exact extraction with sharing is NP-hard, and tools that need it solve it as an integer linear program. Either way, the choice between the two forms of `e7` is made by measuring cost, not by the order the rules happened to run in.

### 14.7 Proving a rule before trusting it

A wrong rule is worse than a wrong pass, because it fires everywhere its pattern appears. So when a rule is loaded, Weft screens it for every width from 1 to 16 and both signednesses, and each time it fires, Weft proves that instance again at the match's exact widths and signedness, caching the result per instance. For each width w and each constant the guard admits, it builds a miter: both sides of the rule over the same symbolic inputs, the outputs compared bit by bit, the differences ORed into one output.

```text
for w in 1..16:
  x ← w symbolic bits
  for each constant k the guard admits at width w:
    L ← bit-blast(from(x, k));  R ← bit-blast(extend(to(x, k), width(L)))
    miss ← OR over i of (L[i] XOR R[i])
    if SAT(miss = 1): reject the rule; report x, k and the differing bit
```

Bit-blasting turns each bit-vector operation into gates, and the Tseitin encoding turns the gates into clauses a SAT solver accepts. An unsatisfiable miter means no input makes the two sides differ at that width. A satisfiable one comes with a counterexample, which is exactly what a rule author needs. The classic catch is a rule that zero-extends a signed operand. At w = 1, a signed `x` takes the values −1 and 0; `x * 8` is −8, and a zero-extended `x << 3` is +8.

The screen is a bounded proof, and a bounded proof does not establish a rule for all widths: a rule could hold at every width up to 16 and fail at 17. Widths 1 to 16 catch the errors rules actually contain (sign handling, extensions, off-by-one shifts), so the screen is a cheap first filter. Soundness comes from the second check, translation validation (Pnueli, Siegel and Singerman, 1998) applied to each rewrite: the instance is proved at the widths where it fires, which are finite and known. Proofs are cached by rule, widths and signedness, so sixty-four identical matches cost one proof. Whole-graph equivalence, the `equiv` step of Chapters 17 and 18, is the same idea applied to an entire change.

### 14.8 Lints report at the source

A lint is a pass that never changes the IR:

```js
const wideCompares = pass("lint: wide comparisons")
  .on("dag")
  .readonly()                                       // preserves every analysis
  .visit(["lt", "le", "gt", "ge"], (n, g) => {
    const w = Math.max(...n.args.map(a => a.width));   // the result is one bit; the operands carry the width
    if (w > 32) g.warn(n, `${w}-bit comparison in one cycle`);   // reported at the lambda's source line
  });
```

`g.warn(n, …)` attaches the message to the node, and the node's provenance from Chapter 13 locates it. The visitor tests its operands' width, because a comparison's own result is one bit (Chapter 2), so n.width would never pass 32. For `scaler`, the 48-bit comparison `$.now > $.deadline` produces a warning at line 53 of F-14, the `.comb` line that wrote it. A lint that pointed at a DAG node id would be correct and useless. One that points at a line of source is something a designer can act on.

### 14.9 Same scenario, three levels, and bisection

The scenario in F-14 carries a third argument:

```js
    { levels: ["hir", "dag", "net"] });             // run at three IR levels; a mismatch is bisected to one pass
```

Every IR level in Weft is executable. HIR runs as interpreted lambdas, the DAG as a levelized evaluation, and the netlist through behavioral models of each cell. A scenario that passes at `dag` and fails at `net` has therefore been broken by one of the passes in between. The compiler already holds a cached snapshot after each of those passes, so it can binary-search:

```text
passes between the passing and failing levels: p1 … pk
lo ← 0 (passes), hi ← k (fails)
while hi − lo > 1:
  mid ← ⌊(lo + hi) / 2⌋
  if scenario passes on snapshot after p_mid: lo ← mid else hi ← mid
report p_hi, with the first differing signal and its provenance
```

Eight passes need three runs. If the culprit is `saturate`, the same search continues inside it over the set of rules, which is Zeller's delta debugging applied to a rule set.

One caution about what "differs" means. Retiming and `pipeline.cut` legitimately change when values appear on paths marked `.pipelined()`. Scenarios that compare streams, sequences of beats, are immune to that. Scenarios that check a signal at an exact cycle are compared only on paths whose latency the compiler was not allowed to change.

### Key points

- Analyses, passes, lints and rewrites are values built like modules, and only a rewrite's `from` and `to` are parsed as hardware.
- Analysis results are cached by graph hash, and `preserves` decides which ones survive a change, as in LLVM's new pass manager.
- Requirements make the pass list a DAG that the manager schedules topologically, and `explainPlan` shows what ran and what was reused.
- Greedy rewriting depends on rule order; an e-graph keeps every equivalent form and lets a cost function choose among them.
- Every rewrite rule is screened by SAT for widths 1 to 16 when loaded and proved again at the exact widths of each match, and the counterexample is the diagnostic when either check fails.
- Because every IR level is executable, a scenario that fails at a lower level is bisected to the single pass that broke it.

The passes in this chapter change structure but never latency. Chapter 15 introduces passes that do: cutting a long combinational path into stages, and moving registers to balance them.

## Chapter 15 · Retiming and exploration

Follows **F-15** (`F-15-retime-explore.js`).

F-15 writes a 31-tap filter the way a mathematician would write it, as one sum, and leaves the compiler to make it fast. This chapter explains why that is allowed and how it is done. It is allowed because the filter's output is a stream, and a stream's consumer cannot observe latency. It is done by two passes, `pipeline.cut`, which adds register stages, and `retime`, which moves registers to where they do the most good. The chapter ends with design-space exploration: compiling the same design under many settings and keeping only the results no other result beats.

Weft is a proposed design; the coefficient values below were computed by running the example's `lowpass` function, and everything else is worked by hand.

### 15.1 What the filter computes

A finite impulse response (FIR) filter computes each output as a weighted sum of the last N inputs:

```latex
y[n] = \sum_{i=0}^{N-1} h[i] \, x[n-i]
```

F-15 designs the weights at build time with a windowed sinc. The ideal low-pass filter's impulse response is a sinc function, which is infinitely long; truncating it to N samples causes ripple, and multiplying by a Hamming window, 0.54 − 0.46 cos(2πi / (N − 1)), tapers the ends to reduce it. The function then scales the weights so they sum to 2^15, which gives the filter unity gain at DC in Q15 fixed point:

```js
function lowpass(n, cutoff) {                       // windowed sinc, normalized to unity gain in Q15: plain JS
  const m = (n - 1) / 2;
  const h = Array.from({ length: n }, (_, i) => {
    const t = i - m;
    const sinc = t === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t);
    return sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1)));   // Hamming window
  });
  const sum = h.reduce((a, b) => a + b, 0);
  return h.map(v => Math.round((v / sum) * 2 ** 15));
}
```

In Q15 a value v is stored as the integer v × 2^15. Running `lowpass(31, 0.1)` gives a symmetric set of integers whose centre tap is 6542 and whose rounded sum is 32 766, within rounding of 2^15. Six of the 31 weights round to exactly zero: the two ends and the taps at offsets ±5 and ±10 from the centre. `constFold` from Chapter 13 removes those six multipliers before anything else happens, which is a small, real example of build-time values shaping hardware.

The hardware lambda computes the same sum:

```js
  .on("in", ($, x) => {
    for (let i = TAPS - 1; i > 0; i--) $.z[i] = $.z[i - 1];
    $.z[0] = x;
    let acc = x * H[0];
    for (let i = 1; i < TAPS; i++) acc = acc + $.z[i - 1] * H[i];   // grows as it must; nothing truncates
    $.push("out", sat(acc >> 15, s(16)));
  });
```

The registers `z` hold the previous 30 inputs, so `$.z[i - 1]` is x\[n − i\]. Products of a Q15 sample and a Q15 weight are Q30; the sum's true range needs about ⌈log2 31⌉ = 5 more bits, while the width rules, adding one bit per adder, give the chain as written about 30 more, which reassociation into a balanced tree and range narrowing bring back to 5; shifting right by 15 returns to Q15, and `sat` brings the result back to 16 bits.

### 15.2 A chain, a tree, and still too slow

The loop `acc = acc + …` parses into a chain of 30 adders. Each adder's output feeds the next, so the critical path crosses all 30. Integer addition is associative, and Weft's growing widths make every intermediate value exact. So the compiler may reassociate the chain into a balanced tree, whose depth is ⌈log2 31⌉ = 5 adders. That would be illegal if any intermediate saturated, because saturating addition is not associative; with Weft's width rules it never does.

Even the tree is too slow for one cycle at 200 MHz. One sample through it crosses a multiplier and five adders whose widths reach the mid-thirties of bits. At 200 MHz the whole path has 5 ns. The design has to be cut into stages.

### 15.3 Latency on a stream is free

Why may the compiler add stages without changing the design's meaning? Because of this line:

```js
  .pipelined({ path: ["in", "out"] })               // latency on this stream path is the compiler's to choose
```

The filter reads beats from the `in` stream and writes beats to `out`. A consumer of a valid/ready stream (Chapter 5) observes the sequence of values and their order. It cannot observe how many cycles each beat spent inside the filter, because it only acts when `valid` is high. Carloni, McMillan and Sangiovanni-Vincentelli formalized this as latency-insensitive design (2001): a system built from such channels keeps its behavior when stages are added to a channel, as long as the handshake is preserved.

That is the distinction Weft draws between a wire and a stream. Latency on a wire is part of the meaning: if a signal arrives one cycle later, the logic reading it computes something different. Latency on a marked stream path is a resource the compiler may spend. `.pipelined()` is how the designer grants it.

The filter has no feedback. Every path from `in` to `out` runs forward through multipliers and adders. A filter with feedback, such as the biquad in Chapter 17, is different: its output depends on its own previous output within a fixed number of cycles, and adding stages inside that loop changes the result.

### 15.4 Cutting the path into stages

`pipeline.cut` uses the DAG timing estimate from Chapter 13. It computes arrival times along the path and chooses register boundaries where arrival would exceed the target period. One rule is non-negotiable: every path from `in` to `out` must cross the same number of new registers. If one product reached the final adder a cycle later than another, the sum would combine values from different samples. The `valid` bit travels through the same number of stages as the data, so the beat and its valid flag stay aligned. When `out` is not ready, the stages stall together, or a skid buffer absorbs the stall as in Chapter 9.

`pipeline.cut` places stages coarsely. Retiming then moves the registers to balance the stages exactly.

### 15.5 Retiming

Leiserson and Saxe (1991) model a circuit as a graph whose vertices are combinational elements with delay d(v), and whose edges carry w(e), the number of registers on the connection. A retiming assigns each vertex an integer lag r(v): the number of registers moved from its outputs back to its inputs. Every edge e from u to v then has a new register count:

```latex
w_r(e) = w(e) + r(v) - r(u) \ge 0
```

The constraint is that no edge can end up with a negative number of registers. Two facts make retiming safe. First, it preserves the circuit's input-output behavior. Second, around any cycle the lags cancel, so the number of registers on every loop is unchanged; this is why retiming cannot speed up a feedback loop beyond the registers it already has.

To reach a clock period c, let W(u, v) be the fewest registers on any path from u to v, and D(u, v) the largest delay among the paths that have W(u, v) registers. A period c is achievable if and only if some lag function satisfies, for every edge and every pair with too much delay:

```latex
r(u) - r(v) \le w(e) \quad \text{for every edge } e: u \to v, \qquad r(u) - r(v) \le W(u,v) - 1 \quad \text{whenever } D(u,v) > c
```

These are difference constraints. A system of difference constraints is a shortest-path problem, so Bellman–Ford either finds a solution or finds a negative cycle, which proves c is unreachable. Binary search over the distinct values of D finds the smallest achievable period.

Retiming alone cannot lengthen the path from input to output, because the inputs and outputs are pinned. That is the division of labour: `pipeline.cut` adds registers at the edge of the path, where the stream contract permits them, and `retime` moves them into the logic.

F-15 changes one setting:

```js
    .replace("retime", std.passes.retime.with({ moves: "both" }))   // registers may move backward too
```

Moving a register forward across logic f is always possible; its new reset value is f applied to the old one. Moving a register backward requires a reset value whose image under f is the old one, and such a value may not exist. Touati and Brayton studied this initial-state problem in 1993. Weft's default moves only forward. `"both"` asks the pass to attempt backward moves and to reject any for which it cannot compute an equivalent reset state.

### 15.6 Three ways to multiply

The `MULT` parameter reaches the compiler as a hint:

```js
  .hint(({ MULT }) => ({ multiply: MULT }))         // "dsp" | "lut" | "shift-add": steers dsp.pack and techmap
```

| Choice | What gets built | Cost lands on | Fits best when |
| --- | --- | --- | --- |
| `dsp` | a hard multiplier in a DSP slice (25 × 18 on DSP48E1) | the part's few DSP slices | operands fit the slice and slices are spare |
| `lut` | an array of partial products and adders in LUTs and carry chains | LUTs, and depth | DSP slices are exhausted |
| `shift-add` | a sum of shifted copies of x, one per nonzero digit of the constant | adders, one fewer than the nonzero digits | the multiplier is a constant |

Shift-add is where the filter's build-time weights pay off again. A constant multiply needs one shifted term per nonzero digit. Canonical signed-digit (CSD) recoding uses the digits −1, 0 and +1 with no two nonzero digits adjacent, and on average needs about a third as many nonzero digits as bits, against a half for binary. The centre tap shows the effect:

```text
6542 binary : 1100110001110                   7 nonzero digits → 6 adders
6542 CSD    : 2^13 − 2^11 + 2^9 − 2^7 + 2^4 − 2^1   6 nonzero digits → 5 adders
```

The filter is also symmetric, h\[i\] = h\[30 − i\]. Adding the two samples that share a weight before multiplying would halve the multipliers again; the example leaves that as its first exercise.

### 15.7 Exploring the design space

Which choice is best depends on the part, the clock, and what else needs the DSP slices. Rather than argue, F-15 compiles them all:

```js
    .explore(x => x
      .knob("fir.TAPS", [15, 31, 63])
      .knob("fir.MULT", ["dsp", "lut", "shift-add"])
      .knob("clock.sys", ["100 MHz", "150 MHz", "200 MHz"])
```

Three values for each of three knobs is 27 compilations. The content-addressed cache from Chapter 13 makes most of them partial. The front, lower and optimize stages depend only on the elaborated design, so they run nine times, once per (TAPS, MULT) pair, because both are module params and so both are in the specialization key (Chapter 4), not once per `TAPS`. The time stage and everything after depend on the multiplier choice and the clock, so they run for every point.

Each point is reduced to a small record by `measure`, infeasible points are dropped by `keep(m => m.met)`, and the rest are filtered to the Pareto front. Point a dominates point b if a is no worse on every objective and strictly better on at least one. The front is the set of points no other point dominates:

```text
front ← []
for each point p:
  if no q in points dominates p: append p to front

dominates(q, p) = (q.luts ≤ p.luts and q.dsps ≤ p.dsps and q.latency ≤ p.latency)
                  and (q is strictly smaller on at least one)
```

The quadratic loop is fine for 27 points. The front, not a single winner, is the right output, because the objectives trade against each other. The designer's remaining choice depends on things the compiler does not know, such as whether the next feature will need those DSP slices.

### 15.8 Build-time knobs and runtime knobs

Chapter 12's knobs and F-15's knobs are the same idea at different times. Each is a bounded choice declared by the designer and made by someone else: an agent, a host program or a search.

|  | Build-time knob (F-15) | Runtime knob (F-12) |
| --- | --- | --- |
| When it is chosen | before synthesis | while the design runs |
| What it can change | structure: how many multipliers, which cells, how many stages | a value in a register |
| Cost of changing it | a (partial) rebuild | one bus write |
| How bounds are enforced | the list of values in `.knob()` | comparators on the write path |

The boundary between them is a design decision. A filter whose tap count could change at runtime would need hardware for the largest count and a RAM for the weights, so the flexibility is paid for in area. F-15 makes taps a build-time choice because, for this filter, the tap count is a question about the product rather than about the moment.

One last detail in the scenario ties back to Chapter 3. The JS reference model divides with `Math.floor(acc / 2 ** 15)` instead of shifting with `>>`. JS's `>>` truncates its operand to 32 bits. For these 31 weights the worst-case sum, about 1.39 × 10^9, fits, and so does the 63-tap worst case, about 1.70 × 10^9, still below 2^31. Longer filters or wider inputs may not, and a reference model should not depend on that.

### Key points

- An FIR filter is a weighted sum, and build-time design of its weights already removes six multipliers here through constant folding.
- Growing widths make adder-chain reassociation exact, which turns a 30-deep chain into a 5-deep tree.
- A consumer of a valid/ready stream cannot observe latency, so `.pipelined()` lets the compiler add stages to a feed-forward stream path.
- Retiming moves registers by integer lags under w\_r(e) ≥ 0, preserves the registers on every cycle, and finds the best period by solving difference constraints.
- Exploration compiles a grid of build-time knobs, reuses every cached stage it can, and returns the Pareto front rather than a single answer.

Every example so far has targeted one part. Chapter 16 builds one design for three, and shows what in the pipeline stays shared until the moment the part has to be named.

## Chapter 16 · Targets and backends

Follows **F-16** (`F-16-targets.js`).

A Weft design is written against the dataflow graph, not against a part. The graph meets a part only at technology mapping. This chapter follows one small design, a UART that shouts back what it hears, through three builds at once. It explains what the builds share, where they differ, and how a backend turns an IR level into files. As everywhere in this book, Weft is a proposed design: the traces are worked by hand from its semantics, not printed by a tool.

### 16.1 Where target independence ends

Every pass before `techmap` speaks the DAG's vocabulary: adders, multiplexers, comparators, registers and memories, each with a width. None of those operations names a cell. An 8-bit `add` is the same node whether it becomes LUTs on a carry chain in an iCE40 or part of a slice in an Artix-7. That is why F-16 can declare three boards and share everything up to the DAG:

```js
return design("shout")
  .boards({
    pico: board("pico"),                            // ice40up5k
    dev: board("dev"),                              // xc7a35t
    big: board("dev").part("xc7a100t-1csg324"),     // a board profile is a copy you can change
  })
```

The compiler builds one pipeline per target, and pass results are content-addressed (Chapter 13). A pass whose input hash and parameters match a cached result does not run again. Parse therefore runs once. Elaboration and the DAG passes run once per distinct clock: dev and big both run at 100 MHz and share them, while pico, at 12 MHz, gets its own DAG, because the UART dividers are computed from the clock while the design is built (Chapter 6). Within each group, the pipelines fork at the first pass whose behavior depends on the part.

That fork is usually `techmap`, with one subtlety. Passes that consult a delay model, such as `pipeline.cut` and `retime`, depend on the family's delays even though they rewrite the DAG. Weft runs them per target when some module is `.pipelined()` and shares them when none is. F-16 has no pipelined module, so its fork falls exactly at the `map` stage.

### 16.2 What the families disagree about

Technology mapping covers the DAG with the cells a family offers. F-16's three targets come from two families, and their differences are structural.

| Resource | iCE40 UP5K (pico) | Artix-7 35T (dev) | Artix-7 100T (big) |
| --- | --- | --- | --- |
| Logic cell | 4-input LUT | 6-input LUT, or two 5-input LUTs sharing inputs | as dev |
| LUTs | 5,280 | 20,800 | 63,400 |
| Carry logic | `SB_CARRY`, one bit per LUT | `CARRY4`, four bits per slice | as dev |
| Shift registers | flip-flops only | `SRL16E` / `SRLC32E` in SLICEM LUTs | as dev |
| Multipliers | 8 `SB_MAC16` (16 × 16) | 90 `DSP48E1` (25 × 18) | 240 `DSP48E1` |
| Block memory | 30 × 4 Kb EBR, 4 × 256 Kb SPRAM | 50 × 36 Kb | 135 × 36 Kb |

These figures are the vendors' published capacities, quoted from memory; check the datasheet before relying on one.

Each row changes what a good mapping looks like. A LUT4 absorbs any function of four inputs and a LUT6 any function of six, so one comparator costs a different number of cells, and a different number of logic levels, on each family. Carry chains are dedicated fast routes, so adders belong on them in both families, but at different granularity. Memories differ most. A 512 × 8 buffer is exactly one 4 Kb EBR on iCE40. A 32 KB buffer is exactly one SPRAM on the UP5K but eight 36 Kb blocks on the 35T.

`upcase` shows how little of this the source needs to know:

```js
const upcase = module("upcase")
  .needs("rx.bytes").provides("tx.bytes")
  .on("rx.bytes", ($, c) => {
    $.push("tx.bytes", c >= 97 && c <= 122 ? c ^ 0x20 : c);   // flip bit 5: a → A
  });
```

Worked by hand: XOR with the constant `0x20` changes only bit 5, so after `constFold` the two arms of the multiplexer agree on seven of eight bits. `muxTree` and `dce` reduce the output to seven plain wires and one gate, `out[5] = c[5] XOR lower(c)`, where `lower(c)` is the test 97 ≤ c ≤ 122. That test reads eight input bits, so it takes more than one cell on either family. How many is `techmap`'s decision, and it decides differently for LUT4 and LUT6.

### 16.3 One pipeline per target: `c.when`

Most of a build is the same for every part. Where it is not, F-16 states the difference as a conditional edit to the pipeline:

```js
.when(t => t.family === "xc7", w => w.after("map", s => s.pass(std.passes.srl.infer)))   // LUTs as shift registers
```

Both lambdas are builder lambdas. The predicate runs once per target and sees that target's record: `name`, `family`, `part`. The second lambda receives the target's pipeline builder and edits it with the verbs F-14 and F-15 use (`after`, `before`, `replace`). The result is one pipeline value per target, and `explainPlan()` prints where they diverge.

`srl.infer` is added only for 7-series because only 7-series has its cell. A SLICEM LUT can act as a 16-bit (`SRL16E`) or 32-bit (`SRLC32E`) addressable shift register, so a chain of up to 32 flip-flops with no taps in between collapses into one LUT. A delay line qualifies. A deserializer, such as a UART receiver's shift register, does not: an SRL exposes one addressed output, and the receiver reads all eight bits at once. SRL16E and SRLC32E also have no reset, so the pass applies only to chains whose reset value is never observed. A CDC synchronizer chain must not: the pass skips registers that `checks.cdc` marked as synchronizers, because an SRL's storage cells resolve metastability poorly. On iCE40 there is no cell to map onto, so the pass is not added at all rather than added and made to do nothing.

### 16.4 Backends walk an IR level

A backend is a function from one IR level to files. F-16 writes one of its own:

```js
const census = backend("cell-census")
  .on("net")                                        // after techmap, once per target
  .emit((net, out) => {
    const counts = {};
    for (const cell of net.cells()) counts[cell.type] = (counts[cell.type] ?? 0) + 1;
    out.file("cells.json", JSON.stringify(counts, null, 2));
  });
```

`.on("net")` fixes the level, and the level fixes how often the backend runs. A DAG-level backend runs once; a net-level backend runs once per target, because each target has its own netlist. The census for `pico` counts iCE40 primitives such as `SB_LUT4`, `SB_CARRY` and the `SB_DFF` family. The census for `dev` counts `LUT6`, `FDRE` and `CARRY4`, plus `SRL16E` or `SRLC32E` where `srl.infer` found a chain.

The built-in Verilog and VHDL emitters are backends of the same kind. Their `to` option is a builder lambda of the target, so they run per target and read the last level that target reached: here the netlist. They print it as structural HDL that instantiates the family's primitives with their `INIT` truth tables. Passing `level: "dag"` instead yields target-neutral RTL with `always` blocks and operators, which is what you hand to a vendor's own synthesis.

Two properties make an emitter usable. The first is naming: every net and cell is named from its provenance, meaning the module and the source text it came from, plus a short content hash where a name would repeat. A path in a vendor timing report then reads as `upcase.on("rx.bytes")` instead of `n_4817`. The second is determinism: the same input yields byte-identical files. An emitter that walked a hash map in address order would write a different file on every run, and every rebuild would appear as a diff. Weft's emitters sort by stable keys.

### 16.5 A model you can run: the DAG compiled to WebAssembly

```js
.emit("sim:wasm", { to: t => `build/${t.name}/shout.wasm`, level: "dag" })   // one model per distinct DAG
```

`sim:wasm` compiles the DAG into a cycle-accurate model, and because it reads the DAG, there is one model per distinct DAG: dev and big share one, and pico has its own. The technique is the one Verilator made standard for Verilog: compiled, levelized, two-state simulation.

Levelization is a topological sort of each domain's DAG. Registers are the DAG's sources and sinks, so each combinational node gets a level one greater than its deepest operand. Evaluating in level order guarantees every operand is ready before it is read. The compiler emits straight-line code in that order rather than an interpreter loop, and each clock edge runs in two phases:

```js
// sketch, not from the examples: one rising edge of one domain, as the compiled model runs it
function edge(state, inputs) {
  const v = evaluateInLevelOrder(state, inputs);   // phase 1: every combinational node, operands first
  for (const r of registers) state[r] = v[r.next]; // phase 2: every register takes its next value at once
}
```

The second phase is what makes the model correct. All flip-flops on a clock sample at the same edge. If the model wrote registers one at a time while still evaluating, a register written early would be read late by its neighbor, and a four-stage shift register would move a bit four places in one cycle. Computing every next value first and committing them together reproduces the hardware's simultaneity. With several domains, the model orders clock edges by time and runs each domain's `edge` when its clock rises.

Two-state means a bit is 0 or 1, never X. Weft can afford that because its semantics leave nothing undefined: registers reset to declared values, and the latch check (Chapter 13) guarantees every wire is assigned on every path.

### 16.6 One scenario, two levels, three parts

```js
  .scenario("shouts back", sc => sc
    .uart("uart", "hello, fabric\n")
    .expectUart("uart", "HELLO, FABRIC\n", { within: "3ms" }),
    { levels: ["dag", "net"], targets: "all" });    // two DAG runs (pico; dev and big), three net runs
```

The scenario drives the serial line bit by bit. 8N1 framing is a start bit (low), eight data bits least significant first, and a stop bit (high): ten bit times per byte. At 115,200 baud a bit lasts 8.68 µs and a byte 86.8 µs, so the 14 characters take 1.22 ms. The echo overlaps the input byte by byte, which leaves room inside 3 ms.

`std.uart.rx` samples the way receivers have for decades. It oversamples the line, usually 16 times per bit, and waits for the falling edge of the start bit. It then moves half a bit to the middle of the start bit, checks the line is still low, and takes one sample in the middle of each following bit. Sampling mid-bit tolerates a few percent of baud-rate mismatch between the two ends.

`levels` and `targets` multiply the run. The scenario executes once against each of the two DAG models (pico's, and the one dev and big share), and once per target against a gate-level model of its netlist, in which every LUT is evaluated from its truth table. That is five runs, two DAG and three net, against one expectation, and the pattern of results says where a fault lives:

| DAG runs | pico net | dev and big nets | Where to look |
| --- | --- | --- | --- |
| pass | pass | pass | Nowhere. |
| fail | fail | fail | The design or the scenario. |
| pass | fail | pass | An iCE40-only step: its mapping rules or cell models. |
| pass | pass | fail | A 7-series-only step, such as `srl.infer`. |
| pass | fail | fail | A shared pass after the DAG, such as `mem.infer` or `fsm.encode`. |

A disagreement between two levels of one target is a compiler bug by definition, because every pass between them claims to preserve behavior. The compiler bisects those passes, running the scenario against each intermediate IR, and names the first pass whose output fails (Chapter 14). "The gate-level simulation disagrees" stops being an afternoon of waveforms and becomes a pass name.

### Key points

- Every pass before `techmap` works on target-neutral DAG operations, so a multi-target build shares those passes through the content-addressed cache.
- Families differ in LUT size, carry chains, shift-register cells, multipliers and memory blocks, and each difference changes what a good mapping is.
- `c.when(predicate, edit)` yields one pipeline per target, and a pass with nothing to map onto is left out rather than run as a no-op.
- A backend walks one IR level; that level decides whether it runs once or once per target, and a usable emitter names from provenance and writes deterministic output.
- The WebAssembly model is a levelized, two-phase, two-state compiled simulation of the DAG, so one model serves every target.
- One scenario run at several levels and on several targets turns a disagreement into the name of the pass that caused it.

Every build so far ends with a bitstream that is loaded and left alone. Chapter 17 changes the design while it runs: the same compiler rebuilds one region, and the same scenarios and asserts decide whether the change may stay.

## Chapter 17 · Changing running hardware

Follows **F-17** (`F-17-hot-swap.js`).

F-17 keeps an audio path playing while its filter is retuned, replaced, and once broken on purpose. This chapter explains the hardware mechanism that makes the swap possible, partial reconfiguration, and the software mechanism that makes it safe: a change pipeline that checks, tries and can undo. It also keeps a lesson from writing the example. The first draft of the deliberately bad change was broken in a different and more instructive way than intended.

### 17.1 Static logic and reconfigurable partitions

An FPGA's configuration memory holds every LUT truth table, every routing switch and every flip-flop's initial value. Loading a full bitstream rewrites all of it and stops the design. Partial reconfiguration rewrites only the configuration frames that cover one region, while the rest of the device keeps running. Xilinx 7-series parts support it through their configuration port; the vendor flow calls the fixed part the static region and each swappable region a reconfigurable partition.

Three constraints follow from that mechanism, and F-17's design names all of them:

```js
  .regions(r => r.partition("dsp", { luts: 1500, dsps: 6 }))   // a floorplanned slot; everything else is static
  .place({ filter: "dsp" })
```

- A partition is a floorplanned rectangle whose resources are fixed at the first build. Every future occupant must fit in 1,500 LUTs and 6 DSPs, and the placer keeps static logic out of that rectangle.
- The boundary is fixed. Signals between static and partition logic cross at fixed routing points, so a replacement must present the same ports. That is why the biquad is declared as `module("filter")` with the same `.needs("dry").provides("wet")`.
- The boundary must be decoupled while frames are rewritten, because the partition's outputs are meaningless during the load. Decoupling logic in the static region holds `wet`'s valid low, so the DAC sees no beats rather than garbage.

A partial bitstream is proportional to the region, not the device. Its build is proportional too: the static region's placement and routing are locked, and the content-addressed cache reuses every static result, so only the partition's subgraph goes back through the pipeline.

### 17.2 Three changes, three costs

F-17 defines three changes, and they cost very different amounts.

| Change | What it alters | Compiler work | What reaches the device |
| --- | --- | --- | --- |
| `softer`: `.knob("filter.alpha", 12)` | one register's value | none | one bus write |
| `louder`: `.patch("filter", { lib: { GAIN: 4 } })` | a constant in one module | re-elaborate `filter`; map, place and route inside `dsp` | a partial bitstream |
| `swap`: `.replace("filter", biquad)` | the whole module | compile the new module; map, place and route inside `dsp` | a partial bitstream and migrated state |

A knob is the cheapest change because it was designed to be changed (Chapter 12). Its bounds are enforced in hardware, so `softer` needs no verification beyond the write itself and commits at once. The other two alter logic, and logic is where a change can be wrong.

### 17.3 The change pipeline

Every change that alters logic moves through the same stages:

&#91;embedded content: the change pipeline · 6 stages, 2 failure exits\]

A failure before the load ends in rejected and never touches the device; a failure during canary reloads the previous partial; a knob change skips the stages entirely.

- **Checked.** `lint()` reruns the front and lower stages on the changed module: the capture check in front, and the width rules, latch checks and checks.cdc in lower. `ports("same")` compares the boundary signature with the partition's fixed one.
- **Verified.** `replay("last 1s")` simulates the candidate on recorded traffic (17.4).
- **Built.** The partition is mapped, placed and routed, and a partial bitstream is written. `timing()` is answered here, on the placed result.
- **Canary.** The partial bitstream is loaded, state is migrated (17.6), and monitors watch for a window (17.5).
- **Committed** if the window passes. A failure before the load ends in **rejected**, and nothing reached the device; a failure during canary ends in **rolled-back**.

The ordering is by cost and by risk. Each stage is more expensive than the one before it, and only the last two touch hardware, so cheap stages filter out most bad changes before any bitstream is built.

### 17.4 Replay: real traffic, simulated candidate

```js
  .record({ streams: ["dry"], keep: "2s" })         // what .replay() feeds a candidate
```

The recorder taps every beat of `dry` and keeps the last two seconds. In the simulator, where the scenario runs, the simulator holds them. On a board the recording has to live somewhere, and both places cost. On chip, 2 s at 48 kHz is 96,000 samples of 16 bits, about 1.5 Mbit, most of the 35T's block RAM. Streamed to a host it is 768 kbit/s of payload, which Chapter 12's 1 Mbaud UART bridge cannot carry once framing is added, and F-17 declares no bridge at all. A board build of F-17 therefore needs a faster host link, such as Ethernet or USB, or a shorter window: a quarter second on chip is 192 kbit, six 36 Kbit block RAMs.

Replay does not ask whether the candidate's output equals the old output. A new filter is supposed to produce different output. Replay asks whether the candidate, fed traffic the device actually saw, violates its own asserts, stalls its streams, or fails timing. That is a weaker question than equivalence, and it is the right one for a change whose purpose is to change behavior. Chapter 18 meets the opposite case, a change that must not alter behavior.

### 17.5 Canary, monitors and rollback

A replay is only as good as the recording. The canary stage runs the candidate on live traffic, in the device, for a fixed window:

```js
  .deploy(d => d.partial("dsp").canary("300ms", { watch: ["asserts", "wet.rate"] }))
  .rollbackOn("assert", "stall");
```

The asserts become hardware. `.assert("never pinned at a rail", $ => $.out !== 32767 && $.out !== -32768)` is parsed like any hardware lambda, so it compiles to two comparators and a sticky flag inside the partition, readable by the change controller. `wet.rate` is a counter of beats per window, compared with the 48,000 per second the stream should carry; too few beats is a stall.

If a watched signal fires, the controller decouples the boundary again and reloads the previous partial bitstream, which it kept. The old module's registers restart from the state captured at the swap. For a filter, whose state is a few samples of history, that stale state decays within milliseconds. The scenario's last line checks the result: across the last 480 samples, 10 ms of audio, the output never touched a rail.

A canary can only fail to observe a failure; it cannot prove there is none. A rare input that never arrives inside the window passes it. The example's "try" line makes this concrete: shorten the canary to 50 ms, and `louder` commits, because the scenario raises the volume 100 ms after applying it, when a 50 ms canary has already ended.

### 17.6 Carrying state across: readback and `.migrate()`

The one-pole filter has one register, `y`. The biquad has five: `x1`, `x2`, `y1`, `y2` and `out`. Swapping one for the other loses state unless something carries it across:

```js
  .migrate(old => ({ y1: old.y, y2: old.y, out: old.y }));   // runtime lambda: the old region's registers, read back
```

The old values come from configuration readback. The device captures its flip-flop values into configuration memory, the controller reads the partition's frames, and the build's logic-location data maps frame bits back to register names. The result is a plain object such as `{ y: 1180 }`, an illustrative value.

`.migrate()` is a runtime lambda: ordinary JS that runs on the host between readback and recoupling. Its result is seeded into the new partition's registers before its outputs reach the static region. Registers it omits, here `x1` and `x2`, take their declared reset values.

The choice of seed matters for the listener. Setting `y1` and `y2` to the old output makes the biquad start as if it had already been producing that level for two samples, so the output does not step and the speaker does not click. The scenario checks the effect with `.expectState("filter", s => s.y1 !== 0)`.

### 17.7 The biquad, and a bug worth keeping

The replacement is a second-order low-pass from Robert Bristow-Johnson's audio EQ cookbook. With cutoff f\_c, sample rate f\_s and Q = 1/√2 (a Butterworth response):

```latex
\omega_0 = \frac{2\pi f_c}{f_s}, \qquad \alpha = \frac{\sin\omega_0}{2Q}
```

```latex
b_0 = b_2 = \frac{1-\cos\omega_0}{2},\quad b_1 = 1-\cos\omega_0,\quad a_0 = 1+\alpha,\quad a_1 = -2\cos\omega_0,\quad a_2 = 1-\alpha
```

`lowpass2` computes these at build time and scales them by 2^14 / a\_0, so 16,384 stands for 1.0:

```js
function lowpass2(fc, fs) {                         // an RBJ biquad low-pass in Q14, plain JS at build time
  const w = (2 * Math.PI * fc) / fs, alpha = Math.sin(w) / Math.SQRT2, c = Math.cos(w), a0 = 1 + alpha;
  const q14 = v => Math.round((v / a0) * 2 ** 14);
  return { B: [q14((1 - c) / 2), q14(1 - c), q14((1 - c) / 2)], A: [q14(-2 * c), q14(1 - alpha)] };
}
```

For f\_c = 2,000 Hz and f\_s = 48,000 Hz it returns B = \[236, 472, 236\] and A = \[−26,755, 11,315\]. Two checks by hand confirm the numbers. The gain at DC is (236 + 472 + 236) / (16,384 − 26,755 + 11,315) = 944 / 944 = 1. The poles are the roots of z² − 1.633 z + 0.691, a complex pair of radius √0.691 ≈ 0.83, inside the unit circle, so the filter is stable.

The handler is the direct form I difference equation:

```latex
y[n] = \frac{1}{a_0}\bigl(b_0x[n] + b_1x[n-1] + b_2x[n-2] - a_1y[n-1] - a_2y[n-2]\bigr)
```

```js
  .on("dry", ($, x) => {
    const acc = B[0] * x + B[1] * $.x1 + B[2] * $.x2 - A[0] * $.y1 - A[1] * $.y2;
    const y = sat(acc >> 14, s(16));
    $.x2 = $.x1; $.x1 = x;
    $.y2 = $.y1; $.y1 = y;
    const out = sat(y * GAIN, s(16));               // gain after the feedback loop, never inside it
    $.out = out;
    $.push("wet", out);
  })
```

Direct form I suits fixed point. `acc` is as wide as the width rules make it, so no intermediate sum can overflow, and the only rounding happens once, at `>> 14`. The stored state is the saturated output, so the state can never hold a value the output could not.

Now the bug. The first draft computed `const y = sat((acc >> 14) * GAIN, s(16))` and stored that `y` in `y1`. That puts the gain inside the feedback loop, and the recursion becomes y\[n\] = G(… − a₁y\[n−1\] − a₂y\[n−2\]), with a₁ and a₂ normalized by a₀. Its characteristic polynomial is:

```latex
P(z) = z^2 + G\,a_1 z + G\,a_2 = z^2 - 1.633\,G\,z + 0.691\,G
```

At z = 1, P(1) = 1 − 0.942 G, which is negative for any G above about 1.06. P(z) grows without bound as z grows, so for such G it has a real root above 1: a pole outside the unit circle. With G = 4 the roots are about 6.08 and 0.45. Any nonzero input then grows sixfold per sample until it pins at the rail, at every volume. The bad change would have failed replay of the quiet recording, and the example would have taught nothing about canaries.

The fix moves the gain after the loop, as the comment says, so `GAIN` scales the output and leaves the poles alone. A JS model of the example's arithmetic, a 330 Hz sawtooth through this biquad, gives output peaks near 3,900 at volume 2 and near 23,350 at volume 12. With `GAIN: 4`, the quiet peak becomes about 15,600, well inside the 16-bit range, so `louder` passes replay. The scenario then raises the volume mid-canary:

```js
    .apply(louder).wait("100ms")
    .write("tone.volume", 12)                       // the live signal gets loud mid-canary
    .expectChange("gain × 4", "rolled-back", { within: "1s" })
```

Four times 23,350 saturates at 32,767, the assert fires, and the change rolls back. Replay passed because the recording was quiet; the canary caught what the recording could not show.

### Key points

- Partial reconfiguration rewrites one floorplanned partition while the static region runs, so a replacement must fit the partition's resources and match its fixed ports.
- A knob change is a register write; a patch or a replacement rebuilds one partition and travels through check, verify, build and canary.
- Replay asks whether a candidate breaks its own asserts, streams or timing on recorded traffic, not whether its output is unchanged.
- During canary, asserts run as hardware monitors, and a failure reloads the previous partial bitstream; a canary can miss a failure but never proves its absence.
- Configuration readback and a `.migrate()` runtime lambda carry state into the new module, and a good seed avoids an audible step.
- Gain inside a feedback loop moves the loop's poles; above a gain of about 1.06 this biquad becomes unstable, which is why `GAIN` sits after the loop.

Every change in this chapter was written by a person. Chapter 18 hands the same pipeline to an agent, and asks what an agent needs to see, and what it must be prevented from touching, for its proposals to be worth verifying.

## Chapter 18 · Agents in the build

Follows **F-18** (`F-18-timing-closer.js`).

F-18 asks for a clock the design cannot meet and puts an agent on the build to close the gap. The agent is not trusted, and most of this chapter explains why it does not need to be. It sees a precise dossier. It may propose only inside a declared scope. Its proposals go through the same pipeline as anyone's and end at your approval. First, though, the chapter works out why the design fails, because a dossier is useful only to a reader who knows what a critical path is.

### 18.1 Why the blend misses 300 MHz

```js
const blend = module("blend")
  .needs("layers").provides("out")
  .lib({ GAMMA: Array.from({ length: 256 }, (_, i) => Math.round(255 * (i / 255) ** (1 / 2.2))) })
  .on("layers", ($, l) => {
    const mix = (l.fg * l.alpha + l.bg * (255 - l.alpha) + 128) >> 8;   // two multiplies, two adds…
    $.push("out", GAMMA[sat(mix, u(8))]);                                 // …and a table, all in one cycle
  });
```

Alpha blending mixes a foreground over a background in proportion to an opacity α. With 8-bit values the exact form divides by 255. The handler divides by 256 instead, which is a shift and costs nothing, and adds 128 first so the shift rounds rather than truncates. The price is at most one step of error. Worked by hand for fg = 255, bg = 0, α = 255: (65,025 + 0 + 128) >> 8 = 254, where the exact blend gives 255. That is why the scenario accepts any output of at least 254.

The table then encodes the result for display. `GAMMA[i]` raises i/255 to the power 1/2.2, a common approximation of the sRGB transfer curve, so blending happens on linear values and only the result is gamma-encoded. By hand, `GAMMA[254]` = round(255 × (254/255)^(1/2.2)) = round(254.55) = 255. The table holds 256 entries of 8 bits, a 2 Kb ROM that `.lib()` instances in the module.

A timing path starts at one register's clock edge and ends at the next register's input, and it must arrive before the next edge:

```latex
\text{slack} = T_{clk} - \bigl(t_{clk \to q} + \textstyle\sum t_{logic} + \sum t_{route} + t_{setup}\bigr)
```

At 300 MHz, T\_clk is 3.33 ns. Inside that window this handler places, in series, a subtraction (`255 - l.alpha`), a multiply that depends on it, an add of two products, an add of 128, a saturation, which is a comparison and a multiplexer, and a 256-entry table read. A 7-series DSP48E1 reaches its rated speed only with its internal pipeline registers enabled. Used as a combinational multiplier and followed by an adder, a comparison and a LUT-built table, the path spans several logic levels plus their routing, and 3.33 ns cannot hold it. Slack goes negative, and the build fails.

### 18.2 The dossier

When timing fails, the compiler raises `timing.failed` and hands the closer a dossier:

```js
  .on("timing.failed", async (ctx, d) => {          // d: { domain, target, slack, path: [{ op, width, origin }], resources }
```

`domain` and `target` say which clock failed and what it asked for. `slack` is the worst path's margin, negative here. `resources` is the utilization report, so a proposal can see whether there is room to add registers or DSPs. `path` is the critical path itself, as a list of DAG operations. Worked by hand from the handler, it has this shape:

| Step | Operation | Origin (source text) |
| --- | --- | --- |
| 1 | register: beat taken from `layers` | `.on("layers", …)` |
| 2 | subtract from 255 | `255 - l.alpha` |
| 3 | multiply | `l.bg * (255 - l.alpha)` |
| 4 | add the two products | `l.fg * l.alpha + …` |
| 5 | add 128 | `+ 128` |
| 6 | shift right 8 | `>> 8` |
| 7 | saturate to 8 bits | `sat(mix, u(8))` |
| 8 | table read | `GAMMA[…]` |
| 9 | register: beat pushed to `out` | `$.push("out", …)` |

The last column is what makes the dossier useful. After `techmap`, placement and routing, the path physically runs through DSP48E1 and LUT6 instances with generated names. Without provenance, the timing report lists those names, and neither an agent nor a person can map them back to a line of code. Weft keeps an `origin` on every IR node through every pass (Chapter 13). A pass that merges nodes, such as `cse`, unions their origins; a pass that splits one, such as `split-fanout`, copies it. The dossier can therefore quote the handler line by line, and a proposal can be about source rather than about cells.

### 18.3 Scope is a capability list

```js
  .scope(s => s.read("*").propose("modules/*", "knobs/*").never("pins", "clocks", "boot", "streams"))
  .budget({ proposals: 3, per: "build" })
```

In capability-based security, an actor's authority is the set of capabilities it holds, not an identity looked up in a global access list. The principle of least privilege then says to hold only what the task needs. The closer may read everything, because diagnosis needs context. It may propose changes under `modules/*` and `knobs/*`. It may never touch pins, clocks, the boot order or stream types, and `never` overrides `propose`.

A change in Weft is data: a list of operations, each with a target path. The pipeline computes a change's footprint, every path it touches, including indirect effects such as a replaced module whose ports differ, which touches `streams`. It checks the footprint against the scope on every proposal, before any verification runs. The `never` list is chosen with care. The cheapest way to meet 300 MHz is to lower the clock, which changes the requirement instead of the design; `clocks` is out of scope for exactly that reason.

The budget bounds cost and breaks loops. Without it, a failing proposal could trigger another failure and another proposal indefinitely. Three proposals per build is a ceiling, not a target.

### 18.4 The order of fixes

The guidelines rank the kinds of fix the closer may propose:

| Fix | What it changes | What must be verified | Risk |
| --- | --- | --- | --- |
| A knob within its bounds | a register's value | nothing; the hardware enforces the bounds | lowest |
| Latency on a stream path | when beats appear, not which beats | equivalence up to stream latency, then timing | low |
| A rewrite of the lambda | the computation | equivalence, timing and replay | highest |

The order is by blast radius. A knob cannot produce a value outside its declared range. Added latency cannot change what the design computes, only when. A rewrite can change anything, so it comes last and carries the heaviest proof obligation. `blend` has no knobs, so a well-behaved closer reaches for the second row. One plausible proposal, written here for illustration:

```js
// sketch, not from the examples: the change the closer might propose
change("blend: let the compiler pipeline layers → out")
  .replace("blend", blend.domain("fast").pipelined({ path: ["layers", "out"] }))
```

The handler's text is untouched. `.pipelined()` hands the latency of the `layers → out` path to `pipeline.cut` and `retime` (Chapter 15), which can place registers after the multiplies and the add and use the block RAM's output register for the table. The design computes the same function, a few cycles later.

### 18.5 Equivalence up to stream latency

The standard tool for proving two circuits equal is a miter. Both circuits get the same inputs, each pair of corresponding outputs feeds an XOR, and the XORs feed one OR:

```latex
m(t) = \bigvee_i \bigl(o_i^A(t) \oplus o_i^B(t)\bigr)
```

A SAT solver asks whether m can ever be 1. For sequential circuits, bounded model checking unrolls both machines in time and induction extends the result to every depth (Chapter 11).

That check is wrong for this change. The pipelined `blend` emits each result some cycles later than the original, so at a given cycle the two outputs belong to different inputs. The miter fires on the first beat, although nothing is wrong. Cycle-exact equivalence is the right question only when cycle timing is part of the contract, and on a stream path it is not.

The right question compares transactions. A beat is transferred on a cycle where valid and ready are both high, and two designs are stream-equivalent if, for every input beat sequence, they transfer the same output beat sequence. A scoreboard turns that into something a solver can check. Each output beat from the original enters a FIFO, and each output beat from the candidate is compared with the FIFO's head and pops it. The property is that every comparison is equal and the FIFO never underflows. A bound L on how far the candidate may lag turns the remaining liveness question into a bounded check. Worked by hand, with the original emitting one cycle after its input and the candidate four:

| Cycle | Input beat | Original emits | Candidate emits | Cycle miter | Scoreboard |
| --- | --- | --- | --- | --- | --- |
| 1 | x₀ | — | — | equal | \[\] |
| 2 | x₁ | f(x₀) | — | differs | \[f(x₀)\] |
| 3 | x₂ | f(x₁) | — | differs | \[f(x₀), f(x₁)\] |
| 4 | — | f(x₂) | — | differs | \[f(x₀), f(x₁), f(x₂)\] |
| 5 | — | — | f(x₀) | differs | f(x₀) matches; pop |
| 6 | — | — | f(x₁) | differs | f(x₁) matches; pop |
| 7 | — | — | f(x₂) | differs | f(x₂) matches; empty |

The cycle miter reports a difference on six cycles; the scoreboard reports none. This is the property that latency-insensitive design, in the work of Carloni, McMillan and Sangiovanni-Vincentelli, builds a theory around: modules that communicate only through valid/ready channels and wait patiently on them stay correct when the latency of a channel changes. `.verify(v => v.lint().equiv({ upTo: "stream latency" }).timing())` asks for exactly this check.

### 18.6 Approval is a gate

The agent never applies anything. `ctx.llm.propose` returns a change value, and `ctx.changes.submit` enters it into the pipeline of Chapter 17, where the agent's authority ends. With `approve: "you"`, a change that passes lint, equivalence and timing waits in the Changes tab, carrying its evidence: the dossier, the change itself, the equivalence report and the new timing report. The scenario walks the whole loop:

```js
  .scenario("closes timing", sc => sc
    .build()
    .expectBuild("timing", "failed")                // the dossier goes to the closer
    .expectProposal("closer", { within: "2m" })
    .approve()
    .expectChange(/blend/, "committed")
    .expectBuild("timing", "met"))
```

The second scenario, `"still blends"`, holds the function fixed from the outside. Whatever the closer proposes, a beat of full foreground and a beat of full background must both come out at 254 or above. The example's "try" line suggests letting knob changes commit without approval. That is defensible because a knob's bounds are enforced in hardware, and indefensible for rewrites, which is why the approval rule can name the kind of change.

### Key points

- A timing path must fit between two clock edges; at 300 MHz this handler's chain of subtract, multiply, add, saturate and table read does not.
- The dossier quotes the critical path as source text because every IR node keeps its origin through every pass.
- Scope is a capability list checked against each change's computed footprint on every proposal, and `never` overrides `propose`.
- Fixes are ranked by blast radius: a bounded knob, then latency on a stream path, then a rewrite with the heaviest proof obligation.
- Once latency may change, cycle-exact equivalence is the wrong check; stream equivalence compares the sequences of transferred beats with a scoreboard.
- An agent's authority ends at submission, and approval is a gate whose policy can depend on the kind of change.

F-18 used one agent on one module. Chapter 19 puts everything in the book into one design: two clock domains, a game, a renderer, sound, knobs, a host panel, reset groups and a mechanic on call.

## Chapter 19 · A whole machine

Follows **F-19** (`F-19-arcade.js`).

F-19 is two-player pong on the studio board, and it uses nearly every idea in this book at once. This chapter does not teach those ideas again. It shows how they compose: where each part sits, how parts talk across clock domains, how failure is contained, how the machine starts, and what can change while it runs. As before, the traces are worked by hand from Weft's semantics.

### 19.1 The parts and where they live

&#91;embedded content: F-19's parts · 2 clock domains, 2 crossings, 2 reset groups\]

The game steps on frame beats from the pixel domain and sends back only its newest scene; every other stream stays inside one domain.

| Part | Kind | Domain | Job |
| --- | --- | --- | --- |
| `pads` | `std.debounce` | sys | four buttons in, debounced levels out as `held: u(4)` |
| `game` | `fsm`, stepped per frame | sys | paddles, ball and score; pushes `scene` and `sfx` |
| `beeper` | `module` | sys | square-wave sound effects at 48 kHz |
| `dac` | `std.sigmaDelta` | sys | one-bit audio output |
| `bridge` | `std.bridge.uart` | sys | the register map, reached from the host |
| `beam` | `std.video.timing` | pix | the 640 × 480 raster position and frame starts |
| `renderer` | `module` | pix | one pixel for each beam position |
| `hdmi` | `std.video.hdmi` | pix | TMDS encoding to the connector |
| `panel` | `host` | host | adaptive difficulty |
| `mechanic` | `std.agents.mechanic` | host | repairs when the video group escalates |

The system domain runs on the board clock. A PLL derives the 25.175 MHz pixel clock from it, the standard rate for 640 × 480 at 60 Hz.

### 19.2 Two crossings and a queue

Three streams carry everything between the parts that are not wired directly:

```js
const frames = stream("frame").of(bit).cross({ from: "pix", to: "sys" });   // one beat per frame start
const scenes = stream("scene").of(scene).buffer(1, { overflow: "latest" }).cross({ from: "sys", to: "pix" });
const sounds = stream("sfx").of(struct({ hz: u(10), ms: u(9) })).buffer(4, { overflow: "drop-oldest" });
```

`frame` carries one beat per frame from the pixel domain to the system domain, about sixty a second. Every beat matters, because each one advances the game by a step. Sixty events a second is slow next to either clock, so a handshake crossing carries each beat safely (Chapter 10).

`scene` goes the other way and is 52 bits wide: 10 + 9 + 9 + 9 + 7 + 4 + 4 for the fields of the `scene` struct. Synchronizing each bit separately would be wrong. Each bit settles in its own cycle, so the renderer could read `bx` from one scene and `by` from the next, a torn value that never existed. The handshake crossing first copies the whole struct into a holding register, and the pixel domain samples that register only after the handshake signal arrives, when every bit is stable. With `latest`, intermediate scenes are dropped, which is correct because only the newest scene should be drawn.

`sfx` stays inside the system domain and buffers four requests, dropping the oldest on overflow. A sound effect is disposable, and the game must never stall waiting for audio.

### 19.3 The game, one step per frame

`.step("frame")` changes when the states run. A plain fsm evaluates its current state on every clock; this one evaluates it once per beat of `frame`, and the registers hold between beats. The `.seq` block is not a state, so it still runs every clock and offers the newest scene to the crossing. Each state is a hardware lambda that returns its successor (Chapter 6): `serve` goes to `play`, `play` to `point`, `point` back to `serve` or on to `over`, and `over` returns to `serve` when any button is held.

A hand-worked trace from reset shows the timing. Recall that a register read inside a state sees its current value; writes take effect at the next step.

1. `serve` runs with `wait` at 0, 1, 2, and so on. The test `$.wait === 60` succeeds on the 61st step, about 1.02 s after reset. With the score 0 : 0, `$.s1 > $.s2` is false, so `vx` becomes `+speed`, which is +2, and the ball heads toward player 2.
2. In `play`, step k computes x = 318 + 2k and y = 237 + k. The ball would reach the bottom edge, y = 472, only after 236 steps, so it does not bounce.
3. At k = 149, x reaches 616 and the right paddle is tested: `hits(386, 208, 64)` is false, since 386 lies below the paddle's last row, 272. The ball travels on.
4. At k = 158, x = 634 exceeds 632, the else branch scores for player 1, pulses `point`, queues a 110 Hz tone and returns `"point"`. That is 159 steps, about 2.65 s.
5. `point` holds for 46 steps, about 0.77 s, then returns to `serve` unless a score has reached 9.

The first point therefore lands about 3.7 s after reset. The scenario `"serve, rally, point"` expects `play` at 1.1 s and the `point` interrupt within the following 6 s, and the trace satisfies both.

Two details from earlier chapters carry the logic. `const x = $.bx + $.vx` adds a u10 to an s4, so x is signed and wide enough to go below zero, and the test `x < 0` is honest (Chapter 2). `movePaddles` and `hits` are plain JS functions shipped by `.lib()`, parsed and inlined where they are called (Chapter 3).

### 19.4 The renderer: a pixel as a function

The renderer has no frame buffer. A 640 × 480 image at 24 bits is 921,600 bytes, about 7.4 Mbit, which is several times the block RAM of the boards in this book. Instead it computes each pixel as the beam reaches it, from the beam position, the newest scene and the palette knob:

```js
  .on("beam", ($, b) => {
    const s = $.sc;
    const lit =
      box(b.x, b.y, s.bx, s.by, 8, 8) ||
      box(b.x, b.y, 8, s.p1, 8, s.size) ||
      box(b.x, b.y, 624, s.p2, 8, s.size) ||
      (b.x.bits(9, 1) === 160 && b.y[4]) ||         // the dashed net
      digitAt(b.x, b.y, 260, s.s1) ||
      digitAt(b.x, b.y, 356, s.s2);
    const pal = PALETTES[$.palette];
    $.push("pixels", lit ? pal.fg : pal.bg);
  })
```

Apart from the copy of the scene into `$.sc`, the handler holds no state, so the same inputs always produce the same pixel. The net is two bit tests. `b.x.bits(9, 1) === 160` drops bit 0 of x, which matches x = 320 and x = 321. `b.y[4]` is 1 on 16 lines out of every 32, which cuts the line into dashes.

The score digits come from a ROM built by a builder lambda from strings:

```js
const glyphs = rom("glyphs").of(u(15)).from(10, d => parseInt(FONT[d], 2));   // 3 × 5 digits, built from strings
```

Each string lists a 3 × 5 glyph row by row, and `parseInt(…, 2)` turns it into a 15-bit word whose most significant bit is the top-left cell. `digitAt` scales the glyph by 8: `cx = (bx - x0) >> 3` and `cy = (by - 24) >> 3` find the font cell under the beam, and bit `14 - (cy * 3 + cx)` says whether it is lit.

Worked by hand, with player 1's score at 4 and the beam at (268, 40): cx = (268 − 260) >> 3 = 1, cy = (40 − 24) >> 3 = 2, and the bit index is 14 − 7 = 7. `FONT[4]` is `"101101111001001"`, and bit 7 is the character at position 14 − 7 = 7, a `'1'`. The pixel is lit. Drawn out, the glyph confirms it: row 2 is full.

```text
#.#
#.#
###
..#
..#
```

`palette` is a knob, but the knob registers live behind the bridge in the system domain. The compiler carries a 1-bit knob into the pixel domain through a two-flip-flop synchronizer. A wider knob would cross by handshake, for the same tearing reason as `scene`.

### 19.5 Failure: watchdogs, reset groups and escalation

A watchdog decides when a part has failed:

```js
  .supervise(s => s.watchdog("20ms", $ => $.has("beam")).reset("local"))   // no beam for 20 ms: reset
```

The second argument is a hardware lambda that defines alive. In hardware it is a counter cleared whenever the condition holds and incremented otherwise; at 25.175 MHz, 20 ms is 503,500 cycles, a 19-bit counter. The beam stream carries beats through every visible line, and a frame lasts 16.7 ms, so 20 ms without a single beat means the path is stuck. Each `std` component brings its own definition of alive; `hang("hdmi")` in a scenario trips the encoder's.

What happens after a failure is the group's decision, and the design follows Erlang/OTP. Joe Armstrong's thesis argued that a reliable system lets a failed process crash and has a supervisor restart it from a known state. OTP supervisors choose among `one_for_one`, `one_for_all` and `rest_for_one`. A restart intensity, at most MaxR restarts in MaxT seconds, bounds them, and a supervisor that exceeds it gives up and escalates to its parent. Weft maps each idea onto resets:

| Erlang/OTP | Weft | In hardware |
| --- | --- | --- |
| `one_for_one` | `"one-for-one"` | assert the failed module's local reset only |
| `one_for_all` | `"all-for-one"` | assert the reset of every module in the group |
| `rest_for_one` | `"dependents"` | reset the failed module and those downstream of it in the stream graph |
| intensity, MaxR in MaxT | `.maxResets(3, "10s")` | count resets in a sliding window |
| escalate to the parent | `.escalate("mechanic")` | raise an event over the bridge, with a dossier |

Each group has its own reset net, asserted at once and released synchronously to the group's clock, the usual reset-synchronizer pattern. `video` is all-for-one because its three parts share an alignment: the encoder expects pixels in step with the timing generator's syncs. Resetting the encoder alone would leave the others mid-frame; resetting all three restarts the raster from the top. `audio` is one-for-one because `beeper` and `dac` meet through a buffered stream and can restart independently. The scenario checks the boundary of the blast: after `hang("hdmi")`, `hdmi` and `renderer` each reset once, and `game` not at all.

When the video group exceeds three resets in ten seconds, it escalates. The dossier includes a capture from the renderer's probe:

```js
  .probe(p => p.signals("sc", "palette").depth(1024).keep("before-reset"));   // the capture goes into dossiers
```

A probe is an integrated logic analyzer: a circular buffer in block RAM, written on every pixel clock with the chosen signals and frozen when a trigger fires, here the reset. Each sample is 53 bits, the 52-bit scene plus the palette bit, so 1,024 samples need 54,272 bits, two 36 Kb block RAMs. That matches the two the `gfx` partition reserves. At 25.175 MHz, 1,024 samples cover about 41 µs, so the capture shows the renderer's state in the moment before the failure, not its history.

The mechanic receives the reset history, that capture, the source and the DAG around the failing module. Its scope lets it propose changes to `renderer`, `beeper` and knobs, never to pins, clocks, the boot order or streams (Chapter 18). Because `renderer` sits in the `gfx` partition, an approved fix ships as a partial bitstream through the pipeline of Chapter 17.

### 19.6 Starting up: the boot order

```js
  .boot(b => b
    .start("clocks")                                // every reset is held until the PLL locks
    .then("beam", "hdmi")                           // a black screen first, never a torn one
    .then("pads", "game", "renderer")
    .background("beeper", "dac", "bridge"))
```

Boot order is reset-release sequencing. Until the PLL reports lock, the pixel clock is not trustworthy, so every module stays in reset. After lock, the timing generator and encoder come out first. The display receives correct syncs and black pixels and can acquire the signal before anything is drawn. The game and renderer follow once that stage reports ready. The `background` group is released after the clocks without gating the stages, because sound and the host link do not affect the picture. Every release is synchronized to the clock of the domain it frees.

### 19.7 What changes while it runs

The game declares two bounded knobs, a status counter and an interrupt:

```js
  .knob("speed", u(3), { reset: 2, min: 1, max: 6 })
  .knob("paddle", u(7), { reset: 64, min: 24, max: 120 })
  .status("rallies", u(16))
  .irq("point")
```

The host panel turns them with a runtime lambda, ordinary JS on the host:

```js
const panel = host("panel")
  .over("bridge")
  .on("game.point", async dev => {
    const rallies = await dev.status("game.rallies").read();
    if (rallies > 20) await dev.knob("game.speed").update(v => v + 1);   // the ceiling of 6 is enforced in hardware
    dev.log(`point after ${rallies} rallies`);
  });
```

The panel never checks the ceiling. The knob saturates writes in hardware (Chapter 12), so no host code, buggy or not, can make the ball faster than 6. `rallies` is cumulative, so once it passes 20, every point raises the speed until the hardware holds it at 6. The palette is a knob as well, and the scenario `"night mode, no rebuild"` switches it with a one-line change. That change is a register write, and within one frame the background turns black on more than 250,000 of the 307,200 pixels.

### Key points

- A large design is the same small pieces composed: modules in two clock domains, joined by declared streams, two of them crossing domains.
- A multi-bit value crosses domains whole, through a handshake, or it can be read torn; `latest` is right when only the newest value matters.
- Stepping an fsm on a stream beat (`.step("frame")`) makes game time count frames rather than clock cycles.
- Reset groups follow Erlang/OTP supervision: a strategy chooses which modules restart together, an intensity bounds the restarts, and escalation hands the failure upward with a dossier.
- Boot order is reset release after PLL lock, staged so the display has a valid signal before anything is drawn on it.
- Bounds that live in hardware let runtime code adjust a running machine without being able to push it outside its declared range.

### Closing: what the book built

Every line of F-19 belongs to one of three kinds of lambda. Builder lambdas ran once, in JS, and shaped the graph: the boards, the stream declarations, the font ROM built from strings. Hardware lambdas were parsed, never called, and became the IR: the game's states, the renderer's pixel function, the helpers shipped by `.lib()`, the watchdog's definition of alive. Runtime lambdas run beside the hardware and touch it only through handles: the host panel, `.migrate()`, the expectations in every scenario, the agents' handlers.

Under all three is one compiler. It lowers source to HIR and then to one DAG per clock domain, and it runs passes that each preserve behavior and keep each node's origin. It maps the DAG onto each family's cells and emits files, models and bitstreams, partial ones included. The same IR feeds simulation, proofs, timing dossiers and live changes, which is why one scenario can check a design at three levels and why an agent can read a critical path as source. The book followed nineteen examples, from one blinking LED to this arcade; each step added a piece to that structure, and none replaced one.

## Appendix A · The grammar at a glance

Every form used in F-01 through F-19, grouped by what it builds, with the example that introduces it. The "Lambda" column says which kind a function argument is: **B** builder (runs now), **H** hardware (parsed), **R** runtime (runs beside the simulator or board).

### Types and the hardware prelude

| Form | Meaning | Lambda | First in |
| --- | --- | --- | --- |
| `bit`, `u(n)`, `s(n)` | One bit; n-bit unsigned; n-bit two's complement | — | F-01, F-02 |
| `pulse` | A bit that returns to 0 on cycles that do not write it | — | F-02 |
| `vec(T, n)`, `struct({ … })` | Arrays and records of types | — | F-04, F-05 |
| `T.init(v)` | The register's reset value | — | F-04 |
| `wrap(x, T?)`, `sat(x, T)` | Narrow by keeping low bits; narrow by clamping | H | F-02, F-08 |
| `x[i]`, `x.bits(hi, lo)`, `x.as(T)` | One bit; a bit range; reinterpret the same bits | H | F-06, F-08, F-17 |
| `clog2(k)` | Bits needed to count k values | B, H | F-11 |
| `past(x)`, `within(n, x)`, `sequence(…)` | Temporal helpers for properties | H | F-11 |

### Modules, fsms and pipelines

| Form | Meaning | Lambda | First in |
| --- | --- | --- | --- |
| `module(name)`, `fsm(name)`, `pipeline(name)` | A component; fsm and pipeline add their own methods | — | F-01, F-06, F-09 |
| `.in(name, T)`, `.out(name, T)`, or an object of them | Ports; a type may be a lambda of params | B | F-02, F-04 |
| `.regs({ … })` | Internal registers | B | F-03 |
| `.seq(fn)`, `.every(dur, fn)`, `.on(event, fn)` | Clocked blocks: what they write is a register | H | F-02, F-01, F-05 |
| `.comb(fn)` | A combinational block: what it writes is a wire | H | F-02 |
| `.params({ … })`, `.require(fn)` | Build-time parameters and a check on them | B | F-04, F-11 |
| `.with({ … })`, `.as(name)`, `.domain(name)` | A new specialized, renamed or re-clocked value | — | F-04, F-10 |
| `.lib({ … } \| fn)` | Ship constants, tables and helpers into hardware lambdas | B | F-03, F-06 |
| `.provides(…)`, `.needs(…)` | Streams produced and consumed, linked by name | — | F-05 |
| `.bind({ port: resource })` | Claim a board resource for a port | — | F-01 |
| `.ram(name, { of, words })` | A memory owned by the module | — | F-08 |
| `.knob(name, T, { reset, min, max })`, `.status(name, T)`, `.irq(name)` | Registers the host may turn, may read, or hears from | — | F-12 |
| `.budget(fn)`, `.hint(fn)`, `.pipelined({ path })` | Resource limits, mapping hints, latency the compiler may change | B | F-03, F-15 |
| `.assert(name, fn)`, `.assume(name, fn)`, `.cover(name, fn)` | Properties for simulation, proofs and monitors | H | F-11 |
| `.supervise(fn)`, `.probe(fn)` | Watchdog with local reset; on-chip signal capture | B (watchdog condition H) | F-19 |
| `.migrate(fn)` | Map old register values to new ones on a live swap | R | F-17 |
| fsm: `.initial(s)`, `.state(s, fn)`, `.step(stream)`, `.encode(kind)` | States as lambdas returning the next state | H | F-06, F-19 |
| pipeline: `.stage(name, fn)`, `.stall(kind)` | Stages with inferred pipeline registers | H | F-09 |
| In hardware: `$.x`, `$.push(s, v)`, `$.has(s)`, `$.take(s)`, `$.mem.read(a)`, `$.mem.q`, `$.mem.write(a, v)` | Signals, stream beats and memory ports | H | F-01 to F-08 |

### Streams, memories and standard parts

| Form | Meaning | First in |
| --- | --- | --- |
| `stream(name).of(T)` | A typed valid/ready channel | F-06 |
| `.buffer(n, { overflow })` | Depth and policy: `block`, `drop-oldest`, `drop-newest`, `latest` | F-06 |
| `.cross({ from, to })` | A sanctioned clock-domain crossing | F-10 |
| `rom(name).of(T).from(n, i => v)` | A table filled by a builder lambda | F-08 |
| `std.debounce`, `std.uart.rx`, `std.uart.tx`, `std.sigmaDelta`, `std.video.timing`, `std.video.hdmi`, `std.bridge.uart` | Standard components, configured with their own methods | F-05 to F-19 |

### Designs

| Form | Meaning | First in |
| --- | --- | --- |
| `design(name)`, `.use(…)` | The top level and what it contains | F-01 |
| `.board(profile)`, `.boards({ … })`, `.part(name)`, `board(p).part(name)` | Where it runs: one board, several, or a bare part | F-01, F-13, F-16 |
| `.clocks(c => c.pin(…).pll(…).port(…))` | Clock domains and how each is made | F-10, F-13 |
| `.wire(a, b)`, `.wire([[a, b], …])`, `.pins({ … })` | Explicit connections and pin bindings | F-02, F-04 |
| `group(name).children(…).supervise(…)` | A reset group with a restart strategy | F-19 |
| `.boot(b => b.start(…).then(…).background(…))` | The order in which resets are released | F-19 |
| `.regions(…)`, `.place({ … })`, `.record({ … })` | Reconfigurable slots, what lives in them, what is recorded for replay | F-17 |
| `.prove(p => p.module(…).bmc(k).induction().engine(…))` | Formal proofs | F-11 |
| `.scenario(name, fn, { levels, targets })` | A test, run at chosen IR levels and targets | F-01, F-14, F-16 |

### The compiler

| Form | Meaning | First in |
| --- | --- | --- |
| `.compile(c => …)` | Configure the pass pipeline; with nothing, the default runs | F-08 |
| `c.use(p)`, `c.stage(name, s => s.pass(…).fixpoint(…))` | Start from a pipeline; declare a stage | F-13 |
| `c.after(x, …)`, `c.before(x, …)`, `c.replace(x, p)`, `c.when(t => …, …)` | Edit a pipeline, per target if needed | F-14, F-15, F-16 |
| `c.cache(dir)`, `c.verifyEach()`, `c.snapshot(…)`, `c.inspect(…)`, `c.explainPlan()` | Incremental builds and seeing inside | F-13, F-14 |
| `c.check(name, r => true \| message)`, `c.emit(backend, opts)` | Checks on the report; outputs | F-08, F-12 |
| `c.explore(x => x.knob(…).measure(…).keep(…).pareto(…))` | Design-space exploration | F-15 |
| `pass(name).on(level).requires(…).preserves(…).params(…).visit(op, fn)` | A transformation (fn is B, over the IR) | F-14 |
| `analysis(name).on(level).run(fn)` | A cached fact about the IR | F-14 |
| `rewrite(name).from(fn).where(fn).to(fn).examples(…)` | A rule: pattern and replacement are H, the guard is B | F-14 |
| `backend(name).on(level).emit((ir, out) => …)` | An output written by walking an IR level | F-16 |

### Scenarios, runtime, changes and agents

| Form | Meaning | First in |
| --- | --- | --- |
| `sc.wait`, `.step`, `.poke`, `.press`, `.toggle`, `.uart`, `.feed`, `.throttle`, `.write`, `.hang`, `.repeat` | Drive the simulated design | F-01 to F-19 |
| `sc.expectPins`, `.expectSignal`, `.expectState`, `.expectStream`, `.expectUart`, `.expectFrame`, `.expectDropped`, `.expectKnob`, `.expectIrq`, `.expectResets`, `.expectToggles` | Check it; their lambdas are R | F-01 to F-19 |
| `async tb => …` with `tb.poke`, `tb.peek`, `tb.push`, `tb.pull`, `tb.random`, `tb.expect`, `tb.expectCoverage` | An imperative testbench | F-03, F-09, F-11 |
| `host(name).over(bridge).onStart(fn).every(dur, fn).on(event, fn)` with `dev.knob(p).set/update`, `dev.status(p).read` | Software beside the board | F-12, F-19 |
| `change(title).knob(…).patch(…).replace(…)` | A change to the running design | F-17 |
| `.verify(v => …)`, `.deploy(d => d.partial(…).canary(…))`, `.rollbackOn(…)` | How it is checked, loaded and undone | F-17 |
| `sc.apply`, `.approve`, `.build`, `.expectChange`, `.expectBuild`, `.expectProposal`, `.expectEscalation` | Drive and check the change pipeline | F-17 to F-19 |
| `agent(name).model(…).guidelines(…).scope(…).budget(…).on(event, fn)`, `std.agents.mechanic` | A participant that proposes changes | F-18, F-19 |

## Appendix B · Further reading

The algorithms and ideas the chapters lean on, by chapter. Each entry gives authors, title, venue and year; they are cited from knowledge of the literature, without links.

| Chapter | Work | What it adds |
| --- | --- | --- |
| 1, 13 | V. Betz, J. Rose, "VPR: A New Packing, Placement and Routing Tool for FPGA Research," FPL 1997 | The standard model of an FPGA's logic blocks and routing, and of the tool flow |
| 3 | W. Taha, T. Sheard, "MetaML and Multi-Stage Programming with Explicit Annotations," Theoretical Computer Science, 2000 | Code for later stages as a first-class idea |
| 3, 4 | J. Bachrach et al., "Chisel: Constructing Hardware in a Scala Embedded Language," DAC 2012 | The traced, embedded approach Weft departs from |
| 3 | C. Baaij et al., "CλaSH: Structural Descriptions of Synchronous Hardware Using Haskell," DSD 2010 | Compiling host-language source to hardware instead of tracing it |
| 4 | N. D. Jones, C. K. Gomard, P. Sestoft, *Partial Evaluation and Automatic Program Generation*, Prentice Hall, 1993 | Elaboration as specializing a program to known inputs |
| 5, 7, 15 | L. P. Carloni, K. L. McMillan, A. L. Sangiovanni-Vincentelli, "Theory of Latency-Insensitive Design," IEEE TCAD, 2001 | Why a valid/ready path may gain stages without changing behavior |
| 5, 6 | R. S. Nikhil, "Bluespec System Verilog: Efficient, Correct RTL from High-Level Specifications," MEMOCODE 2004 | Guarded actions and implicit handshakes in a hardware language |
| 7 | J. D. C. Little, "A Proof for the Queuing Formula: L = λW," Operations Research, 1961 | Buffer occupancy from arrival rate and waiting time |
| 8 | J. Tierney, C. M. Rader, B. Gold, "A Digital Frequency Synthesizer," IEEE Transactions on Audio and Electroacoustics, 1971 | The phase-accumulator synthesizer |
| 10 | R. Ginosar, "Metastability and Synchronizers: A Tutorial," IEEE Design & Test of Computers, 2011 | Metastability, MTBF and synchronizer design |
| 10 | C. E. Cummings, "Simulation and Synthesis Techniques for Asynchronous FIFO Design," SNUG 2002 | Gray-coded pointers across clock domains |
| 10 | C. E. Cummings, "Clock Domain Crossing (CDC) Design & Verification Techniques Using SystemVerilog," SNUG 2008 | A catalogue of crossing patterns and their checks |
| 11 | A. Biere, A. Cimatti, E. Clarke, Y. Zhu, "Symbolic Model Checking without BDDs," TACAS 1999 | Bounded model checking with SAT |
| 11 | M. Sheeran, S. Singh, G. Stålmarck, "Checking Safety Properties Using Induction and a SAT-Solver," FMCAD 2000 | k-induction for unbounded proofs |
| 13 | C. Lattner, V. Adve, "LLVM: A Compilation Framework for Lifelong Program Analysis & Transformation," CGO 2004 | The pass-based compiler and its analysis management |
| 13 | C. Lattner et al., "MLIR: Scaling Compiler Infrastructure for Domain Specific Computation," CGO 2021 | Many IR levels in one framework; the base of the CIRCT hardware project |
| 13 | A. Izraelevitz et al., "Reusability is FIRRTL Ground: Hardware Construction Languages, Compiler Frameworks, and Transformations," ICCAD 2017 | A hardware IR with lowering passes between forms |
| 13 | A. Mishchenko, S. Chatterjee, R. Brayton, "DAG-Aware AIG Rewriting: A Fresh Look at Combinational Logic Synthesis," DAC 2006 | Structural hashing and rewriting on logic DAGs |
| 13 | J. Cong, Y. Ding, "FlowMap: An Optimal Technology Mapping Algorithm for Delay Optimization in Lookup-Table Based FPGA Designs," IEEE TCAD, 1994 | Depth-optimal mapping onto k-input LUTs |
| 13 | S. Kirkpatrick, C. D. Gelatt, M. P. Vecchi, "Optimization by Simulated Annealing," Science, 1983 | The search behind classic placement |
| 13 | L. McMurchie, C. Ebeling, "PathFinder: A Negotiation-Based Performance-Driven Router for FPGAs," FPGA 1995 | Negotiated-congestion routing |
| 14 | G. Nelson, D. C. Oppen, "Fast Decision Procedures Based on Congruence Closure," Journal of the ACM, 1980 | The closure that e-graphs maintain |
| 14 | R. Tate, M. Stepp, Z. Tatlock, S. Lerner, "Equality Saturation: A New Approach to Optimization," POPL 2009 | Rewriting without committing to an order |
| 14 | M. Willsey et al., "egg: Fast and Extensible Equality Saturation," POPL 2021 | A practical e-graph library and its rebuilding algorithm |
| 14 | A. Pnueli, M. Siegel, E. Singerman, "Translation Validation," TACAS 1998 | Checking each compilation instead of the compiler |
| 14 | A. Zeller, R. Hildebrandt, "Simplifying and Isolating Failure-Inducing Input," IEEE TSE, 2002 | Delta debugging, the basis of bisecting a pass list |
| 15 | C. E. Leiserson, J. B. Saxe, "Retiming Synchronous Circuitry," Algorithmica, 1991 | Moving registers to meet a clock period |
| 17 | R. Bristow-Johnson, "Cookbook formulae for audio EQ biquad filter coefficients" | The biquad low-pass in F-17 |
| 18 | J. B. Dennis, E. C. Van Horn, "Programming Semantics for Multiprogrammed Computations," Communications of the ACM, 1966 | Capabilities: authority as an explicit, checkable list |
| 19 | J. Armstrong, "Making Reliable Distributed Systems in the Presence of Software Errors," PhD thesis, KTH, 2003 | Supervision trees and restart strategies |
