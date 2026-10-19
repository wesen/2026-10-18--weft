package board

import (
	"flag"
	"os"
	"strings"
	"testing"

	"github.com/wesen/2026-10-18--weft/pkg/bundle"
)

var update = flag.Bool("update", false, "rewrite the golden files in testdata/")

func loadBundle(t *testing.T, name string) *bundle.Bundle {
	t.Helper()
	b, err := bundle.Load("testdata/" + name + ".bundle.json")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func golden(t *testing.T, name, got string) {
	t.Helper()
	path := "testdata/" + name
	if *update {
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run go test ./pkg/board -update)", err)
	}
	if string(want) != got {
		t.Errorf("%s differs from the golden file; run go test ./pkg/board -update and review the diff\n--- got:\n%s", name, got)
	}
}

func wrapGolden(t *testing.T, name string, bn *bundle.Bundle, opt WrapOptions) *Wrapped {
	t.Helper()
	w, err := GateMateA1EVB.Wrap(bn, opt)
	if err != nil {
		t.Fatal(err)
	}
	golden(t, name+".top.v", w.Files[0].Text)
	golden(t, name+".ccf", w.CCF)
	golden(t, name+".sdc", w.SDC)
	return w
}

func TestWrapBlinky(t *testing.T) {
	w := wrapGolden(t, "F-01-blinky", loadBundle(t, "F-01-blinky"), WrapOptions{})
	if strings.Join(w.Pins, ",") != "led:0" || len(w.Virtual) != 0 {
		t.Errorf("pins %v virtual %v", w.Pins, w.Virtual)
	}
}

func TestWrapCounterVirtualSwitchAndPMOD(t *testing.T) {
	w := wrapGolden(t, "F-02-counter", loadBundle(t, "F-02-counter"), WrapOptions{ButtonReset: "btn:user"})
	if strings.Join(w.Virtual, ",") != "sw:0" {
		t.Errorf("virtual = %v, want sw:0", w.Virtual)
	}
	top := w.Files[0].Text
	for _, want := range []string{
		"assign d_sw[0] = 1'b0;  // sw:0 is virtual: tied inactive",
		"assign pin_led_0 = ~d_led[0];", // the board LED is active-low
		"assign pin_led_7 = d_led[7];",  // PMOD pins are not
		"wire rst_req = ~usr_rstn | ~pin_btn_user;",
	} {
		if !strings.Contains(top, want) {
			t.Errorf("top lacks %q", want)
		}
	}
}

