// Package board turns a hardware bundle into the files a board needs: a top module that wraps the design
// (clock, PLLs, reset, pin polarity, input synchronizers), the pin constraints (CCF) and the clock
// constraints (SDC). Board data here is authoritative for pins and polarity; the JavaScript profile in
// weft-lab/app/src/core/boards.js only names the resources a design may bind.
package board

import (
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/pkg/errors"
	"github.com/wesen/2026-10-18--weft/hdl"
	"github.com/wesen/2026-10-18--weft/pkg/bundle"
)

// TopModule is the name of every generated board top.
const TopModule = "weft_board_top"

// Pin is a physical FPGA pin.
type Pin struct {
	Name      string // "IO_SB_B6"
	ActiveLow bool   // the board inverts it: the design always sees active-high levels
	Attrs     string // extra CCF attributes, e.g. "SCHMITT_TRIGGER=true"
}

// Resource is something a design may bind ("led:0"). A nil Pin makes it virtual: it compiles, and on the
// board it is tied inactive (inputs) or left unconnected (outputs), or driven by the HIL bridge.
type Resource struct {
	ID   string
	Dir  string // in | out
	Kind string // led, button, switch, uart
	Pin  *Pin
}

// Board describes one physical board.
type Board struct {
	Name       string // "gatemate-a1-evb", the JavaScript profile name
	Title      string
	Device     string // nextpnr --device
	Loader     string // openFPGALoader -b
	ClockPort  string // top-level port of the oscillator
	ClockPin   Pin
	ClockHz    float64
	Resources  map[string]Resource
	SerialHint string
}

// WrapOptions select optional parts of the generated top.
type WrapOptions struct {
	// ButtonReset also resets the design while this resource is pressed (e.g. "btn:user").
	ButtonReset string
}

// PLL is one CC_PLL the top instantiates for a derived clock domain.
type PLL struct {
	Domain  string
	WantMHz string  // OUT_CLK as written: the frequency the design asked for
	Hz      float64 // what the compiler says CC_PLL achieves (nextpnr logs "PLL fout=")
}

// Wrapped is the board-side output of Wrap.
type Wrapped struct {
	TopModule string
	Files     []bundle.File // the board top
	Cores     []bundle.File // the native cells' cores (hdl/cells) the design's adapters instantiate
	CCF, SDC  string
	PLLs      []PLL
	Virtual   []string // bound resources with no pin
	Pins      []string // bound resources with a pin
}

var boards = map[string]*Board{}

func register(b *Board) { boards[b.Name] = b }

// Lookup returns a known board.
func Lookup(name string) (*Board, error) {
	b := boards[name]
	if b == nil {
		names := make([]string, 0, len(boards))
		for n := range boards {
			names = append(names, n)
		}
		sort.Strings(names)
		return nil, errors.Errorf("unknown board %q (known: %s)", name, strings.Join(names, ", "))
	}
	return b, nil
}

// PinPort is the board-top port name of a resource: "led:0" → "pin_led_0".
func PinPort(resource string) string {
	var sb strings.Builder
	sb.WriteString("pin_")
	for _, r := range resource {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			sb.WriteRune(r)
		} else {
			sb.WriteByte('_')
		}
	}
	return sb.String()
}

type boundBit struct {
	port *bundle.Port
	bit  bundle.Bit
	res  Resource
}

