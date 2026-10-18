// std: the standard components (owner A for the builders and interfaces, C for behaviour in cells.js).
// A std component is a native cell (ARCH §4): its behaviour is JavaScript in the simulator, its interface
// is declared here so linking, the graph, the report and the Verilog black box all work.
import * as T from "./types.js";
import { Builder, WeftError, agent, callSite, STD_PASSES, STD_ANALYSES, STD_PIPELINE } from "./dsl.js";

export class Cell extends Builder {
  as(name) { return this._w({ inst: String(name) }); }
  domain(d) { return this._w({ domain: String(d) }); }
  bind(map) { return this._w({ binds: { ...this._.binds, ...map } }); }
  provides(...names) { return this._w({ provides: [...this._.provides, ...names.flat()] }); }
  needs(...names) { return this._w({ needs: [...this._.needs, ...names.flat()] }); }
  with(params) { return this._w({ params: { ...this._.params, ...params } }); }
  settle(d) { return this._w({ params: { ...this._.params, settleMs: T.durMs(d) } }); }
  longPress(d) { return this._w({ params: { ...this._.params, longMs: T.durMs(d) } }); }
  baud(b) { return this._w({ params: { ...this._.params, baud: b } }); }
  mode(m) { return this._w({ params: { ...this._.params, mode: String(m) } }); }
}
const cell = (kind, defaults = {}) => (name) => {
  if (typeof name !== "string" || !name) throw new WeftError(`std component ${kind} needs a name`);
  return new Cell({ kind: "cell", cell: kind, name, inst: null, domain: null, binds: {}, provides: [], needs: [], params: { ...defaults }, line: callSite()?.line ?? null });
};

// video modes: total and visible geometry, pixel clock
export const VIDEO_MODES = {
  "640x480@60": { w: 640, h: 480, hTotal: 800, vTotal: 525, hz: 25.175e6, hFront: 16, hSync: 96, vFront: 10, vSync: 2 },
  "320x240@60": { w: 320, h: 240, hTotal: 400, vTotal: 262, hz: 6.29e6, hFront: 8, hSync: 48, vFront: 5, vSync: 1 },
};

// The interface of each cell kind: streams it provides / needs (with types), ports it drives, pins it uses.
// `n` is the number of raw pins bound (debounce). Returns { provides: [{stream, type}], needs: [{stream, type|null}],
// ports: [{name, dir, type}], pins: { port: { dir, resources } } }.
export function cellInterface(st, { pinCount = {} } = {}) {
  const P = st.params || {}, prov = st.provides, need = st.needs;
  switch (st.cell) {
    case "debounce": {
      const n = Math.max(1, pinCount.raw || 1);
      const press = T.struct({ id: T.u(Math.max(1, T.clog2(n))), long: T.bit });
      return {
        provides: prov.map((s) => ({ stream: s, type: press })), needs: [],
        ports: [{ name: "held", dir: "out", type: T.u(n) }],
        pins: { raw: { dir: "in" } },
        params: { settleMs: P.settleMs ?? 10, longMs: P.longMs ?? null, n },
      };
    }
    case "uart-rx":
      return { provides: prov.map((s) => ({ stream: s, type: T.u(8) })), needs: [], ports: [], pins: { rx: { dir: "in" } }, params: { baud: P.baud ?? 115200 } };
    case "uart-tx":
      return { provides: [], needs: need.map((s) => ({ stream: s, type: T.u(8) })), ports: [], pins: { tx: { dir: "out" } }, params: { baud: P.baud ?? 115200 } };
    case "sigma-delta":
      return { provides: [], needs: need.map((s) => ({ stream: s, type: null, signed: true })), ports: [], pins: { out: { dir: "out" } }, params: { rate: P.rate ?? 48000 } };
    case "video-timing": {
      const beam = T.struct({ x: T.u(10), y: T.u(10), visible: T.bit });
      const list = prov.length ? prov : ["beam"];
      return {
        provides: list.map((s) => ({ stream: s, type: /frame/.test(s) ? T.bit : beam, role: /frame/.test(s) ? "frame" : "beam" })),
        needs: [], ports: [], pins: {}, params: { mode: P.mode || "640x480@60", ...VIDEO_MODES[P.mode || "640x480@60"] },
      };
    }
    case "hdmi": {
      const px = T.struct({ r: T.u(8), g: T.u(8), b: T.u(8) });
      const list = need.length ? need : ["pixels"];
      return { provides: [], needs: list.map((s) => ({ stream: s, type: px })), ports: [], pins: { tmds: { dir: "out" } }, params: { serialHz: null } };
    }
    case "bridge-uart":
      return { provides: [], needs: [], ports: [], pins: { uart: { dir: "inout" } }, params: { baud: P.baud ?? 115200 } };
    default:
      throw new WeftError(`unknown std component kind ${st.cell}`);
  }
}

// the mechanic: an agent on call for supervision escalations (F-19)
const MECHANIC_GUIDELINES = `You are on call for a running FPGA design. A supervision group escalated to you after too many resets.
Read the dossier: the reset history, the probe capture taken before each reset, the source of the modules involved and
the DAG nodes near the failure. Propose the smallest change that removes the cause. Never change pins, clocks, the boot
order or stream types. Prefer knobs, then a patch of one module.`;
function mechanic() {
  return agent("mechanic")
    .model("claude")
    .guidelines(MECHANIC_GUIDELINES)
    .budget({ proposals: 2, per: "escalation" })
    .on("escalation", async (ctx, d) => {
      const proposal = await ctx.llm.propose({ goal: `Stop ${d.group} from resetting: ${d.reason || "repeated resets"}`, evidence: d });
      return ctx.changes.submit(proposal, { verify: (v) => v.lint().replay("last 1s"), approve: "you" });
    });
}

export function makeStd() {
  return {
    debounce: cell("debounce", { settleMs: 10, longMs: null }),
    uart: { rx: cell("uart-rx", { baud: 115200 }), tx: cell("uart-tx", { baud: 115200 }) },
    sigmaDelta: cell("sigma-delta"),
    video: { timing: cell("video-timing", { mode: "640x480@60" }), hdmi: cell("hdmi") },
    bridge: { uart: cell("bridge-uart", { baud: 115200 }) },
    agents: { mechanic: mechanic() },
    passes: STD_PASSES,
    analyses: STD_ANALYSES,
    pipeline: { default: STD_PIPELINE },
  };
}
