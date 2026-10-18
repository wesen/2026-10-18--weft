# Recovered embedded diagrams

The Claude Docs Markdown exports in `../` replaced each embedded widget diagram with a placeholder line (`&#91;embedded content: <caption>\]`). These files hold the widget source recovered read-only from the docs on 2026-10-18 via the Claude Docs connector (`read` of each widget node).

Each `.jsx` file is exactly the widget node's `value.code` string: a default-exported component that returns an SVG (`book1-03` wraps it in `<claude.Visualize sources={...}>`, with its chart rows inline in the code). No node held separate `data`/`sources` fields, so there are no companion `.json` files. Colors use the docs renderer's `var(--cds-...)` CSS tokens and `claude.Visualize` is a host-provided component, so the files do not render standalone without stubs for those.

## Source docs

| Doc | Title | Doc (project) id | Tab body node id | Exported markdown |
| --- | --- | --- | --- | --- |
| A | Book 1 — Weft, From First Principles | `e0dfff0e-faaa-46d1-b633-a9e924396aba` | `93b3adf5-2b32` | `../Book 1: Weft, From First Principles (Claude Docs export).md` |
| B | Book 2 — Building Weft: Implementation and Reference | `9491a9dc-ac0e-48e7-80a1-25ce0ebf067d` | `be60bacc-3585` | `../Book 2: Building Weft: Implementation and Reference (Claude Docs export).md` |

## Widgets

Line = line number of the `embedded content` placeholder in the exported markdown (1-based).

| File | Doc | Caption | Widget node id | Placeholder line |
| --- | --- | --- | --- | --- |
| [`book1-01-lambdas-and-ir-levels.jsx`](book1-01-lambdas-and-ir-levels.jsx) | A | Weft's three kinds of lambda and the compiler's IR levels | `8758ed6a-2380` | 33 |
| [`book1-02-uart-tx-state-graph.jsx`](book1-02-uart-tx-state-graph.jsx) | A | uart-tx state graph · 4 states, 4 guarded transitions, a self-loop on every other path | `99f9d8de-6a4d` | 787 |
| [`book1-03-mtbf-vs-clock.jsx`](book1-03-mtbf-vs-clock.jsx) | A | computed from the MTBF formula above · illustrative parameters · 200–600 MHz | `f0cd7584-466d` | 1317 |
| [`book1-04-async-fifo.jsx`](book1-04-async-fifo.jsx) | A | asynchronous FIFO · the structure described by Cummings (SNUG 2002) | `89678811-32e4` | 1342 |
| [`book1-05-f13-default-pipeline.jsx`](book1-05-f13-default-pipeline.jsx) | A | the default pipeline of F-13 · 6 stages, 4 IR levels | `4471c951-9ca9` | 1723 |
| [`book1-06-change-pipeline.jsx`](book1-06-change-pipeline.jsx) | A | the change pipeline · 6 stages, 2 failure exits | `4d92cd95-2109` | 2461 |
| [`book1-07-f19-parts.jsx`](book1-07-f19-parts.jsx) | A | F-19's parts · 2 clock domains, 2 crossings, 2 reset groups | `638158ef-95d5` | 2733 |
| [`book2-01-toolchain-components.jsx`](book2-01-toolchain-components.jsx) | B | The toolchain's fifteen components in five layers, with the chapter that builds each | `19db3dfb-340c` | 17 |