// Wrap generates the board top, CCF and SDC for a bundle.
func (b *Board) Wrap(bn *bundle.Bundle, opt WrapOptions) (*Wrapped, error) {
	if bn.Board != b.Name {
		return nil, errors.Errorf("the bundle was compiled for %q, not %s", bn.Board, b.Name)
	}
	main := bn.MainClock()
	if main.Kind != "board" && main.Kind != "pin" {
		return nil, errors.Errorf("main clock domain %q is a %s clock; it must come from the board oscillator", main.Domain, main.Kind)
	}
	if main.Hz != b.ClockHz {
		return nil, errors.Errorf("main clock domain %q runs at %v Hz, but the %s oscillator is %v Hz", main.Domain, main.Hz, b.Name, b.ClockHz)
	}
	w := &Wrapped{TopModule: TopModule}
	clockNet := map[string]string{main.Domain: b.ClockPort}
	for _, c := range bn.Clocks {
		if c.Main {
			continue
		}
		if c.Kind != "pll" || c.From != main.Domain {
			return nil, errors.Errorf("clock domain %q: only PLLs fed by the main domain are supported (got %s from %q)", c.Domain, c.Kind, c.From)
		}
		if c.WantHz <= 0 {
			return nil, errors.Errorf("clock domain %q: the bundle lacks the requested PLL frequency", c.Domain)
		}
		w.PLLs = append(w.PLLs, PLL{Domain: c.Domain, WantMHz: strconv.FormatFloat(c.WantHz/1e6, 'f', -1, 64), Hz: c.Hz})
		clockNet[c.Domain] = c.Port // a wrapper wire named like the design port it feeds
	}

	for _, c := range bn.Cells {
		src, ok := hdl.Core(c.Module)
		if !ok {
			return nil, errors.Errorf("native cell %s (%s): this weft has no core %q (it has %s)", c.Path, c.Kind, c.Module, strings.Join(hdl.Modules(), ", "))
		}
		if !slices.ContainsFunc(w.Cores, func(f bundle.File) bool { return f.Path == c.Module+".v" }) {
			w.Cores = append(w.Cores, bundle.File{Path: c.Module + ".v", Text: src})
		}
	}

	// resolve every bound bit against the board, refusing drift between the JS profile and this data
	var bits []boundBit
	pinOwner := map[string]string{}
	for i := range bn.Ports {
		p := &bn.Ports[i]
		for _, bit := range p.Bits {
			res, ok := b.Resources[bit.Resource]
			if !ok {
				return nil, errors.Errorf("port %s bit %d: the %s board has no resource %q", p.Name, bit.Bit, b.Name, bit.Resource)
			}
			if res.Dir != p.Dir {
				return nil, errors.Errorf("port %s: %s is an %s resource, but the port is %s", p.Name, bit.Resource, res.Dir, p.Dir)
			}
			if res.Pin != nil {
				if other, taken := pinOwner[res.Pin.Name]; taken && other != bit.Resource {
					return nil, errors.Errorf("%s and %s are the same pin (%s): bind one of them", other, bit.Resource, res.Pin.Name)
				}
				pinOwner[res.Pin.Name] = bit.Resource
				w.Pins = append(w.Pins, bit.Resource)
			} else {
				w.Virtual = append(w.Virtual, bit.Resource)
			}
			bits = append(bits, boundBit{port: p, bit: bit, res: res})
		}
	}
	var buttonReset *Resource
	if opt.ButtonReset != "" {
		r, ok := b.Resources[opt.ButtonReset]
		if !ok || r.Pin == nil || r.Dir != "in" {
			return nil, errors.Errorf("--button-reset %q is not a physical input of %s", opt.ButtonReset, b.Name)
		}
		if _, used := pinOwner[r.Pin.Name]; used {
			return nil, errors.Errorf("--button-reset %s: the design already uses that pin", opt.ButtonReset)
		}
		buttonReset = &r
	}

	w.Files = []bundle.File{{Path: TopModule + ".v", Text: b.top(bn, w, bits, clockNet, buttonReset)}}
	w.CCF = b.ccf(bits, buttonReset)
	w.SDC = fmt.Sprintf("create_clock -name %s -period %.3f [get_ports %s]\n", b.ClockPort, 1e9/b.ClockHz, b.ClockPort)
	return w, nil
}

