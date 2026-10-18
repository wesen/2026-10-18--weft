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
	}
	for name, mutate := range cases {
		bn := loadBundle(t, "F-01-blinky")
		mutate(bn)
		if _, err := GateMateA1EVB.Wrap(bn, WrapOptions{}); err == nil {
			t.Errorf("%s: expected a refusal", name)
		}
	}
}

func TestPinPort(t *testing.T) {
	for in, want := range map[string]string{"led:0": "pin_led_0", "uart.tx": "pin_uart_tx", "btn:user": "pin_btn_user"} {
		if got := PinPort(in); got != want {
			t.Errorf("PinPort(%q) = %q, want %q", in, got, want)
		}
	}
}