func TestWrapPLLDomain(t *testing.T) {
	bn := loadBundle(t, "F-01-blinky")
	bn.Clocks = append(bn.Clocks, bundle.Clock{Domain: "pix", Port: "clk_pix", Hz: 25208333.333333332, Kind: "pll", WantHz: 25175000, From: "sys"})
	w, err := GateMateA1EVB.Wrap(bn, WrapOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(w.PLLs) != 1 || w.PLLs[0].WantMHz != "25.175" {
		t.Fatalf("plls = %+v", w.PLLs)
	}
	top := w.Files[0].Text
	for _, want := range []string{
		`CC_PLL #(.REF_CLK("10.0"), .OUT_CLK("25.175"), .PERF_MD("SPEED")`,
		"CC_BUFG u_bufg_pix (.I(clk_pix_raw), .O(clk_pix));",
		"wire rst_req = ~usr_rstn | ~clk_pix_locked;",
		".clk_pix(clk_pix)",
	} {
		if !strings.Contains(top, want) {
			t.Errorf("top lacks %q\n%s", want, top)
		}
	}
	if strings.Contains(w.SDC, "pix") {
		t.Errorf("PLL outputs need no SDC line (nextpnr constrains them): %s", w.SDC)
	}
}

func TestWrapRefusals(t *testing.T) {
	cases := map[string]func(*bundle.Bundle){
		"same pin": func(b *bundle.Bundle) {
			b.Ports = append(b.Ports,
				bundle.Port{Name: "btn", Dir: "in", Width: 1, Indexed: true, Bits: []bundle.Bit{{Bit: 0, Resource: "btn:0"}}},
				bundle.Port{Name: "btn_user", Dir: "in", Width: 1, Bits: []bundle.Bit{{Bit: 0, Resource: "btn:user"}}})
		},
		"unknown resource": func(b *bundle.Bundle) { b.Ports[0].Bits[0].Resource = "hdmi" },
		"direction":        func(b *bundle.Bundle) { b.Ports[0].Dir = "in" },
		"other board":      func(b *bundle.Bundle) { b.Board = "pico" },
		"clock rate":       func(b *bundle.Bundle) { b.Clocks[0].Hz = 12e6 },
		"cascaded pll": func(b *bundle.Bundle) {
			b.Clocks = append(b.Clocks, bundle.Clock{Domain: "x", Port: "clk_x", Hz: 1e6, Kind: "pll", WantHz: 1e6, From: "y"})
		},
		"unknown core": func(b *bundle.Bundle) {
			b.Cells = append(b.Cells, bundle.Cell{Path: "dac", Kind: "sigma-delta", Module: "weft_core_sigma_delta"})
		},
	}
	for name, mutate := range cases {
		bn := loadBundle(t, "F-01-blinky")
		mutate(bn)
		if _, err := GateMateA1EVB.Wrap(bn, WrapOptions{}); err == nil {
			t.Errorf("%s: expected a refusal", name)
		}
	}
}

// HIL: the bridge carries every input (btn:0 through a mux, the virtual ones directly) and every output, on
// the UART pins; the design's reset also follows the bridge's R.
func TestWrapHIL(t *testing.T) {
	w := wrapGolden(t, "F-05-buttons-hil", loadBundle(t, "F-05-buttons"), WrapOptions{HIL: true})
	h := w.HIL
	if h == nil || h.Baud != 115200 || h.Hz != 10e6 || h.TX != "uart.tx" || h.RX != "uart.rx" {
		t.Fatalf("hil = %+v", h)
	}
	var ins, outs []string
	for _, p := range h.Inputs {
		s := p.Resource
		if p.Physical {
			s += "*"
		}
		ins = append(ins, s)
	}
	for _, p := range h.Outputs {
		outs = append(outs, p.Resource)
	}
	if strings.Join(ins, ",") != "sw:0,btn:0*,btn:1,btn:2,btn:3" || len(outs) != 8 || outs[7] != "led:7" {
		t.Errorf("inputs %v outputs %v", ins, outs)
	}
	var cores []string
	for _, f := range w.Cores {
		cores = append(cores, f.Path)
	}
	if strings.Join(cores, ",") != "weft_core_debounce.v,weft_core_uart_rx.v,weft_core_uart_tx.v,weft_hil.v" {
		t.Errorf("cores %v", cores)
	}
	top := w.Files[0].Text
	for _, want := range []string{
		"wire pin_btn_0_lvl = hil_ovr[1] ? hil_vins[1] : ~pin_btn_0;",
		"wire pin_sw_0_lvl = hil_vins[0];",
		"wire rst = rst_cfg | hil_rst;",
		".rst(rst_cfg),",
		"assign hil_outs[7] = d_led[7];  // led:7",
		"weft_hil #(.CLK_HZ(10000000), .BAUD(115200), .NOUT(8), .NIN(5)) u_hil (",
	} {
		if !strings.Contains(top, want) {
			t.Errorf("top lacks %q", want)
		}
	}
	if !strings.Contains(w.CCF, `"pin_uart_tx" Loc = "IO_SA_B6"`) || !strings.Contains(w.CCF, `"pin_uart_rx" Loc = "IO_SA_A6"`) {
		t.Errorf("ccf lacks the UART pins:\n%s", w.CCF)
	}

	// a design on the UART has no room for the bridge
	bn := loadBundle(t, "F-01-blinky")
	bn.Ports = append(bn.Ports, bundle.Port{Name: "tx", Dir: "out", Width: 1, Bits: []bundle.Bit{{Bit: 0, Resource: "uart.tx", Kind: "uart"}}})
	if _, err := GateMateA1EVB.Wrap(bn, WrapOptions{HIL: true}); err == nil || !strings.Contains(err.Error(), "uart.tx") {
		t.Errorf("HIL with the design on the UART: %v", err)
	}
}

// The cores a bundle's cells name come with the wrapper, once each.
func TestWrapCores(t *testing.T) {
	bn := loadBundle(t, "F-01-blinky")
	bn.Cells = []bundle.Cell{
		{Path: "rx", Kind: "uart-rx", Module: "weft_core_uart_rx"},
		{Path: "tx", Kind: "uart-tx", Module: "weft_core_uart_tx"},
		{Path: "tx2", Kind: "uart-tx", Module: "weft_core_uart_tx"},
	}
	w, err := GateMateA1EVB.Wrap(bn, WrapOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, f := range w.Cores {
		got = append(got, f.Path)
		if !strings.Contains(f.Text, "module "+strings.TrimSuffix(f.Path, ".v")+" ") {
			t.Errorf("%s does not declare its module", f.Path)
		}
	}
	if strings.Join(got, ",") != "weft_core_uart_rx.v,weft_core_uart_tx.v" {
		t.Errorf("cores %v", got)
	}
}

func TestPinPort(t *testing.T) {
	for in, want := range map[string]string{"led:0": "pin_led_0", "uart.tx": "pin_uart_tx", "btn:user": "pin_btn_user"} {
		if got := PinPort(in); got != want {
			t.Errorf("PinPort(%q) = %q, want %q", in, got, want)
		}
	}
}