func (b *Board) top(bn *bundle.Bundle, w *Wrapped, bits []boundBit, clockNet map[string]string, buttonReset *Resource) string {
	var s strings.Builder
	line := func(format string, args ...any) { fmt.Fprintf(&s, format+"\n", args...) }

	ports := []string{fmt.Sprintf("  input  wire %s", b.ClockPort)}
	seen := map[string]bool{}
	for _, x := range bits {
		if x.res.Pin == nil || seen[x.bit.Resource] {
			continue
		}
		seen[x.bit.Resource] = true
		dir := "output"
		if x.res.Dir == "in" {
			dir = "input "
		}
		ports = append(ports, fmt.Sprintf("  %s wire %s", dir, PinPort(x.bit.Resource)))
	}
	if buttonReset != nil {
		ports = append(ports, fmt.Sprintf("  input  wire %s", PinPort(buttonReset.ID)))
	}
	line("// %s: %s board top for the Weft design %s (generated by weft; do not edit).", TopModule, b.Name, bn.Top)
	line("// Clock %s (%g MHz) feeds the main domain; active-low pins are inverted here, so the design sees", b.ClockPort, b.ClockHz/1e6)
	line("// active-high levels; physical inputs pass a two-flop synchronizer in their domain.")
	line("module %s (", TopModule)
	line("%s", strings.Join(ports, ",\n"))
	line(");")

	// clocks
	locked := []string{}
	for _, p := range w.PLLs {
		n := clockNet[p.Domain]
		line("  // %s: CC_PLL asked for %s MHz; the compiler expects %.4f MHz", p.Domain, p.WantMHz, p.Hz/1e6)
		line("  wire %s_raw, %s_locked, %s;", n, n, n)
		line("  CC_PLL #(.REF_CLK(\"%s\"), .OUT_CLK(\"%s\"), .PERF_MD(\"SPEED\"), .LOW_JITTER(1), .CI_FILTER_CONST(2), .CP_FILTER_CONST(4))",
			strconv.FormatFloat(b.ClockHz/1e6, 'f', 1, 64), p.WantMHz)
		line("    u_pll_%s (.CLK_REF(%s), .CLK_FEEDBACK(1'b0), .USR_CLK_REF(1'b0), .USR_LOCKED_STDY_RST(1'b0), .USR_PLL_LOCKED_STDY(),", p.Domain, b.ClockPort)
		line("      .USR_PLL_LOCKED(%s_locked), .CLK0(%s_raw), .CLK90(), .CLK180(), .CLK270(), .CLK_REF_OUT());", n, n)
		line("  CC_BUFG u_bufg_%s (.I(%s_raw), .O(%s));", p.Domain, n, n)
		locked = append(locked, n+"_locked")
	}

	// reset: configuration reset, PLL lock and the optional button, released synchronously to the main clock
	line("  wire usr_rstn;")
	line("  CC_USR_RSTN u_usr_rstn (.USR_RSTN(usr_rstn));")
	req := []string{"~usr_rstn"}
	for _, l := range locked {
		req = append(req, "~"+l)
	}
	if buttonReset != nil {
		v := PinPort(buttonReset.ID)
		if buttonReset.Pin.ActiveLow {
			v = "~" + v
		}
		req = append(req, v)
	}
	line("  wire rst_req = %s;", strings.Join(req, " | "))
	line("  reg [1:0] rst_sync = 2'b11;")
	line("  always @(posedge %s or posedge rst_req)", b.ClockPort)
	line("    if (rst_req) rst_sync <= 2'b11; else rst_sync <= {rst_sync[0], 1'b0};")
	line("  wire rst = rst_sync[1];")

	// design ports
	conns := []string{}
	for _, c := range bn.Clocks {
		conns = append(conns, fmt.Sprintf(".%s(%s)", c.Port, clockNet[c.Domain]))
	}
	conns = append(conns, fmt.Sprintf(".%s(rst)", bn.Reset.Port))
	byPort := map[string][]boundBit{}
	for _, x := range bits {
		byPort[x.port.Name] = append(byPort[x.port.Name], x)
	}
	for _, p := range bn.Ports {
		line("  wire [%d:0] d_%s;", p.Width-1, p.Name)
		conns = append(conns, fmt.Sprintf(".%s(d_%s)", p.Name, p.Name))
		driven := map[int]bool{}
		for _, x := range byPort[p.Name] {
			pin := PinPort(x.bit.Resource)
			if p.Dir == "out" {
				if x.res.Pin == nil {
					continue // virtual output: nothing on the board shows it
				}
				inv := ""
				if x.res.Pin.ActiveLow {
					inv = "~"
				}
				line("  assign %s = %sd_%s[%d];", pin, inv, p.Name, x.bit.Bit)
				continue
			}
			driven[x.bit.Bit] = true
			if x.res.Pin == nil {
				line("  assign d_%s[%d] = 1'b0;  // %s is virtual: tied inactive", p.Name, x.bit.Bit, x.bit.Resource)
				continue
			}
			clk := clockNet[x.bit.Domain]
			if clk == "" {
				clk = b.ClockPort
			}
			idle, inv := "2'b00", ""
			if x.res.Pin.ActiveLow {
				idle, inv = "2'b11", "~"
			}
			line("  reg [1:0] %s_sync = %s;", pin, idle)
			line("  always @(posedge %s) %s_sync <= {%s_sync[0], %s};", clk, pin, pin, pin)
			line("  assign d_%s[%d] = %s%s_sync[1];", p.Name, x.bit.Bit, inv, pin)
		}
		if p.Dir == "in" {
			for i := 0; i < p.Width; i++ {
				if !driven[i] {
					line("  assign d_%s[%d] = 1'b0;  // not bound", p.Name, i)
				}
			}
		}
	}
	line("  %s u_design (", bn.Top)
	line("    %s", strings.Join(conns, ",\n    "))
	line("  );")
	line("endmodule")
	return s.String()
}

func (b *Board) ccf(bits []boundBit, buttonReset *Resource) string {
	var s strings.Builder
	attrs := func(p Pin) string {
		if p.Attrs == "" {
			return ""
		}
		return " | " + p.Attrs
	}
	fmt.Fprintf(&s, "# %s pin constraints (generated by weft)\n", b.Name)
	fmt.Fprintf(&s, "Pin_in  %q Loc = %q%s;\n", b.ClockPort, b.ClockPin.Name, attrs(b.ClockPin))
	seen := map[string]bool{}
	emit := func(r Resource) {
		if r.Pin == nil || seen[r.ID] {
			return
		}
		seen[r.ID] = true
		kw := "Pin_out"
		if r.Dir == "in" {
			kw = "Pin_in "
		}
		fmt.Fprintf(&s, "%s %q Loc = %q%s;\n", kw, PinPort(r.ID), r.Pin.Name, attrs(*r.Pin))
	}
	for _, x := range bits {
		emit(x.res)
	}
	if buttonReset != nil {
		emit(*buttonReset)
	}
	return s.String()
}
