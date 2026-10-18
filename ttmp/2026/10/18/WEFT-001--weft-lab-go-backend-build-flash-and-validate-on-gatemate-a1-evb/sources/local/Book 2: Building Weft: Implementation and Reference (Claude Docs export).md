# Building Weft: Implementation and Reference

Oct 18, 2026 · @Manuel Odendahl

This book specifies Weft precisely enough to build it, then builds it in the order that keeps every step testable: bitvector semantics, staged elaboration, clocked semantics, streams, verification, the IR and its passes, then timing, mapping, runtime and live change. It is the implementation companion to Doc, which explains why the API looks the way it does.

## How to use this book

The toolchain is fifteen components in five layers. Build them in the order F-02 → F-03 → F-06 → F-07 → F-11 → F-13 → F-14, then add timing, mapping, runtime and live change. Each milestone ends when an example file's own scenario passes.

Weft has no implementation yet. This book is its specification plus reference implementations of the algorithms that matter, small enough to read and run. Where building a component from scratch is unrealistic, the book says so and integrates an existing tool instead. Example: the 7-series bitstream format is only partly documented (Project X-Ray), so that path goes through Vivado. The iCE40 and ECP5 formats were documented by Project IceStorm and Project Trellis, so those parts can be targeted with nextpnr.

### The components

The front end turns a script into HIR. Lowering turns HIR into one dataflow DAG per clock domain. The core holds that DAG and transforms it. Everything after reads the DAG: the simulator, the verifier, timing, mapping. Two components sit beside the running design rather than inside the compiler.

&#91;embedded content: The toolchain's fifteen components in five layers, with the chapter that builds each\]

The IR core is the one component every other layer depends on, which is why a minimal version of it is built early (milestone M3) and completed in Chapter 10.

| Component | Input → output | Chapter |
| --- | --- | --- |
| Type system and bitvector evaluator | expressions → types and values | 1 |
| Builder runtime | script → immutable builder values, specializations | 2 |
| Lambda front end | lambda source → checked HIR | 3 |
| Clocked lowering | blocks → one next-state function per register | 4 |
| State-machine lowering | states → transition graph and encoding | 5 |
| Streams and pipelines | `provides`/`needs`, buffers, stages → handshake logic | 6 |
| Memory model and inference | `.ram()`, ROMs → memory ports and cells | 7 |
| Simulator | DAG or netlist → cycle traces | 8 |
| Verifier | properties → monitors, proofs, counterexamples | 9 |
| IR core | nodes, hash-consing, provenance, invariants | 10 |
| Pass manager and optimizer | DAG → DAG, with analyses, rewrites and validation | 11 |
| Clocks and timing | domains, PLLs, slack, retiming | 12 |
| Mapping and back ends | DAG → netlist → Verilog, JSON, placed design | 13 |
| Runtime | knobs → register map, bridge, drivers, host | 14 |
| Live change | a running design + a change → a verified new design | 15 |

### The build order

The order follows dependency, not chapter number. A minimal IR and the simulator are needed from the third milestone onward, long before Chapters 8 and 10 complete them. Build the smallest version of each when a milestone first needs it, and grow it later.

| Milestone | Build | Gate: this must pass | Chapters |
| --- | --- | --- | --- |
| M1 Bits | Types, width rules, BigInt evaluator | F-02's width facts: `$.value + 1` is u9, `wrap(0 - 1)` into u8 is 255 | 1 |
| M2 Elaborate and parse | Builders, specialization, parser, capture check | F-03 reports `gamma` and, through it, `GAMMA`; F-04 elaborates eight PWM instances from one specialization | 2, 3 |
| M3 Clocked logic | Lowering to a DAG, a minimal IR, a two-phase simulator | F-01 and F-02 scenarios at level `dag` | 4, 8, 10 |
| M4 Machines | fsm lowering and encoding | F-06 sends `hello\r\n` twice | 5 |
| M5 Streams | Link, handshakes, buffers, pipelines | F-05, F-07 and F-09 scenarios | 6 |
| M6 Proofs | Monitors, BMC, k-induction | F-11's three assertions prove; its random test passes | 9 |
| M7 Optimizing IR | Full IR core, pass manager, rewrites, validation | F-13's pipeline with `verifyEach`; F-14's scenario agrees at `hir` and `dag` | 10, 11 |
| M8 Memory and time | Memories, CDC check, PLL solver, STA, retiming | F-08, F-10 and F-15 scenarios; F-15's model check | 7, 12 |
| M9 Silicon | Mapping, emitters, nextpnr and Vivado flows | F-01 blinks on a real board; F-16 agrees at `net` on every part | 13 |
| M10 Runtime | Register map, bridge, generated drivers, host | F-12's bounds hold in hardware | 14 |
| M11 Live | Contract checks, change pipeline, DFX, agents | F-17's bad change rolls back; F-18 and F-19 scenarios | 15 |

The first seven milestones establish bitvector semantics, staged elaboration, sequential machines, streaming behavior, formal checks and the optimizing IR. Only then does the physical back end start. A design that simulates and proves correctly at level `dag` is worth more than one that reaches a bitstream with unchecked semantics.

### Conventions

- Each chapter has a specification, data structures, algorithms, a worked example from an example file, tests, exercises and further study.
- Normative rules are numbered R*n*.*k* within Chapter *n*. The cross-cutting decisions are D1–D15, collected with their rationale in Appendix A.
- Code is ES2022 JavaScript. A listing marked as run was executed with Node and its test passed; other listings are labelled sketches.
- Diagnostic codes such as `capture` or `multi-writer`, the IR opcodes and the pass catalogue are in Appendix B.
- Readings, courses and an example-by-example study map are in Appendix C.

### What this book changes from the first

Writing a specification exposed places where the examples leave the semantics open. Five matter most. A hardware lambda may use a parameter such as `N` without `.lib()`: D2 makes parameters a typed environment distinct from forbidden captures. Several blocks may write one register on one cycle: D4 merges them in declaration order and warns when their guards overlap. Reads after writes in a clocked block, and memory reads during writes: D5 and D8 define both. Checking IR invariants is not proving a pass correct: D10 separates the two. Latency-tolerant equivalence needs an explicit observational contract: D9 states it.

## Chapter 1 · Bitvector semantics

Examples: **F-02** · Prerequisite: none

This chapter builds `types.js`: Weft's types, the rule that gives every expression its type, the relation that decides which assignments are legal, and a reference evaluator over JavaScript `BigInt`. Everything later is checked against this file. The lowering pass (Chapter 3) types expressions with it, the constant folder (Chapter 11) computes with it, and the simulator (Chapter 8) and the SAT encodings (Chapters 9 and 11) are tested against it. It comes first because a compiler whose parts disagree about the width of `a + 1` produces circuits that simulate one way and synthesize another.

### 1.1 Specification

The rules below are normative. The implementation in 1.3 follows them line by line, and Appendix A lists them as decision D1.

- **R1.1 Types.** A scalar type is `u(n)` or `s(n)` with n ≥ 1; `bit` is `u(1)`. Aggregates are `vec(T, n)` and `struct({ … })`, whose widths are the sums of their parts. Every type is an exact width; there is no unsized integer in hardware.
- **R1.2 Values.** The values of `u(n)` are the integers 0 to 2^n − 1. The values of `s(n)` are −2^(n−1) to 2^(n−1) − 1, stored in two's complement. A type is a set of integers, and every rule below is a statement about those sets.
- **R1.3 Constants.** A constant k ≥ 0 has type `u(max(1, bitlen(k)))`; a constant k < 0 has type `s(bitlen(−k − 1) + 1)`. So `1` is `u1`, `255` is `u8`, `-1` is `s1` and `-128` is `s8`. The narrowest type keeps constants from widening the expressions they appear in.
- **R1.4 Promotion.** When an unsigned operand `u(n)` meets a signed operand, it is treated as `s(n + 1)`. This keeps its value; reinterpreting its bits as signed would not.
- **R1.5 Result types.** Each operator's result type holds every exact result its operand types allow (table in 1.2). The one exception is `~`, which keeps its operand's type because it is a bit operation with no overflow.
- **R1.6 Order.** `a ⊑ b` holds when every value of `a` is a value of `b`. The join `a ⊔ b` is the least type above both; the conditional `c ? a : b` has type `a ⊔ b`.
- **R1.7 Assignment.** A value of type `t` may be assigned to a target of type `T` when `t ⊑ T`; it is zero- or sign-extended. Otherwise the assignment is error `width` unless the value is `wrap(x, T?)` or `sat(x, T)`. Compound assignments (`+=`, `-=`, `<<=`, `>>=`, `&=`, `|=`, `^=`) wrap by definition, because counters and pointers are modular by intent.
- **R1.8 Narrowing.** `wrap(x, T)` is x modulo 2^width(T), read in `T`'s signedness. `sat(x, T)` is x clamped to `T`'s range. `T` may be omitted in `wrap` only where the context supplies it: an assignment target, a memory address port, whose type is u(⌈log2 W⌉) (F-08's `$.delay.read(wrap($.at + 1))`), or the other operand of a comparison (F-07's `v !== wrap($.last + 1)`).
- **R1.9 Division.** `/` and `%` are allowed only by constant powers of two, on unsigned operands, where they are a right shift and a mask. On signed operands they are rejected. JavaScript's division truncates toward zero while an arithmetic shift floors, and the two differ on negative values.
- **R1.10 Soundness.** For every operator except `~`, `wrap` and `sat`, the exact integer result lies in the result type. This is the property the tests check, and the reason no Weft expression loses information by itself.

### 1.2 Width rules as typing judgments

A typing judgment `Γ ⊢ e : T` says that in environment Γ, which maps names to types, expression e has type T. Each rule reads: if the judgments above the line hold, the one below holds. Four rules carry most of the system.

```latex
\frac{\Gamma \vdash a : \mathsf{u}(m) \quad \Gamma \vdash b : \mathsf{u}(n)}{\Gamma \vdash a + b : \mathsf{u}(\max(m, n) + 1)}
\qquad
\frac{\Gamma \vdash a : \mathsf{u}(m) \quad \Gamma \vdash b : \mathsf{u}(n)}{\Gamma \vdash a - b : \mathsf{s}(\max(m, n) + 1)}
```

```latex
\frac{\Gamma \vdash a : \mathsf{u}(m) \quad \Gamma \vdash b : \mathsf{s}(n)}{\Gamma \vdash a + b : \mathsf{s}(\max(m + 1, n) + 1)}
\qquad
\frac{\Gamma \vdash c : \mathsf{bit} \quad \Gamma \vdash a : t_1 \quad \Gamma \vdash b : t_2}{\Gamma \vdash c \, ? \, a : b \; : \; t_1 \sqcup t_2}
```

The assignment rule ties types to targets. A value fits when its type is below the target's; `wrap` takes the target's type as its own.

```latex
\frac{\Gamma \vdash e : t \quad t \sqsubseteq T}{\Gamma \vdash \$.x = e \;\checkmark} \quad (\Gamma(x) = T)
\qquad
\frac{\Gamma \vdash e : t}{\Gamma \vdash \$.x = \mathrm{wrap}(e) \;\checkmark}
```

The full table of result types, with the promotion of R1.4 applied first when signedness differs:

| Operator | Result type | Why the width suffices |
| --- | --- | --- |
| `a + b` | `max(w_a, w_b) + 1`, signed if either is | The carry needs one bit |
| `a - b` | `s(max(w_a, w_b) + 1)` | The difference of two unsigned values can be negative |
| `a * b` | `w_a + w_b` (unpromoted), signed if either is | \|a\| · \|b\| < 2^(w\_a + w\_b) |
| `-a` | `s(w_a + 1)` | −(−2^(n−1)) needs one more bit |
| `a << k`, k constant | `w_a + k` | Nothing falls off the top |
| `a >> k`, k constant | `max(1, w_a − k)`, arithmetic if signed | The low k bits are dropped |
| `a & b`, `a \| b`, `a ^ b` | `a ⊔ b` | Bitwise: no carry |
| `~a` | the type of `a` | Bitwise inversion |
| `===`, `!==`, `<`, `<=`, `>`, `>=`, `!`, `&&`, `\|\|` | `bit` | A yes or no |

Verilog makes a different choice that Weft deliberately avoids. In Verilog, an expression is signed only if every operand is signed, so a single unsigned operand turns `a - b < 0` into an unsigned comparison that is never true. R1.4 promotes the unsigned operand instead, and the comparison means what it says.

### 1.3 Data structures and the reference evaluator

A type is a frozen record `{ signed, width, reset }`. `reset` holds the value given by `.init(v)`, so `bit.init(1)` in F-04 is the same `u1` with a different reset value. Values are `BigInt`, because widths of 48 or 64 bits are common and JavaScript numbers are exact only to 2^53.

```js
// types.js — Weft bitvector types, width rules (D1) and a BigInt reference evaluator
const T = (signed, width, reset = 0n) =>                             // reset: the value after reset (.init)
  Object.freeze({ signed, width, reset, init: v => T(signed, width, BigInt(v)) });
export const u = n => T(false, n);
export const s = n => T(true, n);
export const bit = u(1);
export const show = t => `${t.signed ? "s" : "u"}${t.width}`;

const bitlen = k => (k === 0n ? 0 : k.toString(2).length);           // k >= 0n

export function constType(k) {                                      // the narrowest type holding k
  k = BigInt(k);
  return k >= 0n ? u(Math.max(1, bitlen(k))) : s(bitlen(-k - 1n) + 1);
}

export function range(t) {                                           // [lo, hi] as BigInt
  const w = BigInt(t.width);
  return t.signed ? [-(1n << (w - 1n)), (1n << (w - 1n)) - 1n] : [0n, (1n << w) - 1n];
}

export function sub(a, b) {                                          // a ⊑ b: every value of a is a value of b
  if (a.signed === b.signed) return a.width <= b.width;
  return !a.signed && a.width < b.width;                             // u(n) ⊑ s(m) iff n < m; s ⋢ u
}

const promote = t => (t.signed ? t : s(t.width + 1));                // u(n) meeting a signed operand
export function join(a, b) {                                         // least upper bound under ⊑
  if (a.signed === b.signed) return (a.signed ? s : u)(Math.max(a.width, b.width));
  return s(Math.max(promote(a).width, promote(b).width));
}

export function inferBinary(op, a, b, k) {                          // k: constant shift amount
  const sg = a.signed || b.signed;
  const A = sg ? promote(a) : a, B = sg ? promote(b) : b;
  const mk = (signed, w) => (signed ? s(w) : u(w));
  switch (op) {
    case "add": return mk(sg, Math.max(A.width, B.width) + 1);
    case "sub": return s(Math.max(A.width, B.width) + 1);
    case "mul": return mk(sg, a.width + b.width);
    case "and": case "or": case "xor": return join(a, b);
    case "eq": case "ne": case "lt": case "le": case "gt": case "ge": return bit;
    case "shl": return mk(a.signed, a.width + k);
    case "shr": return mk(a.signed, Math.max(1, a.width - k));
    default: throw new Error(`unknown binary op ${op}`);
  }
}

export function inferUnary(op, a) {
  if (op === "neg") return s(a.width + 1);
  if (op === "not") return a;                                        // bitwise ~
  if (op === "lnot") return bit;                                     // logical !
  throw new Error(`unknown unary op ${op}`);
}

export function norm(t, v) {                                         // v mod 2^w, read in t's signedness
  const m = 1n << BigInt(t.width);
  let r = ((v % m) + m) % m;
  if (t.signed && r >= m >> 1n) r -= m;
  return r;
}
export const wrap = (t, v) => norm(t, v);
export function sat(t, v) { const [lo, hi] = range(t); return v < lo ? lo : v > hi ? hi : v; }

export function evalOp(op, t, [a, b], k) {                          // operands already in their own types
  const r = {
    add: () => a + b, sub: () => a - b, mul: () => a * b, neg: () => -a,
    and: () => a & b, or: () => a | b, xor: () => a ^ b, not: () => ~a, lnot: () => (a === 0n ? 1n : 0n),
    shl: () => a << BigInt(k), shr: () => a >> BigInt(k),            // BigInt >> floors: arithmetic for signed
    eq: () => BigInt(a === b), ne: () => BigInt(a !== b), lt: () => BigInt(a < b),
    le: () => BigInt(a <= b), gt: () => BigInt(a > b), ge: () => BigInt(a >= b),
  }[op]();
  return norm(t, r);                                                 // an identity for every op except not
}
```

Run with node 22: the tests in 1.5 pass against this file as printed.

Three details carry the design. `evalOp` computes the exact integer result with `BigInt` and then calls `norm`, so the evaluator never depends on JavaScript's 32-bit bitwise operators. `BigInt`'s `&`, `|`, `^` and `~` treat negative numbers as infinitely sign-extended two's complement, which is exactly what bitwise operations on signed bitvectors mean. And `norm` is an identity for every operator except `~`, which is R1.10 restated as code: the call is there to catch a typing bug, not to truncate.

### 1.4 Worked example: F-02's counter

F-02's sequential block assigns `wrap($.down ? $.value - 1 : $.value + 1)` to `value: u(8)`. The table types it bottom-up with the functions above.

| Expression | Rule | Call | Type |
| --- | --- | --- | --- |
| `$.value` | declared | — | `u8` |
| `1` | R1.3 | `constType(1)` | `u1` |
| `$.value + 1` | add, unsigned | `inferBinary("add", u8, u1)` | `u9` |
| `$.value - 1` | sub, unsigned | `inferBinary("sub", u8, u1)` | `s9` |
| `$.down ? … : …` | R1.6 join | `join(s9, u9)` | `s10` |
| `wrap(…)` into `value` | R1.8 | target supplies `u8` | `u8` |
| `$.value === 0` | comparison | `inferBinary("eq", u8, u1)` | `u1` |

The join is worth reading twice. `u9` holds 0 to 511, `s9` holds −256 to 255, and the narrowest type holding both is `s10`. A range analysis over the values this design can produce would find −1 to 256, which also needs `s10`. `dce`'s narrowing step (Chapter 11) then notices that only the low eight bits reach the register and shrinks the adders; the types protect the meaning, and the optimizer recovers the area.

The scenario "wraps below zero" pokes `down = 1`, `en = 1` from `value = 0`. The evaluator gives `evalOp("sub", s9, [0n, 1n]) = -1n` and `wrap(u8, -1n) = 255n`, the value the scenario expects. Without `wrap`, R1.7 rejects the assignment because `s10 ⋢ u8`.

### 1.5 Tests

The tests come in two kinds. Unit tests fix the values F-02 relies on: `constType(1)` is `u1`, `constType(-1)` is `s1`, the three types in the table above, `wrap(u8, -1n) = 255n`, `sat(u8, -1n) = 0n`, `sat(u8, 300n) = 255n`, `mul(u8, s8)` is `s16`, and `~5` in `u8` is 250.

The property test checks R1.10 directly. It draws 20,000 random pairs of operand types and values, computes the exact result of `+`, `-` and `*`, and asserts that the result lies in the inferred type. It also checks that the join is an upper bound of both operands.

```js
const types = [u(1), u(3), u(8), s(1), s(4), s(8)];
let rnd = 12345; const next = () => (rnd = (rnd * 1103515245 + 12345) & 0x7fffffff);
const pick = t => { const [lo, hi] = range(t); return lo + BigInt(next()) % (hi - lo + 1n); };
for (let i = 0; i < 20000; i++) {
  const a = types[next() % types.length], b = types[next() % types.length];
  for (const op of ["add", "sub", "mul"]) {
    const t = inferBinary(op, a, b), x = pick(a), y = pick(b);
    const exact = op === "add" ? x + y : op === "sub" ? x - y : x * y;
    const [lo, hi] = range(t);
    assert.ok(exact >= lo && exact <= hi, `${op} ${show(a)} ${show(b)} -> ${show(t)} lost ${exact}`);
  }
  const j = join(a, b); assert.ok(sub(a, j) && sub(b, j));
}
```

Run with node 22: all unit and property tests pass. The generator is a fixed linear congruential sequence, so a failure reproduces exactly.

The acceptance test for this chapter is F-02's second scenario, run against the evaluator alone: from `value = 0` with `down` and `en` high, one step gives 255 and `zero` falls to 0. Chapter 8 runs the same scenario through the simulator, and the two must agree.

### 1.6 Design notes

The rules work on types, not on values. A value-range analysis could give tighter widths, but its result would depend on the whole design, and a programmer could not predict it from one line. Type-level rules make every width visible from the source, and optimization is free to narrow afterward.

Promotion to `s(n + 1)` costs a bit and buys correctness. The alternative, reinterpreting `u(n)` as `s(n)`, turns 200 into −56 inside a mixed expression. Weft spends the bit.

The soundness property is also what makes Chapter 11's rewrite validation tractable. Because no operator truncates, a rewrite's left and right sides can be compared as exact integers before any `wrap`, which is a simpler SAT query than comparing truncated bitvectors.

### 1.7 Exercises

1. Add rotate-left by a constant, `rotl(x, k)`. Give its typing judgment and its `evalOp` case, and test it exhaustively for `u(5)`.
2. Write an interval analysis over HIR expressions that computes the exact range of each node from its operands' ranges. Show that it finds −1 to 256 for F-02's conditional, and that it narrows `x & 15` from `u8` to `u4`.
3. Implement signed `/` and `%` by constant powers of two with JavaScript's truncating semantics: add a bias of 2^k − 1 to negative dividends before the shift. Test against `BigInt` division for every value of `s(8)` and every k from 1 to 7.
4. Encode each operator in SMT-LIB 2 bitvector logic (`zero_extend`, `sign_extend`, `bvadd`, `bvmul`). Use a solver to prove R1.10 for all widths from 1 to 16; this is the same machinery Chapter 11 uses to validate rewrite rules.
5. Prove that `join` returns the least upper bound under `⊑`. Split on the four combinations of signedness and show that no narrower type holds both operands.

### 1.8 Further study

- Harris and Harris, *Digital Design and Computer Architecture*, Chapters 2–4: combinational logic, sequential logic and hardware description languages. The study curriculum pairs them with F-02 and suggests implementing width inference, signed arithmetic, wrapping and saturation, which is this chapter.
- Amaranth HDL language guide, the section on shapes. Amaranth makes similar choices about the widths of arithmetic results; compare its rules with R1.5 and note where they differ.
- MIT 6.004 *Computation Structures*, the sequential-logic unit, for the registers whose next-state values these types describe.
- The Verilog-2001 standard's rules for expression bit lengths and signedness, as the design Weft departs from in 1.2.

## Chapter 2 · Staged elaboration

Examples: **F-03**, **F-04** · Prerequisite: Chapter 1

This chapter builds `builder.js`. It defines the builder object model, parameters and their specialization, and a memoized elaborator that turns builder values into HIR module definitions plus an instance tree. Elaboration is the first stage of a Weft program: it runs JavaScript now and produces the description that every later stage consumes. Getting its identity rules right decides whether eight copies of a PWM channel compile once or eight times, and whether a cached build can be trusted.

### 2.1 The formal statement

The study curriculum states the core distinction in one line, and this chapter implements it:

```latex
\mathrm{elaborate}(P, \theta) = G_\theta
```

Here P is a hardware program, a builder value such as `pwm`. θ is an assignment of its build-time parameters, such as `{ BITS: 8 }`. Gθ is the resulting circuit description, an HIR module definition. Elaboration also reads an environment *env* that the target supplies: the module's clock, the part and the board. Written out in full, the function is elaborate(P, θ, env).

Two properties make the function useful to a compiler. It must be *deterministic*: the same P, θ and env give the same Gθ. It must also be *memoizable*: if two instances agree on P, θ and the clock domain, they share one Gθ, and the compiler builds it once. The rest of this chapter makes both properties hold, and says where Weft must take the programmer's word for them.

The partial-evaluation reading of the formula is exact. A builder is a program with two kinds of input. Static inputs (θ, env) are known now, and dynamic inputs (the circuit's ports and registers) exist only when the hardware runs. Elaboration evaluates everything that depends only on static inputs, which is a specializer in the sense of Jones, Gomard and Sestoft. Builder lambdas are static code. Hardware lambdas are dynamic code, translated rather than evaluated, and Chapter 3 is the semantics-preserving translation the curriculum asks for.

### 2.2 Specification

- **R2.1 Builders are values.** Every builder method returns a new builder; no method changes its receiver. Sharing a module between designs, or deriving two variants from one, can then never leak a change from one to the other.
- **R2.2 Definition identity.** A definition is identified by its *step list*, the sequence of builder calls that made it. Two builders with the same step list (the same object, not an equal copy) are the same definition. Identity by object is exact, where comparing source text would treat two closures over different variables as equal.
- **R2.3 Parameters.** `.params(defaults)` declares parameter names and default values. `.with(θ)` overrides some of them. Values must be JSON data: numbers, strings, booleans, arrays and plain objects. A key built from them must be canonical, which functions and class instances do not allow.
- **R2.4 Builder lambdas of parameters.** Any builder argument may be a function `(Θ, env) => value`. It is called once per specialization during elaboration, in declaration order. This is how `({ BITS }) => u(BITS)` gives each specialization its own port type.
- **R2.5 Environment.** env is `{ clock: { name, hz }, part, board }` for the module's clock domain. `.every()` and F-06's baud divider need the frequency, and nothing else may supply it.
- **R2.6 Specialization key.** key = (definition id, canonical JSON of θ, clock domain). Canonical JSON sorts object keys, so `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` give the same key.
- **R2.7 Memoization.** One memo table exists per target build. Within it, equal keys share one HIR definition. Across targets, the same domain name may carry different frequencies (F-16's pico at 12 MHz and dev at 100 MHz), so tables are not shared.
- **R2.8 Instances.** An instance is a pair (instance name, key). `.as(name)` changes the instance name and leaves the key alone. Duplicate instance names in one design are rejected when the design is linked (Chapter 6).
- **R2.9 Requirements.** `.require(fn)` calls `fn(Θ, env)` once per specialization. A result other than `true` is error `require`, with the returned string as its message. This catches F-11's `N = 3` before any hardware is built.
- **R2.10 Determinism obligation.** Builder lambdas must depend only on (Θ, env). Weft cannot check this, and the memo table assumes it. A builder lambda that reads a mutable global makes a cached build silently wrong. Exercise 3 adds a debug mode that detects it.
- **R2.11 Generators are JavaScript.** Loops, `Array.from` and `.map` that create builders run before elaboration. The elaborator sees only the values they return.
- **R2.12 Parameters in hardware lambdas.** Θ is visible to the module's hardware lambdas as constants (decision D2). Chapter 3 enforces it.

### 2.3 Data structures: persistent records

A builder holds one frozen record. The record's `steps` field is an immutable list in which each call pushes a new cell on the front. A new builder therefore shares every earlier cell with the builder it came from. Appending a step costs one allocation, and two variants derived from one value share its whole history.

| Field | Holds | Changed by |
| --- | --- | --- |
| `kind`, `name` | `"module"`, `"fsm"`, … and the definition's name | `create` only |
| `steps` | The immutable list of builder calls, newest first | Every builder method except the three below |
| `bind` | Parameter overrides from `.with()` | `.with()` |
| `inst` | The instance name | `.as()` |
| `domain` | The clock domain | `.domain()` |

The three fields outside `steps` are exactly the ones that do not change what the definition *is*. That is why the definition id can be the identity of the steps list while `.with()`, `.as()` and `.domain()` still produce new builders.

```js
// builder.js — persistent builder records, specialization keys and memoized elaboration (D3)
const cons = (head, tail) => Object.freeze({ head, tail });          // an immutable list cell
const toArray = list => { const a = []; for (let c = list; c; c = c.tail) a.push(c.head); return a.reverse(); };

const defIds = new WeakMap(); let nextDef = 0;
const defId = steps => { if (!defIds.has(steps)) defIds.set(steps, ++nextDef); return defIds.get(steps); };

export class Builder {
  #r;
  constructor(r) { this.#r = Object.freeze(r); }
  static create(kind, name) {
    return new Builder({ kind, name, steps: cons(["create", kind, name], null), bind: Object.freeze({}), inst: name, domain: "sys" });
  }
  get name() { return this.#r.inst; }
  get record() { return this.#r; }
  step(op, ...args) { return new Builder({ ...this.#r, steps: cons([op, ...args], this.#r.steps) }); }  // shares the old list
  with(theta) { return new Builder({ ...this.#r, bind: Object.freeze({ ...this.#r.bind, ...theta }) }); }
  as(inst) { return new Builder({ ...this.#r, inst }); }
  domain(d) { return new Builder({ ...this.#r, domain: d }); }
}
for (const m of ["params", "require", "in", "out", "regs", "lib", "seq", "comb", "every", "on", "bind",
                 "provides", "needs", "budget", "initial", "state", "stage", "ram", "knob", "assert"])
  Builder.prototype[m] = function (...args) { return this.step(m, ...args); };

export function canonical(v) {                                        // JSON with sorted keys
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
```

The `WeakMap` gives each distinct steps list a small integer the first time a key is computed, and lets the list be garbage-collected when no builder refers to it. The method list at the bottom is deliberately generic: every grammar method records a step, and the elaborator, not the builder, gives steps their meaning. Adding a method to the grammar adds one name here and one case in `elaborate`.

### 2.4 The elaborator

`elaborate` turns one builder into an instance. It replays the step list oldest-first, resolves θ from the declared defaults and the `.with()` overrides, computes the key, and builds the HIR record only on a memo miss.

```js
export class RequireError extends Error {}
const ev = (x, theta, env) => (typeof x === "function" ? x(theta, env) : x);   // a builder lambda of params, or a value

export function elaborate(b, envOf, memo = new Map()) {               // elaborate(P, θ) = G_θ, memoized per key
  const r = b.record, steps = toArray(r.steps);
  const defaults = Object.assign({}, ...steps.filter(s => s[0] === "params").map(s => s[1]));
  const theta = Object.freeze({ ...defaults, ...r.bind });
  const key = `${defId(r.steps)}|${canonical(theta)}|${r.domain}`;
  if (!memo.has(key)) {
    const env = envOf(r.domain);
    const hir = { key, kind: r.kind, name: r.name, params: theta, domain: r.domain,
                  ports: [], regs: [], blocks: [], lib: {}, provides: [], needs: [], binds: {} };
    for (const [op, ...a] of steps) {
      if (op === "require") { const ok = a[0](theta, env); if (ok !== true) throw new RequireError(`require: ${r.name} ${canonical(theta)}: ${ok}`); }
      else if (op === "in" || op === "out") {
        const ports = typeof a[0] === "string" ? { [a[0]]: a[1] } : a[0];
        for (const [n, t] of Object.entries(ports)) hir.ports.push({ name: n, dir: op, type: ev(t, theta, env) });
      }
      else if (op === "regs") for (const [n, t] of Object.entries(ev(a[0], theta, env))) hir.regs.push({ name: n, type: t });
      else if (op === "lib") Object.assign(hir.lib, ev(a[0], theta, env));
      else if (["seq", "comb", "every", "on", "state", "stage", "assert"].includes(op))
        hir.blocks.push({ kind: op, args: a.slice(0, -1).map(x => ev(x, theta, env)), fn: a.at(-1), src: a.at(-1).toString() });
      else if (op === "provides" || op === "needs") hir[op].push(...a);
      else if (op === "bind") Object.assign(hir.binds, a[0]);
    }
    memo.set(key, Object.freeze(hir));
  }
  return { inst: r.inst, key, def: memo.get(key) };                  // an instance: a name and a shared definition
}
```

Run with node 22: the tests in 2.6 pass against this file, with `types.js` from Chapter 1.

Three choices in this function matter more than their size suggests. The `ev` helper is the entire implementation of R2.4: an argument that is a function is a builder lambda, called with (Θ, env), and anything else is a value. Hardware lambdas are the one exception, which is why the last argument of a block step is stored, not called. Blocks keep their source text in `src`; nothing in this chapter looks inside them. Chapter 3 parses `src`, and Chapter 4 merges the blocks into next-state functions.

### 2.5 Worked example: F-04

F-04 builds one `breathe` and eight `pwm` instances. Running `elaborate` over the design's instances in order gives this trace (the keys are printed by the code above):

| Instance | θ | Key | Memo |
| --- | --- | --- | --- |
| `breathe` | `{ N: 8 }` from `.with({ N: bank.length })` | `1\|{"N":8}\|sys` | miss |
| `pwm-0` | `{ BITS: 8 }` from the default | `2\|{"BITS":8}\|sys` | miss |
| `pwm-1` … `pwm-7` | `{ BITS: 8 }` | `2\|{"BITS":8}\|sys` | 7 hits |

Nine instances need two definitions. Building `pwm.with({ BITS: 12 })` would add a third key, `2|{"BITS":12}|sys`, with `u12` ports and registers. The definition id stays 2, because `.with()` does not touch the steps list. Moving `pwm` to the pixel domain with `.domain("pix")` would also add a key, because `.every()` counters and baud dividers depend on the domain's frequency.

The HIR record for `pwm-3`, printed with types shown as strings, is:

```json
{
  "key": "2|{\"BITS\":8}|sys",
  "kind": "module",
  "name": "pwm",
  "params": { "BITS": 8 },
  "domain": "sys",
  "ports": [ { "name": "duty", "dir": "in", "type": "u8" }, { "name": "out", "dir": "out", "type": "u1" } ],
  "regs": [ { "name": "phase", "type": "u8" } ],
  "blocks": [ { "kind": "seq", "src": "$ => { $.phase += 1; $.out = $.phase < $.duty; }" } ],
  "lib": {}, "provides": [], "needs": [], "binds": {}
}
```

The `duty` port's type came from the builder lambda `({ BITS }) => u(BITS)`, called with θ once, during the miss. The seven hits never call it again.

### 2.6 Tests

The tests check sharing, specialization, memoization and requirements, each against an example.

```js
// structural sharing: two children of one value share its steps
const a = module("x").in("a", bit), b = a.in("b", u(2)), c = a.in("c", u(3));
assert.equal(b.record.steps.tail, a.record.steps);
assert.equal(c.record.steps.tail, a.record.steps);

// F-04: one pwm definition, eight instances; breathe specialized to N = 8
const memo = new Map();
const insts = [breathe.with({ N: bank.length }), ...bank].map(m => elaborate(m, envOf, memo));
assert.equal(memo.size, 2);                                           // two definitions for nine instances
assert.equal(insts[0].def.ports[0].type.n, 8);
const wide = elaborate(pwm.with({ BITS: 12 }), envOf, memo);
assert.equal(show(wide.def.regs[0].type), "u12");
assert.notEqual(elaborate(pwm.domain("pix"), envOf, memo).key, insts[1].key);   // domain is part of the key

// .require runs per specialization (F-11)
const arbiter = module("arbiter").params({ N: 4 }).require(({ N }) => (N & (N - 1)) === 0 || "N must be a power of two");
elaborate(arbiter, envOf);
assert.throws(() => elaborate(arbiter.with({ N: 3 }), envOf), RequireError);
```

Run with node 22: all assertions pass. `pwm`, `breathe` and `bank` are defined exactly as in F-04, using `Builder.create` as `module`.

The acceptance test for the chapter is F-04 itself: elaborating its design must produce two definitions and nine instances, and the instance names must be `breathe` and `pwm-0` to `pwm-7` in order. F-11's arbiter at its default `N = 4` must elaborate, and `.with({ N: 3 })` must fail with the require message.

### 2.7 What HIR holds, and what it leaves for later

HIR at this point is a set of definitions plus an instance tree. Definitions carry typed ports and registers, block sources, shipped values, stream names and pin bindings. Instances carry names and keys. Nothing has been connected yet: `provides`, `needs` and `.wire()` are linked in Chapter 6, and blocks are translated in Chapter 3. Keeping hierarchy at this level makes errors local. A width error in `pwm` is reported once, against the definition, not eight times against flattened copies.

Chisel takes a different route to the same end. It elaborates by running every Scala constructor, so eight `pwm` instances run the constructor eight times, and a later FIRRTL transform deduplicates structurally identical modules. Weft deduplicates up front, by key, and never builds the copies. The price is R2.10: the key is trustworthy only if builder lambdas are pure functions of (Θ, env).

### 2.8 Exercises

1. Add `.when(pred, b => …)`: steps that apply only when `pred(Θ, env)` is true. Decide whether `pred` belongs in the definition id or is evaluated during elaboration, and justify the choice with the memo rule.
2. Persist the memo table across runs. The definition id is an in-memory identity, so design a second-level key from the *content* of each HIR record (hash its ports, registers, block sources and `lib` data) and show that an unchanged module is not re-elaborated after a restart.
3. Add a debug mode that elaborates every key twice with fresh memo tables and compares the HIR records. Show that it catches a builder lambda reading `Date.now()`, a violation of R2.10.
4. Implement design-level instance trees with hierarchical names (`top.bank.pwm-3`) and reject duplicate names at link time.
5. Write a three-instruction module language (declare a register, add two values, compare) and an interpreter for it. Specialize the interpreter by hand with respect to θ and compare the result with what `elaborate` produces for an equivalent builder.

### 2.9 Further study

- Jones, Gomard and Sestoft, *Partial Evaluation and Automatic Program Generation*. Binding-time analysis, the split of a program into static and dynamic parts, is the formal version of Weft's builder and hardware lambdas.
- "AnyHLS: High-Level Synthesis with Partial Evaluation." The curriculum's example of partial evaluation applied directly to FPGA compilation; compare its specialization of generic code with `elaborate`.
- Schoeberl, *Digital Design with Chisel*, the chapters on hardware generators. They show ordinary host-language computation generating circuits, the pattern F-04 uses.
- Taha and Sheard, "MetaML and Multi-Stage Programming with Explicit Annotations," for staging made explicit in syntax rather than by position.

## Chapter 3 · From lambda to HIR

Examples: **F-03**, **F-04**, with **F-02** and **F-06** as test material · Prerequisite: Chapters 1 and 2

This chapter builds three files. `capture.js` gets a hardware lambda's source, parses it and enforces the capture rule. `lower.js` translates the lambda into typed HIR expressions and next-state functions. `lib.js` decides what each shipped value becomes. Together they are the semantics-preserving AST-to-IR translation that the study curriculum identifies as the second half of staging: builder code is evaluated (Chapter 2), and hardware code is translated here.

### 3.1 Specification

- **R3.1 Source.** A hardware lambda's source is `Function.prototype.toString()` of the function passed to a block method. It must parse as an arrow function, a function expression or a method shorthand, which is normalized to a function expression. The source is the program, so the compiler must read exactly what the programmer wrote.
- **R3.2 Allowed names.** A hardware lambda may refer to `$`, its own parameters and locals, the prelude, the module's parameters Θ and the names in its `.lib()`. Any other free name is error `capture`. This is decision D2: params are allowed because they are constants declared on the same builder.
- **R3.3 Transitivity.** A helper function shipped by `.lib()` obeys R3.2 against the same module. A lambda that calls a helper is checked, and so is the helper, and so is every helper it calls.
- **R3.4 Shadowing.** A `.lib()` name equal to a param name is error `lib-shadows-param`. Two meanings for one name would make the translation depend on lookup order.
- **R3.5 Syntax.** The supported subset is in the table in 3.4. Unsupported syntax (`while`, recursion, closures, `try`, `async`, object construction other than a struct literal) is error `unsupported` at its source position.
- **R3.6 Clocked reads and writes.** In clocked blocks, `$.r` reads the current value Q even after an earlier write in the same lambda (D5). Each write records a guarded assignment, and the last assignment in program order wins (D4).
- **R3.7 Combinational reads and writes.** In `.comb`, a read sees the latest earlier write in program order. Reading a wire that the same lambda writes before it has written it is error `comb-read-before-write`. A wire not written on every path is error `latch`.
- **R3.8 Locals.** `const` and `let` are wires. A `let` reassigned in both arms of an `if` becomes a multiplexer at the join, which is SSA form with φ written as a mux.
- **R3.9 Control flow.** Each statement carries a path condition. `return` in a clocked block skips the rest of the lambda on that path; in a helper it also supplies the call's value.
- **R3.10 Loops.** `for` loops must have bounds computable from constants (literals, Θ, `.lib()` numbers and outer loop indices). They unroll completely, at most 4096 iterations, else error `unroll-bound`. Names declared in a loop body stay inside it; updates to outer locals carry over.
- **R3.11 Helpers.** A call to a shipped function is inlined at the call site with a fresh scope, so its locals cannot collide with the caller's. Its returns are mutually exclusive paths and become a mux chain. Its writes to `$` carry the caller's path condition.
- **R3.12 Shipped values.** `.lib()` values translate by the table in 3.8; anything else is error `lib-value`.
- **R3.13 Widths.** Every assignment is checked by R1.7 at the point it is lowered, and errors carry the target and both types.

### 3.2 Getting the source

`toString()` returns the function's source text exactly as written, comments included. Three forms reach the compiler. Arrow functions and function expressions parse as they are. A method shorthand such as `baud($) { … }`, which `toString()` returns for methods in object literals, is not a valid expression, so `normalize` rewrites it as `function baud($) { … }`. Wrapping the text in parentheses makes the parser read it as an expression.

```js
export function normalize(src) {                                     // method shorthand → function expression
  const s = src.trim();
  if (/^(async\s+)?function\b/.test(s) || /^(async\s*)?\(/.test(s) || /^(async\s+)?[\w$]+\s*=>/.test(s)) return s;
  const m = s.match(/^(async\s+)?([\w$]+)\s*\(/);
  return m ? `${m[1] ?? ""}function ${s.slice(m[1]?.length ?? 0)}` : s;
}

export function parseLambda(src) {
  const ast = acorn.parse(`(${normalize(src)})`, { ecmaVersion: "latest", locations: true });
  return ast.body[0].expression;                                      // the function node; offsets are src + 1
}
```

Three sources defeat this, and the compiler must say so instead of guessing. A bound function (`f.bind(x)`) and a built-in return `function () { [native code] }`. A minifier renames locals and parameters, so diagnostics point at names the programmer never wrote. Weft scripts are therefore compiled from their original source, never from a bundled build.

Source positions come from finding the lambda's text in the file. `locate` searches for the exact source string and converts an offset inside it to `file:line:col`. When the text occurs twice, the first occurrence is reported; the builder's call-site stack trace, recorded when the step is made, breaks the tie in a full implementation.

### 3.3 Scope analysis and the capture check

A name is *free* in a function when the function uses it but no scope inside the function declares it. JavaScript has three kinds of scope that matter here. Parameters and `var` belong to the function. `let`, `const`, classes and function declarations belong to their block. A `for` loop's head declares its index for the loop alone. Ignoring block scope is not safe: in `{ const gamma = 1; } return gamma($.x);` the second `gamma` is free, and a checker that collected every declaration in the function would miss it.

The resolver below handles each identifier separately. It walks outward through the identifier's ancestors and asks each scope node whether it declares the name. The walk stops at the lambda's own function node, because the lambda's surroundings in the script are exactly what it is not allowed to see.

```js
const scopeCache = new WeakMap();
function declaredIn(node) {                                            // names a scope node declares
  if (scopeCache.has(node)) return scopeCache.get(node);
  const out = new Set();
  if (isFn(node)) {
    node.params.forEach(p => names(p, out));
    if (node.id && node.type === "FunctionExpression") out.add(node.id.name);
    walk.recursive(node.body, null, {                                  // var is function-scoped; skip nested functions
      Function() {},
      VariableDeclaration(d, st, c) { if (d.kind === "var") d.declarations.forEach(x => names(x.id, out)); d.declarations.forEach(x => x.init && c(x.init, st)); },
    });
  }
  if (node.type === "BlockStatement" || node.type === "Program")
    for (const st of node.body) {
      if (st.type === "VariableDeclaration" && st.kind !== "var") st.declarations.forEach(d => names(d.id, out));
      if (st.type === "FunctionDeclaration" || st.type === "ClassDeclaration") out.add(st.id.name);
    }
  if (/^For(In|Of)?Statement$/.test(node.type)) { const d = node.init ?? node.left; if (d?.type === "VariableDeclaration") d.declarations.forEach(x => names(x.id, out)); }
  if (node.type === "CatchClause") names(node.param, out);
  scopeCache.set(node, out);
  return out;
}

function isReference(id, parent) {
  if (!parent) return true;
  if (parent.type === "MemberExpression" && parent.property === id && !parent.computed) return false;
  if ((parent.type === "Property" || parent.type === "MethodDefinition") && parent.key === id && !parent.computed && !parent.shorthand) return false;
  if (/Statement$/.test(parent.type) && parent.label === id) return false;
  return true;
}

export function freeNames(fnNode) {                                   // [{ name, start }] in source order
  const free = [];
  walk.fullAncestor(fnNode, (n, _st, anc) => {
    if (n.type !== "Identifier" || !isReference(n, anc.at(-2))) return;
    for (let i = anc.length - 2; i >= 0; i--) if (declaredIn(anc[i]).has(n.name)) return;
    free.push({ name: n.name, start: n.start - 1, loc: n.loc });
  });
  return free;
}
```

`isReference` excludes the identifiers that are not uses of a variable: the `phase` in `$.phase`, an object key in `{ x: 1 }` (but not the shorthand `{ x }`, which reads `x`), and statement labels. `names` (not shown, 8 lines) collects every name a destructuring pattern binds, so `({ BITS }) => …` declares `BITS`. The checker applies the result to a module's blocks and, transitively, to its helpers:

```js
export function checkCaptures(hir, { file, text }) {
  const allowed = new Set([...PRELUDE, ...Object.keys(hir.params), ...Object.keys(hir.lib)]);
  const diags = [];
  for (const k of Object.keys(hir.lib)) if (k in hir.params) diags.push({ code: "lib-shadows-param", msg: `.lib name "${k}" is also a param` });
  const visit = (src, where, seen = new Set()) => {
    for (const f of freeNames(parseLambda(src))) {
      if (allowed.has(f.name)) continue;
      diags.push({ code: "capture", where, at: locate(text, file, src, f.start), name: f.name,
                   msg: `${where.startsWith("helper") ? where : `the hardware lambda in ${where}`} uses the JS binding \`${f.name}\`` });
    }
    for (const k of Object.keys(hir.lib)) {                             // helpers this lambda calls are checked too
      const v = hir.lib[k];
      if (typeof v === "function" && !seen.has(k) && new RegExp(`\\b${k}\\s*\\(`).test(src)) { seen.add(k); visit(v.toString(), `helper ${k}`, seen); }
    }
  };
  for (const b of hir.blocks) visit(b.src, `${hir.name}.${b.kind}`);
  return diags;
}
```

Run with node 22 against the real example files. The harness evaluates each file's body with a recording scope (Chapter 2's `Builder` as `module`), elaborates every module, and runs `checkCaptures`. On F-03 as shipped it prints one diagnostic:

```text
F-03-lambdas.js:21:23 the hardware lambda in dimmer.seq uses the JS binding `gamma`
```

Shipping `gamma` alone, by inserting `.lib({ gamma })`, moves the error into the helper, which is the transitive case F-03's second try line asks about:

```text
helper gamma uses the JS binding `GAMMA`
```

With `.lib({ GAMMA, gamma })` the check returns nothing. F-04 also returns nothing, even though `breathe`'s `.comb` lambda uses `N` without shipping it. That is the gap the curriculum points out ("N is referenced inside a hardware lambda without `.lib()`"), and R3.2 closes it: `N` is in Θ, so it is a declared constant of this specialization, not a lexical capture.

The call detector for helpers is a regular expression on the source, which is conservative in one direction only. A helper whose name appears followed by `(` is always checked, including in a comment, which costs nothing. A helper passed as a value without being called is not reached; Exercise 2 replaces the regular expression with a walk of the call graph.

### 3.4 The HIR expression form

Lowering produces trees of plain records. Every record carries a `type` from Chapter 1, computed when the record is made, so a type error is found at the source line that caused it.

| Record | Fields | Comes from |
| --- | --- | --- |
| `const` | `value` (BigInt) | Literals, Θ and `.lib()` numbers, folded expressions |
| `read` | `name` | `$.x`: a register's Q, an input, or (in `.comb`) not yet written |
| `add`, `sub`, `mul`, `and`, `or`, `xor`, `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `shl`, `shr` | `args`, `k` for shifts | Binary operators, typed by `inferBinary` |
| `neg`, `not`, `lnot` | `args` | `-x`, `~x`, `!x` |
| `mux` | `args: [cond, then, else]` | `?:`, `if`, `let` joins, guarded writes, helper returns |
| `slice`, `elem`, `bitsel` | `hi`, `lo` or `index` | `x.bits(hi, lo)`, `$.v[i]` on a vec, `x[i]` on a scalar |
| `rom` | `name`, `args: [addr]` | Indexing a shipped array with a non-constant index |
| `wrap`, `sat` | `args`, `type` | The narrowing calls; a `wrap` with no type takes its target's |

The tree form repeats shared subexpressions, which the next section shows. Chapter 10 replaces these records with hash-consed DAG nodes, which share them; this chapter keeps trees because they are easy to print and to test.

### 3.5 Statements to guarded assignments

Lowering walks statements in order with a *context*: the path condition `guard` and a shared `flow.dead` condition that collects the paths on which the lambda has already returned. The condition under which a statement actually runs is `live = guard ∧ ¬dead`. An `if` lowers each arm under `guard ∧ c` and `guard ∧ ¬c`, sharing `flow`, so a `return` inside an arm makes the rest of the lambda dead on that arm's path.

The constructors fold constants and simplify trivial muxes as they build, which keeps the output readable and costs nothing:

```js
export function bin(op, a, b) {
  if (isK(a) && isK(b)) return K(BigInt(FOLD[op](a.value, b.value)));             // constant folding while lowering
  const k = op === "shl" || op === "shr" ? (isK(b) ? Number(b.value) : null) : undefined;
  if (k === null) throw new LowerError("width", "shift amounts must be constant here");
  return { op, args: k === undefined ? [a, b] : [a], k, type: inferBinary(op, a.type, b.type, k) };
}
const yes = e => isK(e) && e.value !== 0n, no = e => isK(e) && e.value === 0n;
const and = (a, b) => (yes(a) ? b : yes(b) ? a : no(a) || no(b) ? K(0) : bin("and", a, b));
const or = (a, b) => (isK(a) && a.value === 0n ? b : isK(b) && b.value === 0n ? a : bin("or", a, b));
const not = a => (isK(a) ? K(a.value === 0n ? 1 : 0) : { op: "lnot", args: [a], type: bit });
const mux = (c, a, b) => (yes(c) ? a : no(c) ? b : a === b ? a : { op: "mux", args: [c, a, b], type: a === UNDEF ? b.type : b === UNDEF ? a.type : join(a.type, b.type) });
```

An assignment checks widths (R3.13) and then records itself. In a clocked block it appends a guarded assignment; in `.comb` it updates the wire's current value, starting from a distinguished `UNDEF` that later reveals a latch.

```js
  const live = ctx => and(ctx.guard, not(ctx.flow.dead));
  function assign(t, value, ctx, compound) {
    const tt = t.type;
    let v = compound ? { op: "wrap", args: [bin(compound, { op: "read", name: t.name, type: tt }, value)], type: tt } : value;
    if ((v.op === "wrap" || v.op === "sat") && !v.type) v = { ...v, type: tt };
    else if (v.op !== "wrap" && v.op !== "sat" && !sub(v.type, tt))
      throw new LowerError("width", `${show(v.type)} does not fit ${keyOf(t)}: ${show(tt)}; say wrap() or sat()`, null);
    const g = live(ctx);
    if (clocked) assigns.push({ key: keyOf(t), type: tt, guard: g, value: v });
    else comb.set(keyOf(t), mux(g, v, comb.get(keyOf(t)) ?? UNDEF));
  }
```

The statement cases for `if` and `return` show the path-condition machinery and the SSA join for locals. Locals live in a `Map` from name to expression; each arm gets a copy, and any local whose expression differs between the arms becomes a mux on the condition.

```js
      case "IfStatement": {
        const c = toBit(expr(n.test, env, ctx));
        if (isK(c)) return stmt(c.value ? n.consequent : n.alternate ?? { type: "EmptyStatement" }, env, ctx);
        const e1 = new Map(env), e2 = new Map(env);
        stmt(n.consequent, e1, { ...ctx, guard: and(ctx.guard, c) });
        if (n.alternate) stmt(n.alternate, e2, { ...ctx, guard: and(ctx.guard, not(c)) });
        for (const k of new Set([...e1.keys(), ...e2.keys()]))                              // a join: muxes for changed locals
          if (env.has(k) && (e1.get(k) !== env.get(k) || e2.get(k) !== env.get(k))) env.set(k, mux(c, e1.get(k), e2.get(k)));
        return;
      }
      case "ReturnStatement": {
        if (ctx.rets && n.argument) ctx.rets.push({ guard: live(ctx), value: expr(n.argument, env, ctx) });
        ctx.flow.dead = or(ctx.flow.dead, live(ctx));                                       // later statements skip this path
        return;
      }
```

At the end, a clocked block's assignments become next-state functions. For each register, the writes fold left in program order into a priority mux whose last alternative is Q (hold) or 0 (a pulse). A combinational wire's value is checked for `UNDEF`, which survives only if some path never wrote it.

```js
  const next = new Map();
  if (clocked) for (const a of assigns) {                               // D4 within a lambda: the last write in program order wins
    const hold = a.type.pulse ? K(0) : { op: "read", name: a.key, type: a.type };
    next.set(a.key, mux(a.guard, a.value, next.get(a.key) ?? hold));
  }
  else for (const [k, v] of comb) { if (contains(v, UNDEF)) throw new LowerError("latch", `${k} is not written on every path`); next.set(k, v); }
  return next;
```

The complete `lower.js` is 202 lines: these excerpts plus the expression cases, the target resolver for `$.x` and `$.x[i]`, and the loop and helper code below. Run with node 22: every test in 3.10 passes.

### 3.6 Loop unrolling and constant evaluation

Loops are unrolled by running them. The loop's init, test and update are lowered like any expression; because the index starts as a constant and every operation on constants folds, the test is a constant on every iteration unless it depends on a signal. A test that is not constant is error `unroll-bound`, as is a loop that runs more than 4096 times.

```js
      case "ForStatement": {
        stmt(n.init.type === "VariableDeclaration" ? n.init : { type: "ExpressionStatement", expression: n.init }, env, ctx);
        for (let i = 0; ; i++) {
          if (i > 4096) throw new LowerError("unroll-bound", "loop runs more than 4096 times", n);
          const t = expr(n.test, env, ctx); if (!isK(t)) throw new LowerError("unroll-bound", "loop bound is not constant", n);
          if (t.value === 0n) break;
          const inner = new Map(env); stmt(n.body, inner, ctx);                             // the body's own names stay inside;
          for (const k of env.keys()) env.set(k, inner.get(k));                              // updates to outer locals carry over
          stmt({ type: "ExpressionStatement", expression: n.update }, env, ctx);
        }
        return;
      }
```

The last two lines of the body matter for accumulators. F-15's FIR filter sums into `let acc` across iterations, and a body that ran in a throwaway copy of the environment would lose every addition. The test below uses the same shape on four 8-bit taps, and its output shows something the type rules imply but intuition misses: a chain of n additions grows by n bits.

```text
y.next = (add:u12 (add:u11 (add:u10 (add:u9 0 (elem[0]:u8 z)) (elem[1]:u8 z)) (elem[2]:u8 z)) (elem[3]:u8 z))
```

The exact range of a sum of four `u8` values fits in 10 bits. The chain is `u12` because each `+` adds one bit to the widest operand, and the chain's left operand keeps growing. A balanced tree, `(z0 + z1) + (z2 + z3)`, types as `u10`. This is why Chapter 11's reassociation pass is also a width optimization.

### 3.7 Helper inlining

A call to a shipped helper is lowered by lowering the helper's body at the call site. The helper gets a fresh `Map` for its locals, which is all the hygiene inlining needs: the helper's names live in their own map and cannot capture or shadow the caller's. `$` passes through unchanged, so a helper's writes to registers become guarded assignments of the caller, under the caller's live condition.

```js
    const helper = hir.lib[name];
    if (typeof helper !== "function") throw new LowerError("capture", `\`${name}\` is not a shipped helper`, n);
    const h = parseLambda(helper.toString()), local = new Map(), rets = [];   // a fresh scope: helper locals cannot collide
    h.params.forEach((p, i) => local.set(p.name, p.name === "$" ? null : expr(n.arguments[i], env, ctx)));
    local.delete("$");
    const hctx = { guard: live(ctx), flow: { dead: K(0) }, rets };
    stmts(h.body.type === "BlockStatement" ? h.body.body : [{ type: "ReturnStatement", argument: h.body }], local, hctx);
    if (!rets.length) return K(0);
    return rets.reduceRight((acc, r) => (acc ? mux(r.guard, r.value, acc) : r.value), null);   // returns are exclusive
```

F-06's `baud($)` exercises every part of this. The test module ships `{ DIV: 103, baud }` and writes `if (baud($)) $.line = !$.line;`. Lowering produces:

```text
wait.next = (mux:u16 (lnot:u1 (ne:u1 wait 0)) 103 (mux:u16 (ne:u1 wait 0) (wrap:u16 (sub:s17 wait 1)) wait))
line.next = (mux:u1 (mux:u1 (ne:u1 wait 0) 0 1) (lnot:u1 line) line)
```

Read them against the helper. When `wait` is nonzero, the first `return 0` path decrements `wait`; on the other path, `wait` reloads with `DIV`, and the call's value is 1. The call's value, `(mux (ne wait 0) 0 1)`, guards the toggle of `line`. The inner `else wait` of `wait.next` can never be reached, and the duplicated condition in F-04's output below is computed twice. Neither is a bug in the translation: they are what Chapter 11's mux-tree simplification and Chapter 10's hash-consing are for.

### 3.8 Shipped values

`lib.js` classifies each shipped value. The table is R3.12, and the outputs are from running the classifier on values from the examples.

| Shipped value | Becomes | Example and result |
| --- | --- | --- |
| Integer or boolean | A constant of the narrowest type | `DIV: 103` → `u7` |
| String | A compile-time name | F-07's `Q: "q.block"` names a stream inside the lambda |
| Array of integers | A ROM; element type is the join of the elements' types | F-03's `GAMMA` → 256 words of `u8`; F-17's `A = [-26755, 11315]` → `s16` |
| Array of strings | A compile-time list, indexed only by constants | F-07's queue names in an unrolled loop |
| Array of plain objects with one shape | A ROM of structs, one ROM column per field | F-19's `PALETTES` → 2 words; `fg.r` is a 2-word `u8` column |
| Plain object | A struct of constants | `{ W: 640, H: 480 }` |
| `rom()` builder | A memory instanced in the module | F-08's `sine` |
| Function | A helper, inlined at each call | F-06's `baud`, F-19's `hits` |
| Anything else | Error `lib-value` | A `Map`: "m has no hardware meaning (\[object Map\])" |

```js
const plain = v => v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
export function classify(name, v) {
  if (typeof v === "number" && Number.isInteger(v)) return { kind: "const", type: constType(v) };
  if (typeof v === "boolean") return { kind: "const", type: constType(+v) };
  if (typeof v === "string") return { kind: "name" };                                   // F-07's Q: names a stream
  if (typeof v === "function") return { kind: "helper", src: v.toString() };
  if (v?.__rom) return { kind: "memory" };                                              // a rom() builder
  if (Array.isArray(v) && v.length && v.every(x => Number.isInteger(x)))
    return { kind: "rom", words: v.length, type: v.map(constType).reduce(join) };
  if (Array.isArray(v) && v.every(x => typeof x === "string")) return { kind: "names", length: v.length };
  if (Array.isArray(v) && v.length && v.every(plain)) {                                  // F-19's PALETTES
    const fields = Object.keys(v[0]);
    if (!v.every(x => Object.keys(x).join() === fields.join())) throw new Error(`lib-value: ${name}: rows differ in shape`);
    return { kind: "rom-of-structs", words: v.length,                                   // one ROM column per field
             fields: Object.fromEntries(fields.map(f => [f, classify(`${name}.${f}`, v.map(x => x[f]))])) };
  }
  if (plain(v)) return { kind: "struct", fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, classify(`${name}.${k}`, x)])) };
  throw new Error(`lib-value: ${name} has no hardware meaning (${Object.prototype.toString.call(v)})`);
}
```

Run with node 22 on the values in the table; the results in the third column are its output. Storing a ROM of structs as one column per field is a choice with a reason: a read of `PALETTES[i].fg` then reads only the `fg` columns, and the columns nobody reads are removed by dead-code elimination.

### 3.9 Worked examples

The translator's output for the example lambdas, printed by `print` (operator, then type, then arguments):

```text
F-02 counter.seq   value.next = (mux:u8 en (wrap:u8 (mux:s10 down (sub:s9 value 1) (add:u9 value 1))) value)
F-02 counter.comb  zero       = (eq:u1 value 0)
F-04 breathe.every level.next = (mux:u8 (lnot:u1 (mux:u1 (eq:u1 level 0) 1 (mux:u1 (eq:u1 level 255) 0 up)))
                                        (wrap:u8 (sub:s9 level 1))
                                        (mux:u8 (mux:u1 (eq:u1 level 0) 1 (mux:u1 (eq:u1 level 255) 0 up))
                                                (wrap:u8 (add:u9 level 1)) level))
F-04 breathe.comb  duty[3]    = (wrap:u8 (add:u9 level 96))
F-03 dimmer.seq    pwm.next   = (lt:u1 phase (rom GAMMA:u8 level))       ← with .lib({ GAMMA, gamma })
```

Each line can be checked against the source by hand. The counter's next state matches Chapter 1's type table node for node. In `breathe`, the local `up` is a two-level mux used twice, so the tree prints it twice; the `if`/`else` became a priority mux with `level` as the final hold. The `.comb` loop unrolled to four assignments for N = 4 and eight for N = 8, and `i * 32` folded to 96 before typing, so `duty[3]` is a 9-bit add, not a multiply. In `dimmer`, the helper call `gamma($.level)` inlined to a ROM read whose element type, `u8`, came from the join over the 256 table entries.

### 3.10 Tests

The acceptance tests run the checker and the translator on the example files and on the lambdas above, and assert the printed results exactly:

- F-03 as shipped reports exactly one `capture` diagnostic for `gamma` at `F-03-lambdas.js:21:23`. With `.lib({ gamma })` it reports exactly one for `GAMMA` in `helper gamma`. With `.lib({ GAMMA, gamma })` it reports none.
- F-04 reports no diagnostics, and `breathe.with({ N: 8 })` lowers its `.comb` to eight assignments.
- The five printed lines in 3.9 and the two in 3.7 match exactly.
- `$.value = $.value + 1` into `u(8)` fails with `width: u9 does not fit value: u8; say wrap() or sat()`.
- `$.y = $.x; $.x = $.a;` in one `.comb` fails with `comb-read-before-write`. `if ($.a) $.x = 1;` in `.comb` fails with `latch`. A 5000-iteration loop fails with `unroll-bound`.
- The accumulator test types the four-tap chain as `u12`.

Run with node 22: all of these pass. F-03's own scenario, which measures the LED's duty cycle, becomes an acceptance test once Chapter 8's simulator exists.

### 3.11 Error messages

Every diagnostic names a code, a location and a fix. The codes are fixed so that tools and tests can match them; the full catalogue is in Appendix B.

| Code | Source | Message |
| --- | --- | --- |
| `capture` | F-03 as shipped | `F-03-lambdas.js:21:23 the hardware lambda in dimmer.seq uses the JS binding \`gamma\`\` |
| `width` | `$.value = $.value + 1` | `u9 does not fit value: u8; say wrap() or sat()` |
| `comb-read-before-write` | `$.y = $.x; $.x = $.a;` | `x is read before it is written` |
| `latch` | `if ($.a) $.x = 1;` in `.comb` | `x is not written on every path` |
| `unroll-bound` | `for (let i = 0; i < 5000; i++)` | `loop runs more than 4096 times` |
| `lib-value` | `.lib({ m: new Map() })` | `m has no hardware meaning ([object Map])` |

### 3.12 Exercises

1. Support `switch` on a signal. Lower it to a priority mux, then detect when the cases are constants that cannot overlap and emit a parallel mux instead.
2. Replace the regular-expression helper detector with a call-graph walk over the parsed helpers, and make it report helpers passed as values but never called.
3. Add dynamic shifts `a << b`. Give the typing rule (the result needs w\_a + 2^(w\_b) − 1 bits) and argue whether Weft should require a `wrap` on every dynamic shift.
4. Build expressions through a hash-consing table instead of fresh records and measure the node count for F-04's `breathe` before and after. This is the first step of Chapter 10.
5. Write an interpreter that runs a hardware lambda directly on concrete register values, treating `$` as an object with getters and setters. Compare it with evaluating the lowered next-state expressions on 10,000 random states. This differential test is a small form of the translation validation in Chapter 11.

### 3.13 Further study

- Taha and Sheard, "MetaML and Multi-Stage Programming with Explicit Annotations." Quotation makes later-stage code a value; Weft's hardware lambdas are quoted by position instead.
- Cornell CS 6120 *Advanced Compilers*, the lessons on SSA form and data-flow analysis. The join-as-mux in 3.5 is SSA's φ function, specialized to a single acyclic body.
- Cooper and Torczon, *Engineering a Compiler*, the chapters on intermediate representations and on static single-assignment form.
- The ESTree specification, which defines the syntax-tree node types that acorn produces and that every case in `lower.js` matches.

## Chapter 4 · Clocked semantics

Examples: F-01, F-02, F-05, and the greeter in F-06 · Prerequisite: Chapter 3

This chapter turns Chapter 3's output, a list of guarded assignments per lambda, into one next-state function per register and one expression per wire. It fixes what a read sees, what happens when two blocks write one register on the same cycle, and how reset, pulses, `.every()`, edge events and input pins lower. When it is done you have the core of the `lower` stage, and every later chapter builds on its output.

### 4.1 What this step consumes and produces

Chapter 3 translates each hardware lambda separately. For each one it produces an ordered list of assignments, each with a target, a *path guard* (the condition under which control reaches it), a value, and the source line. It does not know when the lambda as a whole runs, or what other lambdas write.

This chapter adds both. Every block gets a *block guard*, the condition under which it runs on a given cycle. Then the assignments of all blocks in a module are merged per target.

| Comes in (from Chapter 3) | Goes out (to Chapters 5 to 11) |
| --- | --- |
| Blocks per module, each with a kind and its lambda's guarded assignments in program order | One `reg` node per register, its `next` input an expression over current values and inputs |
| Locals already in SSA form, with muxes at control-flow joins | One expression per wire |
| Source lines on every assignment | Diagnostics: `mixed-kind`, `multi-writer`, `latch`, `comb-read-before-write`, `every-no-clock` |

### 4.2 Specification

- **R4.1 Block kinds.** `.seq`, `.every`, `.on`, fsm `.state` and pipeline `.stage` are clocked blocks. `.comb` is the only combinational block. Each block has a block guard: true for `.seq` and `.comb`, the prescaler tick for `.every`, the event for `.on` (a beat fired or an edge seen), `state == S` for a state, and the stage's advance condition for a stage.
- **R4.2 Kind of a signal.** A signal written in a clocked block is a register. A signal written in `.comb` is a wire. A signal written in both is the error `mixed-kind`. A port takes its kind from where it is written; a name declared in `.regs()` is a register and may not be written in `.comb`.
- **R4.3 Reads in clocked blocks.** `$.r` reads the register's current value, its Q output, even after an assignment to `r` earlier in the same lambda. All registers in a clock domain update together at the clock edge.
- **R4.4 Locals.** `const` and `let` names are wires. A read of a local sees the latest assignment to it on the current path.
- **R4.5 One lambda.** Within one lambda, the last assignment in program order whose path guard holds wins.
- **R4.6 Several blocks.** The clocked blocks of a module merge in declaration order. For each register, the last block in declaration order whose effective guard (block guard and path guard) holds on a cycle supplies the next value. If no write's guard holds, the register keeps its value; a `pulse` loads 0 instead.
- **R4.7 Overlap warning.** If two writes to one register come from different blocks and their effective guards can both hold on one cycle, the compiler reports the warning `multi-writer`. The report includes a satisfying assignment of the guards (a *witness*) and names the block that wins.
- **R4.8 Combinational completeness.** Every wire must be assigned on every path through its `.comb` block. The disjunction of its write guards must be a tautology; otherwise the compiler reports the error `latch` with a witness. Reading a wire inside its own `.comb` lambda before its first write is the error `comb-read-before-write`. Two `.comb` blocks that write one wire are the error `multi-driver`: a wire has no held value to fall back on.
- **R4.9 Reset.** Reset is synchronous and active-high. On a cycle where reset is asserted, every register loads its initial value, `.init(v)` or 0, whatever any block says. Memories are not reset (Chapter 7).
- **R4.10 `.every(p, fn)`.** The module's clock domain must have a known frequency, or the compiler reports `every-no-clock`. The period in cycles is N = round(f\_clk · p) for a duration and N = round(f\_clk / f) for a frequency, with N at least 1. The block guard is the tick of a counter of ⌈log2 N⌉ bits that counts from 0 to N − 1. The first tick falls on cycle N − 1 after reset.
- **R4.11 Edge events.** `.on("p.rise", fn)` has the guard p ∧ ¬prev(p), where prev is a register the compiler inserts. `.on("p.fall", fn)` has the guard ¬p ∧ prev(p).
- **R4.12 Input pins.** A port bound with `.bind()` to a board input passes through a two-flip-flop synchronizer that the link pass inserts. It adds two or three cycles of latency; in simulation the number is drawn per transfer from the seeded generator (R12.6). Knobs are the second place Weft synchronizes without being asked: a knob read in a domain other than the bus's is synchronized for it (R14.7). Every other crossing is a `.cross()` (Chapter 12).

R4.6 answers one of the gaps the examples expose: several handlers may write one register on the same cycle, and the language must say which wins. Weft chooses declaration order, so the winner is visible in the source. It also warns, because an overlap is usually unintended.

### 4.3 Data structures

The merge works on the records Chapter 3 emits. Guards are small Boolean trees whose leaves are *atoms*: an input bit, an event, or a comparison such as `i==6`. Values are IR expressions; in the listings below they are strings to keep the output readable.

```js
// block = { kind: "seq" | "every" | "on" | "state" | "stage" | "comb", name, order, guard, writes }
// write = { target, block, blockName, guard, value, line }   // guard already includes the block guard
// guard = { op: "atom", name } | { op: "and" | "or", args } | { op: "not", arg } | { op: "const", value }
// reg   = { name, init, pulse }   // becomes an IR node { op: "reg", args: [], type, attrs: { init, next } }
```

### 4.4 Merging blocks into next-state functions

The merge is a fold. Start from the value that holds when nobody writes, the register itself or 0 for a pulse. Then wrap it in one multiplexer per write, in declaration and program order. The last write ends up outermost, so its guard is tested first and it wins whenever it holds. Reset wraps the result last of all. The overlap check runs a satisfiability test on each pair of guards from different blocks. Writes inside one lambda are skipped: program order already decides between them, and Chapter 3 has made their path guards precise.

The listing is the core of a file run with Node 22. The SAT procedure is brute force over the atoms in one pair of guards, which is enough for the handful of atoms a register's writers mention. Chapter 9 replaces it with a real solver. One refinement matters even here: atoms of the form `x==c` on the same `x` exclude each other. Without that, two fsm states would look as if they could run on the same cycle.

```js
function atomsOf(g, out = new Set()) {
  if (g.op === "atom") out.add(g.name);
  else if (g.op === "not") atomsOf(g.arg, out);
  else if (g.args) g.args.forEach(a => atomsOf(a, out));
  return out;
}
function evalGuard(g, env) {
  switch (g.op) {
    case "const": return !!g.value;
    case "atom": return !!env[g.name];
    case "not": return !evalGuard(g.arg, env);
    case "and": return g.args.every(a => evalGuard(a, env));
    case "or": return g.args.some(a => evalGuard(a, env));
  }
}
function consistent(env) {                     // x==a and x==b cannot both hold
  const seen = new Map();
  for (const [name, v] of Object.entries(env)) {
    const m = name.match(/^(.+)==(.+)$/);
    if (!m || !v) continue;
    if (seen.has(m[1]) && seen.get(m[1]) !== m[2]) return false;
    seen.set(m[1], m[2]);
  }
  return true;
}
function sat(g) {                              // a satisfying assignment, or null
  const names = [...atomsOf(g)];
  for (let bits = 0; bits < 2 ** names.length; bits++) {
    const env = Object.fromEntries(names.map((n, i) => [n, (bits >> i) & 1]));
    if (consistent(env) && evalGuard(g, env)) return env;
  }
  return null;
}
function nextState(reg, writes) {              // writes in declaration order, then program order
  let next = reg.pulse ? "0" : reg.name;       // nobody writes: hold, or 0 for a pulse
  for (const w of writes) next = `mux(${show(w.guard)}, ${w.value}, ${next})`;
  return `mux(rst, ${reg.init ?? 0}, ${next})`;   // reset outranks every block
}
function multiWriter(reg, writes) {
  const out = [];
  for (let i = 0; i < writes.length; i++)
    for (let j = i + 1; j < writes.length; j++) {
      const a = writes[i], b = writes[j];
      if (a.block === b.block) continue;       // one lambda: program order decides
      const w = sat({ op: "and", args: [a.guard, b.guard] });
      if (w) out.push({ code: "multi-writer", severity: "warning", line: b.line,
        message: `${reg.name} is written by ${a.blockName} and ${b.blockName} on the same cycle when ` +
          Object.entries(w).filter(([, v]) => v).map(([k]) => k).join(" and ") +
          `; ${b.blockName} is declared later and wins` });
    }
  return out;
}
```

(`show` prints a guard as text; it is omitted.) Run on F-05's `lights`, whose two `.on()` handlers both write `leds`, and on F-06's greeter, whose `.every()` and `.seq()` both write `go`, the file prints:

```text
leds.next = mux(rst, 0, mux(invert.rise, ~leds, mux(presses.fire, mux(p.long, 0, leds ^ (1 << p.id)), leds)))
F-05-buttons.js:23  warning multi-writer
  leds is written by .on("presses") and .on("invert.rise") on the same cycle when presses.fire and invert.rise;
  .on("invert.rise") is declared later and wins
go.next = mux(rst, 0, mux((go && bytes.accepted && i==6), 0, mux(tick, 1, go)))
F-06-fsm.js:17  warning multi-writer
  go is written by .every("1s") and .seq() on the same cycle when tick and go and bytes.accepted and i==6;
  .seq() is declared later and wins
```

Both witnesses describe a real event. In F-05, a press and a switch edge on the same 100 MHz cycle lose the press. In F-06, a one-second tick that lands on the cycle the last character is accepted is cleared at once, and one greeting is skipped. Both are rare and both are probably acceptable, which is why R4.7 makes this a warning and not an error. The witness is what lets the designer decide.

Bluespec takes the other road. Its rules are atomic, and when two rules conflict the compiler schedules them so they never fire on the same cycle, warning about the urgency order it chose. That gives each rule atomicity at the cost of a scheduler whose choices live outside the source. Weft keeps every block firing when its guard holds, and the warning points at the line that loses.

### 4.5 Reads, locals and the latch check

R4.3 means a clocked lambda reads the state from before the edge, wherever its reads sit. F-19's serve state shows the consequence:

```js
    $.wait += 1;
    if ($.wait === 60) { $.wait = 0; return "play"; }   // a second of stillness
```

| Cycle (frames) | `wait` read | Compared with 60 | `wait` next |
| --- | --- | --- | --- |
| 59 | 59 | no | 60 |
| 60 | 60 | yes | 0 (the later assignment wins, R4.5) |

The comparison sees 60 one frame after the increment wrote it, so the state lasts 61 frames, not 60. That is the price of a uniform rule. The alternative, letting a read see an earlier write in the same lambda, would make the meaning of `$.wait` depend on its position, and the two blocks of Chapter 4.4 could no longer be merged independently.

The latch check of R4.8 reuses the same SAT procedure on the complement. A wire is complete if no assignment of the atoms leaves every write guard false.

```js
function latch(wire, writes) {
  const w = sat({ op: "not", arg: { op: "or", args: writes.map(x => x.guard) } });
  return w && { code: "latch", severity: "error",
    message: `${wire} keeps its old value when ${Object.entries(w).map(([k, v]) => (v ? k : "!" + k)).join(" and ")}` };
}
```

For `.comb($ => { if ($.en) $.y = 1; })` it returns `y keeps its old value when !en`. With an `else` branch assigning `y` it returns null.

### 4.6 Reset and pulses

Reset is the outermost multiplexer of every register (R4.9), so it is ordinary data to timing analysis. A pulse differs from a register only in its hold value. F-02's ticker writes `$.tick = 1` in its `.every()` block, and its next state is `mux(rst, 0, mux(every.tick, 1, 0))`. That is 1 on the cycle after each tick and 0 on every other cycle, with no second block to clear it.

### 4.7 Lowering `.every()`

`.every()` becomes a counter and an equality comparison, and the counter's tick becomes the block guard. The listing was run with Node 22.

```js
const UNITS = { s: 1, ms: 1e-3, us: 1e-6, ns: 1e-9 };
const HZ = { hz: 1, khz: 1e3, mhz: 1e6 };
function cyclesFor(spec, clockHz) {
  if (!clockHz) throw Object.assign(new Error(`.every("${spec}") needs the clock frequency of its domain`),
    { code: "every-no-clock" });
  const m = String(spec).trim().toLowerCase().match(/^([\d.]+)\s*(s|ms|us|ns|hz|khz|mhz)$/);
  if (!m) throw new Error(`cannot read the period "${spec}"`);
  const x = Number(m[1]);
  const exact = m[2] in UNITS ? clockHz * x * UNITS[m[2]] : clockHz / (x * HZ[m[2]]);
  const n = Math.max(1, Math.round(exact));
  return { n, error: n / exact - 1 };          // relative error of the period actually built
}
function lowerEvery(spec, clockHz) {
  const { n, error } = cyclesFor(spec, clockHz);
  const width = n === 1 ? 0 : Math.ceil(Math.log2(n));
  const hir = n === 1 ? ["tick = 1"]
    : [`reg count : u${width}`, `tick = eq count, ${n - 1}`, `count.next = mux tick, 0, add(count, 1) wrap u${width}`];
  return { n, width, error, hir };
}
```

| Call (example) | Clock | N | Counter width | Period error |
| --- | --- | --- | --- | --- |
| `.every("250ms")` (F-01) | 12 MHz | 3 000 000 | 22 | 0 |
| `.every("100ms")` (F-02) | 100 MHz | 10 000 000 | 24 | 0 |
| `.every("1s")` (F-06) | 12 MHz | 12 000 000 | 24 | 0 |
| `.every("48 kHz")` (F-08) | 100 MHz | 2 083 | 12 | −0.016 % |
| `.every("4ms")` (F-04) | 100 MHz | 400 000 | 19 | 0 |

The 48 kHz case cannot be exact, because 100 MHz / 48 kHz is 2083.3. The build runs at 100 MHz / 2083 = 48 007.7 Hz, and the build report lists the error so that an audio designer can decide whether it matters. For F-01 the lowering prints the HIR that Chapter 1 of the companion book wrote by hand: `reg count : u22`, `tick = eq count, 2999999`, `count.next = mux tick, 0, add(count, 1) wrap u22`.

### 4.8 Edge events and input synchronizers

F-05's `.on("invert.rise", …)` reads `invert`, which is bound to the switch `sw:0`. Two rules meet here. R4.12 puts two flip-flops, `s1` and `s2`, between the pin and the port. R4.11 adds `prev`, one more register, and the guard `s2 && !prev`. The trace is from the same Node file; the pin rises during cycle 2.

| Cycle | pin | s1 | s2 (`invert`) | prev | rise |
| --- | --- | --- | --- | --- | --- |
| 2 | 1 | 0 | 0 | 0 | 0 |
| 3 | 1 | 1 | 0 | 0 | 0 |
| 4 | 1 | 1 | 1 | 0 | 1 |
| 5 | 1 | 1 | 1 | 1 | 0 |

The handler runs on cycle 4 and `leds` changes at the edge that ends it. Two cycles go to the synchronizer in this trace; in simulation R12.6 makes it two or three per transfer, so a test must not depend on the exact cycle. The synchronizer's job is to give a possibly metastable first flip-flop a full cycle to settle before anything reads it (Chapter 12 has the arithmetic). Each bit of a multi-bit input such as `sw:0..7` is synchronized on its own. That is correct for eight independent switches and wrong for a binary value whose bits must change together. A coherent multi-bit value from another clock must cross through a stream marked `.cross()`.

### 4.9 Worked example: one cycle in F-05

Suppose `leds` holds `0000 0100`, and on one cycle a beat `{ id: 0, long: 0 }` fires on `presses` while `invert.rise` is 1. The merged next state from 4.4 evaluates from the outside in.

| Multiplexer | Guard | Value if taken | Taken? |
| --- | --- | --- | --- |
| reset | `rst` = 0 | 0 | no |
| `.on("invert.rise")` | 1 | `~leds` = `1111 1011` | yes |
| `.on("presses")` | 1 | `leds ^ 1` = `0000 0101` | not reached |

The register becomes `1111 1011`, and the press is lost. Swapping the two `.on()` calls in the source would keep the press and lose the inversion. The `multi-writer` warning at line 23 is the compiler's way of saying that one of these must happen and the source has chosen.

### 4.10 Tests

The acceptance tests are the examples' own scenarios: F-01 "blinks at 2 Hz", F-02 "counts up, then down" and "wraps below zero", and F-05 "toggle, invert, clear". The unit tests check each rule on its own.

- A signal written in `.seq()` and `.comb()` yields `mixed-kind` at the second write's line.
- The F-05 and F-06 merges yield exactly the warnings above, with those witnesses; an fsm's states never yield one.
- `.comb($ => { if ($.en) $.y = 1; })` yields `latch` with the witness `!en`; adding an `else` removes it.
- `lowerEvery` reproduces the table in 4.7, and `.every()` in a domain without a frequency yields `every-no-clock`.
- A clocked lambda that writes `r` and then reads it sees the old value, at both the HIR and the DAG level.

### 4.11 Exercises

1. Suppress `multi-writer` when both writes assign syntactically identical values, and argue from R4.6 that the suppression never hides a behavioral difference.
2. Implement `.on("p.change")` as an event and give its guard and its cost in registers.
3. Replace the brute-force `sat` with a DPLL procedure, then measure both on every register of F-19's game fsm.
4. Let `.every()` accept a lambda of params, as other builder arguments do, and report a warning when the period error exceeds a tolerance given in the design.
5. Specify what `.bind()` must do with a multi-bit input whose bits must change together, and decide whether the compiler can detect that case.

### 4.12 Further study

- Harris & Harris, Ch. 3 (Sequential Logic). Read it for clock enables, prescalers, register timing and synchronous reset, the material R4.9 and R4.10 rely on.
- MIT 6.004, Computation Structures, §5 Sequential Logic. Read it for the register-transfer model this chapter implements.
- MIT 6.175, Constructive Computer Architecture, lectures 5–7 on guarded interfaces, rules and scheduling conflicts. Read them for the Bluespec model that 4.4 contrasts with R4.6: atomic rules, conflict analysis and urgency, against merged blocks with a declared order.

## Chapter 5 · State machines

Examples: F-06, F-19 · Prerequisite: Chapter 4

This chapter specifies `fsm()` and builds its two passes. `fsm.extract` recovers the transition graph from the return statements of the state lambdas and checks it. `fsm.encode` chooses bit patterns for the states. With Chapter 4's merge in hand, an fsm is not a new kind of hardware. It is a module with one extra register, `state`, whose next value the state lambdas compute. What it adds is structure the compiler can analyze: the transition graph can be checked for unreachable states and bad targets, and the encoding can be chosen from the graph's shape.

### 5.1 Why states are lambdas that return

A state machine has a state register, a next-state function and outputs. Textbook HDL code writes the next-state function as one large `case` statement and the outputs in another. Weft writes one lambda per state, and the lambda's return value is the next state. The transitions of a state therefore sit next to the outputs that state drives, and a reader sees one state at a time.

The cost is that the transition graph is no longer written down in one place. A compiler that wants the graph, to find unreachable states, choose an encoding or draw a diagram, has to recover it. That is `fsm.extract`. Recovery is possible because Chapter 3 already attaches a path guard to every statement, including every `return`.

### 5.2 Specification

- **R5.1 The state register.** An `fsm` is a module with an implicit register `state`, whose type is an enumeration of the declared states. `.initial(s)` names the reset state. A name that is not declared is the error `fsm-target`.
- **R5.2 State blocks.** Each `.state(S, fn)` is a clocked block whose block guard is `state == S`, conjoined with the step condition of R5.5 when there is one. Everything in Chapter 4 applies: writes in a state are register writes, reads see current values, and several blocks merge in declaration order.
- **R5.3 Returns.** `return "T"` sets the next state to T on its path. `return;` with no value, or reaching the end of the lambda, leaves the state unchanged. A returned value must be a string literal naming a declared state; anything else is the error `fsm-target`.
- **R5.4 Other blocks.** `.seq`, `.on` and `.every` blocks of an fsm run on their own guards in every state. They may read `$.state` but may not write it; only state lambdas move the machine.
- **R5.5 Stepping.** `.step(s)` makes the state blocks run only on cycles where a beat of stream `s` fires. The fsm is always ready for `s`, so every beat is consumed, whether or not the current state reacts to it.
- **R5.6 Reachability.** A state that cannot be reached from the initial state through the transition graph is the warning `fsm-unreachable`.
- **R5.7 Encoding.** With `auto`, the default, the states are Gray-coded if their transitions, ignoring self-loops, form one ring through every state. Otherwise they are binary-coded when there are at most four states and one-hot above that. `.encode("binary" | "gray" | "onehot")` overrides the choice. An encoding never changes behavior, only area and timing.
- **R5.8 Outputs.** An output written in a state lambda is a register, as R4.2 says. Its new value appears on the cycle after the state that wrote it, so fsm outputs are registered Moore outputs by construction.
- **R5.9 Observation.** Scenarios and the host see `state` as the name of the current state, for example `s.state === "play"` in F-19.

### 5.3 Data structures

`fsm.extract` reads the returns that Chapter 3 found in each state lambda and produces edges. In the listings, guards are printed text; in the compiler they are the guard trees of Chapter 4.

```js
// fsm   = { initial, states: [{ name, returns: [{ guard, to, line }] }] }   // to === undefined for `return;`
// edge  = { from, to, guard, stay }    // stay: the implicit self-loop taken when no return fires
```

### 5.4 `fsm.extract`

Each `return "T"` inside state S becomes an edge from S to T, guarded by the return's path guard. Because a `return` ends its path, the path guards of different returns in one lambda are disjoint, and the order of the edges within a state does not matter. The implicit stay edge is guarded by the negation of all the leaving guards. Reachability is a breadth-first search from the initial state. The listing was run with Node 22.

```js
function extract(fsm) {
  const names = fsm.states.map(s => s.name);
  const diags = [], edges = [];
  if (!names.includes(fsm.initial)) diags.push({ code: "fsm-target", message: `initial state "${fsm.initial}" is not declared` });
  for (const s of fsm.states) {
    for (const r of s.returns) {
      if (r.to === undefined) continue;                  // `return;` stays: the default, not an edge
      if (!names.includes(r.to)) {
        diags.push({ code: "fsm-target", line: r.line, message: `state "${s.name}" returns "${r.to}", which is not a state` });
        continue;
      }
      edges.push({ from: s.name, to: r.to, guard: r.guard });
    }
    const leave = s.returns.filter(r => r.to !== undefined && r.to !== s.name).map(r => r.guard);
    edges.push({ from: s.name, to: s.name, guard: leave.length ? `!(${leave.join(" || ")})` : "1", stay: true });
  }
  const reach = new Set([fsm.initial]), work = [fsm.initial];   // breadth-first from the initial state
  while (work.length) {
    const s = work.shift();
    for (const e of edges) if (e.from === s && !reach.has(e.to)) { reach.add(e.to); work.push(e.to); }
  }
  for (const n of names) if (!reach.has(n)) diags.push({ code: "fsm-unreachable", message: `state "${n}" cannot be reached from "${fsm.initial}"` });
  return { names, edges, reach, diags };
}
```

On F-06's transmitter, F-19's game and a deliberately broken machine, the output is:

```text
uart-tx: idle->start [has(bytes)], start->data [baud], data->stop [baud && n==7], stop->idle [baud]
  stay data: !(baud && n==7)
game: serve->play [wait==60], play->point [out], point->over [s1==9 || s2==9],
      point->serve [wait==45], over->serve [held!=0]
broken: a->b [go], b->a [done], c->a [1]
  fsm-target: state "b" returns "fail", which is not a state
  fsm-unreachable: state "c" cannot be reached from "a"
```

The transmitter's `data` state has a `return;` on the path where `baud` is false. That return has no edge of its own; it is covered by the stay guard. In `point`, the two returns are both guarded and the game's source checks `s1 === 9 || s2 === 9` first, so on a cycle where both conditions hold, the earlier return wins. Chapter 3 encodes that by putting the negation of the first return's guard into the second return's path guard, which is what makes them disjoint.

### 5.5 The next-state function

With edges in hand, the next value of `state` is a multiplexer chain, one arm per edge, wrapped in reset. For the transmitter, in HIR:

```text
state.next = mux(rst, IDLE,
             mux(state==IDLE  && has(bytes),   START,
             mux(state==START && baud,         DATA,
             mux(state==DATA  && baud && n==7, STOP,
             mux(state==STOP  && baud,         IDLE,  state)))))
```

The other registers of the fsm are merged exactly as in Chapter 4, with `state == S` in their block guards. `line`, for instance, has four writers, one per state. Because R4.7's check treats `state==IDLE` and `state==DATA` as exclusive atoms, it reports no overlap between them.

### 5.6 `fsm.encode`

The enumeration has to become bits. Three encodings cover nearly all practice, and they trade flip-flops against logic depth.

| Encoding | Flip-flops for n states | Testing `state == S` | Next-state logic per bit |
| --- | --- | --- | --- |
| Binary | ⌈log2 n⌉ | Compares all state bits | Depends on every edge that changes that bit |
| Gray, on a ring | ⌈log2 n⌉ | Compares all state bits | Each transition flips one bit, so fewer bits switch |
| One-hot | n | Reads one bit | OR, over incoming edges, of the source bit and the guard |

One-hot spends flip-flops to make decoding a single wire and each next-state bit a shallow OR. FPGAs have a flip-flop beside every LUT, so this is usually the right trade for machines with more than a handful of states. For four states or fewer, binary needs two flip-flops, and its comparisons fit in one LUT anyway. A ring is the case Gray code was made for: consecutive codes differ in one bit, so each transition toggles one flip-flop.

R5.7's rule needs one more function, a test for the ring shape. Here are both, also run with Node 22:

```js
function isRing(names, edges) {           // names[0] is the initial state
  const succ = new Map(names.map(n => [n, new Set()]));
  for (const e of edges) if (e.from !== e.to) succ.get(e.from).add(e.to);
  if ([...succ.values()].some(s => s.size !== 1)) return null;
  const order = [names[0]];
  while (order.length < names.length) {
    const next = [...succ.get(order.at(-1))][0];
    if (order.includes(next)) return null;
    order.push(next);
  }
  return [...succ.get(order.at(-1))][0] === order[0] ? order : null;
}
function encode(fsm, ex, kind = "auto") {
  const ring = isRing([fsm.initial, ...ex.names.filter(n => n !== fsm.initial)], ex.edges);
  if (kind === "auto") kind = ring ? "gray" : ex.names.length <= 4 ? "binary" : "onehot";
  const n = ex.names.length, bits = kind === "onehot" ? n : Math.max(1, Math.ceil(Math.log2(n)));
  const order = kind === "gray" ? ring : [fsm.initial, ...ex.names.filter(x => x !== fsm.initial)];
  const code = new Map(order.map((s, i) => [s, kind === "onehot" ? 1 << i : kind === "gray" ? i ^ (i >> 1) : i]));
  return { kind, bits, code };
}
```

| Machine | `auto` chooses | Codes |
| --- | --- | --- |
| `uart-tx` | Gray: idle → start → data → stop → idle is a ring | idle 00, start 01, data 11, stop 10 |
| `game` | Binary: `point` has two successors, and there are four states | serve 00, play 01, point 10, over 11 |

The program also checks the Gray property on the transmitter: each of its four transitions flips exactly one bit. `.encode("onehot")` on the transmitter gives four flip-flops, `0001` to `1000`, as the F-06 try line invites you to compare.

An encoding is a bijection between state names and codes, so `fsm.encode` cannot change behavior. The pass manager still checks that, as it checks every pass. Chapter 11 runs a combinational equivalence check across the `state` register's encoding, and the scenarios run at the net level, after encoding, as well as at HIR and at the DAG level before it.

### 5.7 `.step()`

F-19's game reacts once per video frame, not once per clock. `.step("frame")` adds `frame.fire` to every state's block guard and ties the stream's ready to 1. A counter such as `wait` then counts frames: the serve state's `wait === 60` is one second at 60 frames per second. The scene push in the game's `.seq()` block is untouched by `.step()` and runs every clock, which is what R5.4 promises.

### 5.8 Worked example: one byte through `uart-tx`

The trace comes from a cycle model of F-06's transmitter, written in Node with Chapter 4's rules: every read sees the old value, and all registers update together. `DIV` is 103, the 12 MHz pico board's divider, so each bit lasts 104 cycles. The byte is `h`, 0x68, which goes out least significant bit first as 0, 0, 0, 1, 0, 1, 1, 0.

| Cycle | Event | Why |
| --- | --- | --- |
| 0 | `idle` sees `has(bytes)`, takes the byte, loads `wait = 103` | The return to `start` fires |
| 1 | `state` becomes `start` | The state register updates at the edge |
| 2 | `line` falls to 0: the start bit | `line` is a register written in `start`, one cycle behind the state (R5.8) |
| 105 | `state` becomes `data` | `baud()` returned 1 after 104 cycles in `start` |
| 106–417 | `line` stays 0 for bits 0, 1, 2 | Three bits of 104 cycles |
| 418 | `line` rises: bit 3 is 1 |  |
| 522, 626, 834 | `line` falls, rises, falls: bits 4, 5 and 7 | Bit 6 equals bit 5, so 730 shows no edge |
| 937 | `state` becomes `stop` | `n` was 7 when `baud()` fired |
| 938 | `line` rises: the stop bit |  |
| 1041 | `state` returns to `idle` |  |

Every bit lasts exactly 104 cycles, so the baud rate is 12 MHz / 104 = 115 385, 0.16 % above 115 200. A second byte waiting in the stream would start one cycle later, in `idle`. That cycle costs 0.1 % of throughput and keeps the stop bit at least 104 cycles long.

### 5.9 Tests

The acceptance test is F-06's scenario "says hello every second", which decodes the line in the simulator at 115 200 baud. The unit tests check the passes.

- `extract` on the broken machine reports exactly one `fsm-target` and one `fsm-unreachable`.
- `encode` reproduces the table in 5.6, and on every ring each transition flips one bit.
- Simulating the transmitter at HIR, and at the net level with each of the three encodings, produces the same `line` waveform cycle for cycle.
- A `.seq()` block that writes `$.state` is rejected under R5.4.

### 5.10 Exercises

1. Allow a `.comb()` block in an fsm to read `$.state`, producing Mealy outputs. Work out what changes in the transmitter's timing, and which paths get longer.
2. Implement state minimization by partition refinement: merge states with identical outputs whose successors are equivalent, and run it on a machine with a redundant state.
3. Add `.encode("johnson")` and characterize the machines it suits.
4. A one-hot register can be upset into an illegal pattern by a radiation event. Add an option that sends any illegal pattern back to the initial state, and count the LUTs it costs.
5. Extend R5.3 to accept `return c ? "a" : "b"`, and show the edges `extract` should produce.

### 5.11 Further study

- De Micheli, *Synthesis and Optimization of Digital Circuits*, Ch. 9 (Sequential Logic Optimization). Read it for state minimization and state encoding as optimization problems.
- Hachtel & Somenzi, *Logic Synthesis and Verification Algorithms*, the chapters on FSM synthesis. Read them for state assignment algorithms beyond the three fixed encodings used here.
- MIT 6.004, Computation Structures, §6 (Finite State Machines). Read it for the Moore and Mealy models that R5.8 and exercise 1 contrast.

## Chapter 6 · Streams

Examples: F-05, F-07, F-09, with F-08 and F-10 for handlers · Prerequisite: Chapters 4 and 5

This chapter specifies Weft's streams and builds everything that makes them work: the link pass that connects producers to consumers by name, the buffers and their overflow policies, the lowering of `$.push`, `$.has`, `$.take` and `.on(stream)`, a protocol monitor for simulation, and the pass that puts registers between pipeline stages. It closes with the observational contract that lets a stream path change its latency without changing its meaning. That contract is what Chapters 12 and 15 rely on when they retime a design or verify a change.

### 6.1 What a stream is for

A stream connects one producer to one or more consumers with three signals: `valid` from producer to consumer, `ready` from consumer to producer, and `data`. A beat moves on a cycle where both handshake signals are high. Neither side needs to know how fast the other is. A producer can offer a beat every cycle, and a consumer can take one every fourth cycle; the handshake makes the slower side set the rate.

That independence is what makes streams composable. A module written against a stream works whether its neighbour is a register, a FIFO or a 30-stage pipeline. It is also what lets the compiler add pipeline stages on a stream path: the consumer cannot tell that a beat arrived one cycle later, only which beats arrived and in what order.

### 6.2 Specification

- **R6.1 Interface.** A stream of type T consists of `valid`, `ready` and `data: T`.
- **R6.2 Fire.** A beat fires on a cycle where `valid` and `ready` are both 1.
- **R6.3 Independence.** A producer's `valid` must not depend combinationally on the same stream's `ready`. A consumer's `ready` may depend on `valid`.
- **R6.4 Persistence.** If `valid` is 1 and `ready` is 0 on a cycle, then on the next cycle `valid` is 1 and `data` is unchanged.
- **R6.5 Producers and consumers.** A stream has exactly one producer; a second is the error `multi-producer`. A stream that is needed but produced by nothing is the error `unmet-need`, unless the design declares it with `stream()`, in which case it is a top-level input of the design. A produced stream that nothing consumes is a top-level output if declared, and otherwise a sink whose `ready` is tied to 1.
- **R6.6 Several consumers.** If several modules need one stream, the link pass inserts an eager fork. Each consumer receives each beat exactly once, and the producer's beat fires on the cycle by which every consumer has taken it.
- **R6.7 Buffering.** Every stream has a buffer at its producer. `.buffer(n, { overflow })` sets its depth and policy; the default is depth 2 with policy `block`. The buffer's output satisfies R6.3 and R6.4 whatever the producer's code does.
- **R6.8 Push.** `$.push(s, v)` offers `v` to the buffer of `s` on the paths where it executes, and evaluates to 1 if the buffer accepts it on this cycle. Under `block`, the buffer accepts if its occupancy at the start of the cycle is below its depth. There is no pass-through: a slot freed by the consumer on the same cycle does not count, so the producer's acceptance never depends combinationally on the consumer's `ready`. The lossy policies always accept.
- **R6.9 Overflow.** The consumer's pop happens first on each cycle. Then, if an accepted beat finds the buffer full: `drop-oldest` discards the oldest held beat, `drop-newest` discards the incoming one, and `latest`, which requires depth 1, replaces the held beat. Each discard increments the stream's drop counter, a 16-bit saturating status register.
- **R6.10 Taking.** `$.has(s)` is the buffer's `valid` as the consumer sees it. `$.take(s)` raises `ready` on its path and evaluates to `data`. A module uses either `.on(s)` or `$.has`/`$.take` for a given stream, not both.
- **R6.11 Handlers.** `.on(s, fn)` is a clocked block whose block guard is the fire of `s`. Its `ready` is the conjunction, over the streams the handler can push to on any path, of whether that stream's buffer can accept. A handler that pushes nothing is always ready. Backpressure therefore propagates through a handler without any code.
- **R6.12 Implementation by depth.** `stream.lower` builds a depth-1 buffer as a register, a depth-2 buffer as a skid buffer, depths 3 to 63 as a FIFO in LUT RAM, and depth 64 and above as a FIFO in block RAM. iCE40 has no LUT RAM: there a FIFO of up to 16 entries is built from flip-flops and a deeper one goes to EBR.
- **R6.13 Pipelines.** A pipeline's stages are clocked blocks in sequence. The first receives the input beat, a value a stage writes is visible to the stages after it, and the last stage's return value is the output beat. `pipeline.registers` places a register for every value live across a stage boundary. `.stall("global")` stalls every stage with one signal; `.stall("skid")` puts a skid buffer at each boundary.
- **R6.14 Observational contract.** A module is observed through its ports, cycle by cycle, with one exception: a stream path of a `pipeline()` or of a module marked `.pipelined()` is observed as the sequence of beats that fire on it. Two implementations are equivalent when their cycle observables agree on every cycle, their beat sequences agree beat for beat, and each input beat produces its output beats within a stated bound of cycles.

R6.14 resolves the gap the examples expose between latency-insensitive equivalence and cycle-by-cycle equality. A compiler that may add a stage to a stream path needs to say what it promises to keep, and R6.14 says it: the beats and their order, not the cycles they arrive on.

### 6.3 Data structures

```js
// stream = { name, type, producer, consumers: [], depth: 2, overflow: "block", cross: null, declared: false }
// After stream.lower, a stream is IR: a buffer instance plus, per consumer, the nodes
//   valid : bit, ready : bit, data : T, fire = and(valid, ready)
```

### 6.4 The link pass

Linking is matching. The pass collects, for each stream name, the modules that provide it and the modules that need it, then checks R6.5 and marks forks for R6.6. The listing was run with Node 22.

```js
function link(modules, declared) {
  const producers = new Map(), consumers = new Map(), diags = [], edges = [];
  for (const m of modules) {
    for (const s of m.provides) {
      if (producers.has(s)) diags.push({ code: "multi-producer", message: `${s} is provided by ${producers.get(s)} and ${m.name}` });
      else producers.set(s, m.name);
    }
    for (const s of m.needs) { if (!consumers.has(s)) consumers.set(s, []); consumers.get(s).push(m.name); }
  }
  for (const [s, cs] of consumers) {
    const from = producers.get(s) ?? (declared.includes(s) ? "<design input>" : null);
    if (!from) { diags.push({ code: "unmet-need", message: `${cs.join(", ")} need${cs.length > 1 ? "" : "s"} ${s}, and nothing provides it` }); continue; }
    edges.push({ stream: s, from, to: cs, fork: cs.length > 1 });
  }
  for (const [s, p] of producers) if (!consumers.has(s))
    edges.push({ stream: s, from: p, to: [declared.includes(s) ? "<design output>" : "<sink, ready = 1>"], fork: false });
  return { edges, diags };
}
```

```text
F-07    q.block: fast-block -> slow-block          (and the same for q.oldest, q.newest, q.latest)
F-09    rgb: <design input> -> luma
        gray: luma -> <design output>
broken  x: a -> c, d  (fork)
        multi-producer: x is provided by a and b
        unmet-need: b needs y, and nothing provides it
```

F-09 shows why R6.5 treats declared streams specially. `rgb` and `gray` have no producer or consumer inside the design. The scenario pushes into one and pulls from the other, so they must become the design's ports, not errors.

### 6.5 Buffers and their policies

The reference model implements R6.7 to R6.9 one cycle at a time. It is the oracle that the generated hardware is tested against, in simulation and in Chapter 9's proofs. Note the order inside `step`: the fire is decided from the state at the start of the cycle, the consumer pops, and only then is the push handled.

```js
class Buffer {
  constructor(depth, overflow) { Object.assign(this, { depth, overflow, q: [], dropped: 0 }); }
  get valid() { return this.q.length > 0; }
  get data() { return this.q[0]; }
  get canAccept() { return this.overflow !== "block" || this.q.length < this.depth; }   // start-of-cycle state
  step(push, outReady) {                         // push: { value } or null
    const fired = this.valid && outReady, out = fired ? this.q[0] : undefined;
    const accepted = !!push && this.canAccept;
    if (fired) this.q.shift();
    if (accepted) {
      if (this.q.length === this.depth) {
        this.dropped = Math.min(this.dropped + 1, 0xffff);                     // 16-bit, saturating
        if (this.overflow === "drop-newest") return { accepted, fired, out };  // the newcomer is discarded
        this.q.shift();                                                        // drop-oldest and latest discard the head
      }
      this.q.push(push.value);
    }
    return { accepted, fired, out };
  }
}
```

Driven the way F-07 drives its four streams, with producers pushing every cycle and advancing only when accepted, and consumers taking on one cycle in four, the model gives these counts after 4000 cycles:

| Stream | Accepted | Taken | Held at the end | Dropped | Gaps seen by the consumer |
| --- | --- | --- | --- | --- | --- |
| `q.block` (16, block) | 1015 | 999 | 16 | 0 | 0 |
| `q.oldest` (16, drop-oldest) | 4000 | 999 | 16 | 2985 | 994 |
| `q.newest` (16, drop-newest) | 4000 | 999 | 16 | 2985 | 978 |
| `q.latest` (1, latest) | 4000 | 999 | 1 | 3000 | 999 |

Every row satisfies the conservation law accepted = taken + held + dropped, and the test suite checks it on every buffer. The consumers take 999 beats, not 1000, because a beat pushed on cycle 0 is first visible on cycle 1, and the first cycle on which a consumer is ready with something to take is cycle 4. Only `block` is lossless. It pays with a producer that advanced 1015 times instead of 4000.

### 6.6 The skid buffer

A depth-2 buffer is the default because it is the smallest buffer whose input `ready` can be a register. With one slot, `ready` must look at whether the consumer takes the beat this cycle, which is a combinational path from the consumer's `ready` to the producer's. With two slots, `ready` can be "the second slot is empty", known at the start of the cycle. The beat that arrives while the first slot is stuck parks in the second.

```js
class Skid {
  constructor() { Object.assign(this, { mainValid: 0, main: 0, skidValid: 0, skid: 0 }); }
  get inReady() { return !this.skidValid; }       // registered: no path from outReady to inReady
  get outValid() { return this.mainValid; }
  step(inValid, inData, outReady) {
    const inFire = inValid && this.inReady, outFire = this.mainValid && outReady;
    if (outFire || !this.mainValid) {              // the main slot is free after this edge
      if (this.skidValid) { this.main = this.skid; this.mainValid = 1; this.skidValid = 0; }
      else if (inFire) { this.main = inData; this.mainValid = 1; }
      else this.mainValid = 0;
    } else if (inFire) { this.skid = inData; this.skidValid = 1; }   // main is stuck: park the beat
    return { inFire, outFire };
  }
}
```

This model is written the way the hardware is: two data registers, two valid bits, and one multiplexer per register. Run side by side with `new Buffer(2, "block")` for 200 000 cycles of seeded random `valid` and `ready`, it disagreed on `inReady`, `outValid` or the output data on 0 cycles. That test is the bridge between the policy model and the RTL that `stream.lower` emits.

### 6.7 Lowering push, has, take and handlers

`$.push(s, v)` lowers to two signals into the buffer of `s`: `offer`, the path guard of the push, and `offerData`, the value. The expression's own value is `offer ∧ canAccept`. If one path holds two pushes to the same stream, the later one wins, as for any assignment (R4.5).

`$.has(s)` lowers to the buffer's `valid`, and `$.take(s)` to raising `ready` under its path guard and reading `data`. F-07's consumers use this pair to take only when `busy === 0`.

A handler's `ready` comes from R6.11, and the examples show its three cases.

| Handler | Streams it pushes to | Its input's `ready` |
| --- | --- | --- |
| F-05 `lights.on("presses")` | none | 1 |
| F-08 `echo.on("dry")` | `wet` (depth 2, block) | `wet.canAccept` |
| F-10 `raster.on("beam")` | `pixels` (depth 2, block) | `pixels.canAccept` |

When the HDMI encoder in F-10 stops taking pixels, `pixels` fills, `raster` stops taking beam beats, and the stall reaches the timing generator through two handshakes. No line of the example mentions it.

### 6.8 A protocol monitor

R6.3 and R6.4 are promises a buffer keeps by construction, but a hand-written interface, an external IP block or a bug in `stream.lower` can break them. The simulator therefore attaches a monitor to every stream. R6.4 checks against two consecutive cycles:

```js
function monitor(trace) {                          // trace: [{ valid, ready, data }] per cycle
  const errors = [];
  for (let t = 1; t < trace.length; t++) {
    const p = trace[t - 1], c = trace[t];
    if (p.valid && !p.ready && (!c.valid || c.data !== p.data))
      errors.push(`cycle ${t}: beat ${p.data} offered on cycle ${t - 1} was withdrawn or changed`);
  }
  return errors;
}
```

On 1000 cycles of a buffer's output under random load it finds 0 errors. On a producer that offers each beat for one cycle and then withdraws it, it finds 167, the first at cycle 1. R6.3 cannot be seen in a trace, since it is a property of the circuit's structure. The `lower` stage checks it instead, by searching the DAG for a combinational path from a stream's `ready` to the same stream's `valid`.

### 6.9 Pipelines and their registers

In F-09 the stage `weigh` writes `$.r`, `$.g` and `$.b`; `sum` reads them and writes `$.y`; `round` reads `$.y`. Registers are needed only for values that are live across a boundary, values written at or before it and read after it. That is backward liveness analysis, the same computation a register allocator does, over a straight sequence of stages.

```js
function pipelineRegisters(stages) {
  let live = new Set();                            // after the last stage its return value is the output beat
  const cut = new Array(stages.length - 1);
  for (let k = stages.length - 1; k >= 0; k--) {
    if (k < stages.length - 1) cut[k] = [...live]; // registers between stage k and stage k + 1
    live = new Set([...stages[k].uses, ...[...live].filter(v => !stages[k].defs.includes(v))]);
  }
  return { cut, liveIn: [...live] };
}
```

| Boundary | Live values | Register bits |
| --- | --- | --- |
| `weigh` → `sum` | `r` (15), `g` (16), `b` (13) | 44, plus a valid bit |
| `sum` → `round` | `y` (18) | 18, plus a valid bit |

The widths follow Chapter 1's rules: 8 bits times the 7-bit constant 77 is 15 bits, times 150 (8 bits) is 16, times 29 (5 bits) is 13, and two additions grow the widest of them by two. The input `px` is live only into `weigh`, so it crosses no register.

Stalling is the second decision. Under `.stall("global")` every stage register is enabled by one signal, the output's `!(valid && !ready)`. That is a combinational path from the sink's `ready` to every enable and back to the pipeline's input `ready`, and in a deep pipeline it becomes the critical path. Under `.stall("skid")`, which F-09 chooses, each boundary is a skid buffer, so every `ready` is a register. The price is a second copy of each boundary's registers: 62 more bits for `luma`.

### 6.10 Equivalence up to latency

R6.14 lets a pass add a stage to a stream path, and Chapter 12's `pipeline.cut` does exactly that. A small experiment shows what the contract keeps. The function below runs a globally stalled pipeline; the experiment compares `luma` with three stages against a copy with a fourth, pass-through stage.

```js
function runGlobal(fs, inputs, readyAt) {          // fs: one function per stage, a register after each
  const regs = fs.map(() => null), out = []; let i = 0, t = 0;
  while (out.length < inputs.length) {
    const last = regs.length - 1, outReady = readyAt(t), stall = regs[last] !== null && !outReady;
    if (regs[last] !== null && outReady) out.push({ v: regs[last], t });
    if (!stall) {
      for (let k = last; k > 0; k--) regs[k] = regs[k - 1] === null ? null : fs[k](regs[k - 1]);
      regs[0] = i < inputs.length ? fs[0](inputs[i++]) : null;
    }
    t++;
  }
  return out;
}
```

| Sink ready | Same beats | Same cycles | First output cycles, 3 stages vs 4 |
| --- | --- | --- | --- |
| Every cycle | yes | no | 3, 4, 5, 6 vs 4, 5, 6, 7 |
| 30 % of cycles, seeded | yes | yes | 5, 10, 16, 19 for both |

With a sink that is always ready, every beat arrives one cycle later, and a cycle-by-cycle comparison reports a difference on every output cycle. The beat sequences are identical, so R6.14 calls the two equivalent. With a slow sink the extra stage is hidden entirely, which is why a cycle-exact comparison can pass on one test and fail on another. In the same runs the 500 beats of both versions also matched the JavaScript model of F-09's scenario. That model is the third party R6.14 compares against.

### 6.11 Tests

The acceptance tests are F-07's "only block is lossless", F-09's "matches the JS model" and "survives backpressure", and F-05's "toggle, invert, clear". The unit tests cover each rule.

- `link` reproduces 6.4's output, including `multi-producer` and `unmet-need` with their messages.
- Every buffer configuration satisfies accepted = taken + held + dropped on random load, and F-07's table is reproduced exactly.
- The generated RTL of each buffer kind matches `Buffer` cycle for cycle, as the skid buffer does in 6.6.
- The monitor runs on every stream of every acceptance scenario and reports nothing.
- `pipelineRegisters` reproduces 6.9's table, and `luma` with either stall mode produces the model's beats.

### 6.12 Exercises

1. Specify and implement `merge(a, b)`, a round-robin arbiter that lets two producers share a stream, and say what R6.5 should then allow.
2. Build a lazy fork, which waits until every consumer is ready before any takes. Find a two-consumer design that deadlocks with it and runs with the eager fork of R6.6.
3. Remove the default depth-2 buffer when the producer is provably persistent, as F-07's producers are. State the proof obligation, and discharge it with Chapter 9's tools.
4. Prove with Chapter 9's k-induction that `Skid` and `Buffer(2, "block")` are equivalent for all input sequences, not only the 200 000 cycles of 6.6.
5. Add credit-based flow control for a stream whose ready must cross a long wire, and relate the credit count to the round-trip latency.

### 6.13 Further study

- MIT 6.175, Constructive Computer Architecture, guarded interfaces and FIFOs. Read it for a language in which a method's readiness is part of its interface, the model behind R6.11.
- LaForest, *Ready/Valid Handshakes* and *Skid Buffers*. Read them for working buffers, arbiters and pipeline components built directly from the protocol in R6.1 to R6.4.
- Carloni, McMillan and Sangiovanni-Vincentelli, "Theory of Latency-Insensitive Design". Read it for the theory under R6.14.
- Harris & Harris, Ch. 7, and MIT 6.004 (Pipelining). Read them for pipeline registers, hazards and stalls in a processor, where `pipeline.registers` and stall modes come from.

## Chapter 7 · Memories

Examples: F-08, with ROMs from F-03, F-06 and F-19 · Prerequisites: Chapters 4 and 6

This chapter specifies Weft's memory model and builds `mem.infer`, the pass that decides where each memory lives on the part. A memory is not just a large register file. Its reads are synchronous, its ports are few, and what it returns when a read and a write meet on one word must be defined. The model below fixes those three things in the language, so the implementation can choose freely among flip-flops, LUT RAM, block RAM and SPRAM without changing behavior.

### 7.1 Why memories are their own construct

F-08's delay line holds 8192 words of 12 bits, 98 304 bits. Built from flip-flops it would need 98 304 of them, more than twice the 41 600 flip-flops of the dev board's xc7a35t, plus a 8192-way multiplexer for the read. Built from block RAM it needs three RAMB36E1 primitives. The difference is large enough that a hardware language must let the compiler use RAM primitives, and RAM primitives impose their own rules.

The main rule is that a block RAM read is synchronous. The address is captured at a clock edge, and the data appears after that edge, to be used on the next cycle. A language that lets a designer write `const d = mem[a]` and use `d` at once either cannot use block RAM for that memory, or must silently add a cycle. Verilog flows infer block RAM by recognizing the pattern `always @(posedge clk) q <= mem[a];`, and a slightly different pattern quietly becomes logic. Weft makes the cycle part of the syntax instead.

### 7.2 Specification

- **R7.1 Declaration.** `.ram(name, { of: T, words: W, rdw })` declares a memory owned by the module: W words of type T, one read port and one write port. `rdw` defaults to `"read-first"`.
- **R7.2 Read.** `$.m.read(a)` is a statement. On a cycle where its path guard holds, the address is captured at the edge that ends the cycle. The statement has no value; using it as an expression is the error `mem-read-value`. The address must fit in u(⌈log2 W⌉) without narrowing (Chapter 1).
- **R7.3 Output.** `$.m.q` holds the word at the address captured by the most recent read. It changes only at an edge that ends a cycle with a read, and it holds through cycles without one. Reading `q` on the cycle of a read gives the previous read's word.
- **R7.4 Write.** `$.m.write(a, v)` writes `v` to word `a` at the edge that ends the cycle, on paths where it executes.
- **R7.5 Ports.** At most one read and one write may hold on any cycle. Two reads, or two writes, whose path guards can hold together are the error `mem-ports`, reported with a witness from Chapter 4's satisfiability check.
- **R7.6 Read during write.** When a read and a write address the same word on the same cycle, `q` receives the old word under `"read-first"` and the new word under `"write-first"`. Under `"undefined"`, the simulator returns a seeded random word and warns, and `mem.infer` may use whatever the primitive does.
- **R7.7 Contents.** Memories start at zero and are never reset. A reset of their module leaves their contents unchanged.
- **R7.8 ROMs.** An array of numbers shipped by `.lib()`, or `rom(name).of(T).from(n, fn)`, is a ROM. An array gets the narrowest type that holds all its values; a `rom()` keeps its declared type, and every value must fit. A read `X[i]` is combinational: its value is available on the same cycle. If the index type is wider than ⌈log2 n⌉ bits, the read is the error `rom-index`; otherwise the table is padded with zeros to 2^⌈log2 n⌉ entries.
- **R7.9 Implementation.** `mem.infer` chooses flip-flops, LUT logic, LUT RAM, block RAM or SPRAM by the rules of 7.6. The choice never changes behavior.

R7.3 and R7.6 close two gaps the examples expose. Register reads and memory reads now have exactly one meaning each, including the case where a callback writes a word and reads it in the same cycle. R7.8's padding rule is what makes F-06's `MSG[$.i]` legal: a 3-bit index into a 7-entry table reads entry 7 as 0. F-18's `GAMMA[sat(mix, u(8))]` needs its `sat` because `mix` is s11: 255 − l.alpha is signed (s9), so the second product, the sum and the rounding add are signed as well (s17, s18, s19), and the shift by 8 leaves s11. The sat clamps both the sign and the width before the 256-entry lookup.

### 7.3 Data structures

```js
// memory = { name, type, words, rdw: "read-first", init: null, owner }
// IR (Chapter 10's node set):
//   mem   { attrs: { words, rdw, init } }                 one per memory; not hash-consed, never merged
//   memrd { args: [mem, addr, en] }  -> q                  the address is registered inside the port
//   memwr { args: [mem, addr, data, en] }
//   rom   { args: [index], attrs: { table, type } }       combinational until mem.infer moves a register into it
```

### 7.4 A reference model

The model applies one cycle's operations together at the edge, which is all R7.2 to R7.6 require. It was run with Node 22.

```js
class Ram {
  constructor(words, rdw = "read-first") { Object.assign(this, { mem: new Array(words).fill(0), q: 0, rdw }); }
  edge({ read, write } = {}) {                     // the operations this cycle asked for
    if (read !== undefined) {
      const collide = write !== undefined && write.addr === read;
      this.q = collide && this.rdw === "write-first" ? write.value : this.mem[read];   // read-first: the old word
    }
    if (write !== undefined) this.mem[write.addr] = write.value;
  }
}
```

The test writes 7 to word 3, then reads word 3 on the cycle it writes 9 there, then idles for a cycle.

| Mode | `q` after the colliding cycle | `q` one cycle later, no read | Word 3 afterwards |
| --- | --- | --- | --- |
| `read-first` | 7 | 7 | 9 |
| `write-first` | 9 | 9 | 9 |

The middle column is R7.3: without a read, `q` holds. In hardware, holding is the read port's enable: the compiler drives it with the read's path guard. Block RAMs hold their output latch when the port is disabled.

### 7.5 How the grammar enforces the cycle

F-08 reads and uses the delay line like this:

```js
  .on("dry", ($, x) => {
    const back = $.delay.q;                         // what the last read() returned: reads take a cycle
    const y = sat(x + (back >> 1), s(12));          // 13 bits back into 12 by saturating, never by accident
    $.delay.write($.at, y);
    $.delay.read(wrap($.at + 1));                   // the oldest sample, ready by the next beat
    $.at += 1;
    $.push("wet", y);
  });
```

There is no expression that issues a read and yields its data. `read()` returns nothing, and `q` is a separate name, so the only way to use read data is on a later cycle. Here the later cycle is the next beat, 2083 clock cycles away. That gap is not a problem: R7.3 holds `q` through every cycle without a read. The handler reads `q` before it issues the next read, but R4.3 would give the same result in any order, because `q` is a register-like value read at its current state.

### 7.6 `mem.infer`

The pass looks at each memory and ROM after `lower` and chooses an implementation. Its inputs are the memory's size, its kind, whether each ROM read's result is registered before it is used, whether a RAM's read and write can ever hold on the same cycle (another satisfiability question), the family's primitives and the module's `.budget()`. The rules, in order, as the listing implements them:

1. A ROM becomes LUT logic if its read is not registered before use, if it has 64 words or fewer, or if the budget forbids block RAM.
2. A RAM under a budget of `brams(0)` becomes LUT RAM where the family has it, and flip-flops otherwise.
3. A RAM of fewer than 64 words becomes LUT RAM on a family that has it. On iCE40, which has none, one of up to 16 words becomes flip-flops and a larger one goes to EBR.
4. A RAM of at least 32 Kbit that is provably single-port becomes SPRAM on a family that has it.
5. Everything else becomes block RAM, in the configuration that needs the fewest block equivalents.

```js
const R18 = "RAMB18E1", R36 = "RAMB36E1";
const PRIMS = {                                  // [depth, width, cost in the smallest block, primitive]
  xc7: { lutram: true, spram: false, bram: [
    [16384, 1, 1, R18], [8192, 2, 1, R18], [4096, 4, 1, R18], [2048, 9, 1, R18], [1024, 18, 1, R18], [512, 36, 1, R18],
    [32768, 1, 2, R36], [16384, 2, 2, R36], [8192, 4, 2, R36], [4096, 9, 2, R36], [2048, 18, 2, R36], [1024, 36, 2, R36],
    [512, 72, 2, R36]] },
  ice40: { lutram: false, spram: true, bram: [[256, 16, 1, "EBR"], [512, 8, 1, "EBR"], [1024, 4, 1, "EBR"], [2048, 2, 1, "EBR"]] },
  ecp5: { lutram: true, spram: false, bram: [[16384, 1, 1, "DP16KD"], [8192, 2, 1, "DP16KD"], [4096, 4, 1, "DP16KD"],
    [2048, 9, 1, "DP16KD"], [1024, 18, 1, "DP16KD"], [512, 36, 1, "DP16KD"]] },
};
function pack(words, width, configs) {           // fewest block equivalents; on a tie, fewest primitives
  let best = null;
  for (const [d, w, cost, name] of configs) {
    const n = Math.ceil(words / d) * Math.ceil(width / w), c = n * cost;
    if (!best || c < best.c || (c === best.c && n < best.n)) best = { n, c, name, config: `${d}x${w}` };
  }
  return `${best.n} x ${best.name} as ${best.config}`;
}
function inferMemory(m, fam, budget = {}) {      // m: { kind, words, width, readRegistered, singlePort }
  const f = PRIMS[fam];
  if (m.kind === "rom" && (!m.readRegistered || m.words <= 64 || budget.brams === 0)) return "LUT logic";
  if (budget.brams === 0) return f.lutram ? "LUT RAM" : "flip-flops";
  if (m.words < 64 && f.lutram) return "LUT RAM";
  if (m.words <= 16) return "flip-flops";
  if (f.spram && m.singlePort && m.words * m.width >= 32 * 1024) return "1 x SPRAM (16384x16)";
  return pack(m.words, m.width, f.bram);
}
```

The configuration tables are the primitives' documented aspect ratios: 7-series RAMB18E1 and RAMB36E1 (widths 9, 18, 36 and 72 include the parity bits, which are usable as data), the iCE40 4 Kbit EBR, and the ECP5 DP16KD. Run on the examples' memories:

| Memory | xc7 (dev, big) | iCE40 (pico) | ECP5 |
| --- | --- | --- | --- |
| `SINE`, 1024 × 12, read pushed into a buffer (F-08) | 1 RAMB18E1 as 1024×18 | 3 EBR as 1024×4 | 1 DP16KD as 1024×18 |
| `GAMMA`, 256 × 8, budget `brams(0)` (F-03) | LUT logic | LUT logic | LUT logic |
| `MSG`, 7 × 7 (F-06) | LUT logic | LUT logic | LUT logic |
| `delay`, 8192 × 12 (F-08) | 3 RAMB36E1 as 8192×4 | 24 EBR as 1024×4 | 6 DP16KD as 8192×2 |
| `delay`, if it were single-port | 3 RAMB36E1 | 1 SPRAM | 6 DP16KD |
| A 32-word scratch RAM | LUT RAM | 1 EBR as 256×16 | LUT RAM |

The iCE40 row is the instructive one. The UP5K has 30 EBRs, and the echo's delay line takes 24 of them. Its four 256 Kbit SPRAMs would hold it in one, but an SPRAM has a single port, and the echo reads and writes on the same cycle. Exercise 4 restructures the handler so that rule 4 applies.

Rule 1 needs one more step to put `SINE` in block RAM. In F-08 the ROM's output is pushed into the `dry` buffer, so a register follows the ROM. A ROM is a pure function of its index, so that register can move from the ROM's output to its input, the same move as retiming (Chapter 12). After the move, the address register and the ROM together are a synchronous block RAM read. The data still appears after the same edge, so the move is invisible to every observer.

When a family's primitive cannot provide the requested `rdw` mode, `mem.infer` keeps the mode in logic. It adds a comparator on the two addresses and a register that holds the written word, and multiplexes that word onto `q` on a collision. On 7-series parts the mapping is direct: `read-first` and `write-first` correspond to the block RAM's `READ_FIRST` and `WRITE_FIRST` write modes. `NO_CHANGE`, the third mode, holds the output during a write, and Weft has no use for it, because R7.3 already holds `q` whenever there is no read.

### 7.7 ROMs and their types

R7.8 gives an array the narrowest type that holds all of its values. The function is short:

```js
function romType(values) {
  const lo = Math.min(...values), hi = Math.max(...values);
  if (lo >= 0) return `u(${Math.max(1, Math.ceil(Math.log2(hi + 1)))})`;
  const bits = v => (v >= 0 ? Math.ceil(Math.log2(v + 1)) + 1 : Math.ceil(Math.log2(-v)) + 1);
  return `s(${Math.max(bits(lo), bits(hi))})`;
}
```

| Table | Words | Range | Type |
| --- | --- | --- | --- |
| `SINE` (F-08) | 1024 | −2047 to 2047 | s(12) |
| `GAMMA` (F-03) | 256 | 0 to 255 | u(8) |
| `MSG` (F-06) | 7 | 10 to 111 | u(7) |
| `glyphs` (F-19) | 10 | 11 415 to 31 727 | u(15) |

`SINE` and `glyphs` are declared with `rom()` and these types, which the check confirms. `MSG` and `GAMMA` take their types from the table. A `rom()` whose builder lambda produces a value outside its declared type fails at elaboration, with the index of the first value that does not fit.

### 7.8 Worked example: the echo

The trace runs F-08's handler with a 4-word delay line, the `Ram` model of 7.4, and an impulse of 100 as input. It was produced with Node 22.

| Beat | x | `at` | `back` (`q`) | y | Write | Read issued |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 100 | 0 | 0 | 100 | \[0\] = 100 | \[1\] |
| 1 | 0 | 1 | 0 | 0 | \[1\] = 0 | \[2\] |
| 3 | 0 | 3 | 0 | 0 | \[3\] = 0 | \[0\] |
| 4 | 0 | 0 | 100 | 50 | \[0\] = 50 | \[1\] |
| 8 | 0 | 0 | 50 | 25 | \[0\] = 25 | \[1\] |

On beat 3 the handler issues a read of word 0, which still holds the 100 written on beat 0. On beat 4 that word is in `q`, and the echo returns at half amplitude. The read on beat k − 1 always addresses the word the beat-k write will replace, so `back` on beat k is y from beat k − W. With W = 8192 and the 48 007.7 Hz sample rate of Chapter 4.7, the echo returns after 170.6 ms.

The read address `at + 1` and the write address `at` are never equal, so R7.6 never applies to the echo, and its `rdw` mode does not matter. A pass can prove that: the two addresses differ by a constant 1 modulo 8192, so their equality is unsatisfiable. With that proof, `mem.infer` is free to choose whichever mode the primitive supports most cheaply.

### 7.9 Tests

The acceptance tests are F-08's scenario "stays in range" and its build check "the delay line is block RAM". The unit tests cover the model and the pass.

- The `Ram` model reproduces 7.4's table in both modes, and `q` holds across cycles without a read.
- `const d = $.m.read(a)` is rejected with `mem-read-value`; two reads under guards that can hold together are rejected with `mem-ports` and a witness.
- `romType` reproduces 7.7's table; a 9-bit index into a 256-entry table is `rom-index`; a 3-bit index into 7 entries reads entry 7 as 0.
- `inferMemory` reproduces 7.6's table for all three families.
- The echo at HIR, with a behavioral memory, and at the netlist level, with the inferred primitives, produces the same output samples for an impulse.

### 7.10 Exercises

1. Add a true dual-port `.ram()` with two read/write ports, specify its read-during-write behavior across ports, and map it to the 7-series true dual-port mode.
2. Add byte enables to `$.m.write`, and show which configurations of 7.6's tables support them.
3. Store a quarter of `SINE` and rebuild the full wave from symmetry. Write the reconstruction as a rewrite that Chapter 11 could apply automatically.
4. Restructure F-08's echo so that its read and its write fall on different cycles (beats are 2083 cycles apart), prove the memory single-port, and confirm that rule 4 moves it into one SPRAM on the pico board.
5. Implement `rdw: "undefined"` and let `mem.infer` choose the mode per family. Measure what the bypass logic of 7.6 costs when it cannot.

### 7.11 Further study

- Harris & Harris, Chs. 5 and 8 (Digital Building Blocks; Memory Systems). Read them for memory arrays, ports and the synchronous read that R7.2 and R7.3 encode.
- Yosys, *Memory Handling*. Read it for how an open-source synthesis tool infers memories, the memory-port types it distinguishes, and how it maps synchronous reads onto primitives, the job `mem.infer` does here.

## Chapter 8 · Simulation

Examples: F-01, F-02, F-07, F-10, F-11, F-16 · Prerequisite: Chapters 4–7

This chapter builds the simulator: the program that runs a Weft design cycle by cycle, deterministically, and checks it against its scenarios. Every later chapter leans on it. A pass is tested by simulating the design before and after it, a rewrite rule by comparing traces, a live change by replaying recorded traffic. By the end you will have a compiler from a per-domain DAG to a JavaScript step function, an edge scheduler for several clocks, a stream-protocol monitor, a seeded random source and a trace comparator. Every listing in this chapter was run with Node 22 in a scratch folder; the outputs shown are what it printed.

### 8.1 Specification

The rules below fix what a simulation run means. Chapter 4 defined what one clock edge does to one module; these rules add time, inputs, scenarios and observation.

- **R8.1 Time.** Domain d with frequency f\_d has its k-th rising edge at t\_k = round(k · 10^12 / f\_d) picoseconds, for k ≥ 1. Edges of several domains with equal t are simultaneous.
- **R8.2 Two-phase step.** At an edge, every combinational node of the firing domains is evaluated from current register values and inputs, every register computes its next value, and then all registers of all firing domains are committed together. No register observes another register's next value at the same edge (D15).
- **R8.3 Inputs.** A scenario action scheduled at time t takes effect before any edge at t. An input pin passes through the D6 synchronizer, so logic sees a pin change two or three edges after it is applied, the number drawn per transfer from the seeded generator (R12.6).
- **R8.4 Poke.** `poke(path, v)` on an input or a wire forces v until the scenario ends. On a register it deposits v into Q once, and logic continues from there.
- **R8.5 Waiting.** `wait(d)` advances time by d and processes every edge in (t, t + d\]. `step(n)` processes the next n edges of the primary domain: the domain of the module named in the last poke, else `sys`.
- **R8.6 Press.** `press(id, { for = "50ms", bounce = 0 })` drives the button's active level for `for`, then releases it, advancing time by `for`. With a bounce b, the first b of the press toggles at seeded intervals of 50 to 500 µs (random stream `bounce/<id>`) before settling.
- **R8.7 Determinism.** Design, scenario and seed fix the trace. Nothing reads the wall clock. Every random stream is seeded from its design, scenario and stream name (8.9).
- **R8.8 Observation.** Observables follow D9: ports and pins once per edge of their domain, and pipelined stream paths as the sequence of fired beats.
- **R8.9 Monitors.** Every stream carries a D7 protocol monitor, and every assert and assume is evaluated after each edge (Chapter 9). A violation is a diagnostic with its cycle number.
- **R8.10 Levels.** A scenario may run at `hir` (an interpreter over HIR), `dag` (code compiled from the per-domain DAGs) or `net` (a netlist of mapped cells). Traces from different levels are compared on the observables alone.

### 8.2 Levelization

A synchronous circuit evaluated at one edge is a pure function of its register values and inputs. Chapter 10 makes that precise: the per-domain DAG has no cycles once each register's next-state edge is set aside. Evaluating it is therefore a matter of visiting nodes in topological order, so that each node's operands are computed before the node. That order is called a *levelization*, and it is computed once, at compile time, not at every edge.

The listing uses Kahn's algorithm. A register is a source because its next-state edge lives in `attrs.next`, not in `args`. Ties are broken by node order, so two runs of the compiler emit identical code. If some nodes never reach in-degree zero, they lie on a combinational cycle, and the simulator refuses with the same `comb-loop` diagnostic that `checks.loops` raises.

```js
export function levelize(nodes) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const indeg = new Map(nodes.map(n => [n.id, n.args.length]));
  const users = new Map(nodes.map(n => [n.id, []]));
  for (const n of nodes) for (const a of n.args) users.get(a).push(n.id);
  const ready = nodes.filter(n => n.args.length === 0).map(n => n.id);
  const order = [];
  while (ready.length) {
    const id = ready.shift();
    order.push(byId.get(id));
    for (const v of users.get(id)) {
      indeg.set(v, indeg.get(v) - 1);
      if (indeg.get(v) === 0) ready.push(v);
    }
  }
  if (order.length !== nodes.length) {
    const stuck = nodes.filter(n => indeg.get(n.id) > 0).map(n => n.id);
    throw new Error(`comb-loop: ${stuck.join(", ")}`);
  }
  return order;
}
```

Two inverters feeding each other, `a = not b` and `b = not a`, produce `comb-loop: a, b`.

### 8.3 The counter as data

The input to the compiler is F-02's counter after the `lower` stage: the DAG that book 1 printed in its section 2.5. In the simulator's input format each node has an id, an opcode, operand ids and a type. Chapter 10 adds provenance and domains; the simulator ignores them.

```js
const u = w => ({ signed: false, width: w });
const s = w => ({ signed: true, width: w });

const counter = [
  { id: "v",   op: "reg",   args: [],                 type: u(8),  attrs: { name: "value", init: 0, next: "nx" } },
  { id: "en",  op: "in",    args: [],                 type: u(1),  attrs: { name: "en" } },
  { id: "dn",  op: "in",    args: [],                 type: u(1),  attrs: { name: "down" } },
  { id: "c1",  op: "const", args: [],                 type: u(1),  attrs: { value: 1 } },
  { id: "c0",  op: "const", args: [],                 type: u(1),  attrs: { value: 0 } },
  { id: "dec", op: "sub",   args: ["v", "c1"],        type: s(9) },
  { id: "inc", op: "add",   args: ["v", "c1"],        type: u(9) },
  { id: "sel", op: "mux",   args: ["dn", "dec", "inc"], type: s(10) },
  { id: "w",   op: "wrap",  args: ["sel"],            type: u(8) },
  { id: "nx",  op: "mux",   args: ["en", "w", "v"],   type: u(8) },
  { id: "z",   op: "eq",    args: ["v", "c0"],        type: u(1) },
  { id: "oval", op: "out",  args: ["v"],              type: u(8),  attrs: { name: "value" } },
  { id: "ozero", op: "out", args: ["z"],              type: u(1),  attrs: { name: "zero" } },
];
```

### 8.4 Compiling a step function

An interpreter walks the node list at every edge and dispatches on each opcode. A compiled simulator does that walk once and emits straight-line code with no dispatch left in it. Verilator compiles Verilog to C++ for this reason. The Weft simulator does the same thing to JavaScript, and lets the JavaScript engine's own compiler do the rest.

Values are stored as bit patterns: an integer p with 0 ≤ p < 2^w. Two helpers move between patterns and integers. `I(p, w, signed)` reads a pattern as an integer, applying two's complement when the type is signed. `P(v, w)` reduces an integer modulo 2^w and returns its pattern. Every arithmetic node computes on integers and stores a pattern. That single rule implements every width rule from Chapter 1: sign extension, zero extension and wrapping all fall out of reading with the operand's type and writing with the result's.

```js
const I = (p, w, sgn) => (sgn && p >= 2 ** (w - 1) ? p - 2 ** w : p);
const P = (v, w) => ((v % 2 ** w) + 2 ** w) % 2 ** w;

export function compile(nodes) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const T = id => byId.get(id).type;
  for (const n of nodes) {
    const tooWide = n.type.width > 32 || (n.op === "mul" && T(n.args[0]).width + T(n.args[1]).width > 52);
    if (tooWide) throw new Error(`${n.id}: needs the BigInt path`);
  }
  const int = id => `I(n_${id}, ${T(id).width}, ${+T(id).signed})`;
  const lines = [];
  for (const n of levelize(nodes)) {
    const w = n.type.width, [a, b, c] = n.args;
    const e = {
      in:    () => `force.${n.attrs.name} ?? inp.${n.attrs.name} ?? 0`,
      reg:   () => `st.${n.attrs.name}`,
      const: () => `${P(n.attrs.value, w)}`,
      add:   () => `P(${int(a)} + ${int(b)}, ${w})`,
      sub:   () => `P(${int(a)} - ${int(b)}, ${w})`,
      mul:   () => `P(${int(a)} * ${int(b)}, ${w})`,
      mux:   () => `P(n_${a} ? ${int(b)} : ${int(c)}, ${w})`,
      wrap:  () => `P(${int(a)}, ${w})`,
      eq:    () => `(${int(a)} === ${int(b)} ? 1 : 0)`,
      lt:    () => `(${int(a)} < ${int(b)} ? 1 : 0)`,
      and:   () => `(P(${int(a)}, ${w}) & P(${int(b)}, ${w})) >>> 0`,
      out:   () => `n_${a}`,
    }[n.op];
    if (!e) throw new Error(`no code for op ${n.op}`);
    lines.push(`const n_${n.id} = ${e()};`);
  }
  const regs = nodes.filter(n => n.op === "reg"), outs = nodes.filter(n => n.op === "out");
  lines.push(`return {`);
  lines.push(`  out: { ${outs.map(o => `${o.attrs.name}: n_${o.id}`).join(", ")} },`);
  lines.push(`  next: { ${regs.map(r => `${r.attrs.name}: n_${r.attrs.next}`).join(", ")} },`);
  lines.push(`};`);
  const source = `return function step(st, inp, force) {\n  ${lines.join("\n  ")}\n}`;
  const step = new Function("I", "P", source)(I, P);
  const init = Object.fromEntries(regs.map(r => [r.attrs.name, P(r.attrs.init ?? 0, r.type.width)]));
  return { step, init, source };
}

export function simulate(model, inputsPerCycle, force = {}) {
  let st = { ...model.init };
  const trace = [];
  for (const inp of inputsPerCycle) {
    const { out, next } = model.step(st, inp, force);
    trace.push({ ...inp, ...out });
    st = next;                                       // phase 2: commit
  }
  return trace;
}
```

The step function returns next values without touching `st`. The caller commits them in one assignment, which is R8.2's second phase. Here is the code it generated for the counter, exactly as printed:

```js
return function step(st, inp, force) {
  const n_v = st.value;
  const n_en = force.en ?? inp.en ?? 0;
  const n_dn = force.down ?? inp.down ?? 0;
  const n_c1 = 1;
  const n_c0 = 0;
  const n_oval = n_v;
  const n_dec = P(I(n_v, 8, 0) - I(n_c1, 1, 0), 9);
  const n_inc = P(I(n_v, 8, 0) + I(n_c1, 1, 0), 9);
  const n_z = (I(n_v, 8, 0) === I(n_c0, 1, 0) ? 1 : 0);
  const n_sel = P(n_dn ? I(n_dec, 9, 1) : I(n_inc, 9, 0), 10);
  const n_ozero = n_z;
  const n_w = P(I(n_sel, 10, 1), 8);
  const n_nx = P(n_en ? I(n_w, 8, 0) : I(n_v, 8, 0), 8);
  return {
    out: { value: n_oval, zero: n_ozero },
    next: { value: n_nx },
  };
}
```

Read `n_sel`. The `dec` arm is read as a signed 9-bit integer and the `inc` arm as unsigned, and the result is written as a 10-bit pattern. That one line performs the sign and zero extensions that Chapter 1's mux rule requires. `n_w` then reads the 10-bit pattern as signed and writes eight bits, which is `wrap`.

### 8.5 Numbers, BigInt and wide signals

JavaScript numbers are IEEE doubles: integers are exact up to 2^53, and the bitwise operators work on 32 bits. The compiler therefore chooses a representation per node, and the listing above refuses any node that needs the slower path.

| Width of the exact result | Representation | Why |
| --- | --- | --- |
| ≤ 32 bits, and every product ≤ 52 bits | Number, with `P` or `>>> 0` | Exact, and the bitwise operators apply |
| 33 to 64 bits | BigInt, or two 32-bit halves | Bitwise operators truncate Numbers to 32 bits |
| More than 64 bits | BigInt, or an array of 32-bit words | Verilator stores wide signals as arrays of 32-bit words for the same reason |

BigInt is exact at any width and simple to generate, but each operation allocates. A simulator that must be fast generates word arrays for wide nodes and Numbers for the rest. F-08's 32-bit phase accumulator is the first example that needs the second row: $.phase += STEP is u33 before it wraps. F-12's phase is the same, and F-13's 48-bit accumulator follows.

### 8.6 Several clock domains

F-10 runs a 100 MHz domain and a 25.175 MHz domain. The simulator keeps one edge counter per domain and computes each next edge time from its index, as R8.1 says, so rounding error never accumulates. It then repeatedly takes the earliest time and fires every domain whose edge falls on it.

```js
export function* edges(domains) {
  const k = domains.map(() => 1);
  const at = (d, i) => Math.round((k[i] * 1e12) / d.hz);   // picoseconds, no accumulated drift
  for (;;) {
    const times = domains.map((d, i) => at(d, i));
    const t = Math.min(...times);
    const fire = domains.filter((_, i) => times[i] === t).map(d => d.name);
    domains.forEach((_, i) => { if (times[i] === t) k[i]++; });
    yield { t, fire };
  }
}
```

For F-10's two clocks the first twelve events are `10000:sys 20000:sys 30000:sys 39722:pix 40000:sys … 79444:pix …`. For 10 MHz and 20 MHz they are `50000:b 100000:a+b 150000:b 200000:a+b`. The second schedule shows why R8.2 commits all firing domains together. At 100 ns both domains fire, and a register in either one must read the other's value from before the edge.

A crossing primitive (Chapter 12) is a register in the destination domain whose input comes from the source domain. Two-phase evaluation makes it sample the source's pre-edge value, which is exactly what a real flip-flop does when setup and hold are met. The simulator does not model metastability itself. By R12.6 it delays every synchronized transfer by two or three destination cycles, drawn from the seeded generator, which is the observable effect of a first stage that may or may not settle in time; a design that passes only with one particular latency fails. Exercise 3 goes further and randomizes the value the first stage captures.

### 8.7 Memories and streams

A `.ram()` is an array of patterns plus two ports. At an edge the read port captures its address, and `q` takes the stored word at that address after the edge (D8). The write port stores its data at the same edge. D8's read-first rule is implemented by ordering the commit: all reads of an edge are served from the array before any write of the same edge is applied.

A stream is three ordinary signals: `valid`, `ready` and `data`. A beat fires on an edge where both are high. D7 forbids two things the simulator can see: `valid` falling before its beat fires, and `data` changing while `valid` is high and `ready` is low. The monitor checks both each cycle.

```js
export function streamMonitor(name) {
  let prev = null;
  return (cycle, now) => {                                 // now: { valid, ready, data }
    const errors = [];
    if (prev && prev.valid && !prev.ready) {
      if (!now.valid) errors.push(`stream-protocol ${name}: valid fell at cycle ${cycle} before its beat fired`);
      else if (JSON.stringify(now.data) !== JSON.stringify(prev.data))
        errors.push(`stream-protocol ${name}: data changed at cycle ${cycle} while waiting for ready`);
    }
    prev = now;
    return errors;
  };
}
```

Fed six cycles in which the producer changes its byte from `0x65` to `0x66` while stalled and then drops `valid`, it reports `data changed at cycle 4` and `valid fell at cycle 5`. D7's third rule, that `valid` must not depend combinationally on `ready`, is structural: it is checked on the DAG by a path search from `ready` to `valid` inside the producer, not in simulation.

### 8.8 Scenarios and testbenches

The declarative steps of book 1's scenarios (`wait`, `step`, `poke`, `press`, `uart`, `feed`, `throttle` and the `expect` family) compile to a list of timed actions, which a runner interleaves with the edge schedule of 8.6. The asynchronous form, `async tb => { … }`, needs no compilation. The simulator is synchronous, so each `await tb.step()` advances the model and resolves at once. The `await` only fixes the order of the testbench's statements relative to the edges.

```js
export class Testbench {
  constructor(model, random) {
    this.model = model; this.random = random;
    this.state = { ...model.init }; this.force = {}; this.cycle = 0; this.last = {}; this.failures = [];
  }
  async poke(name, v) { this.force[name] = v; }           // an input: forced until the scenario ends
  async peek(name) { return this.model.step(this.state, {}, this.force).out[name]; }
  async step(n = 1) {
    for (let i = 0; i < n; i++) {
      const { out, next } = this.model.step(this.state, {}, this.force);
      this.last = out; this.state = next; this.cycle++;
    }
  }
  expect(ok, message = "expectation failed") { if (!ok) this.failures.push({ cycle: this.cycle, message }); }
}
```

`peek` evaluates the combinational logic without committing, so it reads outputs as they stand between edges. A random walk of 1,000 cycles against a JavaScript reference model of the counter (`expected = (expected + (down ? 255 : 1)) % 256` when `en` is high) finished with zero failures.

### 8.9 Determinism and seeds

A random test is useful only if its failures reproduce. Weft derives every random stream from three names, design, scenario and stream, hashed with 32-bit FNV-1a and fed to the mulberry32 generator. Two runs of `arbiter / fair under random load` draw `4,9,4,14,5,4` both times. Another scenario draws `5,13,2,0,13,11`. Adding a scenario to a file does not change the numbers any other scenario sees, because no stream depends on run order.

```js
export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (const ch of text) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const randomFor = (design, scenario, stream = "tb") => {
  const next = mulberry32(fnv1a(`${design}/${scenario}/${stream}`));
  return { next, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)) };
};
```

### 8.10 One scenario at three levels

F-14 and F-16 run a scenario with `{ levels: ["dag", "net"] }`. Each level produces a trace of the observables, and the comparator reports the first cycle and signal where two traces disagree.

```js
export function firstDivergence(a, b, observables) {
  const n = Math.min(a.length, b.length);
  for (let cycle = 0; cycle < n; cycle++)
    for (const sig of observables)
      if (a[cycle][sig] !== b[cycle][sig]) return { cycle, sig, a: a[cycle][sig], b: b[cycle][sig] };
  return a.length === b.length ? null : { cycle: n, sig: "(trace length)" };
}
```

To test the comparator, the counter's `dec` node was changed from `sub` to `add`, the kind of bug a faulty pass introduces. Against the reference the result is `{ cycle: 4, sig: "value", a: 2, b: 4 }`: the first cycle after `down` rises. Chapter 11 uses this comparator to bisect a pass list. The `hir` level interprets HIR directly and is the slowest; `net` simulates LUT truth tables, flip-flops and carry chains, and is the closest to silicon.

### 8.11 WebAssembly

`emit("sim:wasm")` (F-16) uses the same levelized order with a different printer. Sketch, not run: registers live at fixed offsets in linear memory, each node becomes a local, `i32` handles widths up to 32 and `i64` up to 64, and wider nodes use word arrays as in 8.5. The module exports `step(n)`. The host writes inputs into memory, calls `step`, and reads outputs back.

```text
;; sketch: the counter's increment and commit, in WebAssembly text
(local.set $v   (i32.load8_u (i32.const 0)))                       ;; value at offset 0
(local.set $inc (i32.and (i32.add (local.get $v) (i32.const 1)) (i32.const 0x1ff)))
...
(i32.store8 (i32.const 0) (local.get $nx))                          ;; phase 2: commit
```

### 8.12 Worked example: F-02's counter

The stimulus holds `en` high, counts up three times, counts down four times, then drops `en`. The table is the simulator's trace; `value` and `zero` are the outputs before each edge.

| Cycle | en | down | value | zero |
| --- | --- | --- | --- | --- |
| 0 | 1 | 0 | 0 | 1 |
| 1 | 1 | 0 | 1 | 0 |
| 2 | 1 | 0 | 2 | 0 |
| 3 | 1 | 1 | 3 | 0 |
| 4 | 1 | 1 | 2 | 0 |
| 5 | 1 | 1 | 1 | 0 |
| 6 | 1 | 1 | 0 | 1 |
| 7 | 0 | 1 | 255 | 0 |

Cycle 7 is book 1's "wraps below zero" scenario in miniature. Run alone, with `down` and `en` poked to 1, the same model gives `value` 0 then 255, which is that scenario's acceptance test.

### 8.13 Tests

- **Differential.** Each module's compiled step function matches the HIR interpreter on 100,000 seeded random cycles.
- **Two-phase.** Two registers with `a ← b` and `b ← a` must swap every edge; a one-phase bug makes both equal.
- **Schedules.** The 10/20 MHz schedule must show coincident edges at every 100 ns, and F-10's schedule must keep each domain's edge k within 0.5 ps of k · 10^12 / f.
- **Determinism.** Two runs of every scenario produce byte-identical traces.
- **Refusals.** A combinational cycle gives `comb-loop`, a 33-bit node on the Number path gives a compile error, and both protocol violations of 8.7 are reported.
- **Acceptance.** F-01's 2 Hz toggle count, F-02's two scenarios and F-07's drop counts pass at `dag` level.

### 8.14 Exercises

1. Add the BigInt path to `compile` and run F-13's multiply-accumulate (18 × 18 into 48 bits) against a BigInt reference model.
2. Write the HIR interpreter, then make the differential test of 8.13 pass for F-02 and F-06.
3. Add a metastability mode. When a synchronizer's source changed within a window before the destination edge, its first stage takes a seeded random bit. Show that F-10 still passes and that removing `.cross()` makes it fail.
4. Extend `firstDivergence` so that D9's pipelined stream paths are compared as beat sequences rather than cycle by cycle, and test it on F-15 with two different pipeline depths.
5. Generate WebAssembly for the counter, and measure cycles per second against the JavaScript step function.

### 8.15 Further study

- **Verilator documentation.** It describes a production compiled simulator: levelized evaluation, two-phase commits and wide signals stored as 32-bit words.
- **Harris & Harris, Digital Design and Computer Architecture, Chapter 4.** It covers HDL simulation semantics, including the blocking and nonblocking assignments that R8.2 replaces.
- **MIT 6.175, lecture material on rule scheduling and simulation.** It shows another way to define what happens at one edge, through atomic rules, and is worth reading beside D4's merge rule.

## Chapter 9 · Verification

Examples: F-11, F-17 · Prerequisite: Chapter 8

This chapter turns `.assert()`, `.assume()` and `.cover()` into three things from one source: checks the simulator runs every cycle, formulas an SMT solver can prove or refute, and circuits that watch the hardware during a canary. The work divides into lowering each property to a monitor circuit, encoding the circuit's transition relation as bitvector logic, and asking a solver two kinds of question. Bounded model checking finds counterexamples up to a depth. k-induction proves the property for every depth. The worked example is F-11's arbiter, and every result quoted here came from running the listings against Z3 5.3.1.

### 9.1 Specification

- **R9.1 Properties are hardware lambdas.** `.assert(name, fn)`, `.assume(name, fn)` and `.cover(name, fn)` take hardware lambdas that return one bit. They are parsed and capture-checked like any other (Chapter 3) and read the cycle's values before the edge.
- **R9.2 Temporal helpers.** `past(x)` is x's value at the previous edge of the module's domain, and 0 on the first cycle. `within(n, x)` may appear only as the consequent of `!a || within(n, x)`, or alone with trigger 1. It means that for every cycle t where a holds, x holds on some cycle in \[t, t + n − 1\]. `sequence(c1, …, ck)` may appear only in `.cover()`. It means c1 holds at t, c2 at t + 1, and so on. Any other position is the diagnostic `temporal-position`.
- **R9.3 Helpers are stateful.** Each helper owns registers that update on every edge. The `||` and `&&` around a helper are logical operators on bits, not JavaScript short-circuits: the helper's state advances whatever the rest of the expression evaluates to.
- **R9.4 Simulation.** A failing assert is the diagnostic `assert`, with its name and cycle. A failing assume is `assume-violated`, which marks the stimulus as wrong. Both fail the scenario at the first occurrence. A cover counts its hits, and `tb.expectCoverage("all")` fails if any cover has none.
- **R9.5 Formal.** The model is the module named by `.prove(p => p.module(…))`. Its inputs are free except where an assume constrains them, and its initial state is the reset state. `bmc(k)` proves that no run of cycles 0 to k violates an assert. `induction()` proves that k consecutive good cycles, from any state that respects the assumes, are always followed by a good one. Base and step together prove the asserts for every depth.
- **R9.6 Hardware monitors.** An assert built into hardware sets a sticky status bit and raises an irq when it fails (Chapter 14). Chapter 15's canary watches those bits.

### 9.2 One lambda, three uses

The design point of this chapter is that a property is lowered once. The `lower` stage turns each property lambda into DAG nodes, a *monitor*, with one output: `fail` for an assert or assume, `hit` for a cover. The simulator evaluates that output after each edge. The formal back end encodes the same nodes as logic. The hardware build keeps them as gates. A property therefore cannot mean one thing in simulation and another in a proof, because there is only one circuit.

### 9.3 Lowering the temporal helpers

Each helper becomes a few registers and gates. The table gives the hardware; the listing gives the same monitors in JavaScript, which is how the simulator runs them before the DAG compiler exists.

| Helper | Monitor circuit | State |
| --- | --- | --- |
| `past(x)` | One register clocked every edge, reset to 0 | width of x |
| `!a \|\| within(n, x)` | An age counter for the oldest pending obligation | ⌈log2(n + 1)⌉ bits |
| `sequence(c1, …, ck)` | A shift register of k − 1 bits, one per partial match | k − 1 bits |

```js
export const pastMonitor = () => { let q = 0; return x => { const prev = q; q = x; return prev; }; };

// !trig || within(n, x): x must hold in one of the n cycles starting with the trigger's.
// age = cycles already spent by the oldest pending obligation; 0 = none pending.
export function withinMonitor(n) {
  let age = 0;
  return (trig, x) => {
    const fail = !x && ((age > 0 && age + 1 >= n) || (age === 0 && trig && n === 1));
    age = x ? 0 : age > 0 ? age + 1 : trig ? 1 : 0;
    return fail;
  };
}

// sequence(c1, …, ck): c1 on some cycle, c2 on the next, … ck k−1 cycles later.
export function sequenceMonitor(k) {
  const r = new Array(k - 1).fill(0);
  return cs => {
    const hit = (k === 1 ? 1 : r[k - 2]) && cs[k - 1] ? 1 : 0;
    for (let j = k - 2; j > 0; j--) r[j] = r[j - 1] && cs[j] ? 1 : 0;
    if (k > 1) r[0] = cs[0] ? 1 : 0;
    return hit;
  };
}
```

The `within` monitor tracks only the oldest pending obligation, and that is enough. If obligations start at t1 < t2 and neither is met, the oldest expires first. A single cycle with x discharges both, because that cycle lies inside both windows. One counter therefore replaces a queue of timers.

Two runs check the monitors. With `req0` held high for eleven cycles and `grant0` high only at cycle 3, `within(4, …)` first fails at cycle 7: a new obligation opens at cycle 4 and its window, cycles 4 to 7, passes without a grant. With grants `1, 2, 4, 8, 1, 4, 2, 4, 8`, the four-step `sequence` hits once, at cycle 3.

R9.3 came from a bug in this chapter's own test harness. The first version updated `past(grant0)` inside `past(req0) && !past(grant0)`. JavaScript skipped the second call whenever the first returned 0, so the second register missed updates, and 110 spurious `assume-violated` reports appeared in 10,000 cycles. Hardware has no short-circuit: every monitor register clocks every edge. The lowering must evaluate every helper unconditionally, and so must any JavaScript model of it.

### 9.4 SAT and SMT in one page

SAT asks whether a Boolean formula in conjunctive normal form has a satisfying assignment. Modern solvers use conflict-driven clause learning (CDCL) and handle millions of clauses. SMT (satisfiability modulo theories) adds typed terms from a theory. The theory that matters here is QF\_BV: quantifier-free formulas over fixed-width bitvectors. A QF\_BV solver simplifies at the word level and then *bit-blasts*, translating each operation into a gate-level SAT encoding.

A Weft DAG maps onto QF\_BV node by node, which is why the encoder is short.

| DAG opcode | SMT-LIB2 term |
| --- | --- |
| `add`, `sub`, `mul`, `neg` | `bvadd`, `bvsub`, `bvmul`, `bvneg` |
| `and`, `or`, `xor`, `not` | `bvand`, `bvor`, `bvxor`, `bvnot` |
| `shl`, `shr`, `ashr` | `bvshl`, `bvlshr`, `bvashr` |
| `eq`, `lt` (unsigned / signed) | `=`, `bvult` / `bvslt` |
| `mux` | `ite` |
| `slice`, `zext`, `sext`, `concat` | `(_ extract hi lo)`, `(_ zero_extend k)`, `(_ sign_extend k)`, `concat` |

Operands are extended to the result width first, exactly as the simulator's `I` and `P` do. btor2 is a lower-level alternative. It is a word-level format for sequential circuits with explicit `state`, `init`, `next`, `constraint` and `bad` lines, which Yosys writes with `write_btor` and hardware model checkers read directly.

### 9.5 Bounded model checking

Let s\_t be the vector of all registers at cycle t, including monitor registers, and i\_t the inputs. Init holds of the reset state, T relates one state to the next, A is the conjunction of assumes, and P the conjunction of asserts. Bounded model checking to depth k asks whether this formula is satisfiable:

```latex
\mathit{Init}(s_0) \wedge \bigwedge_{t<k} T(s_t, i_t, s_{t+1}) \wedge \bigwedge_{t \le k} A(s_t, i_t) \wedge \bigvee_{t \le k} \neg P(s_t, i_t)
```

A satisfying assignment is a counterexample: inputs for every cycle that drive the design into a violation. Unsatisfiable means no violation exists within k + 1 cycles. The generator below emits the formula for F-11's arbiter with N = 4. Its state is `last`, the `within` monitor's `age`, and two `past` registers for the assume. Each cycle's `grant` is F-11's backward priority loop, unrolled into nested `ite` terms.

```js
const bv = (v, w) => `(_ bv${v} ${w})`;

function stepTerms(i, variant) {
  const L = `last_${i}`, R = `req_${i}`;
  let g = bv(0, 4);
  for (let k = 4; k >= 1; k--) {                           // F-11's loop, unrolled for N = 4
    const idx = `(bvadd ${L} ${bv(k % 4, 2)})`;
    const bit = `((_ extract 0 0) (bvlshr ${R} ((_ zero_extend 2) ${idx})))`;
    g = `(ite (= ${bit} #b1) (bvshl #x1 ((_ zero_extend 2) ${idx})) ${g})`;
  }
  const gb = j => `((_ extract ${j} ${j}) grant_${i})`;
  const lastNext = variant === "stuck" ? L
    : `(ite (= ${gb(3)} #b1) #b11 (ite (= ${gb(2)} #b1) #b10 (ite (= ${gb(1)} #b1) #b01 (ite (= ${gb(0)} #b1) #b00 ${L}))))`;
  const trig = `(= ((_ extract 0 0) ${R}) #b1)`, x = `(= ${gb(0)} #b1)`, A = `age_${i}`;
  return {
    grant: g, lastNext, x, trig,
    ageNext: `(ite ${x} #b000 (ite (bvugt ${A} #b000) (bvadd ${A} #b001) (ite ${trig} #b001 #b000)))`,
    fail: `(and (not ${x}) (bvugt ${A} #b000) (bvuge (bvadd ${A} #b001) #b100))`,
  };
}

export function arbiterSmt({ k, mode, variant = "rr", strengthen = false }) {
  const out = ["(set-logic QF_BV)"];
  for (let i = 0; i <= k; i++)
    out.push(`(declare-const last_${i} (_ BitVec 2)) (declare-const req_${i} (_ BitVec 4))`,
             `(declare-const age_${i} (_ BitVec 3)) (declare-const pr0_${i} (_ BitVec 1)) (declare-const pg0_${i} (_ BitVec 1))`,
             `(declare-const grant_${i} (_ BitVec 4))`);
  if (mode === "bmc") out.push("(assert (and (= last_0 #b00) (= age_0 #b000) (= pr0_0 #b0) (= pg0_0 #b0)))");
  const props = [];
  for (let i = 0; i <= k; i++) {
    const t = stepTerms(i, variant), G = `grant_${i}`, R = `req_${i}`;
    out.push(`(assert (= ${G} ${t.grant}))`);
    // assume: a request waits for its grant
    out.push(`(assert (or (not (and (= pr0_${i} #b1) (= pg0_${i} #b0))) (= ((_ extract 0 0) ${R}) #b1)))`);
    const p = [
      `(= (bvand ${G} (bvsub ${G} #x1)) #x0)`,              // at most one grant
      `(= (bvand ${G} (bvnot ${R})) #x0)`,                  // grants go to requesters
      `(not ${t.fail})`,                                    // served within N cycles
    ];
    if (strengthen) p.push(
      `(=> (bvugt age_${i} #b000) (and (= pr0_${i} #b1) (= pg0_${i} #b0)))`,
      `(=> (bvugt age_${i} #b000) (bvule (bvadd age_${i} ((_ zero_extend 1) (bvsub #b11 last_${i}))) #b011))`);
    props.push(`(and ${p.join(" ")})`);
    if (i < k) out.push(
      `(assert (= last_${i + 1} ${t.lastNext}))`,
      `(assert (= age_${i + 1} ${t.ageNext}))`,
      `(assert (= pr0_${i + 1} ((_ extract 0 0) ${R})))`,
      `(assert (= pg0_${i + 1} ((_ extract 0 0) ${G})))`);
  }
  if (mode === "bmc") out.push(`(assert (not (and ${props.join(" ")})))`);           // any step violates
  else out.push(...props.slice(0, k).map(p => `(assert ${p})`), `(assert (not ${props[k]}))`);   // k good steps, then a bad one
  out.push("(check-sat)");
  return out.join("\n");
}
```

The generated file for depth 3 is 5,973 bytes. Its first transition reads `(assert (= pr0_1 ((_ extract 0 0) req_0)))`, which is `past(req[0])` as one equation between two cycles. For the correct arbiter, BMC to depth 24, F-11's `.bmc(24)`, returns `unsat`: no violation in 25 cycles.

To check that the encoding can fail, the `stuck` variant never updates `last`, the bug F-11's first try line invites. At depth 6, Z3 returns `sat` with this counterexample:

| Cycle | req | grant | age | What happens |
| --- | --- | --- | --- | --- |
| 0 | 0x3 | 0x2 | 0 | Port 1 beats port 0 |
| 1 | 0x1 | 0x1 | 1 | Port 0 is served |
| 2 | 0x0 | 0x0 | 0 | Idle |
| 3 | 0xb | 0x2 | 0 | Ports 0, 1, 3 request; port 1 wins; port 0's obligation opens |
| 4 | 0x9 | 0x8 | 1 | Port 3 wins |
| 5 | 0x9 | 0x8 | 2 | Port 3 wins again |
| 6 | 0x9 | 0x8 | 3 | Port 3 wins; the window 3–6 closes without port 0: fail |

With `last` stuck at 0, the priority order is fixed at 1, 2, 3, 0. Port 3 always beats port 0, and the solver found a run that shows it. It is not the shortest: bounded model checking returns some violating run within the bound, and the shortest one fails at cycle 3 (depth 2 is unsat, depth 3 sat). Every counterexample becomes a scenario that the Chapter 8 simulator replays, so the designer debugs it with waveforms rather than formulas.

### 9.6 k-induction

BMC never proves a property for all depths. k-induction does it with a second query, the *step case*. Start from any state at all, with no Init. Assume P holds on k consecutive cycles that follow T and respect A, and ask whether P can fail on the next cycle:

```latex
\bigwedge_{t<k} \big(A(s_t, i_t) \wedge P(s_t, i_t) \wedge T(s_t, i_t, s_{t+1})\big) \wedge A(s_k, i_k) \wedge \neg P(s_k, i_k)
```

If the step case is unsatisfiable and BMC to depth k passes, P holds forever. If the step case is satisfiable, the solver has found a *counterexample to induction*. That is a run that starts in a state the design may never reach, and the proof cannot tell the difference.

| k | Plain property | Strengthened property |
| --- | --- | --- |
| 1 | `sat` (counterexample to induction) | `unsat` |
| 2 | `sat` | `unsat` |
| 3 | `unsat` | `unsat` |
| 4 | `unsat` | `unsat` |
| 8 | `unsat` | `unsat` |

The counterexample at k = 1 starts with `last = 0`, `age = 2` and `past(req0) = 0`. It describes an obligation two cycles old whose request was low on the previous cycle. The assume makes that impossible from reset, but the step case does not start from reset. Two strengthening invariants exclude such states. Proving the stronger property P ∧ I1 ∧ I2 is easier than proving P alone.

- **I1.** If `age > 0`, then `past(req0) = 1` and `past(grant0) = 0`. A pending obligation means port 0 was requesting and not served.
- **I2.** If `age > 0`, then `age + (3 − last) ≤ 3`. Here 3 − `last` counts the ports between the last winner and port 0 in rotation order, which is the most cycles port 0 can still wait. Each cycle without a grant to port 0 grants one of those ports, so `last` moves toward port 0 by at least one while `age` grows by exactly one. The sum never increases.

With I1 and I2 added, the step case is `unsat` at k = 1, and BMC of the strengthened property to depth 8 is `unsat`, which covers the base case. Plain induction also succeeds once k reaches 3 = N − 1. With three consecutive good cycles in the hypothesis, the unreachable starting states break the property early, inside the window the hypothesis already covers. Larger k is a substitute for invariants, paid for in solver time. IC3/PDR, the `abc pdr` engine below, finds such invariants automatically.

### 9.7 Assumptions in simulation

An assume is a claim about the environment, and a proof that uses it says nothing about runs that break it. That is why R9.4 checks assumes in simulation too. F-11's testbench respects its assume with one line: `req = (req & ~grant) | tb.random.int(0, 15)` keeps every ungranted request up. Delete `req & ~grant`, and the simulator reports `assume-violated` at the first cycle where a pending request drops. That report points at the stimulus, before any `assert` failure that would wrongly point at the design.

An assume can also be too strong. If no input sequence satisfies the assumes, every assert holds vacuously. Weft guards against this with a reachability query. BMC of the assumes alone, with their negation as the target, must find a run of the requested depth, or the proof reports the warning `vacuous`. Covers serve the same purpose for the design's interesting states: a proof whose covers are unreachable has proved too little.

### 9.8 Coverage

In simulation a cover counts hits. In formal, a cover is a reachability question: BMC with the cover's `hit` as the target, where `sat` means reached and the model is a trace that reaches it. A plain JavaScript model of F-11, running the arbiter, its monitors and the seeded testbench for 10,000 cycles, gave these numbers:

| Measure | Result |
| --- | --- |
| Grants per port | 2491, 2498, 2503, 2487 |
| Assert failures | 0 |
| Assume violations | 0 |
| Hits of "every port served in turn" | 1975 |

The fairness expectation in F-11, at least 2,000 grants per port, holds with a margin of about 25 %.

### 9.9 The practical back end

Writing a model checker is a research project. Weft does not attempt one. It emits the module and its monitors as Verilog with immediate assertions under `` `ifdef FORMAL ``, then drives SymbiYosys. SymbiYosys runs Yosys to build the model and hands it to an engine: `smtbmc` with Yices, Z3 or Boolector for BMC and k-induction, or `abc pdr` for IC3/PDR. The emitted monitor for F-11's third assert looks like this (a sketch, not run):

```text
`ifdef FORMAL
  reg [2:0] age = 0;
  always @(posedge clk) age <= grant[0] ? 0 : age != 0 ? age + 1 : req[0] ? 1 : 0;
  always @(*) assert(!(!grant[0] && age != 0 && age + 1 >= 4));
`endif
```

The job file asks for a proof with depth 24, which SymbiYosys runs as BMC plus k-induction:

```text
[options]
mode prove
depth 24

[engines]
smtbmc z3

[script]
read -formal arbiter.sv
prep -top arbiter

[files]
arbiter.sv
```

The in-process SMT generator of 9.5 remains useful for small checks that run on every build: the rule proofs of Chapter 11 and the per-pass validation of D10.

### 9.10 Tests

- **Monitors.** Each helper has hand-written traces with known first-failure or hit cycles, including the two in 9.3.
- **Encoder against simulator.** For each opcode, random operand values are encoded as constants, and Z3's `get-value` of the result must equal the Chapter 8 simulator's.
- **Known-bad designs.** The stuck-pointer arbiter must produce a counterexample, and replaying that counterexample in the simulator must fail the same assert on the same cycle.
- **Proofs.** The correct arbiter must pass BMC(24) and strengthened induction at k = 1. A deliberately unprovable property must not pass.
- **Vacuity.** A contradictory assume must raise `vacuous`.

### 9.11 Exercises

1. Convert the stuck-pointer counterexample into a Chapter 8 scenario, run it and confirm the assert fails at cycle 6.
2. Prove the arbiter for N = 8. Decide how wide `last` and `age` must be, and restate I2.
3. Emit btor2 instead of SMT-LIB2 for the arbiter and check it with a btor2 model checker.
4. Explain why plain induction succeeds at exactly k = 3 and not k = 2. Then test your explanation with N = 8.
5. Add R9.6's hardware mode. Compile the `within` monitor into the DAG with a sticky fail bit, and simulate it next to the JavaScript monitor.

### 9.12 Further study

- **Baier and Katoen, Principles of Model Checking.** It covers safety and liveness, transition systems and model-checking algorithms properly.
- **SymbiYosys documentation.** It is the practical reference for 9.9's flow and its engines.
- **Biere, Cimatti, Clarke and Zhu, "Symbolic Model Checking without BDDs" (TACAS 1999).** It introduced bounded model checking.
- **Sheeran, Singh and Stålmarck, "Checking Safety Properties Using Induction and a SAT-Solver" (FMCAD 2000).** It introduced k-induction and the strengthening this chapter needed.

## Chapter 10 · The IR core

Examples: F-13, F-14 · Prerequisites: Chapters 1 and 4

Every pass in Weft reads and writes one data structure: the DAG-level graph. This chapter specifies it and implements it: the node record, the opcode set, hash-consing, use lists, provenance, domains, the structural invariants that `verifyEach` checks, the printed form, a content hash and the methods F-14's passes call. The implementation is one class of about 150 lines. Every listing ran with Node 22, and the outputs are copied from those runs.

### 10.1 Specification

- **R10.1 Nodes.** A graph is a set of node records `{ id, op, args, type, attrs, origins, domain, users }`. `args` are operand ids in order, and `users` is the set of nodes that name this one as an operand or as a register's next value.
- **R10.2 Types.** A derived opcode's type follows the D1 width rules from its operand types. Ports, registers and memories carry declared types.
- **R10.3 Hash-consing.** At most one pure node exists per key: opcode, operands, type and attributes, with operands sorted for commutative opcodes.
- **R10.4 Registers.** A register's next value is held in `attrs.next`. That edge is a sequential edge, not a combinational one.
- **R10.5 Provenance.** Every node carries at least one origin, either a source position `{ file, line, src }` or the pass that made it, `{ pass }`. A node that replaces another inherits the union of both nodes' origins.
- **R10.6 Domains.** Every node belongs to one clock domain, and its operands belong to the same one. The only exception is the next value of a register marked `sync`, the first stage of a synchronizer (Chapter 12).
- **R10.7 Identity.** Ids are unique and never reused within a graph. Nothing observable depends on them: not the printed form's meaning, not the hash.
- **R10.8 Invariants.** With `verifyEach` on, the invariants V1 to V8 of 10.8 hold after every pass. They describe structure only; meaning is checked separately (D10, Chapter 11).

### 10.2 The opcode set

The set is small on purpose. Each operation of the hardware-lambda language lowers to one of these opcodes, and each opcode has one bitvector meaning, so the simulator of Chapter 8, the SMT encoder of Chapter 9 and the emitters of Chapter 13 each need one case per row.

| Opcode | Operands | Result type | Meaning |
| --- | --- | --- | --- |
| `in`, `reg`, `out` | 0, 0, 1 | Declared | An input port; a register's current value (next value in `attrs.next`); an output driven by its operand |
| `const` | 0 | Narrowest type holding the value (D1), unless a pass declares one in attrs.type | A constant |
| `add`, `sub` | 2 | Unify the operands, then one bit wider; `sub` is always signed | Sum, difference |
| `mul` | 2 | w\_a + w\_b, signed if either operand is | Product |
| `neg` | 1 | s(w + 1) | Negation |
| `and`, `or`, `xor` | 2 | Unify | Bitwise, after extending both operands |
| `not` | 1 | Unchanged | Bitwise inverse |
| `shl`, `shr`, `ashr` by a constant k | 1 | w + k; u(w − k); s(w − k) | Shifts. The dynamic forms take the amount as a second operand: `shl` is then w + 2^m − 1 wide, `shr` keeps w |
| `eq`, `ne`, `lt`, `le`, `gt`, `ge` | 2 | u(1) | Comparison after extension; signed when either promoted operand is |
| `mux` | 3 | Unify the two arms | `sel ? a : b`, with a one-bit `sel` |
| `concat` | n | Sum of widths, unsigned | The first operand lands in the high bits |
| `slice` hi..lo | 1 | u(hi − lo + 1) | A bit range |
| `zext`, `sext` to w | 1 | u(w), s(w) | Extension |
| `wrap`, `sat` to T | 1 | T | Modulo 2^w; clamp to T's range |
| `rom` | 1 | Element type | A combinational read of constant contents; `mem.infer` may turn it into a `mem` with a registered read |
| `mem`, `memrd`, `memwr` | 0; 3; 4 | Array; element; none | Storage, a read port whose address is captured at the edge (D8), a write port (address, data, enable) |
| `cell` | n | Per cell | A mapped primitive such as a LUT, carry or DSP; netlist level only |
| `probe` | n | None | Signals captured by `.probe()` |

### 10.3 Types in code

The type rules are one function. `promote` and `unify` carry the two ideas from Chapter 1: an unsigned operand beside a signed one gains a sign bit, and two operands meet in the narrowest type that holds both.

```js
export const u = w => ({ signed: false, width: w });
export const s = w => ({ signed: true, width: w });
export const sameType = (a, b) => a.signed === b.signed && a.width === b.width;
const bitlen = k => (k === 0 ? 0 : Math.floor(Math.log2(k)) + 1);
export const constType = k => (k >= 0 ? u(Math.max(1, bitlen(k))) : s(bitlen(-k - 1) + 1));
const promote = t => (t.signed ? t : s(t.width + 1));            // u(n) beside a signed operand is s(n + 1)
const unify = (a, b) => (!a.signed && !b.signed ? u(Math.max(a.width, b.width))
  : s(Math.max(promote(a).width, promote(b).width)));

export function resultType(op, A, attrs = {}) {                 // A: operand types
  const [a, b, c] = A;
  switch (op) {
    case "add": { const t = unify(a, b); return { ...t, width: t.width + 1 }; }
    case "sub": { const t = unify(a, b); return s(t.width + 1); }
    case "mul": return a.signed || b.signed ? s(a.width + b.width) : u(a.width + b.width);
    case "neg": return s(a.width + 1);
    case "and": case "or": case "xor": return unify(a, b);
    case "not": return a;
    case "shl": return { ...a, width: a.width + attrs.by };
    case "shr": return u(Math.max(1, a.width - attrs.by));
    case "ashr": return s(Math.max(1, a.width - attrs.by));
    case "eq": case "ne": case "lt": case "le": case "gt": case "ge": return u(1);
    case "mux": return unify(b, c);
    case "concat": return u(A.reduce((n, t) => n + t.width, 0));
    case "slice": return u(attrs.hi - attrs.lo + 1);
    case "zext": return u(attrs.width);
    case "sext": return s(attrs.width);
    case "wrap": case "sat": return attrs.type;
    case "const": return attrs.type ?? constType(attrs.value);
    default: return null;                                        // in, out, reg, mem…: declared, not derived
  }
}
```

The function returns `null` for declared types, and the graph insists on one when it adds such a node. The same function serves twice: once to type a new node, and again in `verify` to check that nobody has changed a type by hand.

### 10.4 Hash-consing

*Hash-consing* keeps a table from each pure node's key to its id. Before creating a node, `add` looks the key up and returns the existing node if there is one. Two consequences follow. Common subexpressions are shared at construction time, so CSE is mostly free. And the question "is this the same computation?" becomes an integer comparison of ids. For commutative opcodes the key sorts its operands, so `a * b` and `b * a` meet.

```js
const PURE = new Set(["const", "add", "sub", "mul", "neg", "and", "or", "xor", "not", "shl", "shr", "ashr",
  "eq", "ne", "lt", "le", "gt", "ge", "mux", "concat", "slice", "zext", "sext", "wrap", "sat"]);
const COMMUTATIVE = new Set(["add", "mul", "and", "or", "xor", "eq", "ne"]);

export class Graph {
  constructor() { this.nodes_ = new Map(); this.cons = new Map(); this.next = 1; this.diagnostics = []; }

  key(op, args, type, attrs) {
    const a = COMMUTATIVE.has(op) ? [...args].sort((x, y) => x - y) : args;
    return JSON.stringify([op, a, type, attrs]);
  }

  // Add a node, or return the existing one with the same key (hash-consing).
  add(op, args = [], { type, attrs = {}, origin, domain = "sys" } = {}) {
    const argTypes = args.map(id => this.node(id).type);
    const t = type ?? resultType(op, argTypes, attrs);
    if (!t) throw new Error(`${op}: a declared type is required`);
    const origins = origin ? [origin] : [];
    if (PURE.has(op)) {
      const k = this.key(op, args, t, attrs);
      const hit = this.cons.get(k);
      if (hit !== undefined) { this.addOrigins(this.node(hit), origins); return hit; }
      const id = this.create(op, args, t, attrs, origins, domain);
      this.cons.set(k, id);
      return id;
    }
    return this.create(op, args, t, attrs, origins, domain);
  }

  create(op, args, type, attrs, origins, domain) {
    const id = this.next++;
    this.nodes_.set(id, { id, op, args: [...args], type, attrs, origins, domain, users: new Set() });
    for (const a of args) this.node(a).users.add(id);
    return id;
  }

  node(id) { const n = this.nodes_.get(id); if (!n) throw new Error(`no node %${id}`); return n; }
  nodes(op) { return [...this.nodes_.values()].filter(n => !op || [].concat(op).includes(n.op)); }
  count(op) { return this.nodes(op).length; }
  addOrigins(n, origins) {
    for (const o of origins) if (!n.origins.some(p => JSON.stringify(p) === JSON.stringify(o))) n.origins.push(o);
  }
  setNext(reg, value) { this.node(reg).attrs.next = value; this.node(value).users.add(reg); }
```

Registers, ports, memories and probes are never hash-consed. Two registers with the same next-state logic are still two registers. Merging them is a decision about area and fanout (F-14's `split-fanout` does the opposite), not a fact about equality. Adding `b * a` to F-13's graph after `a * b` returned the existing `%5`. The node's origins became `$.a * $.b ; $.b * $.a`, so a diagnostic about it names both source lines.

### 10.5 Use lists and replacement

Each node keeps the set of its users. A pass that replaces a node must visit every user, and a use list makes that visit proportional to the number of users instead of to the size of the graph. `replace` redirects the users and transfers provenance. Then it *re-canonicalizes* each user, because a user whose operand changed may now have the same key as another node. When it does, the two are merged by a recursive `replace`. This is how a rewrite deep in the graph lets CSE cascade upward without a separate CSE pass.

```js
  replace(oldId, newId, pass) {
    if (oldId === newId) return;
    const old = this.node(oldId), rep = this.node(newId);
    this.addOrigins(rep, old.origins);
    if (pass) this.addOrigins(rep, [{ pass }]);
    const work = [...old.users];
    for (const uid of work) {
      const user = this.node(uid);
      user.args = user.args.map(a => (a === oldId ? newId : a));
      if (user.attrs.next === oldId) user.attrs.next = newId;
      rep.users.add(uid);
    }
    old.users.clear();
    this.remove(oldId);
    for (const uid of work) this.recanon(uid, pass);             // a user may now equal another node
  }

  recanon(id, pass) {
    const n = this.nodes_.get(id);
    if (!n || !PURE.has(n.op)) return;
    for (const [k, v] of this.cons) if (v === id) this.cons.delete(k);
    const k = this.key(n.op, n.args, n.type, n.attrs), twin = this.cons.get(k);
    if (twin !== undefined && twin !== id) this.replace(id, twin, pass);
    else this.cons.set(k, id);
  }

  remove(id) {
    const n = this.node(id);
    if (n.users.size) throw new Error(`%${id} still has users`);
    for (const a of n.args) this.nodes_.get(a)?.users.delete(id);
    if (n.attrs.next) this.nodes_.get(n.attrs.next)?.users.delete(id);
    for (const [k, v] of this.cons) if (v === id) this.cons.delete(k);
    this.nodes_.delete(id);
  }
```

The test graph has two outputs: `p = x * 8 + y` and `q = (x << 3) + y`, where `x << 3` has already been zero-extended to `x * 8`'s 12 bits. Replacing the multiply with the extended shift makes the two adds identical. `recanon` merges them, and the graph is left with one `add` that both outputs share. Its origins read `(x << 3) + y ; x * 8 + y ; pass:rewrite`: both source lines, plus the pass responsible. The scans of `cons` are linear for clarity; a production graph keeps a reverse map from id to key.

### 10.6 Provenance

R10.5 is what makes diagnostics late in the pipeline point at source lines. Origins only grow: a merged node keeps every origin of every node it absorbed, and a node made by a pass records the pass. When Chapter 12's timing analysis reports a critical path, `explain()` prints each node's source origins in path order. That list is the dossier F-18's agent receives. The cost is memory: one shared origin object per source position, plus a small array per node.

### 10.7 Domains

A graph holds every clock domain of a design, and each node records its domain. V7 below enforces R10.6. Any operand from another domain is an error, except the next value of a register marked `sync`. That one exception is how a crossing primitive is built, and it is why `checks.cdc` (Chapter 12) can be a simple scan over registers instead of a whole-graph analysis.

### 10.8 verifyEach

`c.verifyEach()` runs `verify` after every pass. It checks eight structural invariants:

| Invariant | Holds when |
| --- | --- |
| V1 | Every operand id names a node |
| V2 | Use lists and operand lists agree in both directions |
| V3 | Every derived type equals what the D1 rules give for its operands |
| V4 | No two pure nodes share a key |
| V5 | The combinational edges form a DAG |
| V6 | Every register has a next value, and every output name has one driver |
| V7 | Operands share their node's domain, except a `sync` register's next value |
| V8 | Every node has at least one origin |

```js
export function verify(g) {
  const errs = [];
  const all = g.nodes();
  const ids = new Set(all.map(n => n.id));
  for (const n of all) {
    for (const a of n.args) if (!ids.has(a)) errs.push(`V1 %${n.id}: operand %${a} does not exist`);
    for (const a of n.args) if (ids.has(a) && !g.node(a).users.has(n.id)) errs.push(`V2 %${n.id}: missing from the use list of %${a}`);
    for (const u2 of n.users) if (!ids.has(u2)) errs.push(`V2 %${n.id}: stale user %${u2}`);
    if (n.args.every(a => ids.has(a))) {
      const want = resultType(n.op, n.args.map(a => g.node(a).type), n.attrs);
      if (want && !sameType(want, n.type)) errs.push(`V3 %${n.id}: type ${JSON.stringify(n.type)} but the rule gives ${JSON.stringify(want)}`);
    }
    if (n.op === "reg" && !ids.has(n.attrs.next)) errs.push(`V6 %${n.id}: register without a driver`);
    if (!n.origins.length) errs.push(`V8 %${n.id}: no provenance`);
    for (const a of n.args) if (ids.has(a) && g.node(a).domain !== n.domain) errs.push(`V7 %${n.id}: operand %${a} is in domain ${g.node(a).domain}`);
    if (n.op === "reg" && ids.has(n.attrs.next) && g.node(n.attrs.next).domain !== n.domain && !n.attrs.sync)
      errs.push(`V7 %${n.id}: next comes from domain ${g.node(n.attrs.next).domain} without a synchronizer`);
  }
  const seen = new Map();                                        // V4: no two pure nodes with one key
  for (const n of all) if (PURE.has(n.op)) {
    const k = g.key(n.op, n.args, n.type, n.attrs);
    if (seen.has(k)) errs.push(`V4 %${n.id} duplicates %${seen.get(k)}`); else seen.set(k, n.id);
  }
  const indeg = new Map(all.map(n => [n.id, n.args.filter(a => ids.has(a)).length]));   // V5: no combinational cycle
  const ready = all.filter(n => indeg.get(n.id) === 0).map(n => n.id);
  let done = 0;
  while (ready.length) {
    const id = ready.pop(); done++;
    for (const v of g.node(id).users) {
      const k = g.node(v).args.filter(a => a === id).length;    // y * y uses y twice
      if (k) { indeg.set(v, indeg.get(v) - k); if (indeg.get(v) === 0) ready.push(v); }
    }
  }
  if (done !== all.length) errs.push(`V5 combinational cycle through ${all.filter(n => indeg.get(n.id) > 0).map(n => `%${n.id}`).join(", ")}`);
  const outs = new Map();                                        // V6: one driver per output name
  for (const n of all.filter(n => n.op === "out")) {
    if (outs.has(n.attrs.name)) errs.push(`V6 output ${n.attrs.name} driven by %${outs.get(n.attrs.name)} and %${n.id}`);
    outs.set(n.attrs.name, n.id);
  }
  return errs;
}
```

Two experiments show what `verify` can and cannot see. Damage the structure of F-13's graph, claiming that the product `%5` is 30 bits wide and stripping the constant's origin, and it reports both: `V3 %5: type {"signed":true,"width":30} but the rule gives {"signed":true,"width":36}` and `V8 %9: no provenance`. Change the meaning instead, turning the accumulator's `add` into a `sub` with a correctly derived type, and it reports nothing. The graph is well formed and computes the wrong thing.

That is D10, and the point the study curriculum raises about F-13 and F-14: structural invariants are not semantic equivalence. `verifyEach` catches a pass that corrupts the data structure. Only translation validation, or a scenario run before and after the pass (Chapter 11), catches a pass that corrupts the design.

### 10.9 The printed form

The printer writes one line per node, with the register's next value on its own line and the first source origin on the right. Here is F-13's multiply-accumulate, built through the API (10.12) and printed:

```text
%1 = in a : s18                         ← .in({ a: s(18) … })
%2 = in b : s18                         ← .in({ b: s(18) … })
%3 = in clear : u1                      ← .in({ clear: bit })
%4 = reg acc : s48                      ← .out("acc", s(48)), written in .seq
%4.next = %10
%5 = mul %1, %2 : s36                   ← $.a * $.b
%6 = sext %5 : s48                      ← +=
%7 = add %4, %6 : s49                   ← +=
%8 = wrap %7 : s48                      ← +=
%9 = const 0 : u1                       ← $.acc = 0
%10 = mux %3, %9, %8 : s48              ← if ($.clear)
%11 = out acc %4 : s48                  ← .out("acc", s(48))
```

Book 1's listing of the same graph folded `sext`, `add` and `wrap` into one line, `add %4, sext(%5) : s48 wrap`. The IR keeps them as three nodes because three passes treat them differently: `dsp.pack` absorbs the `sext` into a DSP's input, `dce`'s narrowing step drops the 49th bit, and `wrap` costs nothing at all.

### 10.10 A content hash and serialization

The pass manager of Chapter 11 caches analyses by graph hash, and the build cache of F-13's `c.cache()` stores results by content. Both need a hash that depends on what the graph computes, not on how its ids happened to be assigned. The hash below is a Merkle hash. Each node hashes its opcode, type, attributes and its operands' hashes. Registers and inputs hash by name, which breaks the cycles through registers. The graph hash combines the sorted hashes of its outputs and register next values.

```js
  hash() {
    const memo = new Map();
    const fnv = text => { let h = 0x811c9dc5; for (const ch of text) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h; };
    const h = id => {
      if (memo.has(id)) return memo.get(id);
      const n = this.node(id);
      const leaf = n.op === "reg" || n.op === "in";               // registers break cycles: hash them without next
      const { next, ...own } = n.attrs;                            // name, init, sync… all count; next is hashed below
      const v = fnv(JSON.stringify([n.op, n.type, leaf ? own : n.attrs, leaf ? [] : n.args.map(h)]));
      memo.set(id, v);
      return v;
    };
    const roots = this.nodes().flatMap(n => (n.op === "out" ? [h(n.id)] : n.op === "reg" ? [fnv(`${n.attrs.name}<-${h(n.attrs.next)}`)] : []));
    return fnv(roots.sort((x, y) => x - y).join(",")).toString(16);
  }

  toJSON() {
    return { version: 1, nodes: this.nodes().map(({ users, ...n }) => n) };
  }
```

F-13's graph hashes to `d5b3e5e6`. Built again after an unrelated constant has taken id 1, every id shifts by one (the product becomes `%6`), and the hash is still `d5b3e5e6`. Thirty-two bits is enough to key an in-memory cache; a build cache on disk should use a cryptographic hash of the same canonical text. Serialization drops the derived use lists, and loading rebuilds them along with the hash-cons table. A register's and an input's own attributes are part of their hash, so changing acc's reset value from 0 to 5 changes it (to 90511515); only attrs.next is left out, because it is hashed separately where the register's cycle is cut. A loaded graph must pass `verify` before any pass touches it.

### 10.11 The API passes use

F-14's passes call six methods. With the class above, each is a few lines.

| Method | Meaning |
| --- | --- |
| `g.nodes(op?)`, `g.count(op?)` | Nodes, optionally of some opcodes, in id order; their number |
| `n.users`, `n.args`, `n.type`, `n.origins` | The node record of R10.1 |
| `g.replace(old, new, pass)` | Redirect uses, merge provenance, re-canonicalize (10.5) |
| `g.duplicate(n, { copies })` | Copy a node and deal its users out among the copies |
| `g.warn(n, message)` | A diagnostic located at the node's first source origin |
| `g.print()`, `g.hash()` | 10.9 and 10.10 |

```js
  duplicate(id, { copies }) {
    const n = this.node(id), users = [...n.users].sort((x, y) => x - y);
    const ids = [id];
    for (let i = 1; i < copies; i++) {
      const c = this.create(n.op, n.args, n.type, { ...n.attrs, copy: i }, [...n.origins], n.domain);
      if (n.attrs.next) this.node(n.attrs.next).users.add(c);
      ids.push(c);
    }
    users.forEach((uid, j) => {
      const target = ids[j % copies];
      if (target === id) return;
      const user = this.node(uid);
      user.args = user.args.map(a => (a === id ? target : a));
      n.users.delete(uid); this.node(target).users.add(uid);
    });
    return ids;
  }

  warn(id, message, code = "lint") {
    const o = this.node(id).origins.find(x => x.file) ?? {};
    this.diagnostics.push({ severity: "warning", code, message, at: o.file ? `${o.file}:${o.line}` : `%${id}` });
  }
```

Run on F-14's `scaler`, the register `go` starts with 64 users, one per `y[i]` multiplexer. `duplicate(go, { copies: 4 })` leaves four registers with 16 users each, and `verify` stays clean. A copy's next value is the same node, so all four hold the same bit on every cycle. The 48-bit `$.now > $.deadline` comparison, checked by operand width as F-14's lint does, produces `{ severity: 'warning', code: 'lint', message: '48-bit comparison in one cycle', at: 'F-14-own-passes.js:53' }`.

### 10.12 Worked example: F-13 through the API

This is the code that built the graph printed in 10.9. Each call corresponds to one source construct, and each origin points at the line in `F-13-pass-pipeline.js` that wrote it.

```js
export function buildMac(g = new Graph()) {
  const at = (line, src) => ({ file: "F-13-pass-pipeline.js", line, src });
  const a = g.add("in", [], { type: s(18), attrs: { name: "a" }, origin: at(13, ".in({ a: s(18) … })") });
  const b = g.add("in", [], { type: s(18), attrs: { name: "b" }, origin: at(13, ".in({ b: s(18) … })") });
  const clear = g.add("in", [], { type: u(1), attrs: { name: "clear" }, origin: at(13, ".in({ clear: bit })") });
  const acc = g.add("reg", [], { type: s(48), attrs: { name: "acc", init: 0 }, origin: at(14, '.out("acc", s(48)), written in .seq') });
  const prod = g.add("mul", [a, b], { origin: at(17, "$.a * $.b") });
  const ext = g.add("sext", [prod], { attrs: { width: 48 }, origin: at(17, "+=") });
  const sum = g.add("add", [acc, ext], { origin: at(17, "+=") });
  const wrapped = g.add("wrap", [sum], { attrs: { type: s(48) }, origin: at(17, "+=") });
  const zero = g.add("const", [], { attrs: { value: 0 }, origin: at(16, "$.acc = 0") });
  const next = g.add("mux", [clear, zero, wrapped], { origin: at(16, "if ($.clear)") });
  g.setNext(acc, next);
  g.add("out", [acc], { type: s(48), attrs: { name: "acc" }, origin: at(14, '.out("acc", s(48))') });
  return { g, a, b, prod, sum };
}
```

The types in the printout were not written by hand. `mul` of two `s18` gave `s36`, `add` of `s48` and `s48` gave `s49`, and the `mux` of a `u1` constant with an `s48` arm gave `s48`, because `u1` is promoted to `s2` first. `verify` returns no errors.

### 10.13 Tests

- **Type rules.** Every row of book 1's width table and of 10.2 is a test of `resultType`, including mixed signedness and constants such as −1, 0, 1 and 255.
- **Hash-consing.** `a + b` and `b + a` must give one node, `a - b` and `b - a` must give two, and two registers must never merge.
- **Replace.** The cascade of 10.5 must leave one `add`. Every origin must survive, and `verify` must be clean afterwards.
- **Invariants.** Each of V1 to V8 needs a graph that breaks it alone. The suite must also include the meaning-changing `sub`, which must pass `verify`, as a reminder of what `verify` does not check. A node that uses one operand twice, such as y \* y, must not be reported as a cycle. The first version of V5 in this chapter did exactly that: it counted the in-degree as 2 and decremented it once, because a use list is a set.
- **Hash.** Identical graphs built in different orders must hash equally, and any change to an operand, a type or an attribute must change the hash.
- **Round trip.** `toJSON` followed by a load must reproduce the hash and pass `verify`.

### 10.14 Exercises

1. Replace the linear scans of `cons` in `recanon` and `remove` with a reverse map, and measure `replace` on a graph of 100,000 nodes.
2. Add the dynamic shift forms to `resultType` and to the simulator of Chapter 8, and test them against Z3's `bvshl` and `bvlshr`.
3. Write `explain(path)`. Given node ids along a timing path, print each node's source origins, with consecutive duplicates removed.
4. Implement `load(json)`, which rebuilds use lists and the hash-cons table and rejects a file that fails `verify`.
5. Make `hash()` incremental. When `replace` changes a node, recompute only the hashes of that node's transitive users.

### 10.15 Further study

- **Cooper and Torczon, Engineering a Compiler.** It covers intermediate representations, value numbering (the compiler-textbook name for hash-consing) and the trade-offs between graph and linear IRs.
- **Yosys documentation of RTLIL.** It describes a production hardware IR at the cell-and-wire level.
- **CIRCT dialect documentation.** It shows the same IR levels expressed as MLIR dialects, from FIRRTL down to `comb` and `seq`.
- **Izraelevitz et al., "Reusability is FIRRTL Ground" (ICCAD 2017).** It explains why a hardware IR is lowered in stages.
- **De Micheli, Synthesis and Optimization of Digital Circuits, Chapter 3.** It gives the formal models of hardware that these graphs encode.

## Chapter 11 · Passes

Examples: F-13, F-14 · Prerequisite: Chapter 10

This chapter builds the machinery that runs passes and four of the passes themselves. It then adds the three things that make an optimizer trustworthy. A rewrite engine compiles F-14's rule lambdas into graph patterns. An e-graph applies rules without committing to an order. A set of checks proves that a rule or a pass preserved meaning, as D10 requires, and names the guilty pass when it did not. Everything here runs on the `Graph` class of Chapter 10. Every listing was run with Node 22 and Z3 5.3.1, and the outputs are copied from those runs.

### 11.1 Specification

- **R11.1 Passes.** A pass is a record `{ name, level, requires, preserves, params, run(g, deps) }`. `requires` lists analyses. `preserves` lists the analysis names that stay valid after the pass, or is `"all"`. A readonly pass preserves all and must not change the graph hash.
- **R11.2 Analyses.** An analysis is `{ name, level, requires, run(g, deps) }`, and its value is a function of the graph alone. It is cached under its name and the graph's content hash (Chapter 10.10).
- **R11.3 Invalidation.** After a pass changes the graph, a cached analysis survives only if the pass lists it in `preserves`.
- **R11.4 Order.** Analyses are computed on demand, dependencies first. A cycle among analyses is an error.
- **R11.5 Fixpoints.** A stage marked `.fixpoint({ max })` repeats its passes until one full round leaves the hash unchanged, or until `max` rounds have run. Reaching the bound is reported.
- **R11.6 Obligations.** Every pass keeps V1 to V8 true, which `verifyEach` checks, and keeps the observables of D9 unchanged. Meaning is checked by translation validation when `c.validate()` is on, and by scenarios run at several levels.
- **R11.7 Rules.** A rule's `.from` and `.to` are hardware lambdas compiled to patterns, and `.where` is a builder lambda over the bindings. A replacement is brought to the matched node's type with `wrap` before it replaces that node.
- **R11.8 Rule checks.** A rule is screened at widths 1 to 16, signed and unsigned, when it is loaded. It is then proved at each concrete width and signedness where it fires, and each proof is cached by that pair (D10). A failure rejects the rule with the diagnostic `rule-unsound`.
- **R11.9 Bisection.** When a scenario's traces differ between two levels, the manager bisects the passes between them and names the first pass after which the scenario differs.

### 11.2 Meaning: a BigInt evaluator

Every check in this chapter compares meanings, so the first listing defines one. `computeNode` gives each opcode of Chapter 10.2 its bitvector meaning, with the same pattern-and-integer split as the Chapter 8 simulator. It uses BigInt, so every width works. Speed does not matter here, because the evaluator is the reference the fast paths are tested against.

```js
const big = n => BigInt(n);
export const toInt = (p, t) => (t.signed && p >= 1n << big(t.width - 1) ? p - (1n << big(t.width)) : p);
export const toPat = (v, t) => { const m = 1n << big(t.width); return ((v % m) + m) % m; };

export function computeNode(n, A, T) {          // n: node, A: operand patterns, T: operand types
  const I = i => toInt(A[i], T[i]), P = v => toPat(v, n.type), w = n.type.width;
  switch (n.op) {
    case "const": return P(big(n.attrs.value));
    case "add": return P(I(0) + I(1));
    case "sub": return P(I(0) - I(1));
    case "mul": return P(I(0) * I(1));
    case "neg": return P(-I(0));
    case "and": return P(I(0)) & P(I(1));
    case "or": return P(I(0)) | P(I(1));
    case "xor": return P(I(0)) ^ P(I(1));
    case "not": return P(~I(0));
    case "shl": return P(I(0) << big(n.attrs.by));
    case "shr": return P(A[0] >> big(n.attrs.by));
    case "ashr": return P(I(0) >> big(n.attrs.by));
    case "eq": return I(0) === I(1) ? 1n : 0n;
    case "ne": return I(0) !== I(1) ? 1n : 0n;
    case "lt": return I(0) < I(1) ? 1n : 0n;
    case "le": return I(0) <= I(1) ? 1n : 0n;
    case "gt": return I(0) > I(1) ? 1n : 0n;
    case "ge": return I(0) >= I(1) ? 1n : 0n;
    case "mux": return P(A[0] ? I(1) : I(2));
    case "concat": return A.reduce((acc, p, i) => (acc << big(T[i].width)) | p, 0n);
    case "slice": return (A[0] >> big(n.attrs.lo)) & ((1n << big(w)) - 1n);
    case "zext": return A[0];
    case "sext": return P(toInt(A[0], s(T[0].width)));
    case "wrap": case "out": return P(I(0));
    case "sat": {
      const lo = n.type.signed ? -(1n << big(w - 1)) : 0n, hi = n.type.signed ? (1n << big(w - 1)) - 1n : (1n << big(w)) - 1n;
      const v = I(0); return P(v < lo ? lo : v > hi ? hi : v);
    }
    default: throw new Error(`no meaning for ${n.op}`);
  }
}

export function evaluate(g, env) {
  const memo = new Map();
  const get = id => {
    if (memo.has(id)) return memo.get(id);
    const n = g.node(id);
    const v = n.op === "in" ? toPat(env.inputs[n.attrs.name] ?? 0n, n.type)
      : n.op === "reg" ? toPat(env.regs[n.attrs.name] ?? 0n, n.type)
      : computeNode(n, n.args.map(get), n.args.map(a => g.node(a).type));
    memo.set(id, v);
    return v;
  };
  const out = {}, next = {};
  for (const n of g.nodes("out")) out[n.attrs.name] = get(n.id);
  for (const n of g.nodes("reg")) next[n.attrs.name] = toPat(toInt(get(n.attrs.next), g.node(n.attrs.next).type), n.type);
  return { out, next };
}
```

Two cases deserve a sentence. `shr` shifts the pattern, so it is a logical shift even on a signed operand, while `ashr` shifts the integer. `sext` reads its operand's pattern as signed at the operand's own width, whatever the operand's declared signedness, because sign extension is defined on bits.

### 11.3 The pass manager

The manager answers three questions: which analyses a pass needs, which cached values are still valid, and when a stage is finished. Caching by content hash answers the second without trusting any pass about what it touched. If a pass changed nothing, the hash is the same and every cached analysis remains valid automatically. If it changed something, the cache entries keyed by the old hash are unreachable, except the ones the pass explicitly carries forward through `preserves`.

```js
export class PassManager {
  constructor(g) { this.g = g; this.cache = new Map(); this.log = []; }

  analysis(a, stack = []) {
    if (stack.includes(a.name)) throw new Error(`analysis cycle: ${[...stack, a.name].join(" → ")}`);
    const key = `${a.name}@${this.g.hash()}`;
    if (this.cache.has(key)) { this.log.push(`  reuse ${a.name}`); return this.cache.get(key); }
    const deps = {};
    for (const d of a.requires ?? []) deps[d.name] = this.analysis(d, [...stack, a.name]);   // depth-first = topological
    const value = a.run(this.g, deps);
    this.cache.set(key, value);
    this.log.push(`  run ${a.name}`);
    return value;
  }

  runPass(p) {
    const before = this.g.hash();
    const deps = {};
    for (const a of p.requires ?? []) deps[a.name] = this.analysis(a);
    p.run(this.g, { ...deps, ...(p.params ?? {}) });
    const after = this.g.hash();
    if (after !== before) {
      for (const [key, value] of [...this.cache]) {           // carry preserved analyses to the new graph
        const [name, h] = key.split("@");
        if (h === before && (p.preserves === "all" || (p.preserves ?? []).includes(name))) this.cache.set(`${name}@${after}`, value);
      }
    }
    if (this.verifyEach) {
      const errs = verify(this.g);
      if (errs.length) throw new Error(`after ${p.name}: ${errs[0]}`);
    }
    this.log.push(`pass ${p.name}${after === before ? " (no change)" : ""}`);
    return after !== before;
  }

  fixpoint(passes, max = 8) {
    for (let round = 1; round <= max; round++) {
      let changed = false;
      for (const p of passes) changed = this.runPass(p) || changed;
      if (!changed) return round;
    }
    this.log.push(`fixpoint: stopped at the bound of ${max} rounds`);
    return max;
  }
}
```

The recursion in `analysis` is a depth-first walk of the analysis dependency graph, so dependencies are always computed first: a topological order found on demand. The test uses `fanout`, `heavy` (which requires `fanout`) and a readonly `lint` pass that requires `heavy`. It runs `lint`, `lint` again, then `constFold`, then `lint` a third time. This is the log, which is what F-14's `c.explainPlan()` prints:

```text
  run fanout
  run heavy
pass lint (no change)
  reuse heavy
pass lint (no change)
pass constFold
  run fanout
  run heavy
pass lint (no change)
```

The second `lint` reuses `heavy` without even asking for `fanout`. `constFold` changed the graph and preserves nothing, so both analyses run again. The pass DAG that F-14 talks about is this structure: analyses form a DAG through `requires`, and passes are an ordered list within stages that draw on it.

### 11.4 Four core optimizations

The four passes below are the `optimize` stage of F-13. Each walks the graph in topological order, skips nodes that an earlier replacement removed, and edits through `replace`, so provenance and hash-consing are kept for free. Two helpers come first. `topo` counts repeated operands correctly; Chapter 10's first V5 did not. `extendTo` brings a replacement to the replaced node's type.

```js
export function topo(g) {
  const all = g.nodes(), indeg = new Map(all.map(n => [n.id, n.args.length]));
  const ready = all.filter(n => n.args.length === 0).map(n => n.id), order = [];
  while (ready.length) {
    const id = ready.shift(); order.push(id);
    for (const v of g.node(id).users) {
      const k = g.node(v).args.filter(a => a === id).length;
      if (k) { indeg.set(v, indeg.get(v) - k); if (indeg.get(v) === 0) ready.push(v); }
    }
  }
  return order;
}
const alive = (g, id) => g.nodes_.has(id);
export const extendTo = (g, id, type, pass) =>
  sameType(g.node(id).type, type) ? id : g.add("wrap", [id], { attrs: { type }, origin: { pass } });

export const constFold = {
  name: "constFold", preserves: [],
  run(g) {
    for (const id of topo(g)) {
      if (!alive(g, id)) continue;
      const n = g.node(id);
      if (!PURE.has(n.op) || n.op === "const" || !n.args.every(a => g.node(a).op === "const")) continue;
      const v = toInt(computeNode(n, n.args.map(a => computeNode(g.node(a), [], [])), n.args.map(a => g.node(a).type)), n.type);
      const value = v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
      g.replace(id, g.add("const", [], { attrs: { value, type: n.type }, origin: { pass: "constFold" } }), "constFold");
    }
  },
};

export const cse = {                                          // re-canonicalize after passes that edit in place
  name: "cse", preserves: [],
  run(g) { for (const id of topo(g)) if (alive(g, id)) g.recanon(id, "cse"); },
};

export const dce = {
  name: "dce", preserves: [],
  run(g) {
    const live = new Set(), stack = g.nodes(["out", "probe"]).map(n => n.id);
    while (stack.length) {
      const id = stack.pop();
      if (live.has(id)) continue;
      live.add(id);
      const n = g.node(id);
      stack.push(...n.args);
      if (n.op === "reg") stack.push(n.attrs.next);           // a live register keeps its next-state logic alive
    }
    for (const n of g.nodes("reg")) if (!live.has(n.id)) { g.node(n.attrs.next).users.delete(n.id); n.attrs.next = null; }
    for (const id of topo(g).reverse()) if (!live.has(id) && alive(g, id)) g.remove(id);
    g.liveBits = demandedBits(g);                             // the narrowing step: types stay, techmap builds fewer bits
  },
};

export const muxTree = {
  name: "muxTree", preserves: [],
  run(g) {
    for (const id of topo(g)) {
      if (!alive(g, id) || g.node(id).op !== "mux") continue;
      const n = g.node(id), [sel, a, b] = n.args, S = g.node(sel), A = g.node(a), B = g.node(b);
      let r = null;
      if (S.op === "const") r = big(S.attrs.value) ? a : b;                                  // constant select
      else if (a === b) r = a;                                                               // equal arms
      else if (A.op === "mux" && A.args[0] === sel) r = g.add("mux", [sel, A.args[1], b], { origin: { pass: "muxTree" } });
      else if (B.op === "mux" && B.args[0] === sel) r = g.add("mux", [sel, a, B.args[2]], { origin: { pass: "muxTree" } });
      if (r !== null) g.replace(id, extendTo(g, r, n.type, "muxTree"), "muxTree");
    }
  },
};
```

`dce` ends with a narrowing step. Removing dead nodes answers whether a node is used; the narrowing step answers how many of its bits are. It propagates *demanded bits* backwards from every output, probe and register input. For `add`, `sub`, `mul`, `neg`, the bitwise operators and the extensions, the low d bits of the result depend only on the low d bits of the operands, so a demand of d bits passes through unchanged. `wrap` caps the demand at its target width, a constant left shift by k lowers it by k, a `mux` passes it to both arms and demands one bit of the select, and every other operation (comparisons, right shifts, `sat`, table and memory reads) demands all of its operands' bits. The result is stored beside the graph, not in the nodes' types: types keep their D1 meaning, so V3 still holds, and `techmap` builds only the demanded bits. This is the step Chapters 1 and 10 refer to.

```js
const LOW = new Set(["add", "sub", "mul", "neg", "and", "or", "xor", "not", "zext", "sext"]);   // low bits need only low bits
export function demandedBits(g) {
  const live = new Map(g.nodes().map(n => [n.id, 0]));
  const need = (id, d) => live.set(id, Math.max(live.get(id), Math.min(d, g.node(id).type.width)));
  for (const n of g.nodes()) {                                // roots use every bit
    if (n.op === "out" || n.op === "probe") n.args.forEach(a => need(a, g.node(a).type.width));
    if (n.op === "reg" && n.attrs.next != null) need(n.attrs.next, n.type.width);
  }
  for (const id of topo(g).reverse()) {                       // every user before its operands
    const n = g.node(id), d = live.get(id);
    if (d === 0 || n.op === "reg") continue;
    if (LOW.has(n.op)) n.args.forEach(a => need(a, d));
    else if (n.op === "wrap") need(n.args[0], Math.min(d, n.attrs.type.width));
    else if (n.op === "slice") need(n.args[0], n.attrs.lo + d);
    else if (n.op === "shl") need(n.args[0], Math.max(0, d - n.attrs.by));
    else if (n.op === "mux") { need(n.args[0], 1); need(n.args[1], d); need(n.args[2], d); }
    else n.args.forEach(a => need(a, g.node(a).type.width));  // comparisons, right shifts, sat, rom, memories: every bit
  }
  return live;
}
```

Run on F-02's counter, lowered as in book 1's Chapter 2.5, `dce` keeps every node and the narrowing step reports that only eight bits of the decrement, the increment and the multiplexer between them are ever used, because `wrap(…)` into the `u8` register keeps eight. The adders that techmap builds are therefore 8 bits wide, not 9 and 10. The listing and this run were executed with Node 22:

```text
%5 sub s9  live 8 bits  ← $.value - 1
%6 add u9  live 8 bits  ← $.value + 1
%7 mux s10  live 8 bits  ← $.down ? … : …
verify: clean
```

- **constFold** evaluates a pure node whose operands are all constants and replaces it with a constant of the node's own type. Chapter 10's `attrs.type` exists for this. A constant of the narrowest type would change its users' derived types and break V3.
- **cse** re-canonicalizes every pure node. Hash-consing at construction and `recanon` inside `replace` already share most subexpressions. This pass catches what direct edits to `args` or `attrs` left behind.
- **dce** marks backward from outputs and probes. A register is live only if something observable depends on it, through any number of registers, so liveness follows `attrs.next` as well as `args`. A dead register's next-state edge is cut first; then dead nodes are removed users-first.
- **muxTree** applies four laws: a constant select picks an arm, equal arms are that arm, and an inner multiplexer on the same select collapses into its outer one (on either side). The replacement may be narrower than the multiplexer; `extendTo` wraps it to the multiplexer's type. That is safe because `unify` made the multiplexer wide enough for every value of either arm.

### 11.5 Termination

A fixpoint must stop. For these four passes the argument is a measure. constFold turns a non-constant node into a constant, cse and the first two mux laws remove a node, and the nested-mux laws remove one level of same-select nesting. dce only removes. A round that changes the graph therefore lowers the pair (non-constant nodes, nesting levels) in lexicographic order, and the pair cannot fall below zero.

Rewrite rules carry no such guarantee. A rule set containing `a * b → b * a` can loop forever in a greedy rewriter. That is why R11.5 has a bound, why reaching it is reported rather than ignored, and why F-14 runs its peephole rules through equality saturation (11.7), which is immune to that loop.

### 11.6 The rewrite engine

A rule is written as two hardware lambdas. The engine parses each with acorn, exactly as the front end parses hardware lambdas (Chapter 3), and converts the expression into a pattern tree: parameters become pattern variables, literals become constants, and operators become opcodes. The lambda's text is the pattern. There is no second rule language to learn.

```js
const BIN = { "+": "add", "-": "sub", "*": "mul", "&": "and", "|": "or", "^": "xor", "<<": "shl", ">>": "sr", "===": "eq", "<": "lt" };
const UN = { "~": "not", "-": "neg" };
const COMMUTATIVE = new Set(["add", "mul", "and", "or", "xor", "eq"]);
const HELPERS = { clog2: k => Math.ceil(Math.log2(k)) };

export function compileLambda(fn) {                         // (x, k) => x * k  →  { params, body: pattern tree }
  const e = acorn.parse(`(${fn.toString()})`, { ecmaVersion: "latest" }).body[0].expression;
  const params = e.params.map(p => p.name);
  const conv = x => {
    switch (x.type) {
      case "Identifier": if (params.includes(x.name)) return { v: x.name }; throw new Error(`unknown name ${x.name}`);
      case "Literal": return { k: x.value };
      case "BinaryExpression": return { op: BIN[x.operator], args: [conv(x.left), conv(x.right)] };
      case "UnaryExpression": return { op: UN[x.operator], args: [conv(x.argument)] };
      case "ConditionalExpression": return { op: "mux", args: [conv(x.test), conv(x.consequent), conv(x.alternate)] };
      case "CallExpression": return { call: x.callee.name, args: x.arguments.map(conv) };
      default: throw new Error(`not allowed in a rule: ${x.type}`);
    }
  };
  return { params, body: conv(e.body) };
}

function* matches(g, p, id, b) {                           // yields every binding that fits, not just the first
  const n = g.node(id);
  if (p.v) { if (b[p.v] === undefined) yield { ...b, [p.v]: id }; else if (b[p.v] === id) yield b; return; }
  if (p.k !== undefined) { if (n.op === "const" && big(n.attrs.value) === big(p.k)) yield b; return; }
  const sameOp = p.op === "sr" ? n.op === "shr" || n.op === "ashr" : n.op === p.op;   // >> follows the operand's type (D1)
  if (!sameOp) return;
  if (p.op === "shl" || p.op === "sr") { if (p.args[1].k === n.attrs.by) yield* matches(g, p.args[0], n.args[0], b); return; }
  if (n.args.length !== p.args.length) return;
  const orders = COMMUTATIVE.has(p.op) ? [n.args, [...n.args].reverse()] : [n.args];
  for (const args of orders) yield* matchArgs(g, p.args, args, 0, b);
}
function* matchArgs(g, ps, ids, i, b) {
  if (i === ps.length) { yield b; return; }
  for (const b2 of matches(g, ps[i], ids[i], b)) yield* matchArgs(g, ps, ids, i + 1, b2);
}

const view = (g, id) => { const n = g.node(id); return { id, isConst: n.op === "const", value: n.op === "const" ? Number(n.attrs.value) : undefined, ...n.type }; };

function build(g, t, b, origin) {
  if (t.v) return b[t.v];
  if (t.k !== undefined) return g.add("const", [], { attrs: { value: t.k }, origin });
  if (t.op === "shl" || t.op === "sr") {
    const x = build(g, t.args[0], b, origin);
    const op = t.op === "shl" ? "shl" : g.node(x).type.signed ? "ashr" : "shr";   // >> is arithmetic on a signed value
    return g.add(op, [x], { attrs: { by: constOf(g, t.args[1], b) }, origin });
  }
  return g.add(t.op, t.args.map(a => build(g, a, b, origin)), { origin });
}
function constOf(g, t, b) {
  if (t.k !== undefined) return t.k;
  if (t.v) return Number(g.node(b[t.v]).attrs.value);
  if (t.call) return HELPERS[t.call](...t.args.map(a => constOf(g, a, b)));
  throw new Error("a shift amount must be constant");
}

export function rewrite(name, from, where, to) {
  const lhs = compileLambda(from), rhs = to && compileLambda(to);
  return {
    name, preserves: [],
    run(g) {
      let fired = 0;
      for (const id of topo(g)) {
        if (!alive(g, id)) continue;
        for (const b of matches(g, lhs.body, id, {})) {       // the guard sees each binding; 8 * x binds k := 8 second
          if (where && !where(Object.fromEntries(Object.entries(b).map(([k, v]) => [k, view(g, v)])))) continue;
          const r = build(g, rhs.body, b, { pass: name });
          const ext = extendTo(g, r, g.node(id).type, name);
          if (ext !== id) { g.replace(id, ext, name); fired++; }
          break;
        }
      }
      this.fired = (this.fired ?? 0) + fired;
    },
  };
}
```

Three details make the engine correct rather than plausible.

- **Non-linear patterns.** `(c, a) => (c ? a : a)` uses `a` twice. `match` binds a variable on its first occurrence and requires the same node id on the second. Hash-consing makes "the same expression" and "the same id" coincide, so this check is exact.
- **Commutativity.** For commutative opcodes, `matches` tries both operand orders and yields every binding, and the `.where` guard runs on each. On `8 * x` the first binding is k := x, which the guard rejects, and the second is k := 8, which it accepts. A matcher that returned only the first binding would fire on `x * 8` and never on `8 * x`; both orders were run against the listing, and each fires once.
- **Width.** `x * 8` is `u12` when x is `u8`, because the constant 8 is `u4`. `x << 3` is `u11`. `extendTo` wraps the replacement to `u12` before `replace`, so no user's type changes.

The test graph contains all three of F-14's targets and some dead logic: a constant sum `3 + 5`, the product `x * K`, an unused `y * y`, a multiplexer with equal arms, `~~y`, and a register `idle` that nothing reads. Run to a fixpoint through `[constFold, cse, muxTree, the three F-14 rules, dce]` with `verifyEach` on, the graph goes from this:

```text
%1 = in x : u8                          ← x: u(8)
%2 = in y : u8                          ← y: u(8)
%3 = in en : u1                         ← en: bit
%4 = const 3 : u2                       ← 3
%5 = const 5 : u3                       ← 5
%6 = add %4, %5 : u4                    ← 3 + 5
%7 = mul %1, %6 : u12                   ← x * K
%8 = mul %2, %2 : u16                   ← y * y
%9 = mux %3, %7, %7 : u12               ← en ? x * K : x * K
%10 = not %2 : u8                       ← ~y
%11 = not %10 : u8                      ← ~~y
%12 = add %9, %11 : u13                 ← … + ~~y
%13 = reg idle : u4                     ← idle: u(4)
%13.next = %16
%14 = const 1 : u1                      ← 1
%15 = add %13, %14 : u5                 ← += 1
%16 = wrap %15 : u4                     ← += 1
%17 = out q %12 : u13                   ← q
```

to this, in two rounds, the second of which changed nothing:

```text
%1 = in x : u8                          ← x: u(8)
%2 = in y : u8                          ← y: u(8)
%12 = add %20, %2 : u13                 ← … + ~~y
%17 = out q %12 : u13                   ← q
%19 = shl %1 : u11
%20 = wrap %19 : u12                    ← x * K
```

The `wrap` inherited the origin of the multiply it replaced, so a later diagnostic about it still says `x * K`. The shift's only origin is the rule, so the printer shows no source text for it. "Multiply by a power of two" fired once and "double inversion" once. "Same value on both arms" fired zero times, because `muxTree` ran earlier in the list and had already applied the same law. Overlapping passes are normal, and with a greedy pipeline their order decides which one gets credit, or, in less benign cases, which result you get.

### 11.7 E-graphs and equality saturation

Greedy rewriting commits to each rewrite as it makes it, and a rewrite can destroy the match another rule needed. The demonstration uses three rules on `a * 3 + a * 5`: factor (`x*a + x*b → x*(a+b)`), "multiply by 2^n + 1" (`x * k → (x << n) + x`) and "multiply by a power of two". The same rules in the same order give different results depending only on where the rewriter looks first.

| Strategy | Result | Cost (illustrative) |
| --- | --- | --- |
| Greedy, root first | `a << 3` | 0 |
| Greedy, leaves first | `((a << 1) + a) + ((a << 2) + a)` | 6 |
| Equality saturation | `a << 3` | 0 |

Rewriting leaves first turns both products into shift-adds before the factoring rule can see the shared `a`. An e-graph avoids the choice. It stores many equivalent expressions at once, so a rewrite adds an alternative instead of replacing the original. The vocabulary is small.

- An **e-node** is an operator applied to e-classes, not to nodes.
- An **e-class** is a set of e-nodes known to be equal. Classes are merged with union-find.
- The **congruence invariant** says that two e-nodes with the same operator and equal argument classes are in the same class. After `a = b`, the nodes `~a` and `~b` must merge.
- **Rebuilding** restores congruence after a batch of merges, following egg's deferred approach: merges mark classes dirty, and `rebuild` repairs their parents once per batch rather than once per merge.
- **Saturation** repeats a read phase (find every match of every rule) and a write phase (instantiate each right side and merge it with the matched class), with a rebuild after each, until nothing changes or a bound is hit.
- **Extraction** picks, for each class, the cheapest e-node given its children's cheapest costs, by iterating to a fixpoint.

```js
export class EGraph {
  constructor() { this.parent = []; this.classes = new Map(); this.memo = new Map(); this.dirty = []; }

  find(a) { while (this.parent[a] !== a) { this.parent[a] = this.parent[this.parent[a]]; a = this.parent[a]; } return a; }
  canon(n) { return { op: n.op, value: n.value, args: n.args.map(a => this.find(a)) }; }
  key(n) { return `${n.op}|${n.value ?? ""}|${n.args.join(",")}`; }
  constOf(c) { return this.classes.get(this.find(c)).nodes.find(n => n.op === "const")?.value; }

  add(node) {
    const n = this.canon({ args: [], ...node }), k = this.key(n);
    if (this.memo.has(k)) return this.find(this.memo.get(k));
    const id = this.parent.length;
    this.parent.push(id);
    this.classes.set(id, { nodes: [n], parents: [] });
    for (const a of n.args) this.classes.get(a).parents.push([n, id]);
    this.memo.set(k, id);
    const vals = n.args.map(a => this.constOf(a));               // an e-class analysis: constant folding
    const fold = { add: (x, y) => x + y, sub: (x, y) => x - y, mul: (x, y) => x * y }[n.op];
    if (fold && vals.every(v => v !== undefined)) this.union(id, this.add({ op: "const", value: fold(...vals) }));
    return this.find(id);
  }

  union(a, b) {
    a = this.find(a); b = this.find(b);
    if (a === b) return false;
    if (b < a) [a, b] = [b, a];
    this.parent[b] = a;
    const A = this.classes.get(a), B = this.classes.get(b);
    A.nodes.push(...B.nodes); A.parents.push(...B.parents);
    this.classes.delete(b);
    this.dirty.push(a);
    return true;
  }

  rebuild() {                                                   // restore congruence: equal operands ⇒ one class
    while (this.dirty.length) {
      const todo = [...new Set(this.dirty.map(c => this.find(c)))];
      this.dirty = [];
      for (const c of todo) this.repair(c);
    }
  }

  repair(c) {
    const cls = this.classes.get(this.find(c));
    for (const [n, id] of cls.parents) {
      this.memo.delete(this.key(n));
      this.memo.set(this.key(this.canon(n)), this.find(id));
    }
    const fresh = new Map();
    for (const [n, id] of cls.parents) {
      const cn = this.canon(n), k = this.key(cn);
      if (fresh.has(k)) this.union(id, fresh.get(k)[1]);         // two parents became congruent
      fresh.set(k, [cn, this.find(id)]);
    }
    this.classes.get(this.find(c)).parents = [...fresh.values()];
  }

  *ematch(p, c, b = {}) {
    c = this.find(c);
    if (p.v) {
      if (b[p.v] === undefined) yield { ...b, [p.v]: c };
      else if (this.find(b[p.v]) === c) yield b;
      return;
    }
    for (const n of this.classes.get(c).nodes) {
      if (p.k !== undefined) { if (n.op === "const" && n.value === p.k) yield b; continue; }
      if (n.op === p.op && n.args.length === p.args.length) yield* this.matchArgs(p.args, n.args, 0, b);
    }
  }
  *matchArgs(ps, cs, i, b) {
    if (i === ps.length) { yield b; return; }
    for (const b2 of this.ematch(ps[i], cs[i], b)) yield* this.matchArgs(ps, cs, i + 1, b2);
  }

  instantiate(t, b) {
    if (t.v) return b[t.v];
    if (t.k !== undefined) return this.add({ op: "const", value: t.k });
    if (t.call) return this.add({ op: "const", value: HELPERS[t.call](...t.args.map(a => this.constOf(this.instantiate(a, b)))) });
    return this.add({ op: t.op, args: t.args.map(a => this.instantiate(a, b)) });
  }

  saturate(rules, { iters = 8 } = {}) {
    for (let i = 1; i <= iters; i++) {
      const found = [];                                         // read phase: match everything first …
      for (const r of rules) for (const c of [...this.classes.keys()]) for (const b of this.ematch(r.lhs, c))
        if (!r.where || r.where(b, this)) found.push([r, c, b]);
      let changed = false;                                      // … then write
      for (const [r, c, b] of found) changed = this.union(c, this.instantiate(r.rhs, b)) || changed;
      this.rebuild();
      if (!changed) return i;
    }
    return iters;
  }

  extract(root, cost) {
    const best = new Map();
    for (let changed = true; changed;) {
      changed = false;
      for (const [c, cls] of this.classes) for (const n of cls.nodes) {
        const kids = n.args.map(a => best.get(this.find(a)));
        if (kids.some(k => !k)) continue;
        const total = cost(n) + kids.reduce((t, k) => t + k.cost, 0);
        if (!best.has(c) || total < best.get(c).cost) { best.set(c, { cost: total, node: n }); changed = true; }
      }
    }
    const show = c => {
      const { node: n } = best.get(this.find(c));
      if (n.op === "const") return String(n.value);
      if (n.op === "var") return n.value;
      const a = n.args.map(show);
      return { not: `~${a[0]}`, mux: `(${a[0]} ? ${a[1]} : ${a[2]})` }[n.op] ?? `(${a[0]} ${SYM[n.op]} ${a[1]})`;
    };
    return { cost: best.get(this.find(root)).cost, term: show(root) };
  }
}
```

The rules reuse 11.6's `compileLambda`, so F-14's lambdas drive the e-graph unchanged. Commutativity becomes two harmless rules: in an e-graph, `a * b → b * a` adds one node to an existing class and then stops, because the class already contains both orders. Constant folding is an *e-class analysis*. When `add` creates an operator node whose arguments are all constant classes, it merges the node with the constant it equals. That is how `x * (3 + 5)` becomes a class containing `x * 8`, which the power-of-two rule can then match.

```js
export const rules = [
  rule("multiply by a power of two", (x, k) => x * k, (x, k) => x << clog2(k), (b, eg) => isPow2(konst(eg, b.k))),
  rule("same value on both arms", (c, a) => (c ? a : a), (c, a) => a),
  rule("double inversion", x => ~~x, x => x),
  rule("multiply by 2^n + 1", (x, k) => x * k, (x, k) => (x << clog2(k - 1)) + x, (b, eg) => konst(eg, b.k) > 2 && isPow2(konst(eg, b.k) - 1)),
  rule("factor", (x, a, b) => x * a + x * b, (x, a, b) => x * (a + b)),
  rule("commute *", (a, b) => a * b, (a, b) => b * a),
  rule("commute +", (a, b) => a + b, (a, b) => b + a),
];

// illustrative LUT costs: wiring is free, a multiplier is expensive
export const cost = n => ({ var: 0, const: 0, shl: 0, not: 1, xor: 1, and: 1, mux: 1, add: 2, sub: 2, mul: 20 })[n.op];
```

Three expressions went into one e-graph. After `a = b` in a separate graph, `~a` and `~b` share a class, which shows the congruence rebuild working. Saturation stopped after 3 rounds, growing the e-graph from 15 classes to 18, and extraction returned:

| Expression | Cheapest equivalent | Cost |
| --- | --- | --- |
| `~~((x ^ 5) * 8)` | `(x ^ 5) << 3` | 1 |
| `c ? y : y` | `y` | 0 |
| `a * 3 + a * 5` | `a << 3` | 0 |

These costs are illustrative, not a model of any part. In Weft, `std.passes.saturate(peephole, { cost: "luts" })` uses the cost of each opcode on the target family, and its e-nodes carry types in their keys, exactly as Chapter 10's hash-cons key does. Two terms of different types are never merged, and `instantiate` wraps a right side to its class's type, as `extendTo` does in the greedy engine.

### 11.8 Checking a rule (D10)

A rewrite rule is a claim that two expressions are equal at every width where it fires. F-14 now says that SAT screens each rule at widths 1 to 16 when it is loaded, then proves it again at the exact width of each match. The study curriculum asks why both are needed. A screen at small widths cannot establish a claim about all widths, and the counterexample is short:

| Rule | Screen, widths 1–16, signed and unsigned | Instance u20 | Instance u48 |
| --- | --- | --- | --- |
| `x * 8 → x << 3` | passes | — | proved |
| `x >> 16 → 0` | fails at s1, x = −1; passes all 16 unsigned widths | fails at x = 558,555 | fails: Z3's model is `x = #xffffffff0000` |

For every unsigned width up to 16, `x >> 16` is a single zero bit, so the second rule survives the 16 unsigned screened types. It fails on the signed ones: `>>` is arithmetic on a signed value (D1), so for `s1` and x = −1 it gives −1, not 0, and the screen rejects the rule at once. Had the rule been limited to unsigned operands, the screen would pass and the instance proof would still catch it: at 20 bits, 558,555 `>> 16` = 8. The instance proofs also covered `x * 8 → x << 3` at `s48` and `u64`, both `unsat`, that is, proved.

```js
function instance(rule, from, T) {
  const g = new Graph();
  const x = g.add("in", [], { type: T, attrs: { name: "x" }, origin: { file: "rule", line: 1, src: "x" } });
  const body = compileLambda(from).body;
  const build = p => (p.v ? x : p.k !== undefined ? g.add("const", [], { attrs: { value: p.k }, origin: { pass: "rule" } })
    : p.op === "shl" || p.op === "shr" ? g.add(p.op, [build(p.args[0])], { attrs: { by: p.args[1].k }, origin: { pass: "rule" } })
    : g.add(p.op, p.args.map(build), { origin: { pass: "rule" } }));
  const root = build(body);
  g.add("out", [root], { type: g.node(root).type, attrs: { name: "y" }, origin: { pass: "rule" } });
  const before = clone(g);
  rule.run(g);
  return { before, after: g };
}

// The screen: every value of x, at every width from 1 to 16, signed and unsigned.
export function screen(rule, from) {
  for (let w = 1; w <= 16; w++) for (const T of [u(w), s(w)]) {
    const { before, after } = instance(rule, from, T);
    const r = validate(before, after);
    if (!r.equal) return { ok: false, type: T, x: r.env.inputs.x };
  }
  return { ok: true };
}
```

The screen enumerates every input value. For a one-variable rule at 16 bits or fewer, that is a complete decision procedure and cheaper than calling a solver. Rules with more variables are bit-blasted into a miter instead: both sides, an XOR of their outputs, and a SAT query for a 1. The per-instance proof builds the same two graphs at the width where the rule fired and asks Z3 whether they can differ. For the failing `u48` instance of the second rule, the whole query is four lines:

```text
(declare-const x (_ BitVec 48))
(assert (not (= ((_ extract 47 16) x) ((_ zero_extend 31) (_ bv0 1)))))
(check-sat)
(get-value (x))
```

Why not prove each rule once for all widths? SMT-LIB fixes bitvector widths, so a width-parametric proof needs induction on the width or a richer logic. Weft does not need one. A build contains finitely many (rule, width, signedness) instances, each proof takes milliseconds, and the cache makes a rebuild pay nothing for instances it has already proved. The whole script, including all 32 screens of both rules, took 3.8 seconds; nearly all of it was the exhaustive screens.

### 11.9 Translation validation

A pass can be checked the same way a rule is: compare the graph before it with the graph after it. When no registers move, each output and each register's next value is a combinational function of the inputs and the current register values. Two graphs are equivalent if those functions agree everywhere. `validate` checks every assignment when the inputs and registers total 16 bits or fewer, and 2,000 seeded random assignments otherwise. A production build replaces the random fallback with the SAT miter of 11.8, applied to every output cone.

```js
export function validate(before, after, { vectors = 2000, seed = 1 } = {}) {
  const ins = before.nodes("in").map(n => n.attrs.name), regs = before.nodes("reg").map(n => n.attrs.name);
  const width = name => (before.nodes("in").find(n => n.attrs.name === name) ?? before.nodes("reg").find(n => n.attrs.name === name)).type.width;
  const names = [...ins, ...regs], bits = names.reduce((t, x) => t + width(x), 0);
  let a = seed >>> 0;
  const rnd = () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a; };
  const exhaustive = bits <= 16, count = exhaustive ? 1 << bits : vectors;
  for (let k = 0; k < count; k++) {
    const env = { inputs: {}, regs: {} };
    let rest = big(k);
    for (const x of names) {
      const w = width(x);
      const v = exhaustive ? rest & ((1n << big(w)) - 1n) : (big(rnd()) << 32n | big(rnd())) & ((1n << big(w)) - 1n);
      rest >>= big(w);
      (ins.includes(x) ? env.inputs : env.regs)[x] = v;
    }
    const p = evaluate(before, env), q = evaluate(after, env);
    for (const [kind, A, B] of [["out", p.out, q.out], ["next", p.next, q.next]])
      for (const x of Object.keys(B))                   // registers the pass removed were unobservable
        if (A[x] !== B[x]) return { equal: false, kind, signal: x, env, before: A[x], after: B[x] };
  }
  return { equal: true, checked: count, exhaustive };
}
```

The first version compared every register of the original graph, and it reported that `dce` had broken the design: the register `idle` had no next value afterwards. It had none because `dce` removed it, which is correct, since nothing observable read it. Comparing only registers that survive is sound, because the outputs are compared over every value of every register, removed ones included. A removed register on which an output depended would show up as a difference in that output.

Now the case validation exists for. `badFold` folds a constant `add` as if it were `sub`. After it runs, `verify` reports nothing. `validate` reports `{ kind: "out", signal: "q", inputs: { x: 219, y: 197, en: 1 }, before: 1949, after: 3263 }`: `3 + 5` became `3 - 5 = -2`, which is 14 as a `u4` pattern, and 219 × 14 + 197 = 3263. This is D10 again, now as code. `verifyEach` checks the data structure; `validate` checks the design.

Passes that move registers, `pipeline.cut` and `retime` in the `time` stage, break the correspondence between registers, so combinational equivalence does not apply. Their check is sequential and uses D9's contract: cycle-exact on ordinary observables, beat sequences on pipelined stream paths. Chapters 12 and 15 build it.

### 11.10 Bisecting a pass list

When a scenario passes at `dag` and fails at `net`, some pass in between is wrong. Rerunning the scenario after every pass costs one run per pass. Binary search costs about log2 of the number of passes, provided a pass that breaks the design stays broken after later passes, which is the usual case.

```js
export function bisect(g0, passes, scenario) {
  const after = i => { const g = clone(g0); for (const p of passes.slice(0, i)) p.run(g); return g; };
  const ref = JSON.stringify(scenario(g0), (k, v) => (typeof v === "bigint" ? v.toString() : v));
  const same = i => JSON.stringify(scenario(after(i)), (k, v) => (typeof v === "bigint" ? v.toString() : v)) === ref;
  let lo = 0, hi = passes.length, runs = 1;
  if (same(hi)) return { culprit: null, runs };
  while (hi - lo > 1) {                                       // prefix lo agrees, prefix hi differs
    const mid = (lo + hi) >> 1; runs++;
    if (same(mid)) lo = mid; else hi = mid;
  }
  return { culprit: passes[hi - 1].name, index: hi, runs: runs + 1 };
}
```

With eight passes, `badFold` fifth, and a scenario that evaluates `q` for four values of x, the result is `{ culprit: "badFold", index: 5, runs: 5 }`: the reference, the full list, and three halvings. When a failure needs two passes together, or appears and then disappears, binary search can blame the wrong pass. Zeller's delta debugging generalizes the search to isolate a minimal failure-inducing subset, at the cost of more runs.

### 11.11 Worked example: F-14's pipeline on this machinery

Each call in F-14's `.compile()` maps onto something built in this chapter:

| F-14 | Here |
| --- | --- |
| `c.use(std.pipeline.default)` | Stages of passes run by `PassManager`, `optimize` as a `fixpoint` |
| `.after("lower", s => s.pass(wideCompares))` | A readonly pass: `preserves: "all"`, no hash change, every cached analysis survives |
| `.after("optimize", s => s.pass(std.passes.saturate(peephole, …)))` | `EGraph.saturate` over the three rules, then `extract` with the family's costs |
| `.before("techmap", s => s.pass(splitFanout.with({ limit: 16 })))` | A pass that `requires` `fanout` and timing; the manager computes or reuses them, and `g.duplicate` does the work |
| `.explainPlan()` | The manager's log, as printed in 11.3 |
| `{ levels: ["hir", "dag", "net"] }` | Scenario traces compared, then `bisect` between the first two levels that disagree |

### 11.12 Tests

- **Manager.** The log of 11.3 must be reproduced exactly, including the reuse. An analysis cycle must raise an error naming the cycle.
- **Passes.** Each pass is validated against the evaluator on generated graphs: every opcode, mixed signedness, repeated operands, and dead registers.
- **Fixpoint.** The demo must converge in two rounds. A rule set containing commutativity in the greedy engine must stop at the bound and say so.
- **Rewrites.** Every rule's `.examples()` from F-14 must pass, including the `null` example, which must not match.
- **E-graph.** The congruence check of 11.7, the three extractions, and the greedy strategy table must all reproduce.
- **Rule checks.** `x >> 16 → 0` must be rejected by the screen at s1, and by an instance proof at any unsigned width above 16, and `x * 8 → x << 3` accepted at `u48`, `s48` and `u64`.
- **Bisection.** A deliberately broken pass placed at each position of an eight-pass list must be found in at most five runs.

### 11.13 Exercises

1. Implement the SAT-miter fallback for `validate`, using Chapter 9's SMT encoding of the whole output cone instead of random vectors.
2. Make `saturate` typed. Put the type in each e-node key, and have `instantiate` wrap the right side to the class's type.
3. Add a node budget to `saturate`, as egg does, and find the smallest budget at which `a * 3 + a * 5` still reaches `a << 3`.
4. Write `.examples()` checking for `rewrite` records. Build each left lambda over a 16-bit input, run the rule, and compare with the right lambda by `validate`.
5. Give `muxTree` a fifth law, `c ? 1 : 0 → c`, and prove it with the screen and the instance proof of 11.8.

### 11.14 Further study

- **De Micheli, Synthesis and Optimization of Digital Circuits, Chapters 7 and 8.** They cover two-level and multilevel combinational optimization, the classical setting of these passes.
- **Hachtel and Somenzi, Logic Synthesis and Verification Algorithms.** It treats multilevel minimization and the verification side together.
- **Willsey et al., "egg: Fast and Extensible Equality Saturation" (POPL 2021).** It introduced the deferred rebuilding and e-class analyses used in 11.7.
- **CS 6120 blog post on e-graph technology mapping.** It applies the same machinery to choosing FPGA cells, which is where Chapter 13 picks up.

## Chapter 12 · Clocks and timing

Examples: F-10, F-15, F-18 · Prerequisite: Chapter 11

This chapter implements everything in Weft that is measured in nanoseconds rather than cycles. It covers which clock each node belongs to, how values cross between clocks, how PLL settings are found, how long each path takes, and how latency is added and registers moved to meet a period. Every listing below was run with Node 22 in a scratch folder, and the outputs shown are from those runs. Delay numbers are illustrative, chosen so the arithmetic is visible; they are not data-sheet values.

### 12.1 Specification

- **R12.1 Domains.** A design's clock domains are those declared by `.clocks()`. With no `.clocks()` there is one domain, `sys`, driven by the board's main clock (D14). `c.port(name, { hz })` declares a domain driven from outside, for IP blocks.
- **R12.2 Membership.** Every `reg`, `mem` and `in` node belongs to exactly one domain: its module's `.domain()`, `sys` by default. A `const` belongs to none.
- **R12.3 Propagation.** A combinational node's domain is the join of its arguments' domains. A node whose arguments come from two domains is an error `cdc`.
- **R12.4 Sinks.** A register whose next value lies in another domain is an error `cdc`, unless the register is the first stage of a crossing, marked sync (R10.6).
- **R12.5 Crossings.** `stream().cross({ from, to })` lowers by its buffer: depth 1 with `latest` becomes a toggle handshake; depth 2 or more becomes an asynchronous FIFO with Gray-coded pointers, its depth rounded up to a power of two. A bound input pin gets two flip-flops (D6).
- **R12.6 Synchronizer depth.** A synchronizer has two flip-flops, or three when the MTBF computed for its destination frequency falls below the design's floor (default 1000 years). In simulation each synchronizer delays a transfer by 2 or 3 destination cycles, chosen per transfer by the seeded generator (D15), so a design that depends on an exact crossing latency fails a test.
- **R12.7 PLL.** All outputs derived from one input clock are solved together on one VCO. An output declared as an exact multiple of another, as `std.video.hdmi` declares its ×5 clock, must be exact; the others must fall within their tolerance (default 0.1 %). No setting is an error `pll`.
- **R12.8 Timing.** Within a domain, every register-to-register path must fit the period. The `timing` pass reports slack per domain and the worst path with provenance; a negative slack is an error `timing`. Paths that end at a crossing's sync register are excluded, except Gray pointer buses, which receive a maximum delay of one destination period.
- **R12.9 Latency.** Only stream paths marked `.pipelined()` may gain latency. `pipeline.cut` adds stages there; each inserted stage carries the path's valid bit and is enabled by the path's stall signal.
- **R12.10 Retiming.** `retime` moves registers only inside `.pipelined()` regions, never across a stall-enable boundary and never across a register whose reset value is observable. Forward moves are the default. `moves: "both"` is legal because data registers on pipelined paths carry no reset; only their valid bits reset (D13).

### 12.2 Domain propagation: checks.cdc

The domains form a lattice. The bottom element is "no domain", which constants have. Above it sit the named domains, all incomparable. The top element is a conflict. The join of two domains is the domain itself when they are equal and a conflict otherwise. A node's domain is the join over its arguments, which is a dataflow analysis in the ordinary sense.

A dataflow analysis on a cyclic graph iterates a worklist until nothing changes. The Weft DAG has no combinational cycles, because registers cut every cycle (Chapter 10), so one pass in topological order reaches the fixpoint. Registers, inputs and memories are sources with a fixed domain. A crossing at this level is a chain of registers in the destination domain whose first stage is marked sync (R10.6), so it needs no special node. The second loop checks the sinks: each register's next value, held in attrs.next, must lie in the register's own domain, except for a sync register, which is allowed to load from another domain.

```js
// checks.cdc: every node's domain is the join of its sources' domains.
// Lattice: null (no domain: constants) < 'sys', 'pix', … < CONFLICT.
const CONFLICT = Symbol('conflict');
const join = (a, b) => (a === null ? b : b === null ? a : a === b ? a : CONFLICT);

export function checkDomains(nodes) {            // nodes in topological order (args before users)
  const dom = new Map(), src = new Map(), diags = [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const n of nodes) {
    if (n.op === 'reg' || n.op === 'in' || n.op === 'mem') { dom.set(n.id, n.domain); src.set(n.id, n.id); continue; }
    if (n.op === 'const') { dom.set(n.id, null); continue; }
    let d = null, s = null;
    for (const a of n.args) {
      const j = join(d, dom.get(a));
      if (j === CONFLICT) {
        diags.push(`error cdc: ${n.id} mixes ${byId.get(s).id} (${d}) and ${byId.get(src.get(a)).id} (${dom.get(a)})`);
        break;
      }
      if (j !== d) { d = j; s = src.get(a); }
    }
    dom.set(n.id, d); src.set(n.id, s);
  }
  for (const n of nodes) {                       // sinks: a register's next value (R10.4: attrs.next)
    const next = n.attrs?.next;
    if (n.op === 'reg' && next != null && !n.attrs.sync) {   // a sync register is a crossing's first stage (R10.6)
      const d = dom.get(next);
      if (d !== null && d !== CONFLICT && d !== n.domain)
        diags.push(`error cdc: ${n.id} (${n.domain}) is loaded from ${src.get(next)} (${d}) without a crossing`);
    }
  }
  return { dom, diags };
}
```

The test graph is F-10 by hand, with two mistakes added: the `.cross()` line removed, so `raster.sx` loads `physics.x` directly, and a subtraction `beam.x - physics.x` that reads across domains. The function reports both. With the crossing restored as a `cell` whose far side is in `pix`, it reports nothing.

```text
[ 'error cdc: oops mixes beam.x (pix) and physics.x (sys)',
  'error cdc: raster.sx (pix) is loaded from physics.x (sys) without a crossing' ]
[]
```

The diagnostic names the two sources rather than the node where they met. A designer recognizes `physics.x` and `beam.x`; an anonymous subtractor in the DAG means nothing to them. The real pass adds the source line of each source from its provenance record (Chapter 10).

### 12.3 The crossing library

A crossing exists because a flip-flop that samples a signal changing within its setup and hold window may enter a metastable state, and its output settles at an unpredictable time. The probability that it has not settled after a resolution time t\_r falls exponentially. Each crossing primitive gives the first flip-flop enough time to settle before anyone reads it.

```latex
\mathrm{MTBF} = \frac{e^{t_r / \tau}}{T_0 \, f_{clk} \, f_{data}}, \qquad t_r = (n - 1)\,(T_{clk} - t_{cq} - t_{su})
```

τ and T\_0 are properties of the flip-flop, characterized per family; Weft's library stores them as data with a note of their source. f\_clk is the destination clock and f\_data is the rate of changes at the input. Each extra stage adds a full period minus the clock-to-output and setup overhead, never a full period.

| Primitive | Chosen for | Cost | Latency | Throughput |
| --- | --- | --- | --- | --- |
| Two flip-flops | A level bit, such as a bound input pin | 2 flip-flops | 2 destination cycles | Slowly changing levels only |
| Toggle handshake | `.buffer(1, { overflow: "latest" })` | Data register, two 2-flop synchronizers, edge detectors | About 2 destination + 2 source cycles per transfer | One value per round trip |
| Asynchronous FIFO | Depth 2 or more | N × W RAM, two Gray pointers, two 2-flop synchronizers | At least 3 destination cycles | One word per cycle of the slower clock |

The toggle handshake follows four rules. The sender holds its data register stable and flips `req`. The receiver synchronizes `req`, detects the change, captures the data and flips `ack`. The sender synchronizes `ack` and may load new data only when `ack` equals `req` again. With `latest`, a value that arrives while a transfer is in flight overwrites the pending value, so the receiver always gets the newest position, as F-10 wants.

The asynchronous FIFO is Cummings' design. Each side keeps a binary pointer with one extra bit and publishes its Gray code, in which consecutive values differ in one bit. A synchronizer that samples a Gray pointer mid-change therefore sees either the old value or the new one, never a third. Empty is true when the read pointer equals the synchronized write pointer. Full is true when the write pointer equals the synchronized read pointer with its top two bits inverted.

```js
const toGray = b => b ^ (b >> 1);

function asyncFifo(depthLog2) {
  const N = 1 << depthLog2, mask = (N << 1) - 1;   // pointers carry one extra bit to tell full from empty
  const top2 = 3 << (depthLog2 - 1);               // the two most significant bits of a Gray pointer
  const mem = new Array(N);
  const w = { bin: 0, gray: 0, rq1: 0, rq2: 0 };    // write side; rq1, rq2 synchronize the read pointer
  const r = { bin: 0, gray: 0, wq1: 0, wq2: 0 };    // read side; wq1, wq2 synchronize the write pointer
  const full = () => w.gray === (w.rq2 ^ top2);    // Cummings: top two bits inverted, the rest equal
  const empty = () => r.gray === r.wq2;
  return {
    full, empty,
    writeEdge(push, data) {
      const accept = push && !full();              // decided from pre-edge state
      w.rq2 = w.rq1; w.rq1 = r.gray;               // two flip-flops on the crossing
      if (accept) { mem[w.bin & (N - 1)] = data; w.bin = (w.bin + 1) & mask; w.gray = toGray(w.bin); }
      return accept;
    },
    readEdge(pop) {
      const take = pop && !empty();
      const d = take ? mem[r.bin & (N - 1)] : undefined;
      r.wq2 = r.wq1; r.wq1 = w.gray;
      if (take) { r.bin = (r.bin + 1) & mask; r.gray = toGray(r.bin); }
      return d;
    },
  };
}
```

The first version of this model was wrong in an instructive way: it shifted the synchronizer before deciding `full`, so the decision used a post-edge value and the order check failed at word 10. In hardware every register updates from pre-edge values, and the model must decide before it updates. The corrected model ran with F-10's two clocks, a 10 000 ps writer and a 39 722 ps reader (25.175 MHz), on a depth-8 FIFO.

```text
{ written: 100007, read: 100000, writeEdgesBlockedByFull: 297217, simulatedMs: 3.972 }
0000 0001 0011 0010 0110 0111 0101 0100 1100
```

All 100 000 words arrived in order. The reader took one word per cycle, 100 000 words in 3.972 ms, which is 25.175 million per second. The writer was refused on 297 217 of its edges because it runs four times faster. The second line is the Gray sequence for 0 to 8, one bit changing per step. The emitted constraints give each pointer bus a maximum delay of one destination period, so bits that change together also arrive together.

### 12.4 Solving the PLL

A 7-series MMCM produces each output as f\_out = f\_in × M / (D × O). Its parameters have ranges, its phase detector and VCO have frequency windows, and only the first output divider accepts fractional values. Choosing parameters is a small constrained search, and it must cover every output on the same VCO at once.

```js
// Limits for an Artix-7, speed grade -1, as given in DS181/UG472 (check them before relying on them).
const LIM = { vco: [600e6, 1200e6], pfd: [10e6, 450e6], M: [2, 64, 0.125], D: [1, 106], O: [1, 128], O0: [2, 128, 0.125] };

const range = (lo, hi, step = 1) => Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, i) => lo + i * step);

// outputs: [{ name, hz, tol }] or [{ name, ratioOf: 'pix', k: 5 }] (exactly k times another output)
export function solveMMCM(fin, outputs) {
  const base = outputs.find(o => o.hz);
  const tied = outputs.filter(o => o.ratioOf === base.name);
  let best = null, tried = 0;
  for (const D of range(...LIM.D)) {
    const pfd = fin / D;
    if (pfd < LIM.pfd[0] || pfd > LIM.pfd[1]) continue;
    for (const M of range(...LIM.M)) {
      const vco = pfd * M;
      if (vco < LIM.vco[0] || vco > LIM.vco[1]) continue;
      // the base output may use the fractional CLKOUT0 only if nothing is tied to it
      const steps = tied.length ? range(...LIM.O) : range(...LIM.O0);
      for (const O of steps) {
        tried++;
        const hz = vco / O, err = Math.abs(hz - base.hz) / base.hz;
        if (err > base.tol) continue;
        // a tied output divides the same VCO by O / k, which must itself be a legal integer divider
        const outs = { [base.name]: { O, hz } };
        let ok = true;
        for (const t of tied) {
          const Ot = O / t.k;
          if (!Number.isInteger(Ot) || Ot < LIM.O[0]) { ok = false; break; }
          outs[t.name] = { O: Ot, hz: vco / Ot };
        }
        if (!ok) continue;
        const cand = { M, D, vco, err, outs };
        // smallest error, then the highest VCO (less jitter), then the smallest D
        if (!best || err < best.err - 1e-12 || (Math.abs(err - best.err) < 1e-12 && (vco > best.vco || (vco === best.vco && D < best.D)))) best = cand;
      }
    }
  }
  return { best, tried };
}
```

| Request (input 100 MHz) | M | D | VCO | Dividers | Outputs | Error | Settings tried |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 25.175 MHz alone | 9 | 1 | 900 MHz | 35.75 | 25.1748 MHz | 0.0007 % | 1 382 330 |
| 25.175 MHz and exactly ×5 | 17.625 | 2 | 881.25 MHz | 35 and 7 | 25.1786 and 125.8929 MHz | 0.0142 % | 175 360 |

The first row is the best setting for the pixel clock alone. It is useless for F-10, because `std.video.hdmi` asks for a ×5 clock from the same VCO, and 35.75 / 5 = 7.15 is not a legal integer divider. The joint search finds the second row, whose two outputs share a VCO and stand in an exact 5 : 1 ratio. Its error, 0.014 %, is far inside VGA's tolerance. Other families have other formulas: an iCE40 PLL has DIVR, DIVF, DIVQ and a filter range. Weft keeps one solver interface and one table of limits per family.

### 12.5 Static timing analysis

Static timing analysis computes, for every node, the time its value settles after the clock edge, and the latest time it may settle without breaking a register downstream. Both are passes over the DAG.

```latex
a(n) = \max_{m \in \mathrm{args}(n)} a(m) + d(n), \quad q(n) = \min_{u \in \mathrm{users}(n)} \big(q(u) - d(u)\big), \quad \mathrm{slack}(n) = q(n) - a(n)
```

Sources (register outputs and registered inputs) start at t\_cq. Sinks (register inputs) are required at T − t\_su. A negative slack means the path is too long. Before placement, d(n) comes from a per-family table indexed by operator and width; after routing, it comes from the router's own timing report, which nextpnr and Vivado both write.

```js
const T_CQ = 0.4, T_SU = 0.1;
const DELAY = { in: 0, const: 0, mul8: 2.6, sub: 0.9, add: 1.0, shr: 0, sat: 0.6, rom256: 1.4 };
const delay = n => DELAY[n.kind ?? n.op];

export function sta(nodes, period) {
  const byId = new Map(nodes.map(n => [n.id, n])), arr = new Map(), req = new Map();
  const users = new Map(nodes.map(n => [n.id, []]));
  for (const n of nodes) for (const a of n.args ?? []) users.get(a).push(byId.get(a).op === 'const' ? null : n);
  for (const n of nodes) {                                    // forward, in topological order
    if (n.op === 'const') continue;
    const start = n.op === 'in' ? T_CQ : Math.max(...n.args.filter(a => arr.has(a)).map(a => arr.get(a)));
    arr.set(n.id, start + delay(n));
  }
  for (const n of [...nodes].reverse()) {                     // backward
    if (n.op === 'const') continue;
    const us = users.get(n.id).filter(Boolean);
    req.set(n.id, n.sink ? period - T_SU : Math.min(...us.map(u => req.get(u.id) - delay(u))));
  }
  return [...arr.keys()].map(id => ({ id, arrival: +arr.get(id).toFixed(2), required: +req.get(id).toFixed(2),
                                      slack: +(req.get(id) - arr.get(id)).toFixed(2) }));
}

// explain(): the worst path, walked back from the worst sink through the latest-arriving argument.
export function explain(nodes, table) {
  const row = new Map(table.map(r => [r.id, r])), byId = new Map(nodes.map(n => [n.id, n]));
  let n = nodes.filter(x => x.sink).sort((a, b) => row.get(a.id).slack - row.get(b.id).slack)[0];
  const path = [];
  while (n) {
    path.unshift(n.src ?? n.id);
    const args = (n.args ?? []).filter(a => row.has(a));
    n = args.length ? byId.get(args.reduce((a, b) => (row.get(a).arrival >= row.get(b).arrival ? a : b))) : null;
  }
  return path.join(' → ');
}
```

The test graph is F-18's `blend`, one cycle from the input register to the output register, at 300 MHz (T = 3.333 ns).

| Node | Source text | Arrival (ns) | Required (ns) | Slack (ns) |
| --- | --- | --- | --- | --- |
| `l.alpha` | input register | 0.40 | −4.27 | −4.67 |
| `inv` | `255 - l.alpha` | 1.30 | −3.37 | −4.67 |
| `p1` | `l.fg * l.alpha` | 3.00 | −0.77 | −3.77 |
| `p2` | `l.bg * (255 - l.alpha)` | 3.90 | −0.77 | −4.67 |
| `s1`, `s2` | the two additions | 4.90, 5.90 | 0.23, 1.23 | −4.67 |
| `idx` | `sat(mix, u(8))` | 6.50 | 1.83 | −4.67 |
| `g` | `GAMMA[…]` | 7.90 | 3.23 | −4.67 |

`explain()` printed `l.alpha → 255 - l.alpha → l.bg * (…) → p1 + p2 → + 128 → >> 8 → sat(mix, u(8)) → GAMMA[…]`. Every node on the critical path carries the same slack, which is how a critical path is recognized. Because each node carries its source text, this path is exactly the dossier F-18's closer receives (Chapter 15).

### 12.6 pipeline.cut

A `.pipelined()` path may gain latency, so the compiler may cut it into stages. The pass gives each node a stage number and a local arrival time. A node starts in the latest stage among its arguments. An argument from an earlier stage arrives from a register, t\_cq after the edge. If the node would end after the stage's budget, T − t\_su, it moves to the next stage. Each value then crosses one register for every stage boundary between its producer and a user.

```js
export function cut(nodes, period) {
  const byId = new Map(nodes.map(n => [n.id, n])), st = new Map(), t = new Map(), budget = period - T_SU;
  const live = a => byId.get(a).op !== 'const';                // constants are available in every stage
  const problems = [];
  for (const n of nodes) {
    if (n.op === 'const') continue;
    if (n.op === 'in') { st.set(n.id, 0); t.set(n.id, T_CQ); continue; }
    const args = n.args.filter(live), d = DELAY[n.kind ?? n.op];
    let s = Math.max(...args.map(a => st.get(a)));
    // an argument made in an earlier stage comes out of a register, T_CQ after the stage's edge
    let at = Math.max(...args.map(a => (st.get(a) === s ? t.get(a) : T_CQ))) + d;
    if (at > budget) { s += 1; at = T_CQ + d; }               // too late: start this node one stage later
    if (at > budget) problems.push(`${n.id} alone takes ${d} ns: it needs registers inside it`);
    st.set(n.id, s); t.set(n.id, at);
  }
  const regs = new Set();                                      // one register per value per boundary crossed
  for (const n of nodes) for (const a of (n.args ?? []).filter(live))
    for (let k = st.get(a); k < st.get(n.id); k++) regs.add(`${a} after stage ${k}`);
  return { stage: Object.fromEntries([...st].map(([id, s]) => [id, `${s} (ends at ${t.get(id).toFixed(1)} ns)`])),
           registers: [...regs], latency: Math.max(...st.values()), problems };
}
```

| Stage | Nodes (end time in the stage) | Values registered at its end |
| --- | --- | --- |
| 0 | `inv` (1.3 ns), `p1` (3.0 ns) | `l.bg`, `inv`, `p1` |
| 1 | `p2` (3.0 ns) | `p1` again, `p2` |
| 2 | `s1` (1.4 ns), `s2` and `mix` (2.4 ns), `idx` (3.0 ns) | `idx` |
| 3 | `g` (1.8 ns) | the output |

The pass added three cycles of latency. Three is the minimum for these delays: `255 - l.alpha` followed by a multiply takes 3.5 ns, more than the 2.83 ns a stage allows after t\_cq, so a boundary must fall between them, and the rest of the path needs two more. A greedy assignment can leave stages unbalanced; retiming, next, moves registers to even them out. In a DSP48E1 the multiply's own pipeline register (MREG) would split it, which is why `dsp.pack` runs before the stage count is final.

### 12.7 Retiming

Leiserson and Saxe model a synchronous circuit as a graph. Each vertex v is a combinational element with delay d(v); each edge e from u to v carries w(e) registers. A retiming is an integer r(v) per vertex, the number of registers moved from its outputs to its inputs, and it changes each edge's count as follows.

```latex
w_r(e) = w(e) + r(v) - r(u) \ge 0 \quad \text{for every edge } e: u \to v
```

Around any cycle the r terms cancel, so retiming preserves the register count on every cycle. That one fact explains what retiming can and cannot do. It cannot change the number of registers in an accumulator's feedback loop. Through the host vertex, which stands for the outside world, it cannot change the latency from inputs to outputs. Latency must come from `pipeline.cut`; retiming only places it.

To test whether a period c is reachable, compute two matrices. W(u, v) is the fewest registers on any path from u to v. D(u, v) is the largest total delay among the paths that have exactly W(u, v) registers. A period c is feasible if and only if some r satisfies two families of difference constraints:

```latex
r(u) - r(v) \le w(e) \ \ \text{for each edge } u \to v, \qquad r(u) - r(v) \le W(u, v) - 1 \ \ \text{whenever } D(u, v) > c
```

The second family says that a path too long for c must end up with at least one register. A system of difference constraints is solved by shortest paths: each constraint r(u) − r(v) ≤ b is an edge from v to u of weight b, and Bellman–Ford either finds distances, which are a valid r, or a negative cycle, which proves c infeasible. The candidate periods are the distinct values of D, tried in increasing order.

```js
export function WD(V, E, d) {
  const n = V.length, ix = new Map(V.map((v, i) => [v, i]));
  // lexicographic shortest paths on (w(e), −d(u)): W = fewest registers, D = longest delay among those paths
  const W = Array.from({ length: n }, () => Array(n).fill(Infinity));
  const X = Array.from({ length: n }, () => Array(n).fill(Infinity));
  for (let i = 0; i < n; i++) { W[i][i] = 0; X[i][i] = 0; }   // the empty path: D(v, v) = d(v)
  for (const [u, v, w] of E) {
    const i = ix.get(u), j = ix.get(v), cand = [w, -d[u]];
    if (cand[0] < W[i][j] || (cand[0] === W[i][j] && cand[1] < X[i][j])) { W[i][j] = cand[0]; X[i][j] = cand[1]; }
  }
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const w = W[i][k] + W[k][j], x = X[i][k] + X[k][j];
    if (w < W[i][j] || (w === W[i][j] && x < X[i][j])) { W[i][j] = w; X[i][j] = x; }
  }
  const D = X.map((row, i) => row.map((x, j) => (x === Infinity ? -Infinity : d[V[j]] - x)));
  return { W, D, ix };
}

// Feasibility of period c: difference constraints r(u) − r(v) ≤ b, solved by Bellman–Ford.
export function feasible(V, E, d, c, { W, D }) {
  const cons = [];                                          // [u, v, b] means r(u) − r(v) ≤ b
  for (const [u, v, w] of E) cons.push([u, v, w]);          // no edge may end with a negative register count
  V.forEach((u, i) => V.forEach((v, j) => { if (D[i][j] > c) cons.push([u, v, W[i][j] - 1]); }));  // a too-long path needs a register
  const r = Object.fromEntries(V.map(v => [v, 0]));         // a virtual source at distance 0 to every vertex
  for (let it = 0; it < V.length; it++) {
    let changed = false;
    for (const [u, v, b] of cons) if (r[v] + b < r[u]) { r[u] = r[v] + b; changed = true; }   // edge v → u, weight b
    if (!changed) { const h = r.h ?? 0; for (const x of V) r[x] -= h; return r; }               // normalize r(h) = 0
  }
  return null;                                              // a negative cycle: no retiming reaches c
}

export function minPeriod(V, E, d) {
  const wd = WD(V, E, d);
  const cands = [...new Set(wd.D.flat().filter(x => x > -Infinity))].sort((a, b) => a - b);
  for (const c of cands) { const r = feasible(V, E, d, c, wd); if (r) return { c, r }; }
}
```

The first run returned periods below the multiplier's own 3 ns, which is impossible. W and D lacked the empty path from a vertex to itself, so the constraint for D(v, v) = d(v) > c never appeared. With the diagonal initialized, the test graph behaves. It is a 4-tap direct-form FIR, the shape of F-15 in miniature: a delay line x0 to x3 (no delay), multipliers m0 to m3 (3 ns each), an adder chain a1 to a3 (1 ns each), an input register, and L output registers added by `pipeline.cut`.

| Added latency L | Period before | Period after retiming | Edges that changed |
| --- | --- | --- | --- |
| 0 | 6 ns | 6 ns | none |
| 1 | 6 ns | 3 ns | input register moved past the fan-out: h→x0 0, one register on each m→a edge |
| 2 | 6 ns | 3 ns | the same |
| 3 | 6 ns | 3 ns | the same |

One cycle of latency halves the period: retiming pushes the input register through the delay line's fan-out and the multipliers, leaving each product registered. More latency buys nothing, because a 3 ns multiplier is one vertex in this model. Splitting it needs a multiplier with an internal register, which the DSP mapping in Chapter 13 provides. A register moved forward across a fan-out becomes one register per branch: the count on each cycle is preserved, the total is not.

### 12.8 What Weft adds to Leiserson and Saxe

The classical algorithm assumes registers that load on every cycle, have no reset, and sit in a circuit whose latency nobody observes. Weft's designs violate all three, and each needs a rule.

- **Stalls.** A pipelined path's registers share an enable, the stall signal. A register moved across logic must keep the same enable, so retiming works within one stall group and never moves a register between groups. Mixing enables would make a moved register load on a cycle where the original held.
- **Resets.** Moving a register forward across logic needs a new initial value, computed by evaluating the logic on the old initial values. Moving it backward needs a preimage, which may not exist. R12.10 avoids the problem: on pipelined paths only valid bits reset, data registers do not, and valid bits move only with stage boundaries, never across logic.
- **Feedback state.** Accumulators, phase registers and fsm state sit on cycles, and their register counts are fixed by the cycle property. Weft retimes only acyclic regions of `.pipelined()` modules; a cycle inside such a module stays as written.
- **Observable latency.** Retiming alone never changes input-to-output latency, because of the host cycle. Latency changes only through `pipeline.cut`, only on `.pipelined()` paths, and the change is checked against the observational contract D9, which compares beat sequences, not cycles.

### 12.9 Worked example: what F-10 and F-15 build

| Step | F-10 | F-15 |
| --- | --- | --- |
| Domains | `sys` (100 MHz pin), `pix`, `pix5` | `sys` only |
| PLL | M = 17.625, D = 2, O = 35 and 7 (12.4) | none |
| Crossings | `sprite.pos`: toggle handshake, `latest` | none |
| checks.cdc | clean; error `cdc` if `.cross()` is removed | clean |
| Constraints emitted | two generated clocks; the handshake's data path excluded from timing | one clock |
| pipeline.cut | not applicable | stages added on `in → out` until the estimated period meets the explored clock |
| retime | not applicable | `moves: "both"`, legal because the delay line and products carry no reset |

### 12.10 Tests

- **checks.cdc.** Each rule gets a passing graph and a failing one. F-10 with its `.cross()` line deleted must produce exactly one diagnostic naming `physics` and `raster`.
- **Crossings.** Run the asynchronous FIFO with seeded random clock ratios from 1 : 8 to 8 : 1 at depths 2, 4 and 8, for 10^5 words each. Check order, no loss, and that full and empty never hold together.
- **PLL.** Pin F-10's result as a regression. As a property, check that every returned setting lies inside every range and that its error is within tolerance.
- **STA.** For a chain of known delays, the slack must equal T − (t\_cq + Σd + t\_su). Compare pre-placement estimates with the router's report and record the error per family.
- **Retiming.** On random small graphs, check that every w\_r(e) ≥ 0, that the recomputed period is at most c, and that every cycle keeps its register count. Simulate the original and retimed designs and compare beat sequences (D9).

### 12.11 Exercises

1. Extend `checkDomains` so the diagnostic includes the shortest path from each conflicting source to the node where they meet.
2. Model the toggle handshake as a cycle-accurate JS object, and measure how many sprite positions per second it carries from 100 MHz to 25.175 MHz.
3. Add an iCE40 PLL solver behind the same interface, with the DIVR, DIVF, DIVQ ranges and the filter-range table, and solve F-01's 12 MHz input for 48 MHz.
4. Implement retiming with enables. Give each register a stall group, forbid moves that would mix groups, and test it on F-09's `luma` pipeline under backpressure.
5. Replace the O(V³) Floyd–Warshall step with Leiserson and Saxe's FEAS algorithm, which tests a period without computing W and D, and compare run times on a 63-tap filter.

### 12.12 Further study

- **Cummings, Clock Domain Crossing (CDC) Design & Verification Techniques Using SystemVerilog (SNUG 2008), and Simulation and Synthesis Techniques for Asynchronous FIFO Design (SNUG 2002).** These are the patterns behind 12.3.
- **Project F, FPGA Graphics.** It covers the 640 × 480 video timing that F-10's pixel domain drives.
- **De Micheli, Synthesis and Optimization of Digital Circuits, Chapters 5 and 9.** Chapter 5 covers scheduling, the problem `pipeline.cut` solves greedily. Chapter 9 treats sequential optimization and retiming.
- **Leiserson and Saxe, Retiming Synchronous Circuitry.** It gives the W and D construction, the feasibility constraints and the proofs that 12.7 relies on.
- **Smith, The Scientist and Engineer's Guide to Digital Signal Processing, Chapter 16: Windowed-Sinc Filters.** It derives the taps that F-15 computes at build time.

## Chapter 13 · Mapping and back ends

Examples: F-13, F-16, with F-01 and F-15 as test cases · Prerequisite: Chapter 12

This chapter takes the word-level DAG to a specific part. The steps are bit-blasting it into an and-inverter graph, covering that graph with lookup tables, claiming hard blocks, emitting a netlist other tools accept, and placing and routing it yourself if you want to. Every listing ran with Node 22 in a scratch folder, and the outputs quoted are from those runs. The `map` stage of Chapter 11 runs these passes, and Chapter 12's timing analysis consumes their result.

### 13.1 Specification

- **R13.1 Target independence.** Every pass before `techmap` sees the same DAG for every target that shares the design's clocks. The part's family selects a cell library at `techmap` and nowhere earlier.
- **R13.2 Cell libraries.** A cell library lists the family's primitives with their ports, parameters and a behavioral model written in IR. A mapped netlist can therefore be simulated at level `net` by the same engine as the DAG (Chapter 8).
- **R13.3 Claiming order.** `mem.infer` and `dsp.pack` claim nodes before generic LUT mapping. A claimed node is replaced by a `cell` node, and LUT mapping never sees it. `srl.infer` runs after `techmap`, on mapped flip-flop chains (7-series only).
- **R13.4 Validation.** Each mapped cone is checked against the DAG cone it replaced. A cone of a few LUTs is compared exhaustively; a larger one goes to SAT (D10). A failure is an internal error that names the pass and the cone.
- **R13.5 Determinism.** Emitters are pure functions of the IR. Names come from instance paths and provenance, and every collection is sorted by a stable key. The same IR yields byte-identical output, which makes caches and diffs meaningful.
- **R13.6 Provenance.** Every emitted cell carries a `src` attribute with the file and line of the lambda it came from, so timing reports from external tools can be traced back to source.
- **R13.7 Constraints.** The board profile and `.clocks()` produce the place-and-route constraints: a PCF file for nextpnr on iCE40, an LPF file for nextpnr on ECP5, and an XDC file for Vivado on 7-series. Each declares clocks, generated clocks, pins and I/O standards, and the crossing exceptions from Chapter 12.

### 13.2 From words to an and-inverter graph

The DAG's nodes are words: a `u(8)` adder is one node. LUT mapping works on single bits, so `techmap` first *bit-blasts* each word-level node into an and-inverter graph (AIG). An AIG has one kind of gate, a two-input AND, and inverters live on its edges. A *literal* is twice a node index plus a complement bit. Literal 0 is false and literal 1 is true.

The AIG is hash-consed in the same way as the DAG of Chapter 10. `and(a, b)` first applies four identities, then looks the pair up in a table; an existing AND is returned instead of a new one. This is structural hashing, and it is why shared subexpressions cost nothing.

```js
export class AIG {
  constructor() { this.nodes = [{ op: 'const' }]; this.strash = new Map(); }
  input(name) { this.nodes.push({ op: 'in', name }); return 2 * (this.nodes.length - 1); }
  and(a, b) {
    if (a > b) [a, b] = [b, a];
    if (a === 0) return 0;                 // x ∧ 0 = 0
    if (a === 1) return b;                 // x ∧ 1 = x
    if (a === b) return a;                 // x ∧ x = x
    if ((a ^ 1) === b) return 0;           // x ∧ ¬x = 0
    const key = `${a},${b}`, hit = this.strash.get(key);
    if (hit !== undefined) return hit;     // the same AND already exists: share it
    this.nodes.push({ op: 'and', a, b });
    const lit = 2 * (this.nodes.length - 1);
    this.strash.set(key, lit);
    return lit;
  }
  or(a, b) { return this.and(a ^ 1, b ^ 1) ^ 1; }
  xor(a, b) { return this.or(this.and(a, b ^ 1), this.and(a ^ 1, b)); }
  mux(s, t, f) { return this.or(this.and(s, t), this.and(s ^ 1, f)); }
  add(xs, ys) {                            // ripple-carry, least significant bit first
    const out = []; let c = 0;
    for (let i = 0; i < xs.length; i++) {
      const p = this.xor(xs[i], ys[i]);
      out.push(this.xor(p, c));
      c = this.or(this.and(xs[i], ys[i]), this.and(p, c));
    }
    return [...out, c];
  }
}
```

A 4-bit adder becomes 31 AND nodes. An evaluator over all 256 input pairs found no wrong sums. The identities did real work: the first carry-in is the constant 0, so the first bit's XOR with it and AND with it fold away.

### 13.3 Cuts and depth-optimal labels

A *cut* of node n is a set of nodes whose values determine n. A cut is *k-feasible* when it has at most k members, and then one k-input LUT can compute n from them. The cuts of an AND node are the unions of one cut from each fan-in, together with the trivial cut {n}. Enumerating them bottom-up is short.

The *label* of a node is the depth of the best LUT mapping of its fan-in cone: inputs have label 0, and an AND node takes the minimum over its non-trivial cuts of one plus the deepest leaf's label. The number of cuts grows quickly, so mappers keep only the best few per node. These are *priority cuts*, after Mishchenko, Cho, Chatterjee and Brayton, and the default below keeps eight.

```js
export function enumerateCuts(g, k, keep = 8) {
  const cuts = g.nodes.map(() => []), label = new Array(g.nodes.length).fill(0);
  g.nodes.forEach((n, i) => {
    if (n.op !== 'and') { cuts[i] = [[i]]; return; }
    const seen = new Map();
    for (const c1 of cuts[n.a >> 1]) for (const c2 of cuts[n.b >> 1]) {
      const c = [...new Set([...c1, ...c2])].sort((p, q) => p - q);
      if (c.length <= k) seen.set(c.join(','), c);
    }
    // depth of a cut = 1 + the deepest leaf; keep the best few (priority cuts)
    const ranked = [...seen.values()].map(c => ({ c, depth: 1 + Math.max(...c.map(l => label[l])) }))
      .sort((p, q) => p.depth - q.depth || p.c.length - q.c.length).slice(0, keep);
    label[i] = ranked[0].depth;                          // the depth-optimal label
    cuts[i] = [[i], ...ranked.map(r => r.c)];
    n.best = ranked[0].c;
  });
  return { cuts, label };
}

// Cover the outputs: each needed node becomes one LUT over its best cut; the cut's leaves become needed.
export function cover(g, outputs) {
  const need = [...new Set(outputs.map(l => l >> 1))], luts = new Map();
  while (need.length) {
    const i = need.pop();
    if (g.nodes[i].op !== 'and' || luts.has(i)) continue;
    luts.set(i, g.nodes[i].best);
    need.push(...g.nodes[i].best);
  }
  return luts;
}
```

On the 4-bit adder, LUT4s give 11 LUTs at depth 3 and LUT6s give 8 LUTs at depth 2. The cover starts at the outputs, takes each needed node's best cut, and makes that cut's leaves needed in turn. AND nodes buried inside a chosen cut never become LUTs.

### 13.4 FlowMap

Enumeration is exponential in k. Cong and Ding's FlowMap computes the same depth-optimal labels in polynomial time, using two facts. Let p be the largest label among t's fan-ins. Then label(t) is either p or p + 1. It is p exactly when a k-feasible cut exists after every node of label p in t's cone is merged into t, because those nodes must sit inside t's LUT for the depth to stay p.

Whether such a cut exists is a max-flow question. Split every cone node into an input half and an output half joined by a capacity-1 edge, so cutting a node costs one LUT input. Give every other edge infinite capacity, join a source to the primary inputs and the merged nodes to the sink, and ask whether the maximum flow is at most k.

```js
export function flowmapLabels(g, k) {
  const label = new Array(g.nodes.length).fill(0), INF = 1e9;
  const fanins = i => (g.nodes[i].op === 'and' ? [g.nodes[i].a >> 1, g.nodes[i].b >> 1] : []);
  g.nodes.forEach((n, t) => {
    if (n.op !== 'and') return;
    const cone = new Set(), stack = [t];               // the transitive fan-in of t
    while (stack.length) { const i = stack.pop(); if (!cone.has(i)) { cone.add(i); stack.push(...fanins(i)); } }
    const p = Math.max(...fanins(t).map(i => label[i]));
    // collapse t and every cone node of label p into the sink; a primary input there means no cut can exist
    const sink = new Set([...cone].filter(i => i === t || label[i] === p));
    if ([...sink].some(i => g.nodes[i].op === 'in')) { label[t] = p + 1; return; }
    const cap = new Map(), edge = (u, v, c) => { if (!cap.has(u)) cap.set(u, new Map()); cap.get(u).set(v, c); };
    for (const i of cone) {
      if (sink.has(i)) continue;
      edge(`${i}i`, `${i}o`, 1);                       // cutting node i costs one LUT input
      if (g.nodes[i].op === 'in') edge('S', `${i}i`, INF);
      for (const u of fanins(i)) edge(`${u}o`, `${i}i`, INF);
    }
    for (const i of sink) for (const u of fanins(i)) if (!sink.has(u)) edge(`${u}o`, 'T', INF);
    label[t] = maxflowLeq(cap, 'S', 'T', k) <= k ? p : p + 1;
  });
  return label;
}
```

`maxflowLeq` is Edmonds–Karp: breadth-first augmenting paths with unit pushes. It stops as soon as the flow exceeds k, because only the comparison matters. The first version disagreed with exhaustive enumeration on every node of a 6-bit adder. It merged only AND nodes of label p into the sink, and for a gate fed directly by inputs p is 0, the inputs have label 0, and they belong in the sink too, which makes a cut impossible and the label 1. With that fixed, the two methods agree.

| 6-bit ripple adder, LUT size k | Deepest label by max-flow | By exhaustive cuts | Disagreements |
| --- | --- | --- | --- |
| 3 | 6 | 6 | 0 |
| 4 | 4 | 4 | 0 |
| 6 | 3 | 3 | 0 |

The last row shows a limit of structural mapping. A carry-lookahead structure computes a 6-bit sum in two levels of LUT6, but the mapper sees only the ripple structure it was given and finds three. Mapping is optimal with respect to the subject graph, not the function. That is one reason Weft sends adders to carry chains (13.7) instead of LUTs, and why industrial mappers keep alternative structures, called choice nodes, in the AIG.

### 13.5 Area recovery

Depth-optimal labels minimize the critical path, but most nodes are not on it. After labelling, the mapper computes each node's required depth, as Chapter 12 computes required times, and re-chooses cuts off the critical path to save area. The first pass uses *area flow*: a cut's area is one LUT plus each leaf's area flow divided by that leaf's fan-out, which shares a leaf's cost among its users. A second pass uses *exact area*, which counts the LUTs a choice would actually add or free given the current cover. Both keep every node within its required depth, so area recovery never lengthens the critical path.

### 13.6 LUT contents

A chosen cut becomes one LUT whose INIT parameter is the truth table of the root over the leaves. Bit j of INIT is the output for input pattern j, with the first leaf on I0, the least significant input. SB\_LUT4's LUT\_INIT and a 7-series LUT's INIT both use this order. A complemented root literal is absorbed into the table, so inverters cost nothing.

```js
export function lutInit(g, rootLit, leaves) {
  const root = rootLit >> 1, inv = rootLit & 1;         // a complemented output is absorbed into the table
  let init = 0n;
  for (let j = 0; j < 1 << leaves.length; j++) {
    const v = new Map(leaves.map((l, b) => [l, (j >> b) & 1]));
    const val = i => {
      if (v.has(i)) return v.get(i);
      const n = g.nodes[i];
      const r = n.op === 'const' ? 0 : (val(n.a >> 1) ^ (n.a & 1)) & (val(n.b >> 1) ^ (n.b & 1));
      v.set(i, r); return r;
    };
    if (val(root) ^ inv) init |= 1n << BigInt(j);
  }
  return init;
}
```

Sum bit 1 of the 4-bit adder maps to one LUT4 over x0, x1, y0 and y1 with INIT 0x936c. That matches the table computed directly from x1 ⊕ y1 ⊕ (x0 ∧ y0). The first run printed 0x6c93 and a note that the output was inverted, because the root literal carried a complement. 0x6c93 is the bitwise inverse of 0x936c, and absorbing the inversion is what the `inv` line does.

### 13.7 Hard blocks

Carry chains, multipliers and shift registers are faster and smaller as dedicated cells than as LUTs. They are claimed by pattern before LUT mapping (R13.3).

**Carry chains.** Adders, subtractors and comparators wider than about three bits map to the family's carry primitive: CARRY4 on 7-series (four bits per slice), SB\_CARRY on iCE40 (one bit beside each LUT), and CCU2C on ECP5 (two bits). Each bit keeps one LUT for its propagate signal. That removes the ripple structure from 13.4's LUT mapping entirely.

**DSP packing.** The pattern for F-13's `mac` is a register fed by a multiplexer that either clears it or adds a sign-extended product to it. The matcher walks back from each register, checks each node's shape, then checks the operand and accumulator widths against the family's block.

```js
const FAMILY = {
  xc7:   { dsp: 'DSP48E1', a: 25, b: 18, acc: 48 },          // signed operand widths and accumulator width
  ice40: { dsp: 'SB_MAC16', a: 16, b: 16, acc: 32 },
  ecp5:  { dsp: 'MULT18X18D+ALU54B', a: 18, b: 18, acc: 54 },
};

// reg acc ← mux(clear, 0, add(acc, sext(mul(a, b))))  becomes one DSP with its accumulator register (PREG) inside.
export function packMac(g, family) {
  const f = FAMILY[family], at = id => g.get(id), out = [];
  for (const r of g.values()) {
    if (r.op !== 'reg') continue;
    const m = at(r.next); if (m?.op !== 'mux') continue;
    const [sel, zero, sum] = m.args.map(at);
    if (zero.op !== 'const' || zero.value !== 0 || sum.op !== 'add') continue;
    const [fb, ext] = sum.args.map(at);
    if (fb !== r) continue;                                    // the adder must feed back the register itself
    const mul = ext.op === 'sext' ? at(ext.args[0]) : ext; if (mul.op !== 'mul') continue;
    const [a, b] = mul.args.map(at).sort((p, q) => q.width - p.width);
    const fits = a.width <= f.a && b.width <= f.b && r.width <= f.acc;
    out.push(fits
      ? { cell: f.dsp, absorbs: [mul.id, ext.id, sum.id, m.id, r.id], A: a.id, B: b.id, clear: sel.id, P: r.id }
      : { reject: r.id, why: `${a.width}×${b.width} into ${r.width} bits does not fit ${f.dsp} (${f.a}×${f.b}, ${f.acc})` });
  }
  return out;
}
```

On 7-series the whole `mac` becomes one DSP48E1: the multiply, sign extension, add, clear multiplexer and the 48-bit register (its PREG) are absorbed. That is the single DSP F-13's `.check("one DSP")` expects. On iCE40 the matcher reports `18×18 into 48 bits does not fit SB_MAC16 (16×16, 32)`, and the multiply falls back to decomposition into four 16-bit products or to LUTs. A rejection is a diagnostic, not a silent fallback, so the designer sees why the resource report changed between targets.

**Shift registers.** On 7-series a LUT can act as a 16- or 32-deep shift register (SRL16E, SRLC32E) with one addressable output. A chain qualifies only when four conditions hold: each register is loaded only from the one before it; only the chain's end is read; every register shares one enable; and no register's reset is observed, because an SRL has no reset. Synchronizer flip-flops carry the ASYNC\_REG attribute and are excluded: they must stay real flip-flops placed next to each other.

```js
export function findSrls(g) {
  const users = new Map([...g.keys()].map(k => [k, []]));
  for (const n of g.values()) for (const a of [...(n.args ?? []), ...(n.next ? [n.next] : [])]) users.get(a)?.push(n.id);
  const plain = r => r?.op === 'reg' && !r.resetObserved && !r.asyncReg;
  const isLink = r => plain(r) && plain(g.get(r.next)) && g.get(r.next).en === r.en;
  const feedsLink = r => users.get(r.id).length === 1 && isLink(g.get(users.get(r.id)[0])) && g.get(users.get(r.id)[0]).next === r.id;
  const chains = [];
  for (const r of g.values()) {
    if (r.op !== 'reg' || feedsLink(r)) continue;            // start from a chain's last register and walk back
    const chain = [r];
    let cur = r;
    while (isLink(cur) && users.get(cur.next).length === 1) { cur = g.get(cur.next); chain.unshift(cur); }
    if (chain.length >= 3) chains.push({ cell: chain.length <= 16 ? 'SRL16E' : 'SRLC32E', depth: chain.length, regs: chain.map(c => c.id) });
  }
  return chains;
}
```

| Chain tested | Result | Why |
| --- | --- | --- |
| Four data registers that `pipeline.cut` added to carry a value alongside a stage | One SRL16E, depth 4 | Data registers on pipelined paths have no reset (R12.10) |
| The four valid bits of the same stages | None | Valid bits reset (D13), and an SRL cannot |
| F-15's delay line `z`, every tap feeding a multiplier | None | Every register is read, not only the last |

In F-16 itself the pass finds nothing. The receiver's shift register is read in parallel, the transmitter's is loaded in parallel, and the synchronizers on the receive pin are ASYNC\_REG. `c.when(t => t.family === "xc7", …)` adds the pass anyway because it costs nothing when it finds nothing.

### 13.8 The cell libraries

| Family | LUT | Carry | Flip-flops | Block RAM | Multiplier | Shift register |
| --- | --- | --- | --- | --- | --- | --- |
| iCE40 UP5K | SB\_LUT4 | SB\_CARRY | SB\_DFF and its enable and reset variants | SB\_RAM40\_4K (4 Kbit), SB\_SPRAM256KA (256 Kbit) | SB\_MAC16: 16 × 16, 32-bit accumulator | none |
| ECP5 | LUT4 | CCU2C | TRELLIS\_FF | DP16KD (18 Kbit) | MULT18X18D with ALU54B | none |
| 7-series | LUT1 to LUT6 | CARRY4 | FDRE, FDSE, FDCE, FDPE | RAMB18E1, RAMB36E1 | DSP48E1: 25 × 18, 48-bit accumulator | SRL16E, SRLC32E |

Each entry in a Weft cell library has three parts. The first is the primitive's port and parameter list, exactly as the vendor or the open-source flow names it. The second is a behavioral model in IR, used for net-level simulation and for validating each mapped cone (R13.4). The third is a delay table for the pre-placement estimates of Chapter 12. The names above are the ones Yosys and nextpnr use for iCE40 and ECP5 and the UNISIM names Vivado uses for 7-series.

### 13.9 Emitting netlists

Weft has its own Verilog and VHDL emitters, and for the open-source flow it writes the JSON netlist that Yosys produces and nextpnr reads. In that format a module has ports, cells and netnames. Signals are integers numbered from 2, and the strings "0" and "1" are constants. Parameters are written as strings of bits.

```js
export function emitYosysJson(top, net) {
  const bits = new Map();                                    // net name → integer id, assigned in sorted order
  const id = n => (n === '0' || n === '1' ? n : bits.get(n));
  [...new Set([...net.ports.map(p => p.net), ...net.cells.flatMap(c => Object.values(c.conn))])]
    .filter(n => n !== '0' && n !== '1').sort().forEach((n, i) => bits.set(n, i + 2));
  const sorted = o => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const mod = {
    attributes: { top: '00000000000000000000000000000001' },
    ports: sorted(Object.fromEntries(net.ports.map(p => [p.name, { direction: p.dir, bits: [id(p.net)] }]))),
    cells: sorted(Object.fromEntries(net.cells.map(c => [c.name, {
      hide_name: 0, type: c.type,
      parameters: sorted(c.params ?? {}),
      attributes: { src: c.src },                            // provenance survives into the netlist
      port_directions: sorted(c.dirs),
      connections: sorted(Object.fromEntries(Object.entries(c.conn).map(([p, n]) => [p, [id(n)]]))),
    }]))),
    netnames: sorted(Object.fromEntries([...bits].map(([n, b]) => [n, { hide_name: 0, bits: [b] }]))),
  };
  return JSON.stringify({ creator: 'weft', modules: { [top]: mod } }, null, 1);
}
```

The test netlist is F-01's toggle after mapping on iCE40: an SB\_LUT4 with LUT\_INIT 0101010101010101 (NOT I0, whatever I1 to I3 are) feeding an SB\_DFFE whose enable is the prescaler's terminal-count pulse. Both cells carry `src: F-01-blinky.js:11`, the `.every` line. Emitting the netlist with its cells in two different orders produced the same SHA-256 prefix, 13fd906b5365621f, both times. That is R13.5 under test.

The JSON then goes to the open-source tools, one command each for place-and-route and bitstream packing:

```text
nextpnr-ice40 --up5k --package sg48 --json build/pico/top.json --pcf build/pico/top.pcf --asc build/pico/top.asc
icepack build/pico/top.asc build/pico/top.bin

nextpnr-ecp5 --85k --package CABGA381 --json build/ecp5/top.json --lpf build/ecp5/top.lpf --textcfg build/ecp5/top.config
ecppack build/ecp5/top.config build/ecp5/top.bit
```

For 7-series, Weft emits structural Verilog over UNISIM primitives plus an XDC file, and drives Vivado in non-project mode:

```text
read_verilog build/dev/rtl/top.v
read_xdc build/dev/top.xdc
synth_design -top top -part xc7a35tcsg324-1
opt_design
place_design
route_design
report_timing_summary -file build/dev/timing.rpt
write_bitstream -force build/dev/top.bit
```

Both flows write timing reports. Weft parses them back, maps cell names to its own nodes through the `src` attributes, and fills the post-route slack that `.check("meets 250 MHz", …)` and F-18's dossier read.

### 13.10 A placer of your own

Placement assigns each cell a site. The classic objective is total half-perimeter wirelength (HPWL): for each net, the width plus the height of the bounding box of its cells. Simulated annealing minimizes it by proposing random swaps and accepting a worse placement with probability e^(−Δ/T). The temperature T falls slowly, so the search can leave local minima early and settles later.

```js
export function place(cells, nets, W, H, seed = 1) {
  const rand = rng(seed), pos = new Map(), at = new Map(), key = (x, y) => y * W + x;
  cells.forEach((c, i) => { const x = i % W, y = Math.floor(i / W); pos.set(c, [x, y]); at.set(key(x, y), c); });
  const netsOf = new Map(cells.map(c => [c, []]));
  nets.forEach((n, i) => n.forEach(c => netsOf.get(c).push(i)));
  const hpwl = n => { const xs = n.map(c => pos.get(c)[0]), ys = n.map(c => pos.get(c)[1]);
    return Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys); };
  const total = () => nets.reduce((s, n) => s + hpwl(n), 0);
  // move cell c to (x, y), swapping with whatever is there; return the change in cost
  const swap = (c, x, y) => {
    const other = at.get(key(x, y)), [cx, cy] = pos.get(c);
    const touched = [...new Set([...netsOf.get(c), ...(other ? netsOf.get(other) : [])])];
    const before = touched.reduce((s, i) => s + hpwl(nets[i]), 0);
    pos.set(c, [x, y]); at.set(key(x, y), c);
    if (other) { pos.set(other, [cx, cy]); at.set(key(cx, cy), other); } else at.delete(key(cx, cy));
    return touched.reduce((s, i) => s + hpwl(nets[i]), 0) - before;
  };
  const start = total();
  let T = 0;                                                  // initial temperature: the spread of random moves
  for (let i = 0; i < 50; i++) { const c = cells[Math.floor(rand() * cells.length)], [x, y] = pos.get(c);
    const d = swap(c, Math.floor(rand() * W), Math.floor(rand() * H)); T += Math.abs(d); swap(c, x, y); }
  T = (T / 50) * 2;
  const movesPerT = Math.ceil(10 * cells.length ** (4 / 3));  // VPR's inner-loop count
  while (T > 0.005) {
    for (let m = 0; m < movesPerT; m++) {
      const c = cells[Math.floor(rand() * cells.length)], [x, y] = pos.get(c);
      const d = swap(c, Math.floor(rand() * W), Math.floor(rand() * H));
      if (d > 0 && rand() >= Math.exp(-d / T)) swap(c, x, y);  // reject: undo
    }
    T *= 0.9;
  }
  return { start, end: total(), pos };
}
```

Only the nets touching the moved cells are recomputed, which makes each move cheap. `rng` is a seeded linear congruential generator, so a placement is reproducible. On 48 cells in an 8 × 8 grid, with a ring of 16 two-pin nets and 32 random nets placed in scrambled order, total HPWL fell from 245 to 72. VPR replaces the fixed cooling factor with an adaptive schedule driven by the fraction of accepted moves, and it adds a timing term to the cost. Both are natural next steps.

### 13.11 A router of your own

Routing gives each net a path through the wires of the device. Nets compete for the same wires, and a router that routes nets one at a time, never revisiting them, blocks itself. McMurchie and Ebeling's PathFinder lets nets share wires at first, then raises the price of sharing until no wire is shared.

The cost of a wire is (1 + h) × (1 + p · overuse). h is the wire's history, increased each time it ends an iteration overused, and p is a present-congestion factor that grows every iteration. Each iteration rips up every net and reroutes it with Dijkstra's algorithm under the current costs.

```js
export function pathfinder(W, H, nets, cap = 1, maxIter = 30) {
  const wire = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const nbrs = p => { const [x, y] = p.split(',').map(Number);
    return [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]].filter(([u, v]) => u >= 0 && v >= 0 && u < W && v < H).map(q => q.join(',')); };
  const hist = new Map(), occ = new Map(), routes = new Map();
  let pres = 0.5;
  for (let iter = 1; iter <= maxIter; iter++) {
    for (const [name, [src, dst]] of nets) {                       // rip up and reroute every net, in order
      for (const w of routes.get(name) ?? []) occ.set(w, occ.get(w) - 1);
      const cost = w => (1 + (hist.get(w) ?? 0)) * (1 + pres * Math.max(0, (occ.get(w) ?? 0) + 1 - cap));
      const dist = new Map([[src, 0]]), prev = new Map(), done = new Set();
      while (!done.has(dst)) {                                     // Dijkstra; a small grid needs no heap
        let u = null; for (const [p, d] of dist) if (!done.has(p) && (u === null || d < dist.get(u))) u = p;
        done.add(u);
        for (const v of nbrs(u)) { const d = dist.get(u) + cost(wire(u, v));
          if (d < (dist.get(v) ?? Infinity)) { dist.set(v, d); prev.set(v, u); } }
      }
      const path = []; for (let v = dst; v !== src; v = prev.get(v)) path.push(wire(prev.get(v), v));
      routes.set(name, path);
      for (const w of path) occ.set(w, (occ.get(w) ?? 0) + 1);
    }
    const over = [...occ].filter(([, n]) => n > cap);
    if (!over.length) return { iter, length: [...routes.values()].reduce((s, p) => s + p.length, 0), routes };
    for (const [w] of over) hist.set(w, (hist.get(w) ?? 0) + 1);    // shared wires get dearer for good
    pres *= 1.6;                                                    // and sharing costs more each round
  }
  return null;
}
```

Six two-pin nets on a 6 × 6 grid, with one track per wire and endpoints chosen so the shortest routes collide, overused one wire after each of the first two iterations and were legal after the third, using 42 wire segments. Adding two more nets made the problem unroutable on one track: the router still had overused wires after 40 iterations. With two tracks per wire, all eight routed on the first pass. PathFinder is a heuristic and cannot prove a problem unroutable. A real router stops at an iteration limit and reports the wires it could not resolve.

### 13.12 Worked example: F-13 and F-16 per family

| Decision | 7-series (dev, big) | iCE40 (pico) | ECP5 |
| --- | --- | --- | --- |
| F-13 `mac` (18 × 18 into 48 bits) | One DSP48E1, accumulator in PREG | Rejected for SB\_MAC16; decomposed or LUT multiplier | MULT18X18D with ALU54B |
| F-16 adder and comparators in `upcase` | CARRY4 chains | SB\_CARRY chains | CCU2C chains |
| F-16 `srl.infer` | Runs, finds nothing (13.7) | Not run | Not run |
| Netlist handed on | Structural Verilog + XDC to Vivado | Yosys JSON + PCF to nextpnr-ice40 | Yosys JSON + LPF to nextpnr-ecp5 |
| Post-route timing back into Weft | Vivado's timing summary | nextpnr's timing report | nextpnr's timing report |

### 13.13 Tests

- **Bit-blasting.** Every word-level operator, at widths 1 to 8 and both signednesses, is compared exhaustively with a BigInt reference (Chapter 1). Wider operators are compared by SAT against the same reference.
- **LUT mapping.** Labels from cut enumeration and from FlowMap must agree on random AIGs. Every emitted INIT is checked against a direct truth-table computation.
- **Hard blocks.** For each family, a matching pattern and four near-misses: one operand too wide, an extra user of the product, a different enable, and an observed reset. Each must be rejected with its reason.
- **Determinism.** Emit every example twice with shuffled internal orders; the outputs must be byte-identical.
- **Integration.** F-01 and F-16 go through nextpnr for pico and ECP5 and through Vivado for dev. The same scenario then runs at level `net` against each mapped netlist (Chapter 8).

### 13.14 Exercises

1. Add area-flow recovery to `enumerateCuts` and `cover`. Measure the LUT count of a 16-bit adder and a 4-tap FIR with and without it, at the same depth.
2. Implement carry-chain claiming for adders wider than three bits on 7-series, and compare the depth of a 16-bit adder with and without it.
3. Extend `packMac` to absorb input registers (AREG, BREG) and the multiplier's MREG. Re-run Chapter 12's FIR retiming with the multiplier split into two 1.5 ns halves.
4. Do the BYU ECEn 629 VTR exercise once Weft emits BLIF: run VTR's placer and router on a Weft design, then replace the placer with 13.10's and compare wirelength and critical path.
5. Add timing-driven costs to `pathfinder`: weight each net's wires by its criticality from Chapter 12's slack, and show that a critical net takes the shortest path when it competes with others.

### 13.15 Further study

- **De Micheli, Synthesis and Optimization of Digital Circuits, Chapter 10 (Cell-Library Binding).** It gives the theory of 13.3 to 13.7: covering, pattern matching and binding to a library.
- **VTR (Verilog-to-Routing) CAD flow.** It is the academic reference for packing, placement and routing, and the setting for exercise 4.
- **Kahng, Lienig, Markov and Hu, VLSI Physical Design: From Graph Partitioning to Timing Closure.** Its chapters on placement and routing cover 13.10 and 13.11 in depth.
- **CIRCT and Yosys technology mapping.** These show how production open-source flows organize the same passes: dialect lowering in CIRCT, and `techmap`, `abc` and the `synth_ice40` / `synth_ecp5` scripts in Yosys.
- **Lakeroad: Sketch-Guided Technology Mapping.** It maps to DSPs and other hard blocks by program synthesis against vendor semantics, a principled alternative to 13.7's hand-written patterns.
- **BYU ECEn 629.** Its VTR placement-and-routing exercise turns 13.10 and 13.11 from listings into experiments on real benchmarks.

## Chapter 14 · Runtime

Examples: F-12, with F-19's panel and palette · Prerequisites: Chapters 4 and 12

This chapter builds the boundary between the running hardware and the software beside it. It covers the register map that `csr.collect` makes from every `.knob()`, `.status()` and `.irq()`, the hardware that enforces each register's rules, and the bridge protocol that carries reads, writes and events over a UART. It ends with the three artifacts generated from the map and the host runtime that gives runtime lambdas their `dev` handles. Every listing ran with Node 22 in a scratch folder, and the outputs quoted are from those runs.

### 14.1 Specification

- **R14.1 Knobs.** `.knob(name, T, { reset, min, max, doc })` declares a register the host may read and write. The reset value must lie within the bounds, or the build fails with `require`. A write outside the bounds is clamped in hardware, and the write's acknowledgement carries the stored value.
- **R14.2 Status.** `.status(name, T)` declares a register the hardware writes and the host only reads. Counters wrap modulo 2^width unless declared saturating. The drop counters of lossy streams are saturating (D7), and a host reads them as values and never differences them.
- **R14.3 Interrupts.** `.irq(name)` declares a pulse. A pulse sets its bit in the system's pending register, and a pending bit stays set until the host writes 1 to it. If a pulse and the host's clear arrive on the same cycle, the pulse wins, so no event is lost. While a bit is both pending and enabled, the bridge sends an event frame.
- **R14.4 Allocation.** `csr.collect` runs in the `lower` stage. The system block occupies 0x0000 to 0x00FF: the map identifier at 0x0000, pending interrupts at 0x0004 (write 1 to clear) and enabled interrupts at 0x0008. Each module with registers then gets a 256-byte page, in order of its sorted instance path, starting at 0x0100. Within a page, registers take one 32-bit word each, in declaration order. Interrupt bits are numbered in the same order.
- **R14.5 Packing.** With `csr: { pack: true }`, consecutive registers of the same access kind share a word until it is full; no register straddles two words. The generated drivers perform the read-modify-write a packed field needs.
- **R14.6 Map identity.** The map identifier is the first 32 bits of the SHA-256 of the map's canonical description. A driver refuses to talk to a device whose identifier differs from its own.
- **R14.7 Domains.** The register file lives in the bridge's clock domain. A knob read by a module in another domain reaches it through a toggle handshake (Chapter 12), so a write takes effect a few destination cycles later. A read returns the bridge-side copy.
- **R14.8 Bridge.** Every frame is 9 bytes: 0xA5, an opcode, a little-endian 16-bit address, little-endian 32-bit data, and a CRC-8 over bytes 1 to 7 (polynomial 0x07, initial value 0). Requests are read (0x01) and write (0x02). Replies are read reply (0x41), write acknowledgement (0x42) and error (0xE0, with a code in the data field). The device sends event frames (0x80) on its own.
- **R14.9 Single source.** The C header, the JS driver and the Markdown register table are generated from the same map object in the same build, and each carries the map identifier.

### 14.2 The register map

A map is a list of register records, each with a path, kind, width, access, address, least significant bit, and its reset value and bounds where it has them, plus the list of interrupt names. The allocator is short. A stable order matters more than anything else, because addresses become part of firmware and host code, and a map whose addresses shift whenever an unrelated module is renamed breaks every program that uses it.

```js
const SYS = [
  { path: 'sys.id', kind: 'id', width: 32, access: 'ro', doc: 'map hash: the driver refuses a bitstream whose map differs' },
  { path: 'sys.irq_pending', kind: 'status', width: 32, access: 'w1c', doc: 'one bit per irq; write 1 to clear' },
  { path: 'sys.irq_enable', kind: 'knob', width: 32, access: 'rw', reset: 0, doc: 'one bit per irq; 1 sends events' },
];

export function collect(modules, { page = 0x100, pack = false } = {}) {
  const regs = [], irqs = [];
  SYS.forEach((r, i) => regs.push({ ...r, addr: 4 * i, lsb: 0 }));
  const sorted = [...modules].sort((a, b) => (a.path < b.path ? -1 : 1));      // stable: by instance path
  sorted.forEach((m, mi) => {
    let addr = page * (mi + 1), bit = 0, lastAccess = null;
    for (const d of m.decls) {                                                // declaration order inside a module
      if (d.kind === 'irq') { irqs.push(`${m.path}.${d.name}`); continue; }
      const access = d.kind === 'knob' ? 'rw' : 'ro';
      // packing puts consecutive registers of one access kind into a word until 32 bits are used
      if (!pack || bit + d.width > 32 || access !== lastAccess) { if (bit) addr += 4; bit = 0; }
      regs.push({ path: `${m.path}.${d.name}`, kind: d.kind, width: d.width, access, addr, lsb: bit,
                  reset: d.reset ?? 0, min: d.min, max: d.max, saturating: d.saturating ?? false, doc: d.doc ?? '' });
      bit += pack ? d.width : 32; lastAccess = access;
      if (bit >= 32) { addr += 4; bit = 0; }
    }
  });
  const body = JSON.stringify({ regs: regs.slice(1), irqs });                // sys.id itself is not hashed
  const id = parseInt(createHash('sha256').update(body).digest('hex').slice(0, 8), 16);
  return { regs, irqs, id };
}
```

Run on F-12's `synth` (`hz` u14 with bounds 20 to 8000, `volume` u4, `clipped` u16 status, `clip` interrupt), the allocator produced the maps below. The unpacked map is the one the first book's Chapter 12 shows.

| Register | Unpacked | Packed |
| --- | --- | --- |
| `sys.id` (ro) | 0x0000 \[31:0\] | 0x0000 \[31:0\] |
| `sys.irq_pending` (w1c) | 0x0004 \[31:0\] | 0x0004 \[31:0\] |
| `sys.irq_enable` (rw) | 0x0008 \[31:0\] | 0x0008 \[31:0\] |
| `synth.hz` (rw) | 0x0100 \[13:0\] | 0x0100 \[13:0\] |
| `synth.volume` (rw) | 0x0104 \[3:0\] | 0x0100 \[17:14\] |
| `synth.clipped` (ro) | 0x0108 \[15:0\] | 0x0104 \[15:0\] |
| Interrupt bit 0 | `synth.clip` | `synth.clip` |
| Map identifier | 0xd9c6c3a6 | 0x418eee32 |

The identifiers differ because the maps differ, which is the point of R14.6. Packing saves one word here and costs a read-modify-write whenever the host changes `volume`, which is why it is off by default.

### 14.3 The hardware behind each register

`csr.collect` adds logic to each module that declares registers. The sketch below shows what it adds to `synth` for `hz`, in Weft's own notation. It is a sketch of the generated logic, not a file from the examples.

```js
// Sketch: the write port csr.collect adds for synth.hz (address 0x0100, bounds 20..8000)
.seq($ => {
  if ($.bus.write && $.bus.addr === 0x0100)
    $.hz = wrap($.bus.data < 20 ? 20 : $.bus.data > 8000 ? 8000 : $.bus.data);   // the clamp leaves only zero bits to drop
})
```

Each bounded knob costs two comparators and two multiplexers on its write path, and nothing on its read path. Clamping in hardware makes the bound a property of the device: a buggy host, a hand-typed serial command and a corrupted driver all get the same answer. The acknowledgement returns the stored value, so a host learns about a clamp in the same round trip as its write.

The interrupt logic is one line per bit, and its order is the whole design: `pending' = (pending & ~clear) | pulse`. The pulse is applied after the clear, so an event that fires in the cycle the host clears an older one stays pending. Event frames are sent when a pending, enabled bit is newly set, not on every cycle it stays set. A host that never clears gets one frame, not a flood.

### 14.4 The bridge protocol

| Byte | Field | Meaning |
| --- | --- | --- |
| 0 | sync | 0xA5 |
| 1 | op | 0x01 read, 0x02 write; 0x41 read reply, 0x42 write acknowledgement, 0xE0 error; 0x80 event |
| 2–3 | address | Register byte offset, little-endian |
| 4–7 | data | Write data, read value, stored value, error code or pending bits, little-endian |
| 8 | crc | CRC-8 over bytes 1–7, polynomial 0x07, initial value 0 |

The sync byte can also appear inside a frame's data, so it does not mark frame boundaries by itself. The receiver keeps a sliding 9-byte window. It drops bytes until the window starts with 0xA5, waits for nine bytes, and accepts the frame only if the CRC matches. On a mismatch it drops one byte and tries again. In hardware this is a 9-byte shift register, a CRC unit and a small sequencer. A frame never needs escaping, and a damaged or false frame costs at most nine bytes of resynchronization.

```js
export function crc8(bytes) {
  let c = 0;
  for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff; }
  return c;
}
export function frame(op, addr, data) {                       // little-endian address and data
  const body = [op, addr & 0xff, addr >> 8, data & 0xff, (data >>> 8) & 0xff, (data >>> 16) & 0xff, data >>> 24];
  return [0xa5, ...body, crc8(body)];
}
export const parse = f => ({ op: f[1], addr: f[2] | (f[3] << 8), data: (f[4] | (f[5] << 8) | (f[6] << 16) | (f[7] << 24)) >>> 0 });

// The device side: a 9-byte window slides over the byte stream; a frame is accepted only when sync and CRC agree.
export function device(map) {
  const words = new Map(), win = [], out = [];
  const regsAt = a => map.regs.filter(r => r.addr === a);
  for (const r of map.regs) words.set(r.addr, (words.get(r.addr) ?? 0) | ((r.reset ?? 0) << r.lsb));
  words.set(0, map.id);
  const field = (r, w) => (w >>> r.lsb) & ((2 ** r.width) - 1);
  const dev = {
    words,
    raise(i) { words.set(4, words.get(4) | (1 << i));                                // an irq pulse sets its pending bit
               if (words.get(8) & (1 << i)) out.push(frame(OP.event, 0, words.get(4))); },
    receive(byte) {
      win.push(byte);
      while (win.length && win[0] !== 0xa5) win.shift();                           // hunt for sync
      if (win.length < 9) return;
      if (crc8(win.slice(1, 8)) !== win[8]) { win.shift(); return; }                // a false sync or a damaged frame
      const { op, addr, data } = parse(win.splice(0, 9)), rs = regsAt(addr);
      if (!rs.length) return out.push(frame(OP.error, addr, ERR.address));
      if (op === OP.read) return out.push(frame(OP.readReply, addr, words.get(addr)));
      if (rs.every(r => r.access === 'ro')) return out.push(frame(OP.error, addr, ERR.readOnly));
      let w = words.get(addr);
      for (const r of rs) {
        let v = rs.length === 1 ? data : field(r, data);                             // a register alone sees the whole word
        if (r.access === 'w1c') { w &= ~data; continue; }                           // write 1 to clear
        if (r.min !== undefined) v = Math.min(Math.max(v, r.min), r.max);            // bounds, as the hardware clamps
        w = (w & ~(((2 ** r.width) - 1) << r.lsb)) | (v << r.lsb);
      }
      words.set(addr, w >>> 0);
      out.push(frame(OP.writeAck, addr, w >>> 0));                                   // the ack carries what was stored
    },
    send: () => out.shift(),
  };
  return dev;
}
```

The first run acknowledged a write of 50 000 with a stored value of 848. The model masked the data to `hz`'s 14 bits before clamping, and 50 000 mod 16 384 is 848, which lies inside the bounds. A register alone in its word must clamp the whole written word, and the hardware compares all 32 bits of the bus data for the same reason. After the fix:

| Exchange | Bytes (hex) | Meaning |
| --- | --- | --- |
| Host writes `synth.hz` = 50 000 | a5 02 00 01 50 c3 00 00 17 | 0xC350 to 0x0100 |
| Device acknowledges | a5 42 00 01 40 1f 00 00 e0 | stored 0x1F40 = 8000: clamped |
| Garbage 00, a false sync a5 13, then a read of 0x0100 | a5 41 00 01 40 1f 00 00 86 | the window resynchronized and answered 8000 |
| Host writes `synth.clipped` | a5 e0 08 01 03 00 00 00 79 | error 3: read-only |

At F-12's 1 Mbaud with 8N1 framing, each byte takes 10 µs, so a request and its reply take 180 µs and the bridge carries at most about 5 500 transactions a second. That is ample for knobs turned every 20 ms and hopeless for streaming samples. Recording live traffic for replay needs another path (Chapter 15).

### 14.5 Three artifacts from one map

The C header, the JS driver and the Markdown table are three printers over the same records. Because they are generated in the same build and stamped with the same identifier, a register cannot be documented at one address and driven at another.

```js
const hex4 = a => `0x${a.toString(16).padStart(4, '0')}`;
const NAME = r => r.path.split('.').join('_').toUpperCase();
const note = r => [r.access, `u${r.width}`, r.reset !== undefined && r.kind === 'knob' ? `reset ${r.reset}` : null,
  r.min !== undefined ? `saturates to ${r.min}..${r.max}` : null, r.kind === 'status' && r.access === 'ro' ? (r.saturating ? 'saturates' : 'wraps') : null]
  .filter(Boolean).join(', ');

export function genC(map, prefix) {
  const lines = [`/* generated by weft from the design's register map; do not edit */`,
    `#define ${prefix}_MAP_ID 0x${map.id.toString(16).padStart(8, '0')}u`];
  for (const r of map.regs) {
    lines.push(`#define ${prefix}_${NAME(r).padEnd(16)} ${hex4(r.addr)}u  /* ${note(r)} */`);
    if (r.lsb || (r.width < 32 && map.regs.some(o => o !== r && o.addr === r.addr)))
      lines.push(`#define ${prefix}_${NAME(r)}_SHIFT ${r.lsb}\n#define ${prefix}_${NAME(r)}_MASK 0x${((2 ** r.width - 1) * 2 ** r.lsb).toString(16)}u`);
  }
  map.irqs.forEach((n, i) => lines.push(`#define ${prefix}_IRQ_${n.split('.').join('_').toUpperCase()} (1u << ${i})`));
  return lines.join('\n');
}
```

For F-12 with the prefix `SIREN`, it printed:

```c
/* generated by weft from the design's register map; do not edit */
#define SIREN_MAP_ID 0xd9c6c3a6u
#define SIREN_SYS_ID           0x0000u  /* ro, u32 */
#define SIREN_SYS_IRQ_PENDING  0x0004u  /* w1c, u32 */
#define SIREN_SYS_IRQ_ENABLE   0x0008u  /* rw, u32, reset 0 */
#define SIREN_SYNTH_HZ         0x0100u  /* rw, u14, reset 440, saturates to 20..8000 */
#define SIREN_SYNTH_VOLUME     0x0104u  /* rw, u4, reset 8 */
#define SIREN_SYNTH_CLIPPED    0x0108u  /* ro, u16, wraps */
#define SIREN_IRQ_SYNTH_CLIP (1u << 0)
```

The JS printer emits the same records as a module exporting `MAP_ID`, `REGS` and `IRQS`, which the host runtime loads. The Markdown printer emits one table row per register with its address, bits, access, path and notes. A packed map adds `_SHIFT` and `_MASK` definitions for each shared field.

### 14.6 The host runtime

A `host()` component's lambdas receive `dev`, a `Device` built over a transport. A transport has two operations: `transact` sends a request frame and resolves with the reply, and `poll` returns a frame the device sent on its own. On a board the transport is a serial port. In simulation it calls the device model between clock cycles, at points the scenario fixes, so a host lambda's effects land on the same cycle in every run (D15).

```js
export class Device {
  constructor(transport, map) {
    this.t = transport; this.map = map; this.handlers = new Map();
    this.reg = path => { const r = map.regs.find(x => x.path === path); if (!r) throw new Error(`no register ${path}`); return r; };
  }
  async check() {                                             // refuse a bitstream built from a different map
    const id = await this.read(0);
    if (id !== this.map.id) throw new Error(`map id 0x${id.toString(16)} on the device, 0x${this.map.id.toString(16)} in the driver`);
  }
  async read(addr) { const r = parse(await this.t.transact(frame(OP.read, addr, 0))); if (r.op !== OP.readReply) throw new Error(`error ${r.data} at ${addr}`); return r.data; }
  async write(addr, v) { const r = parse(await this.t.transact(frame(OP.write, addr, v))); if (r.op !== OP.writeAck) throw new Error(`error ${r.data} at ${addr}`); return r.data; }
  knob(path) {
    const r = this.reg(path), get = async () => ((await this.read(r.addr)) >>> r.lsb) & (2 ** r.width - 1);
    const set = async v => {                                  // a packed field needs read-modify-write
      const others = this.map.regs.some(o => o !== r && o.addr === r.addr);
      const word = others ? ((await this.read(r.addr)) & ~((2 ** r.width - 1) << r.lsb)) | (v << r.lsb) : v;
      return ((await this.write(r.addr, word)) >>> r.lsb) & (2 ** r.width - 1);   // what the hardware kept
    };
    return { get, set, update: async f => set(f(await get())) };
  }
  status(path) { const r = this.reg(path); return { read: async () => ((await this.read(r.addr)) >>> r.lsb) & (2 ** r.width - 1) }; }
  on(irq, fn) { this.handlers.set(this.map.irqs.indexOf(irq), fn); }
  async enableEvents() { await this.write(8, [...this.handlers.keys()].reduce((m, i) => m | (1 << i), 0)); }
  async pump() {                                              // deliver pending event frames, then clear what was handled
    for (let f; (f = this.t.poll()); ) {
      const pending = parse(f).data;
      for (const [i, fn] of this.handlers) if (pending & (1 << i)) { await fn(this); await this.write(4, 1 << i); }
    }
  }
}
```

The test drives the device model of 14.4 through a simulation transport. It checked the map identifier, set `hz` to 50 000 and to 3, set `volume` to 15, registered a handler for `synth.clip`, enabled events, and raised the interrupt in the hardware model.

```text
hz set to 50000, kept 8000
hz set to 3, kept 20
clip event; volume now 14
pending after the handler: 0
```

`set()` returns what the hardware kept, not what was asked for, so F-12's panel can see a clamp without a second read. The handler runs before the pending bit is cleared. If the hardware raises the interrupt again while the handler runs, the bit is set again after the clear and produces a new event, by R14.3.

### 14.7 Worked example: F-12's scenarios

| Step | On the bridge | In the hardware | Scenario check |
| --- | --- | --- | --- |
| `.write("synth.hz", 50_000)` | a5 02 00 01 50 c3 00 00 17 | Clamp to 8000; acknowledge 8000 | `.expectKnob("synth.hz", 8000)` passes |
| `.write("synth.hz", 3)` | write 3 to 0x0100 | Clamp to 20 | `.expectKnob("synth.hz", 20)` passes |
| `.write("synth.volume", 15)` | write 15 to 0x0104 | Stored 15; `y` reaches 3838 > 2047 | none |
| Next 48 kHz sample | none | `clipped` +1, `clip` pulse, pending bit 0 set, event frame sent | none |
| `.run("panel")` | event a5 80 …; the handler reads and writes `volume` | `volume` = 14 | `.expectKnob("synth.volume", v => v < 15)` passes |

The value 3838 is (2047 × 15) >> 3, the largest sample at volume 15, above the 2047 a 12-bit output can carry. That is why the synth clips at volume 15, as in the first book's Chapter 12.

### 14.8 Tests

- **Allocation.** Addresses must not change when a module is added whose path sorts after the existing ones. The map identifier must change whenever any record changes, and only then.
- **Hardware rules.** For every bounded knob, write min − 1, min, max and max + 1 and check the acknowledgements. Raise a pulse on the same cycle as the host's clear and check that the bit stays pending.
- **Protocol.** Feed the receiver random bytes with valid frames inserted at random offsets: every valid frame must be answered exactly once, and nothing else. Flip each bit of a valid frame in turn: none may be accepted, because CRC-8 detects every single-bit error.
- **Artifacts.** Compile the C header, import the JS module, and check that both agree with the map record for record. Fail the build if the Markdown table is out of date.
- **End to end.** Run F-12's scenarios in simulation, then against a board through a serial port, and compare the bridge traces byte for byte.

### 14.9 Exercises

1. Add a burst read op that returns N consecutive words. Choose a frame layout and an error rule for bursts that cross a page, and measure F-19's panel polling time before and after.
2. Generate a SystemRDL description from the map, and write the reverse: an importer that builds Weft `.knob()` and `.status()` declarations from a SystemRDL file.
3. Implement R14.7 for F-19's `renderer.palette`: a toggle handshake from the bus domain to `pix`. Write a test that measures how many pixel cycles a write takes to take effect.
4. Replace the UART transport with a USB CDC or Ethernet transport behind the same interface, and run F-12's host code unchanged.

### 14.10 Further study

- **OpenTitan reggen.** A production register generator that makes RTL, C headers and documentation from one description, as R14.9 requires. Its handling of access types and of hardware-written fields is worth comparing with 14.3.
- **SystemRDL 2.0 (Accellera).** The standard language for register descriptions. It is the obvious interchange format for exercise 2.
- **Harris and Harris, Digital Design and Computer Architecture, Chapter 9 (I/O Systems).** It covers memory-mapped I/O, interrupts and serial interfaces from the processor's side of the boundary this chapter builds.

## Chapter 15 · Live change

Examples: F-17, F-18, F-19 · Prerequisites: Chapters 8, 9, 12, 13 and 14

This chapter implements changes to hardware that is already running, and the machinery that keeps those changes safe. It starts with the contract that says when two designs are the same and how to check it. Then it covers the change record and its pipeline, recording and replay, partial reconfiguration, state migration, canaries and rollback, and the agents that propose changes through the same pipeline as people. It ends with the reset groups that decide when an agent is called at all. Every listing ran with Node 22 in a scratch folder, and the outputs quoted are from those runs; where a step is stubbed, the text says so.

### 15.1 Specification

- **R15.1 Observational contract (D9).** A design's *cycle observables* are its top-level ports, pins and register-map values, sampled every cycle. Each stream path of a `pipeline()` or of a `.pipelined()` module is observed instead as the sequence of beats that fired on it. Two designs are equivalent when three conditions hold: the cycle observables agree on every cycle; the beat sequences agree on every such path; and each input beat's output beat fires within the path's liveness bound.
- **R15.2 Change record.** A change is `{ id, title, ops, verify, deploy, rollbackOn, approve, author, stage, history }`. Its ops are `knob`, `patch`, `replace`, `add` and `remove`.
- **R15.3 Stages.** A change moves through proposed → checked → verified → built → canary → committed. A failure before `built` makes it rejected; a failure at or after `built` makes it rolled-back. A change that requires approval waits before `committed`. A change made only of `knob` ops goes from checked straight to committed, after the register is written and read back.
- **R15.4 Incremental build.** A `patch` or `replace` re-elaborates only the modules it names. All of them must lie in one reconfigurable region, or the change is rejected with `region`.
- **R15.5 Region boundaries.** A region's ports must be streams and knobs. A raw wire across a region boundary is an error `region`, because nothing could decouple it.
- **R15.6 Decoupling.** During reconfiguration, streams leaving the region present `valid = 0`, streams entering it present `ready = 0`, and the region is held in reset until loading and migration finish. Upstream producers then stall or drop according to their buffer policies (D7).
- **R15.7 Recording.** `.record({ streams, keep })` keeps a ring buffer of fired beats. In simulation it costs nothing. On a board it uses block RAM unless the design has a host link fast enough to stream it, and a recording that exceeds the budget is an error `record-budget`.
- **R15.8 Replay.** `verify.replay(window)` runs the candidate on the recorded input beats with every assertion active and checks liveness and beat rates. It does not compare output values, which a change is expected to alter; output equivalence is checked only by equiv() under R15.1.
- **R15.9 Simulated time.** In simulation, checking, verifying and building take no simulated time. The canary window is measured in simulated time.
- **R15.10 Canary and rollback.** The canary loads the change, migrates state and watches the triggers in `rollbackOn`: assertion monitors, watchdog resets and stream rates. A trigger reloads the previous partial bitstream, which the host keeps, and restores the state snapshot taken before the change.
- **R15.11 Migration.** `.migrate(old => new)` runs on the host, over a snapshot of the old region's registers read through generated state registers. Registers the lambda does not set take their reset values.
- **R15.12 Agents.** A proposal lists the resources it touches. It is admitted only if every resource matches a `propose` pattern of the agent's scope and none matches a `never` pattern, and only while the agent's budget lasts. Admitted proposals enter the pipeline as ordinary changes.
- **R15.13 Supervision (D13).** A group's strategy is `one-for-one`, `all-for-one` or `dependents`. More than n resets within its window escalates: the group sends an event and a dossier to its escalation target.

### 15.2 Checking the contract

Two comparisons are needed, because a pipelined path may change latency and nothing else may. A *cycle miter* compares two traces sample by sample. A *beat miter* extracts the beats that fired on a stream, where a beat fires on a cycle with both valid and ready high, and compares the sequences without regard to when each beat fired. A liveness check pairs the i-th input beat with the i-th output beat and bounds the distance, so a design that holds every beat forever cannot pass by producing nothing.

```js
export function cycleMiter(a, b, signals) {                  // a, b: arrays of per-cycle samples
  const diffs = [];
  for (let t = 0; t < Math.max(a.length, b.length); t++)
    for (const s of signals) if (a[t]?.[s] !== b[t]?.[s]) diffs.push({ cycle: t, signal: s, a: a[t]?.[s], b: b[t]?.[s] });
  return diffs;
}
export const beats = (trace, stream) => trace.flatMap((c, t) => (c[`${stream}.valid`] && c[`${stream}.ready`] ? [{ t, data: c[`${stream}.data`] }] : []));

export function beatMiter(a, b, stream) {                     // compare what fired, not when
  const x = beats(a, stream), y = beats(b, stream), n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i].data !== y[i].data) return { ok: false, at: i, a: x[i], b: y[i] };
  return x.length === y.length ? { ok: true, count: n } : { ok: false, at: n, missing: x.length > y.length ? 'b' : 'a' };
}
export function liveness(trace, input, output, bound) {       // the i-th output beat within `bound` cycles of the i-th input beat
  const ins = beats(trace, input), outs = beats(trace, output);
  for (let i = 0; i < ins.length; i++)
    if (!outs[i] || outs[i].t - ins[i].t > bound) return { ok: false, beat: i, in: ins[i].t, out: outs[i]?.t ?? null };
  return { ok: true, worst: Math.max(...ins.map((b, i) => outs[i].t - b.t)) };
}
```

The test models F-18's `blend` before the closer's change (latency 1) and after it (latency 4), with the same function, and once more with a sink that refuses every third cycle.

| Check | Result |
| --- | --- |
| Cycle miter, before against after, on `out.valid` and `out.data` | 18 differences, the first at cycle 1 |
| Beat miter, before against after | equal, 6 beats |
| Beat miter, before against the stalled run | equal, 6 beats |
| Liveness after the change, bound 6 | holds; worst distance 4 cycles |
| Liveness with the stalled sink, bound 6 | holds; worst distance 6 cycles |

The cycle miter rejects a correct change, which is why the first book's F-18 verifies with `equiv({ upTo: "stream latency" })`. For formal checking (Chapter 9), the beat miter becomes a *transaction miter*: each side counts its fired beats, the property asserts equal data whenever the counts are equal, and the liveness bound becomes a bounded-response assertion.

### 15.3 The change pipeline

The pipeline is a small state machine over the change record. Each stage is a function that returns `{ ok, why }`, and the pipeline decides what a failure means from where it happened. Before anything is loaded, a failure rejects the change. Once a partial bitstream exists, a failure rolls the change back.

```js
const NEXT = { proposed: 'checked', checked: 'verified', verified: 'built', built: 'canary', canary: 'committed' };

export class ChangePipeline {
  constructor(steps, clock) { this.steps = steps; this.clock = clock; this.log = []; this.live = new Map(); }
  note(c, stage, why = '') { c.stage = stage; this.log.push(`${String(this.clock.now()).padStart(5)} ms  ${c.title.padEnd(28)} ${stage}${why && `: ${why}`}`); }
  async submit(c) {
    this.note(c, 'proposed');
    const knobOnly = c.ops.every(op => op.kind === 'knob');   // a register write needs no bitstream
    for (let stage = 'proposed'; stage !== 'committed'; ) {
      let next = NEXT[stage];
      if (knobOnly && next === 'verified') next = 'committed';
      if (next === 'committed' && c.approve && !(await this.steps.approve(c))) return this.note(c, 'stopped', 'not approved');
      const r = await this.steps[next === 'committed' ? 'commit' : next](c);   // each step returns { ok, why }
      if (!r.ok) {
        if (stage === 'built' || stage === 'canary') { await this.steps.rollback(c); return this.note(c, 'rolled-back', r.why); }
        return this.note(c, 'rejected', r.why);                 // nothing was loaded: nothing to roll back
      }
      stage = next;
      this.note(c, stage, r.why);
    }
  }
}
```

The test feeds it F-17's three changes, 100 ms apart, with each step stubbed to report what the real step would compute: lint passes, replay passes, the biquad's canary stays quiet, and `gain × 4`'s canary sees its assertion fire after the volume rises. By R15.9, checking, verifying and building take no simulated time.

```text
    0 ms  softer                       proposed
    0 ms  softer                       checked
    0 ms  softer                       committed: register written and read back
  100 ms  biquad instead of one-pole   proposed
  100 ms  biquad instead of one-pole   checked
  100 ms  biquad instead of one-pole   verified: replay of the last 1 s passes: asserts quiet, rate held
  100 ms  biquad instead of one-pole   built: partial bitstream for region dsp
  400 ms  biquad instead of one-pole   canary: asserts quiet, wet.rate 48 000/s
  400 ms  biquad instead of one-pole   committed: previous partial kept for rollback
  500 ms  gain × 4                     proposed
  500 ms  gain × 4                     checked
  500 ms  gain × 4                     verified: replay of the last 1 s passes: asserts quiet, rate held
  500 ms  gain × 4                     built: partial bitstream for region dsp
  603 ms  gain × 4                     rolled-back: assert “never pinned at a rail” fired 103 ms into the canary, 3 ms after the volume rose
```

The last change shows why replay and canary are both needed. The recorded second was quiet: with `tone.volume` at 2 the biquad peaks near 3900, and four times that is about 15 600, inside the rail. The scenario raises the volume to 12 at 100 ms; four times the new peak of about 23 350 is far past 32 767, so the output saturates and the assertion fires within one 330 Hz period. Replay checks the change against the past; the canary checks it against the present.

### 15.4 Recording and replay

A recording is a ring buffer of fired beats. Its cost is rate × width × duration. F-17 records `dry` at 48 000 beats a second, 16 bits each, for 2 seconds: 1 536 000 bits. The dev board's xc7a35t has 50 block RAMs of 36 Kbit, 1 843 200 bits in all. Counting bits alone gives 83 %, but block RAM is allocated in whole words: 96 000 words of 16 bits need 47 RAMB36 in 2K × 18 mode, about 94 % (47 of the 50), so the board build reports `record-budget` unless `keep` is shortened. The bridge of Chapter 14 cannot stream it either: 768 kbit/s of payload is more than a 1 Mbaud UART carries once each 4 data bytes are wrapped in a 9-byte frame. In simulation, where the scenario runs, recording is free, and the design passes as written.

Replay drives a simulation of the candidate with the recorded input beats, in order and at their recorded beat rate, and checks that every input beat yields its output beats at the recorded rate, with no stall: the bounded-liveness half of R15.1. It does not compare output values, because a change is expected to alter them; output equivalence is equiv()'s job (15.2). Every assertion is active during replay, so an assertion that would have fired on the recorded traffic rejects the change before anything is built.

### 15.5 Partial reconfiguration

On 7-series parts, Weft uses AMD's Dynamic Function eXchange (DFX) flow. A region declared with `.regions(r => r.partition("dsp", { luts: 1500, dsps: 6 }))` becomes a *reconfigurable partition* inside a *pblock*, a rectangle of the device sized to hold that many LUTs and DSP columns. Everything outside it is the *static region*, implemented once and then locked.

```text
# Sketch of the non-project Tcl Weft drives; see UG909 for the full flow.
set_property HD.RECONFIGURABLE true [get_cells dsp]
create_pblock pblock_dsp
add_cells_to_pblock pblock_dsp [get_cells dsp]
resize_pblock pblock_dsp -add {SLICE_X0Y50:SLICE_X27Y99 DSP48_X0Y20:DSP48_X0Y39}
set_property SNAPPING_MODE ON [get_pblocks pblock_dsp]
set_property RESET_AFTER_RECONFIG true [get_pblocks pblock_dsp]
# implement the first configuration, then keep only the static part, locked
opt_design; place_design; route_design
update_design -cell dsp -black_box
lock_design -level routing
# each later configuration is implemented against the locked static design
read_checkpoint -cell dsp build/dsp_biquad.dcp
place_design; route_design
write_bitstream -force build/dev/hot_swap.bit
```

The pblock coordinates above are placeholders; Weft computes them from the region's budget and the part's resource columns. `write_bitstream` produces a full bitstream and a partial one per reconfigurable partition. `pr_verify` checks that every configuration shares an identical static region. During development the host loads partials over JTAG. A deployed design uses an internal configuration access port (ICAPE2) fed from memory, which loads a small region in milliseconds.

The boundary is decoupled by R15.6, and R15.5 makes that generic. Because every port of a region is a stream or a knob, Weft forces the region's outgoing valid bits low and its incoming ready bits low during the load, with no special knowledge of the module inside.

### 15.6 State migration

A new partial bitstream starts its registers at their reset values, and an audio filter that restarts from zero clicks. `.migrate()` carries state across. Weft gives every register in a reconfigurable region a word in a generated *state page*, readable through the bridge while the region is decoupled. The host reads the old region's page into an object, calls the migration lambda, and writes the result into the new region's page before releasing reset.

```js
  .migrate(old => ({ y1: old.y, y2: old.y, out: old.y }));   // runtime lambda: the old region's registers, read back
```

F-17's biquad takes the one-pole filter's output `y` as both of its past outputs, and its own `out`. Its past inputs `x1` and `x2` are not set, so they reset to zero (R15.11). The migration lambda is a runtime lambda (Chapter 3), so it may use any JavaScript, and it sees only register values, never hardware. 7-series parts can also capture flip-flop states into configuration memory and read them back through the configuration port. Weft prefers the state page because it works the same on every family and needs no knowledge of frame addresses.

### 15.7 Canary and rollback

Each trigger in `rollbackOn` maps to hardware the build already contains. Assertions in the region are synthesized as monitors that set sticky bits in the region's status page (Chapter 9). Watchdogs count resets. Each stream named in a `watch` list gets a beat counter, which the host differences over the window. The canary polls these through the bridge at a rate the build chooses from the window length. Reading one counter every 10 ms uses under 2 % of the bridge's capacity of about 5 500 transactions a second.

Rollback reverses the load. The host reloads the previous partial bitstream, which it kept at commit time, writes back the state snapshot it read before the change, and releases the region. The snapshot is from the moment of the change, not from the moment of the rollback. For F-17 that means the filter resumes from where it was before `gain × 4`, which is audible only as a short gap.

### 15.8 Agents

An agent receives a *dossier*: the evidence a person would want, with provenance on every node. For F-18's closer, the timing dossier for the path of Chapter 12 looks like this:

```js
{ kind: 'timing.failed', design: 'blend', domain: 'fast', target: '300 MHz', slack: -4.67,
  path: [
    { op: 'in',  width: 8,  origin: { file: 'F-18-timing-closer.js', line: 31, src: 'l.alpha' } },
    { op: 'sub', width: 9,  origin: { file: 'F-18-timing-closer.js', line: 32, src: '255 - l.alpha' } },
    { op: 'mul', width: 17, origin: { file: 'F-18-timing-closer.js', line: 32, src: 'l.bg * (255 - l.alpha)' } },
    { op: 'add', width: 19, origin: { file: 'F-18-timing-closer.js', line: 32, src: '… + 128' } },
    { op: 'sat', width: 8,  origin: { file: 'F-18-timing-closer.js', line: 33, src: 'sat(mix, u(8))' } },
    { op: 'rom', width: 8,  origin: { file: 'F-18-timing-closer.js', line: 33, src: 'GAMMA[sat(mix, u(8))]' } } ],
  pipelined: ['layers → out'],         // paths whose latency may change (R12.9)
  scope: { propose: ['modules/*', 'knobs/*'], never: ['pins', 'clocks', 'boot', 'streams'] } }
```

The slack and the path come from Chapter 12's analysis with its illustrative delays. A real dossier carries post-route numbers (Chapter 13). For F-19's mechanic, an escalation dossier carries the group's reset times, the probe's capture from before the last reset, the source of the modules in the group, and the DAG around the failing node.

A proposal is admitted by matching. Each resource a change touches is a path: `modules/blend`, `knobs/game.speed`, `streams/out`, `clocks/fast`. A scope is a capability list of `propose` patterns, checked against every resource, and `never` patterns, which also cover everything beneath them.

```js
const glob = p => { const parts = p.split('*'); return s => {      // '*' matches any run of characters
  if (!s.startsWith(parts[0])) return false;
  let at = parts[0].length;
  for (const mid of parts.slice(1, -1)) { const k = s.indexOf(mid, at); if (k < 0) return false; at = k + mid.length; }
  const last = parts.at(-1); return parts.length === 1 ? s === p : s.length - last.length >= at && s.endsWith(last);
}; };
const under = p => { const m = glob(p); return s => m(s) || s.startsWith(`${p}/`); };   // 'pins' covers 'pins/led:0'

export function checkScope(scope, touched) {
  const ok = scope.propose.map(glob), no = scope.never.map(under);
  const refused = touched.filter(r => no.some(m => m(r)) || !ok.some(m => m(r)));
  return refused.length ? { ok: false, refused } : { ok: true };
}

export function budget({ proposals, per }) {                       // a counter per window: per a build, or per hour
  const used = new Map();
  return window => { const n = (used.get(window) ?? 0) + 1; used.set(window, n); return n <= proposals; };
}
```

| Proposal touches | Admitted? |
| --- | --- |
| `modules/blend` | yes |
| `modules/blend` and `streams/out` | no: `streams/out` is under `never: streams` |
| `clocks/fast` | no: under `never: clocks`, and no `propose` pattern matches |
| `knobs/game.speed` | yes |

With `budget({ proposals: 3, per: "build" })`, the first three proposals in a build were admitted and the fourth was refused. A refused proposal never enters the pipeline. An admitted one still passes every stage of 15.3, and with `approve: "you"` it waits for a person before `committed`. The agent's authority is the intersection of its scope, its budget and the pipeline's checks.

### 15.9 Reset groups as supervision

F-19 groups modules the way Erlang/OTP groups processes. A failing child is reset by its group's strategy, and a group that resets too often hands the problem up. Here the escalation target is an agent rather than a parent supervisor.

```js
export function group({ name, children, strategy, maxResets, window, escalate, dependents = {} }) {
  const resets = [], log = [];
  return {
    log,
    fail(child, now) {
      while (resets.length && now - resets[0] > window) resets.shift();     // forget resets older than the window
      resets.push(now);
      if (resets.length > maxResets) { log.push(`${now} ms  ${name}: ${resets.length} resets in ${window} ms, escalate to ${escalate}`); return; }
      const hit = strategy === 'one-for-one' ? [child]
                : strategy === 'all-for-one' ? children
                : [child, ...(dependents[child] ?? [])];                    // 'dependents': the child and what consumes its streams
      log.push(`${now} ms  ${name}: ${child} failed, local reset of ${hit.join(', ')}`);
    },
  };
}
```

F-19's video group is `all-for-one` with `maxResets(3, "10s")`. With the HDMI encoder hanging at 1.0, 1.3, 1.6 and 1.9 seconds, the model printed:

```text
1000 ms  video: hdmi failed, local reset of beam, renderer, hdmi
1300 ms  video: hdmi failed, local reset of beam, renderer, hdmi
1600 ms  video: hdmi failed, local reset of beam, renderer, hdmi
1900 ms  video: 4 resets in 10000 ms, escalate to mechanic
```

The same children under `dependents`, where the renderer feeds the encoder, reset only the renderer and the encoder when the renderer fails. In hardware the sliding window is exact and cheap. The group keeps the times of its last n + 1 resets, read from a free-running millisecond counter, so `maxResets(3, "10s")` costs four 16-bit registers and one comparator. A local reset is synchronous, held for a fixed number of cycles, and released in the order `.boot()` gives (D13).

### 15.10 Worked example: F-17 and F-19 end to end

| Time (simulated) | F-17 | F-19 |
| --- | --- | --- |
| Change applied | `softer` writes `filter.alpha` = 12 and commits | none |
| Swap | biquad: replay, partial build, decouple, load, migrate `y` into `y1`, `y2`, `out`, 300 ms canary, commit | none |
| Bad change | `gain × 4`: replay passes on quiet traffic; the volume rises; the assertion fires; reload the previous partial; restore the snapshot | none |
| Repeated failure | none | hdmi hangs four times in 900 ms; three all-for-one resets; escalation with a dossier |
| Agent | none | the mechanic's proposal is checked against its scope, enters the pipeline, waits for `approve()`, and is built as a partial for region `gfx` |

### 15.11 Tests

- **Contract.** Generate random latency-insensitive pipelines and their retimed versions. The beat miter and liveness check must accept every pair, and the cycle miter must reject every pair whose latency changed. Corrupt one beat: the beat miter must name it.
- **Pipeline.** For every stage, a stub that fails there must leave the change rejected if the stage comes before `built` and rolled-back otherwise. A knob-only change must never call `built`.
- **Regions.** A design with a raw wire across a region boundary must fail with `region`. During a simulated load, every outgoing valid bit must be low and every incoming ready bit low.
- **Migration.** Snapshot, migrate and restore must round-trip every register of a region whose new definition is identical to the old one.
- **Agents and groups.** Scope matching must refuse anything under a `never` pattern even when a `propose` pattern also matches. A group must escalate exactly on reset n + 1 within the window and never after the window has emptied.

### 15.12 Exercises

1. Implement the transaction miter of 15.2 as a Weft module with two beat counters and an assertion, and prove F-18's latency change equivalent with bounded model checking (Chapter 9).
2. Add a `stall` trigger to the canary: a stream whose beat counter stops for longer than a bound, as F-17's `rollbackOn("assert", "stall")` requests. Choose the bound from the stream's declared rate.
3. Give `.record()` a compression option that stores only beat-to-beat differences, and compute the BRAM F-17's 2-second recording would need for a 330 Hz sawtooth.
4. Write the inverse migration for F-17's swap, from the biquad back to the one-pole filter, and use it during rollback instead of the pre-change snapshot. When is each better?
5. Implement the `dependents` strategy from the stream graph instead of a hand-written table, and test it on F-19's video and audio groups.

### 15.13 Further study

- **AMD UG909, Vivado Design Suite User Guide: Dynamic Function eXchange.** It is the authority for 15.5: partitions, pblocks, locking, decoupling and partial bitstreams.
- **Kahng, Lienig, Markov and Hu, VLSI Physical Design, Chapter 8 (Timing Closure).** It covers the problem F-18's closer works on, from the physical-design side.
- **Lakeroad: Sketch-Guided Technology Mapping.** It is a model of a tool that proposes implementations and proves them correct against vendor semantics before using them, which is the discipline 15.8 asks of agents.
- **Pnueli, Siegel and Singerman, Translation Validation.** It is the idea behind checking each change against R15.1 instead of trusting whoever proposed it.
- **Armstrong, Making Reliable Distributed Systems in the Presence of Software Errors.** It is the source of supervision trees, restart strategies and restart intensity.
- **Project F, FPGA Pong, and Cornell ECE 5760.** They are whole-system designs on real boards of the kind F-19 describes. MIT 6.175 covers composing many interacting hardware components with guarded interfaces.

## Appendix A · Specification decisions

The nineteen examples fix Weft's surface but leave fifteen semantic questions open. Each entry below states the question, the rule this book adopts, the reason, and the chapter that implements it. Where the rule differs from what a reader might assume, the entry says so.

### D1 · Types and widths

**Question.** How wide is every expression, and what happens when a value does not fit its destination?

**Rule.** `bit` is `u(1)`; `u(n)` and `s(n)` exist for n ≥ 1. A constant k ≥ 0 has type `u(max(1, bitlen(k)))`; a negative k has type `s(bitlen(−k−1) + 1)`. Addition of unsigned values grows by one bit; unsigned subtraction is signed and one bit wider; multiplication sums widths and is signed if either operand is; negation of `s(n)` gives `s(n+1)`; shifts by a constant add or remove that many bits; bitwise operators take the join of the two types (R1.6); comparisons and logical operators give `bit`; a conditional takes the smallest type holding both arms. A `u(n)` operand meeting a signed one is treated as `s(n+1)`. Division and modulo are allowed only on unsigned operands and only by constant powers of two; on signed operands JavaScript's division truncates toward zero while a shift floors, so they are rejected. Narrowing assignment is error `width` unless written `wrap(x, T?)` or `sat(x, T)`; widening extends by zero or sign; compound assignments wrap.

**Why.** Every operation is lossless by itself, so a lost bit is always visible in the source. **Chapter 1.**

### D2 · Parameters are not captures

**Question.** F-04 uses `N` inside a hardware lambda without `.lib()`. F-03 forbids `gamma`. What separates them?

**Rule.** Parameters form a typed constant environment Θ, fixed per specialization. A hardware lambda's allowed free names are `$`, the prelude (`wrap`, `sat`, `u`, `s`, `bit`, `vec`, `clog2`, `past`, `within`, `sequence`, `rep`, `cat`), dom(Θ) and dom(Lib). Everything else is error `capture`. A `.lib()` name equal to a parameter name is error `lib-shadows-param`. Helper functions shipped by `.lib()` are checked by the same rule, transitively.

**Why.** Parameters are declared on the same builder and are constant by construction, so shipping them is safe and needs no syntax. Lexical captures are neither declared nor guaranteed constant. **Chapters 2 and 3.**

### D3 · Elaboration

**Question.** What is a specialization, and when are two instances the same hardware?

**Rule.** elaborate(P, θ) = G\_θ. Builders are immutable persistent records. A specialization's key is the definition's identity, the canonical JSON of θ and the clock domain; elaboration is memoized on that key, with one memo table per target build, so a domain named sys at 12 MHz never shares a specialization with sys at 100 MHz. `.as(name)` changes only the instance name. Loops in hardware lambdas must have bounds computable from constants, and unrolling stops at 4096 iterations with error `unroll-bound`.

**Why.** Memoization makes eight identical PWM instances one elaboration, and the unroll bound turns a mistaken data-dependent loop into a diagnostic rather than a hang. **Chapter 2.**

### D4 · Several writers of one register

**Question.** F-05 writes `leds` in two `.on()` handlers; F-06's greeter writes `go` in `.every()` and `.seq()`. Which write wins when both fire?

**Rule.** All clocked blocks of a module (`.seq`, `.every`, `.on` handlers, fsm states, pipeline stages) merge into one next-state function in declaration order. For each register, the last block in declaration order whose path guard holds on that cycle wins; within one lambda, the last assignment in program order wins; with no writer the register holds, and a `pulse` loads 0. The compiler emits warning `multi-writer` when two blocks' guards can hold on the same cycle, with a satisfying assignment as the witness. A signal written in a clocked block and in `.comb` is error `mixed-kind`; two `.comb` blocks writing one wire is error `multi-driver`.

**Why.** Declaration order is visible in the source and costs one priority multiplexer. The warning catches the cases where the programmer did not intend an order. In F-05, `invert.rise` wins over a press on a shared cycle; in F-06, the greeter's `.seq` clears `go` even if the timer fires on the same cycle. **Chapter 4.**

### D5 · Reads after writes

**Question.** In a clocked block, does a read after a write see the new value?

**Rule.** No. In clocked blocks `$.r` always reads the register's current value Q. Locals (`const`, `let`) are wires; reassigning a `let` is SSA renaming with multiplexers where paths join. In `.comb`, a read of a wire sees the latest earlier write in program order, and reading a wire in its own `.comb` lambda before any write to it is error `comb-read-before-write`.

**Why.** Clocked semantics match the hardware, where all registers update together at the edge; F-15's delay line and F-19's `$.wait` both depend on it. Combinational semantics match program order, and the error rules out an accidental loop. **Chapters 3 and 4.**

### D6 · Events and time

**Rule.** `.on("p.rise")` is `p ∧ ¬past(p)`, one inserted register. Input pins bound with `.bind()` get a two-flop synchronizer. `.every(d, fn)` is a prescaler of ⌈log2 N⌉ bits with N = d · f\_clk, and a module whose domain has no known frequency gets error `every-no-clock`. `.on(stream, fn)` fires on a beat. **Chapter 4.**

### D7 · Streams

**Rule.** fire = valid ∧ ready. Valid must not depend combinationally on the same interface's ready, and once valid rises, valid and data hold until fire. A stream has one producer (error `multi-producer`); several consumers get an eager fork that delivers each beat to each consumer once. `$.push` returns fire, `$.has` is valid, `$.take` asserts ready and returns data. A handler's ready is the AND of the ready of every stream it may push to on that cycle. Buffers: depth 1 is a register, 2 a skid buffer, 3–63 LUT RAM, 64 and up block RAM. iCE40 has no LUT RAM, so there up to 16 entries become flip-flops and more go to EBR. RAMs follow the same rule: fewer than 64 words is LUT RAM, 64 and more is block RAM. Policies are `block`, `drop-oldest`, `drop-newest` and `latest`; lossy streams always accept, and their drop counters are 16-bit saturating status registers. **Chapter 6.**

### D8 · Memories

**Question.** What does a memory read return, and when, especially if the same address is written on the same cycle?

**Rule.** `.ram()` is simple dual-port: one read and one write per cycle. `read(a)` captures the address at the edge; `q` is valid after that edge, is used on the next cycle, and holds until the next read. `write(a, v)` happens at the edge. A read and a write to the same address on one cycle returns the old data (read-first) unless the declaration says `rdw: "write-first"`. Arrays shipped by `.lib()` are ROMs read combinationally in the language; `mem.infer` puts a ROM in block RAM only when its read result is registered before use.

**Why.** Read-first is what both 7-series and iCE40 block RAMs can implement without extra logic, and stating it removes the most common simulation-versus-hardware disagreement. **Chapter 7.**

### D9 · The observational contract

**Question.** When a change adds a pipeline stage, in what sense is the design "the same"?

**Rule.** A design's observables are its ports and pins on every cycle, except the stream paths of a `pipeline()` or of a module marked `.pipelined()`, which are observed as the sequence of fired beats. Two designs are equivalent when cycle observables are equal on every cycle, beat sequences on those paths are equal, and every input beat yields its output beats within a stated bound.

**Why.** Cycle-by-cycle equality forbids exactly the transformation F-15 and F-18 need. Beat-sequence equality alone would allow a design that never answers, so the bound is part of the contract. **Chapter 15.**

### D10 · Structure is not semantics

**Rule.** `verifyEach` checks structural invariants only: types, single drivers, no combinational cycle, consistent domains, provenance present. Semantic preservation is a separate check, `c.validate()`: a SAT miter over matched register boundaries for passes that do not move registers, and sequential or transaction-level checks for the `time` stage. Rewrite rules are screened by SAT for widths 1–16 and both signednesses when loaded, then proved again at each concrete width and signedness where they fire, with results cached. A failing instance rejects the rule with error `rule-unsound`.

**Why.** A pass can preserve every invariant and still change behavior. A rule proved for widths up to 16 is not thereby proved for width 48, so the instance proof is what licenses each rewrite. **Chapter 11.**

### D11 · Stages and passes

**Rule.** `front`: parse, elaborate, link. `lower`: fsm.extract, pipeline.registers, stream.lower, csr.collect, flatten, widths, checks.loops, checks.latches, checks.cdc. `optimize` (to a fixpoint): constFold, cse, muxTree, dce. `time`: pipeline.cut, retime. `map`: mem.infer, dsp.pack, fsm.encode, techmap, and srl.infer on 7-series. `back`: place, route, timing. IR levels: `hir` after front, `dag` from lower through time, `net` after map, `phys` after back. **Chapters 10–13.**

### D12 · State encoding

**Rule.** `auto` picks Gray when the transition graph is a single cycle, binary for other machines of up to four states, and one-hot above that. `.encode()` overrides. **Chapter 5.**

### D13 · Reset

**Rule.** Reset is synchronous and active-high, to the `.init()` value or zero. A `group` is a reset domain with strategy `one-for-one`, `all-for-one` or `dependents`; `.boot()` orders the release of group resets after the PLLs lock. Two kinds of state are exempt: data registers on .pipelined() paths have no reset and only their valid bits reset (R12.10), and memories are never reset (Chapter 7). **Chapters 4 and 15.**

### D14 · Clocks

**Rule.** The default domain `sys` is the board's main clock. `.clocks()` solves PLL or MMCM settings for all outputs of one PLL together, from a single VCO, so F-10's pixel clock and the encoder's ×5 clock are solved as one problem. **Chapter 12.**

### D15 · Simulation

**Rule.** Each cycle evaluates all combinational logic from the current register values, then updates every register at once. Simulation is deterministic, `tb.random` is seeded, and a scenario can run at levels `hir`, `dag` and `net`. **Chapter 8.**

### Rules the chapters add

Writing the reference implementations forced more decisions than D1–D15. These are the ones a second implementation would most likely get wrong; each is stated in full in its chapter.

| Rule | Chapter | Statement |
| --- | --- | --- |
| R2.7 | 2 | One memo table per target build; specializations are never shared across targets with different clocks. |
| `.every` timing | 4 | The first tick falls on cycle N − 1, and the rounding error of N is listed in the build report (48 kHz at 100 MHz: 2083 cycles, −0.016 %). |
| Stream defaults | 6 | Every stream is buffered at its producer, depth 2 and policy `block` unless declared. `block` has no pass-through: it accepts when occupancy at the start of the cycle is below the depth. |
| Open stream ends | 6 | A declared stream with no producer is a design input; one with no consumer is a design output. |
| ROM indices | 7 | An index wider than ⌈log2 n⌉ bits is error `rom-index`; otherwise the table is padded with zeros to a power of two, which keeps F-06's `MSG[$.i]` legal. |
| Memory placement | 7 | A ROM of 64 words or fewer, or with an unregistered read, becomes LUT logic. A RAM of fewer than 64 words becomes LUT RAM where the family has it; on iCE40 up to 16 words become flip-flops and more go to EBR. A single-port RAM of at least 32 Kbit becomes SPRAM on iCE40. Everything else packs into the fewest block-RAM equivalents. |
| R9.3 | 9 | Monitor registers update on every cycle; no `&&` or `\|\|` in a property short-circuits them. |
| Vacuity | 9 | A proof also checks that the assumptions admit a run of the requested depth, or warns `vacuous`. |
| Typed constants | 10 | A constant node may carry a declared type in `attrs.type`, so folding never changes a user's type. |
| R12.6 | 12 | A synchronizer has two flip-flops, or three when its MTBF falls below the design's floor (default 1000 years). In simulation each crossing delays 2 or 3 destination cycles, drawn from the seeded generator, so a design that depends on an exact crossing latency fails a test. |
| R12.10 | 12 | `retime` moves registers only inside `.pipelined()` regions, never across a stall enable or an observable reset; data registers there have no reset. |
| R14.4 | 14 | The system block occupies 0x0000–0x00FF (identifier, pending and enabled interrupts); each module with registers gets a 256-byte page from 0x0100, in sorted instance-path order, one 32-bit word per register in declaration order. |
| R15.5 | 15 | A reconfigurable region's ports must be streams and knobs, so its boundary can be decoupled generically during a load. |
| R15.7 | 15 | A board build fails with `record-budget` when a `.record()` window does not fit the memory or the host link; F-17's 2 s window would take about 94 % of the xc7a35t's block RAM (47 of the 50 RAMB36, in 2K × 18 mode). |
| R15.9 | 15 | Building a change takes no simulated time; only loading and the canary window advance the simulated clock. |

## Appendix B · Reference

The API as typed declarations, the IR's opcodes, the pass catalogue and the diagnostics. The declarations are TypeScript notation for reference only; the implementation is JavaScript. `HW` marks a hardware lambda (parsed, never called) and `RT` a runtime lambda.

### B.1 API declarations

```ts
// ---- types and lambdas ----
interface Type { readonly width: number; readonly signed: boolean; init(v: number | bigint | object): Type }
declare function u(n: number): Type;           declare function s(n: number): Type;
declare const bit: Type, pulse: Type;
declare function vec(t: Type, n: number): Type; declare function struct(f: Record<string, Type>): Type;
type Params = Record<string, unknown>;
type Env = { clock: { name: string; hz: number }; part: string; board?: string };
type Lazy<T> = T | ((p: Params, env: Env) => T);       // a builder lambda of params (D2, D3)
type HW = ($: any, ...args: any[]) => any;             // parsed into HIR, never called
type RT<A extends any[], R> = (...a: A) => R;           // ordinary JS, runs beside sim or board
type Dur = string;                                      // "250ms", "1s", "48 kHz"

// ---- components: module(), fsm(), pipeline() ----
interface Component<Self> {
  readonly name: string;
  params(p: Params): Self;                 require(check: (p: Params) => true | string): Self;
  in(name: string, t: Lazy<Type>): Self;   in(ports: Record<string, Lazy<Type>>): Self;
  out(name: string, t: Lazy<Type>): Self;  out(ports: Record<string, Lazy<Type>>): Self;
  regs(r: Lazy<Record<string, Type>>): Self;
  seq(f: HW): Self;  comb(f: HW): Self;  every(d: Dur, f: HW): Self;
  on(event: string, f: HW): Self;          // a stream name, "port.rise" or "port.fall"
  provides(...streams: string[]): Self;    needs(...streams: string[]): Self;
  lib(v: Lazy<Record<string, unknown>>): Self;
  bind(m: Record<string, string>): Self;   domain(name: string): Self;
  ram(name: string, o: { of: Type; words: number; rdw?: "read-first" | "write-first" | "undefined" }): Self;
  knob(name: string, t: Type, o?: { reset?: number; min?: number; max?: number; doc?: string }): Self;
  status(name: string, t: Type): Self;     irq(name: string): Self;
  budget(f: (b: Budget) => Budget): Self;  hint(h: Lazy<Record<string, string>>): Self;
  pipelined(o: { path: [string, string] }): Self;
  assert(name: string, f: HW): Self;  assume(name: string, f: HW): Self;  cover(name: string, f: HW): Self;
  supervise(f: (s: Supervisor) => Supervisor): Self;  probe(f: (p: Probe) => Probe): Self;
  migrate(f: RT<[Record<string, number>], Record<string, number>>): Self;
  with(p: Params): Self;  as(name: string): Self;
}
interface Fsm extends Component<Fsm> {
  initial(s: string): Fsm;  state(s: string, f: HW): Fsm;  step(stream: string): Fsm;
  encode(e: "auto" | "binary" | "onehot" | "gray"): Fsm;
}
interface Pipeline extends Component<Pipeline> { stage(name: string, f: HW): Pipeline; stall(k: "global" | "skid"): Pipeline }
interface Budget { luts(n: number): Budget; ffs(n: number): Budget; brams(n: number): Budget; dsps(n: number): Budget }
interface Supervisor { watchdog(d: Dur, alive: HW): Supervisor; reset(k: "local"): Supervisor;
  strategy(k: "one-for-one" | "all-for-one" | "dependents"): Supervisor; maxResets(n: number, window: Dur): Supervisor; escalate(agent: string): Supervisor }
interface Probe { signals(...names: string[]): Probe; depth(n: number): Probe; keep(k: "before-reset" | "on-trigger"): Probe }

// ---- streams, memories, groups ----
interface Stream { of(t: Type): Stream; buffer(n: number, o?: { overflow: "block" | "drop-oldest" | "drop-newest" | "latest" }): Stream;
  cross(o: { from: string; to: string }): Stream }
interface Rom { of(t: Type): Rom; from(n: number, f: (i: number) => number): Rom }
interface Group { children(...names: string[]): Group; supervise(f: (s: Supervisor) => Supervisor): Group }

// ---- designs ----
type Level = "hir" | "dag" | "net" | "phys";
interface Design {
  board(b: string | Board): Design;  boards(m: Record<string, Board>): Design;  part(p: string): Design;
  clocks(f: (c: Clocks) => Clocks): Design;
  use(...items: unknown[]): Design;
  wire(from: string, to: string): Design;  wire(pairs: [string, string][]): Design;  pins(m: Record<string, string>): Design;
  regions(f: (r: Regions) => Regions): Design;  place(m: Record<string, string>): Design;
  record(o: { streams?: string[]; inputs?: boolean; keep: Dur }): Design;
  boot(f: (b: Boot) => Boot): Design;
  compile(f?: (c: Compiler) => Compiler): Design;
  prove(f: (p: Prover) => Prover): Design;
  scenario(name: string, f: ((sc: Sc) => Sc) | RT<[Tb], Promise<void>>, o?: { levels?: Level[]; targets?: "all" | string[] }): Design;
}
interface Board { part(p: string): Board }
interface Clocks { pin(name: string, resource: string): Clocks; port(name: string, o: { hz: string }): Clocks;
  pll(name: string, o: { from: string; hz: string; tolerance?: string }): Clocks }
interface Boot { start(...g: string[]): Boot; then(...g: string[]): Boot; background(...g: string[]): Boot }
interface Prover { module(name: string): Prover; bmc(k: number): Prover; induction(): Prover; engine(e: "smt" | "abc-pdr"): Prover }

// ---- the compiler ----
interface Compiler {
  use(p: PassPipeline): Compiler;  stage(name: string, f: (s: Stage) => Stage): Compiler;
  after(at: string, f: (s: Stage) => Stage): Compiler;  before(at: string, f: (s: Stage) => Stage): Compiler;
  replace(name: string, p: Pass): Compiler;  without(name: string): Compiler;
  when(pred: (t: Target) => boolean, f: (c: Compiler) => Compiler): Compiler;
  cache(dir: string): Compiler;  verifyEach(): Compiler;  validate(o?: { passes?: string[] }): Compiler;   // validate: D10
  snapshot(l: Level, o: { after: string; as: "dot" | "text" | "json"; to: string }): Compiler;
  inspect(l: Level, f: (ir: IR) => void, o?: { after: string }): Compiler;
  check(name: string, f: (r: Report, t: Target) => true | string): Compiler;
  emit(b: string | Backend, o?: { to?: string | ((t: Target) => string); level?: Level }): Compiler;
  explore(f: (x: Explorer) => Explorer): Compiler;  explainPlan(): Compiler;
}
interface Stage { pass(...p: Pass[]): Stage; fixpoint(o: { max: number }): Stage }
interface PassB { on(l: Level): PassB; requires(...a: Array<Analysis | string>): PassB; preserves(...names: string[]): PassB;
  params(p: Params): PassB; visit(op: string | string[], f: (n: Node, g: IR, ctx: Record<string, unknown>) => void): PassB;
  run(f: (g: IR, ctx: Record<string, unknown>) => void): PassB; readonly(): PassB; with(p: Params): PassB }
interface AnalysisB { on(l: Level): AnalysisB; run(f: (g: IR) => unknown): AnalysisB }
interface RewriteB { from(p: HW): RewriteB; where(f: (m: Record<string, Node>) => boolean): RewriteB; to(r: HW): RewriteB;
  examples(e: Array<[HW, HW | null]>): RewriteB }
interface BackendB { on(l: Level): BackendB; emit(f: (ir: IR, out: { file(path: string, text: string): void }) => void): BackendB }
interface Explorer { knob(path: string, values: unknown[]): Explorer; measure(f: (r: Report) => Record<string, unknown>): Explorer;
  keep(f: (m: Record<string, unknown>) => boolean): Explorer; pareto(keys: string[]): Explorer; parallel(n: number): Explorer; report(path: string): Explorer }

// ---- runtime, changes, agents ----
interface Tb { poke(path: string, v: number): Promise<void>; peek(path: string): Promise<number>; step(n?: number): Promise<void>;
  wait(d: Dur): Promise<void>; set(pins: string, v: number): Promise<void>; measure(pin: string, o: { over: Dur }): Promise<number>;
  push(stream: string, beats: unknown | unknown[]): Promise<void>; pull(stream: string, n?: number): Promise<unknown>;
  random: { int(lo: number, hi: number): number }; expect(c: boolean, msg?: string): void;
  expectEqual(a: unknown, b: unknown, msg?: string): void; expectCoverage(k: "all" | string[]): void }
interface Host { over(bridge: string): Host; onStart(f: RT<[Dev], unknown>): Host; every(d: Dur, f: RT<[Dev], unknown>): Host;
  on(event: string, f: RT<[Dev, unknown], unknown>): Host }
interface Dev { knob(path: string): { get(): Promise<number>; set(v: number): Promise<number>; update(f: (v: number) => number): Promise<void> };
  status(path: string): { read(): Promise<number> }; registers(): Promise<unknown>; clock: { seconds(): number }; log(...a: unknown[]): void }
interface Change { knob(path: string, v: number): Change; patch(module: string, p: { lib?: Record<string, unknown>; on?: Record<string, HW>; seq?: HW; comb?: HW }): Change;
  replace(module: string, m: Component<any>): Change; verify(f: (v: Verify) => Verify): Change;
  deploy(f: (d: Deploy) => Deploy): Change; rollbackOn(...events: Array<"assert" | "stall" | "watchdog" | "timing">): Change }
interface Verify { lint(): Verify; ports(k: "same"): Verify; replay(window: string): Verify; timing(): Verify; equiv(o?: { upTo?: "stream latency" }): Verify }
interface Deploy { partial(region: string): Deploy; canary(d: Dur, o?: { watch: string[] }): Deploy }
interface Agent { model(m: string): Agent; guidelines(t: string): Agent; scope(f: (s: Scope) => Scope): Agent;
  budget(o: { proposals: number; per: string }): Agent; on(event: string, f: RT<[Ctx, unknown], unknown>): Agent }
```

### B.2 IR opcodes

| Opcode | Operands | Result type | Meaning |
| --- | --- | --- | --- |
| `in` | — | the port's type | Value of an input port this cycle |
| `out` | x | the port's type | Drives an output port |
| `const` | — | narrowest type (D1), or `attrs.type` | A literal; `attrs.value` is a BigInt, and `attrs.type` keeps a declared type when folding produced the constant |
| `reg` | — (none) | declared type | Q of a register; `attrs.init`, `domain`; `attrs.next` is its D input |
| `add`, `sub` | a, b | D1 | Exact sum or difference; cannot overflow its own type |
| `mul` | a, b | w\_a + w\_b bits, signed if either operand is | Exact product |
| `neg` | a | s(n + 1) | Exact negation |
| `and`, `or`, `xor` | a, b | the join of the two types (R1.6) | Bitwise, after extension |
| `not` | a | same | Bitwise inversion |
| `shl`, `shr`, `ashr` | a, k | constant k: w ± k; dynamic k: `shl` w + 2^w\_k − 1, `shr` w | Shifts; `ashr` keeps the sign |
| `eq`, `ne`, `lt`, `le`, `gt`, `ge` | a, b | bit | Comparisons; `attrs.signed` |
| `mux` | c, t, f | smallest type holding t and f | c ? t : f |
| `concat` | a, b, … | sum of widths | The first operand is most significant |
| `slice` | a | hi − lo + 1 bits, unsigned | Bits hi..lo |
| `wrap` | a | `attrs.type` | Modulo 2^w, read in the target type's signedness; what `wrap()` lowers to |
| `sext`, `zext` | a | `attrs.width` | Sign or zero extension |
| `sat` | a | target type | Clamp to the target's range |
| `mem` | — | — | One memory; `attrs.words`, `rdw`, `init` |
| `memrd` | mem, addr, en | element type | Read port; the address is registered inside the port and the data appears on the next cycle (D8) |
| `memwr` | mem, addr, data, en | — | Write port; writes at the edge when en is high |
| `rom` | index | element type | Combinational table read; `attrs.table`, `type` |
| `cell` | inputs | `attrs.outputs` | A technology cell at level `net`: LUT, FF, CARRY, DSP, RAM |
| `probe` | x, … | — | Marks signals for scenarios and on-chip capture |

Pure opcodes are hash-consed on (op, args, type, attrs). The stateful opcodes are never merged: `in`, `out`, `reg`, `mem`, `memwr`, `probe`, and the read port `memrd`.

### B.3 Pass catalogue

| Pass | Stage | Level | What it does |
| --- | --- | --- | --- |
| `parse` | front | source → hir | Parses hardware lambdas; runs the capture check (D2) |
| `elaborate` | front | hir | Applies params, `.with()`, `.require()`; memoizes specializations (D3) |
| `link` | front | hir | Joins `provides`/`needs`, `.wire()` and pins; inserts forks; reports `unmet-need`, `multi-producer`, `pin-claimed` |
| `fsm.extract` | lower | hir | States and returns → transition graph and next-state logic |
| `pipeline.registers` | lower | hir | Inserts registers for values live across stages |
| `stream.lower` | lower | hir | Handshakes, buffers by depth and policy, drop counters (D7) |
| `csr.collect` | lower | hir | Gathers knobs, status and irqs into one register map and a bus slave |
| `flatten` | lower | hir → dag | Merges blocks (D4), removes hierarchy, one DAG per domain |
| `widths` | lower | dag | Infers and enforces D1 |
| `checks.loops` | lower | dag | Rejects combinational cycles (`comb-loop`) |
| `checks.latches` | lower | dag | Rejects wires not assigned on every path (`latch`) |
| `checks.cdc` | lower | dag | Propagates domains; rejects unmarked crossings (`cdc`) |
| `constFold` | optimize | dag | Evaluates nodes whose operands are constants |
| `cse` | optimize | dag | Merges structurally equal pure nodes |
| `muxTree` | optimize | dag | Flattens and simplifies nested multiplexers |
| `dce` | optimize | dag | Removes nodes that reach no output, register or probe; narrows unused high bits |
| `pipeline.cut` | time | dag | Places pipeline stages on `.pipelined()` paths to meet the clock |
| `retime` | time | dag | Moves registers on `.pipelined()` paths (Leiserson–Saxe) |
| `mem.infer` | map | dag → net | Maps memories and registered ROM reads to RAM cells (D8) |
| `dsp.pack` | map | dag → net | Folds multiply, add and register into DSP cells |
| `fsm.encode` | map | dag → net | Chooses state encodings (D12) |
| `srl.infer` | map | net | 7-series only: shift-register chains to SRL16/SRL32 cells |
| `techmap` | map | dag → net | Maps logic to the part's LUTs and carry chains |
| `place` | back | net → phys | Assigns each cell a site |
| `route` | back | phys | Assigns each net a path |
| `timing` | back | phys | Static timing analysis; error `timing` on negative slack |

### B.4 Diagnostics

| Code | Severity | Raised by | Meaning |
| --- | --- | --- | --- |
| `capture` | error | parse | A hardware lambda uses a name outside $, the prelude, params and `.lib()` |
| `lib-shadows-param` | error | parse | A `.lib()` name equals a parameter name |
| `lib-value` | error | parse | A shipped value has no hardware meaning (a Map, a class instance) |
| `unroll-bound` | error | parse | A loop bound is not constant, or exceeds 4096 iterations |
| `unsupported` | error | parse | Syntax outside the supported subset (R3.5): while, recursion, closures, try, async, object construction other than a struct literal |
| `temporal-position` | error | parse | `within()` or `sequence()` used outside the positions R9.2 allows |
| `mem-read-value` | error | parse | `$.m.read(a)` used as an expression; read data arrives in `$.m.q` on the next cycle |
| `require` | error | elaborate | A `.require()` check returned a message |
| `unmet-need` | error | link | A needed stream has no producer |
| `multi-producer` | error | link | Two modules provide one stream |
| `pin-claimed` | error | link | Two modules bind one output resource |
| `fsm-target` | error | fsm.extract | An initial or returned state is not a declared state |
| `fsm-unreachable` | warning | fsm.extract | A state cannot be reached from the initial state |
| `every-no-clock` | error | lower | `.every()` in a domain without a known frequency |
| `width` | error | widths | A narrowing assignment without `wrap()` or `sat()` |
| `rom-index` | error | widths | A ROM index type is wider than ⌈log2 n⌉ bits for an n-entry table |
| `mixed-kind` | error | flatten | A signal written in a clocked block and in `.comb` |
| `multi-driver` | error | flatten | Two `.comb` blocks write one wire |
| `multi-writer` | warning | flatten | Two clocked blocks can write one register on the same cycle; a witness is shown |
| `mem-ports` | error | flatten | Two reads or two writes of one `.ram()` can happen on the same cycle; a witness is shown |
| `comb-read-before-write` | error | flatten | A `.comb` lambda reads a wire before writing it |
| `latch` | error | checks.latches | A wire is not assigned on every path |
| `comb-loop` | error | checks.loops | A cycle without a register |
| `cdc` | error | checks.cdc | A signal crosses domains without `.cross()` or a crossing primitive |
| `pll` | error | lower | No PLL or MMCM setting meets every requested output of one PLL within tolerance and VCO limits |
| `region` | error | lower | A raw wire crosses a reconfigurable region's boundary; only streams and knobs may (R15.5) |
| `record-budget` | error | map | A `.record()` window does not fit the board's memory or host link (R15.7) |
| `rule-unsound` | error | rewrite engine | A rewrite rule fails its proof at some width (D10) |
| `lint` | warning | a readonly pass | A message from `g.warn()`, reported at the node's source line |
| `budget` | error | map | A module exceeds its `.budget()` |
| `timing` | error | timing | Negative slack after routing; the path is reported by source line |
| `stream-protocol` | error | simulation | Valid fell, or data changed, before a beat fired (D7) |
| `assert` | error | simulation, proof | An assertion failed; the trace or counterexample is attached |
| `assume-violated` | error | simulation | The stimulus broke an assumption: a testbench bug, not a design bug |
| `vacuous` | warning | proof | No run satisfies the assumptions to the requested depth, so every assertion holds trivially |

## Appendix C · Study curriculum

The nineteen examples span four bodies of knowledge: hardware semantics, streaming systems, compilers and synthesis, and runtime reconfiguration. Study each body alongside the milestones that build it. The first implementation sequence is F-02 → F-03 → F-06 → F-07 → F-11 → F-13 → F-14. Every link below was opened and checked on 18 October 2026.

### C.1 Four bodies of knowledge

| Area | Examples | Start with | Milestones |
| --- | --- | --- | --- |
| Hardware semantics and language design | F-01–F-06 | [MIT 6.004 Computation Structures](https://ocw.mit.edu/courses/6-004-computation-structures-spring-2017/); [Digital Design with Chisel](https://www.imm.dtu.dk/~masca/chisel-book.html) | M1–M4 |
| Streaming architectures and hardware systems | F-07–F-12 | [MIT 6.175 Constructive Computer Architecture](https://csg.csail.mit.edu/6.175/) | M5, M6, M8, M10 |
| Compiler construction, synthesis and optimization | F-13–F-16 | [Cornell CS 6120 Advanced Compilers](https://www.cs.cornell.edu/courses/cs6120/2025fa/); De Micheli, *Synthesis and Optimization of Digital Circuits* | M7, M9 |
| Runtime reconfiguration and autonomous engineering | F-17–F-19 | [AMD UG909, Dynamic Function eXchange](https://docs.amd.com/r/en-US/ug909-vivado-partial-reconfiguration); physical-design and formal-verification literature | M11 |

These courses are chosen because they have real lecture material, exercises and substantial implementations, not only tool demonstrations.

### C.2 Reading map, example by example

| Example | Read | Study | Chapter here |
| --- | --- | --- | --- |
| F-01 Blinky | Harris & Harris, Ch. 3 (Sequential Logic); [MIT 6.004, L05 Sequential Logic](https://ocw.mit.edu/courses/6-004-computation-structures-spring-2017/pages/c5/) | Clock enables, prescalers, register timing | 4 |
| F-02 Counter | Harris & Harris, Chs. 2–4; [Amaranth language guide: shapes](https://amaranth-lang.org/docs/amaranth/latest/guide.html) | Width inference, signed arithmetic, wrapping, saturation | 1 |
| F-03 Lambdas | Jones, Gomard & Sestoft, *Partial Evaluation and Automatic Program Generation*; [AnyHLS: High-Level Synthesis with Partial Evaluation](https://arxiv.org/abs/2002.05796) | Staging, quotation, closure capture, specialization | 2, 3 |
| F-04 Generators | [Digital Design with Chisel](https://www.imm.dtu.dk/~masca/chisel-book.html); partial evaluation | Host-language computation that generates circuits | 2 |
| F-05 Buttons | Harris & Harris, Chs. 3 and 5; [MIT 6.175](https://csg.csail.mit.edu/6.175/), lectures 5–7 on guarded interfaces, rules and scheduling conflicts | Events, edges, several writers (D4) | 4, 6 |
| F-06 FSM | De Micheli, Ch. 9 (Sequential Logic Optimization); Hachtel & Somenzi on FSM synthesis; [MIT 6.004, L06 Finite State Machines](https://ocw.mit.edu/courses/6-004-computation-structures-spring-2017/pages/c6/) | State extraction and encoding | 5 |
| F-07 Backpressure | [MIT 6.175](https://csg.csail.mit.edu/6.175/) on guarded interfaces and FIFOs; [LaForest, Rules for Ready/Valid Handshakes](https://fpgacpu.ca/fpga/handshake.html) | Composable streaming circuits | 6 |
| F-08 Memories | Harris & Harris, Chs. 5 and 8; [Yosys: memory handling](https://yosyshq.readthedocs.io/projects/yosys/en/latest/using_yosys/synthesis/memory.html) | Block RAM inference, port types, synchronous reads | 7 |
| F-09 Pipelines | Harris & Harris, Ch. 7; MIT 6.004 on pipelining; [LaForest, Pipeline Skid Buffer](https://fpgacpu.ca/fpga/Pipeline_Skid_Buffer.html) | Pipeline registers and stalls | 6 |
| F-10 Clock domains | Cummings, "Clock Domain Crossing (CDC) Design & Verification Techniques Using SystemVerilog" (SNUG 2008, now in the [Paradigm Works technical library](https://www.paradigm-works.com/technical-library), registration required); [Project F: FPGA Graphics](https://projectf.io/posts/fpga-graphics/) | Crossings, video timing | 12 |
| F-11 Proofs | Baier & Katoen, *Principles of Model Checking*; [SymbiYosys](https://yosyshq.readthedocs.io/projects/sby/en/latest/) | Safety, bounded liveness, BMC, k-induction, counterexamples | 9 |
| F-12 Knobs | Harris & Harris, Ch. 9 (I/O); [OpenTitan reggen](https://opentitan.org/book/util/reggen/index.html); [SystemRDL 2.0](https://www.accellera.org/downloads/standards/systemrdl) | Hardware/software register interfaces, code generation | 14 |
| F-13 Pass pipeline | Cooper & Torczon, *Engineering a Compiler*; De Micheli, Chs. 3, 8 and 10; [Yosys RTLIL](https://yosyshq.readthedocs.io/projects/yosys/en/latest/yosys_internals/formats/rtlil_rep.html); [CIRCT dialects](https://circt.llvm.org/docs/Dialects/) | IR design and lowering | 10, 11 |
| F-14 Custom passes | De Micheli, Chs. 7–8; Hachtel & Somenzi on multilevel minimization; [egg: equality saturation](https://egraphs-good.github.io/); [CS 6120 blog: Technology Mapping with Egraphs](https://www.cs.cornell.edu/courses/cs6120/2025sp/blog/superopt/) | Rewriting, e-graphs, rule validation | 11 |
| F-15 Retiming | De Micheli, Chs. 5 and 9; Leiserson & Saxe, "Retiming Synchronous Circuitry"; [Smith, Ch. 16: Windowed-Sinc Filters](https://www.dspguide.com/ch16.htm) | Retiming, FIR design | 12 |
| F-16 Targets | De Micheli, Ch. 10 (Cell-Library Binding); [VTR CAD flow](https://docs.verilogtorouting.org/en/latest/vtr/cad_flow/); CIRCT and Yosys technology mapping | Mapping and back ends | 13 |
| F-17 Hot swap | [AMD UG909: Dynamic Function eXchange](https://docs.amd.com/r/en-US/ug909-vivado-partial-reconfiguration); Kahng et al. on placement and routing; refinement and state migration | Partial reconfiguration | 15 |
| F-18 Timing closer | Kahng et al., Ch. 8 (Timing Closure); [Lakeroad: FPGA Technology Mapping Using Sketch-Guided Program Synthesis](https://arxiv.org/abs/2401.16526); translation validation | Provenance and equivalence | 15 |
| F-19 Arcade | [Project F: FPGA Pong](https://projectf.io/posts/fpga-pong/); [Cornell ECE 5760](https://people.ece.cornell.edu/land/courses/ece5760/); MIT 6.175 | Interacting components in a whole system | 15 |

F-17 is where a textbook alone stops being enough. Partial reconfiguration depends on device-specific configuration interfaces, physical constraints, isolation at the region boundary and state transfer, and AMD's DFX guide covers those where a compiler book does not.

### C.3 Courses, exercises and tools

| Resource | What it offers | Use it at |
| --- | --- | --- |
| [MIT 6.004](https://ocw.mit.edu/courses/6-004-computation-structures-spring-2017/) (OCW, Spring 2017) | Annotated slides, videos and worksheets per unit | M1–M4 |
| [MIT 6.175](https://csg.csail.mit.edu/6.175/) | Bluespec, guarded interfaces, FIFOs, processor labs | M5 |
| [Cornell CS 6120](https://www.cs.cornell.edu/courses/cs6120/2025fa/) (Fall 2025) | IRs, SSA, data-flow analysis, e-graphs, a student blog | M2, M7 |
| [BYU ECEn 629 VTR exercise](https://byu-cpe.github.io/ecen629/exercises/vtr/) and [placer lab](https://byu-cpe.github.io/ecen629/labs/placer/) | Annealing placement and PathFinder routing in VPR, then a placer of your own | M9, once logic synthesis works |
| [Cornell ECE 5760](https://people.ece.cornell.edu/land/courses/ece5760/) | Complete FPGA systems; now titled Hardware Acceleration via FPGA, taught by Hunter Adams, with Bruce Land's earlier pages archived | M11 |
| [Yosys](https://yosyshq.readthedocs.io/projects/yosys/en/latest/using_yosys/synthesis/memory.html), [SymbiYosys](https://yosyshq.readthedocs.io/projects/sby/en/latest/), [nextpnr](https://github.com/YosysHQ/nextpnr) | Open synthesis, formal checking, and place and route | M6, M9 |
| [Project IceStorm](https://prjicestorm.readthedocs.io/), [Project Trellis](https://prjtrellis.readthedocs.io/) | Documented iCE40 and ECP5 bitstream formats | M9 |
| [Verilator](https://verilator.org/guide/latest/) | A compiled simulator to compare against Chapter 8's | M3 |
| [CIRCT](https://circt.llvm.org/) | Hardware IR dialects on MLIR | M7 |

### C.4 Three connections worth formalizing

**Staged computation becomes a compiler architecture (F-03, F-13).** Elaboration maps a hardware program P and build-time parameters θ to a circuit representation:

```latex
\operatorname{elaborate}(P, \theta) = G_\theta
```

Builder functions are partial evaluation of P with respect to θ. Hardware lambdas need something different: a semantics-preserving translation from syntax trees to IR. Study partial evaluation alongside CIRCT rather than as unrelated subjects. Chapters 2 and 3 and decisions D2 and D3 implement both halves.

**Optimization becomes an equivalence problem (F-14).** The rule that rewrites `x * k` to `x << clog2(k)` combines four subjects: term rewriting and e-graphs, typed finite-width bitvector semantics, SMT-based equivalence checking, and extraction costs that depend on the target. A proof for widths 1 to 16 does not establish the rule at every width; the theorem needs explicit width and signedness assumptions. D10 therefore proves each rule again at every concrete width where it fires. Chapter 11 implements this.

**Retiming is graph optimization constrained by semantics (F-15).** Represent the circuit as a directed graph whose edges carry register counts w(u, v). An integer retiming r changes them:

```latex
w_r(u, v) = w(u, v) + r(v) - r(u) \ge 0
```

That legality condition is the core of Leiserson and Saxe's method. The hard part in Weft is everything the simple model leaves out: pipeline stalls, synchronous resets, feedback state and observable stream latency each add constraints. Weft restricts retiming to `.pipelined()` paths and states the observational contract in D9. Chapter 12 implements this.

### C.5 Books

- David Money Harris and Sarah L. Harris, *Digital Design and Computer Architecture*, Morgan Kaufmann (RISC-V or ARM edition): Chs. 2–5 and 7–9.
- Martin Schoeberl, *Digital Design with Chisel*, free from the [author's page](https://www.imm.dtu.dk/~masca/chisel-book.html).
- Giovanni De Micheli, *Synthesis and Optimization of Digital Circuits*, McGraw-Hill, 1994.
- Gary D. Hachtel and Fabio Somenzi, *Logic Synthesis and Verification Algorithms*, Kluwer, 1996.
- Christel Baier and Joost-Pieter Katoen, *Principles of Model Checking*, MIT Press, 2008.
- Keith D. Cooper and Linda Torczon, *Engineering a Compiler*, Morgan Kaufmann.
- Andrew B. Kahng, Jens Lienig, Igor L. Markov and Jin Hu, *VLSI Physical Design: From Graph Partitioning to Timing Closure*, Springer.
- Neil D. Jones, Carsten K. Gomard and Peter Sestoft, *Partial Evaluation and Automatic Program Generation*, Prentice Hall, 1993.
- Steven W. Smith, *The Scientist and Engineer's Guide to Digital Signal Processing*, free at [dspguide.com](https://www.dspguide.com/ch16.htm).
- Clifford E. Cummings, "Simulation and Synthesis Techniques for Asynchronous FIFO Design" (SNUG 2002) and the CDC paper above, both in the [Paradigm Works technical library](https://www.paradigm-works.com/technical-library).
