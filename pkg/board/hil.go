package board

import (
	"fmt"
	"strings"

	"github.com/pkg/errors"
	"github.com/wesen/2026-10-18--weft/hdl"
	"github.com/wesen/2026-10-18--weft/pkg/bundle"
)

// HILBaud is the bridge's line rate: the RP2040's CDC bridge on the A1-EVB runs the FPGA UART at 115200.
const HILBaud = 115200

// HILPin is one bit the bridge carries. Index i is bit i of the bridge's vins and ovr (inputs) or of outs
// (outputs), and digit i/4 from the right in the protocol's hex fields.
type HILPin struct {
	Resource string `json:"resource"`
	Index    int    `json:"index"`
	Physical bool   `json:"physical,omitempty"` // an input with a pin: the mux passes the pin while ovr[i] is 0
}

// HILMap is the host's view of the bridge in one build (protocol in hdl/hil/weft_hil.v). It goes into the
// build report, so a board session can name the bits it reads and writes.
type HILMap struct {
	Baud    int      `json:"baud"`
	Hz      float64  `json:"hz"` // the clock of the cycle count: the main domain, the board oscillator
	TX      string   `json:"tx"` // the board resources the bridge occupies
	RX      string   `json:"rx"`
	Inputs  []HILPin `json:"inputs"`
	Outputs []HILPin `json:"outputs"`
}

func (h *HILMap) nin() int  { return max(len(h.Inputs), 1) }
func (h *HILMap) nout() int { return max(len(h.Outputs), 1) }

// planHIL lists the bits the bridge carries (resources in bundle order, each once), adds its Verilog and the
// UART cores it uses, and returns the UART resources for the CCF. A design that uses the UART itself cannot
// have the bridge.
func (b *Board) planHIL(w *Wrapped, bits []boundBit, pinOwner map[string]string) ([]Resource, error) {
	tx, okT := b.Resources["uart.tx"]
	rx, okR := b.Resources["uart.rx"]
	if !okT || !okR || tx.Pin == nil || rx.Pin == nil {
		return nil, errors.Errorf("HIL: the %s board has no UART for the bridge", b.Name)
	}
	for _, r := range []Resource{tx, rx} {
		if other, used := pinOwner[r.Pin.Name]; used {
			return nil, errors.Errorf("HIL: the design uses %s, and the bridge needs the board's UART; validate it on the board through its own UART instead", other)
		}
	}
	h := &HILMap{Baud: HILBaud, Hz: b.ClockHz, TX: tx.ID, RX: rx.ID}
	seen := map[string]bool{}
	for _, x := range bits {
		if seen[x.bit.Resource] {
			continue
		}
		seen[x.bit.Resource] = true
		if x.res.Dir == "in" {
			h.Inputs = append(h.Inputs, HILPin{Resource: x.bit.Resource, Index: len(h.Inputs), Physical: x.res.Pin != nil})
		} else {
			h.Outputs = append(h.Outputs, HILPin{Resource: x.bit.Resource, Index: len(h.Outputs)})
		}
	}
	for _, m := range []string{"weft_core_uart_rx", "weft_core_uart_tx"} {
		if hasFile(w.Cores, m+".v") {
			continue
		}
		src, ok := hdl.Core(m)
		if !ok {
			return nil, errors.Errorf("HIL: this weft has no core %s", m)
		}
		w.Cores = append(w.Cores, bundle.File{Path: m + ".v", Text: src})
	}
	w.Cores = append(w.Cores, bundle.File{Path: hdl.HILModule + ".v", Text: hdl.HIL()})
	w.HIL = h
	return []Resource{tx, rx}, nil
}

func hasFile(files []bundle.File, path string) bool {
	for _, f := range files {
		if f.Path == path {
			return true
		}
	}
	return false
}

// hilLevels declares one active-high level per HIL input: the bridge's value for a virtual input; for a
// physical one, the pin unless the host overrides it.
func (b *Board) hilLevels(line func(string, ...any), h *HILMap) {
	for _, in := range h.Inputs {
		pin := PinPort(in.Resource)
		if !in.Physical {
			line("  wire %s_lvl = hil_vins[%d];  // %s is virtual: the bridge drives it", pin, in.Index, in.Resource)
			continue
		}
		inv := ""
		if r := b.Resources[in.Resource]; r.Pin != nil && r.Pin.ActiveLow {
			inv = "~"
		}
		line("  wire %s_lvl = hil_ovr[%d] ? hil_vins[%d] : %s%s;", pin, in.Index, in.Index, inv, pin)
	}
}

// hilInput feeds one design input bit from its level through a two-flop synchronizer in the bit's domain.
func (b *Board) hilInput(line func(string, ...any), h *HILMap, p bundle.Port, x boundBit, clockNet map[string]string) {
	clk := clockNet[x.bit.Domain]
	if clk == "" {
		clk = b.ClockPort
	}
	s := fmt.Sprintf("hs_%s_%d", p.Name, x.bit.Bit)
	line("  reg [1:0] %s = 2'b00;", s)
	line("  always @(posedge %s) %s <= {%s[0], %s_lvl};", clk, s, s, PinPort(x.bit.Resource))
	line("  assign d_%s[%d] = %s[1];", p.Name, x.bit.Bit, s)
}

// hilBridge taps every bound output (outputs of other domains pass a synchronizer into the main domain) and
// instantiates the bridge on the main clock. Its reset is the configuration reset, never its own R.
func (b *Board) hilBridge(line func(string, ...any), h *HILMap, bits []boundBit, clockNet map[string]string) {
	line("  // HIL bridge (hdl/hil/weft_hil.v): reports these outputs and drives the inputs above")
	line("  wire [%d:0] hil_outs;", h.nout()-1)
	if len(h.Outputs) == 0 {
		line("  assign hil_outs = 1'b0;  // no outputs")
	}
	for _, o := range h.Outputs {
		var x *boundBit
		for i := range bits {
			if bits[i].bit.Resource == o.Resource && bits[i].res.Dir == "out" {
				x = &bits[i]
				break
			}
		}
		src := fmt.Sprintf("d_%s[%d]", x.port.Name, x.bit.Bit)
		if clk := clockNet[x.bit.Domain]; clk != "" && clk != b.ClockPort {
			s := fmt.Sprintf("ho_%d", o.Index)
			line("  reg [1:0] %s = 2'b00;  // %s, from domain %s", s, o.Resource, x.bit.Domain)
			line("  always @(posedge %s) %s <= {%s[0], %s};", b.ClockPort, s, s, src)
			src = s + "[1]"
		}
		line("  assign hil_outs[%d] = %s;  // %s", o.Index, src, o.Resource)
	}
	line("  weft_hil #(.CLK_HZ(%d), .BAUD(%d), .NOUT(%d), .NIN(%d)) u_hil (", int64(b.ClockHz), h.Baud, h.nout(), h.nin())
	line("    %s", strings.Join([]string{
		fmt.Sprintf(".clk(%s)", b.ClockPort), ".rst(rst_cfg)", ".outs(hil_outs)", ".vins(hil_vins)", ".ovr(hil_ovr)",
		".dut_rst(hil_rst)", fmt.Sprintf(".tx(%s)", PinPort(h.TX)), fmt.Sprintf(".rx(%s)", PinPort(h.RX)),
	}, ",\n    "))
	line("  );")
}
