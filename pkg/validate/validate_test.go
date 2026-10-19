package validate

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wesen/2026-10-18--weft/pkg/toolchain"
)

func load(t *testing.T, name string) *Vectors {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name+".vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	v, err := Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestGenerate(t *testing.T) {
	v := load(t, "F-02-counter")
	tb, err := Generate(v, &v.Scenarios[0])
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"counter dut (",
		".clk_sys(clk),",
		".sw(p_sw)",
		"reg  [0:0] p_sw = 0;",
		"wire [7:0] p_led;",
		"$display(\"MISMATCH cycle=%0d port=led",
		"for (cycle = 1; cycle <= 650000;",
	} {
		if !strings.Contains(tb.Verilog, want) {
			t.Errorf("testbench lacks %q", want)
		}
	}
	// each change memory word is {cycle[63:0], value}: cycle 350001 (0x55731) toggles sw to 1
	if got := tb.Mems["sw.mem"]; got != "aae63\n" {
		t.Errorf("sw.mem = %q", got)
	}
	if !strings.HasPrefix(tb.Mems["led.mem"], "186a201\n") { // cycle 100002 (0x186a2), led = 0x01
		t.Errorf("led.mem starts %q", tb.Mems["led.mem"][:min(20, len(tb.Mems["led.mem"]))])
	}
}

func TestParseRejects(t *testing.T) {
	good, _ := os.ReadFile(filepath.Join("testdata", "F-01-blinky.vectors.json"))
	for name, text := range map[string]string{
		"schema":       strings.Replace(string(good), Schema, "weft.vectors/v0", 1),
		"port":         strings.Replace(string(good), `[250001,0,"1"]`, `[250001,3,"1"]`, 1),
		"out of order": strings.Replace(string(good), `[250001,0,"1"]`, `[900001,0,"1"]`, 1),
	} {
		if _, err := Parse([]byte(text)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestParseOutput(t *testing.T) {
	if ok, n, mm := parseOutput("VCD info\nWEFT-COSIM PASS 1100000\n"); !ok || n != 1100000 || mm != nil {
		t.Errorf("pass: %v %d %v", ok, n, mm)
	}
	ok, _, mm := parseOutput("MISMATCH cycle=250001 port=led got=0 want=1\n")
	if ok || mm == nil || mm.Cycle != 250001 || mm.Port != "led" || mm.Got != "0" || mm.Want != "1" {
		t.Errorf("mismatch: %v %+v", ok, mm)
	}
}

func suite(t *testing.T) *toolchain.Suite {
	t.Helper()
	if testing.Short() {
		t.Skip("runs iverilog and yosys")
	}
	s, err := toolchain.Open("")
	if err != nil {
		t.Skipf("no OSS CAD Suite: %v", err)
	}
	return s
}

// F-01 and F-02 pass L1 and L2 over their whole scenarios (P6's exit check); F-02's poking scenario is
// skipped with its reason. F-05 (debounce) and F-16 (uart-rx, uart-tx) pass cut at their cells (P7's check).
func TestCosimExamples(t *testing.T) {
	s := suite(t)
	for _, name := range []string{"F-01-blinky", "F-02-counter", "F-05-buttons", "F-16-targets"} {
		t.Run(name, func(t *testing.T) {
			v := load(t, name)
			res, err := Run(context.Background(), s, t.TempDir(), v, []string{LevelRTL, LevelNet}, nil)
			if err != nil {
				t.Fatal(err)
			}
			passed := 0
			for _, r := range res {
				t.Logf("%s %q: %s %s (%d ms)", r.Level, r.Scenario, r.Status, r.Message, r.Ms)
				switch r.Status {
				case "pass":
					passed++
				case "skip":
					if !strings.Contains(r.Message, "poke") {
						t.Errorf("unexpected skip: %+v", r)
					}
				default:
					t.Errorf("%s %q failed: %s", r.Level, r.Scenario, r.Message)
				}
			}
			if passed != 2 {
				t.Errorf("%d passing levels, want 2 (rtl and net of the first scenario)", passed)
			}
		})
	}
}

// A design with cells is cut there: the testbench drives the domain module, feeding what the cells drive and
// checking what they read (every bit of a checked port).
func TestGenerateCut(t *testing.T) {
	v := load(t, "F-16-targets")
	if v.DUT == nil || v.DUT.Module != "shout_sys" {
		t.Fatalf("dut = %+v, want shout_sys", v.DUT)
	}
	tb, err := Generate(v, &v.Scenarios[0])
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"shout_sys dut (",
		".clk(clk),",
		"reg  [7:0] p_rx_bytes_data = 0;", // a value the rx cell drives into the graph
		"wire [7:0] p_x_7;",               // tx.bytes.data, read by the tx cell
		"(p_x_7 & 8'hff) !== (want_x_7 & 8'hff)",
	} {
		if !strings.Contains(tb.Verilog, want) {
			t.Errorf("testbench lacks %q", want)
		}
	}
	if strings.Contains(tb.Verilog, "uart_tx") {
		t.Error("the cut testbench reaches a cell-owned pin")
	}
	if got := v.ChangesText(&v.Scenarios[0]); !strings.Contains(got, "device under test shout_sys") || !strings.Contains(got, " rx_bytes_data 68\n") {
		t.Errorf("change list:\n%.400s", got)
	}
}

// A netlist with an output stuck at 0 fails at the first cycle the simulator drives a 1, naming the port.
func TestBrokenNetlistFails(t *testing.T) {
	s := suite(t)
	v := load(t, "F-01-blinky")
	dir := t.TempDir()
	if _, err := Run(context.Background(), s, dir, v, []string{LevelNet}, nil); err != nil {
		t.Fatal(err)
	}
	netlist := filepath.Join(dir, "net", "netlist.v")
	text, err := os.ReadFile(netlist)
	if err != nil {
		t.Fatal(err)
	}
	broken, n := breakOutput(string(text), "led")
	if n == 0 {
		t.Fatalf("no assignment to led in the netlist:\n%s", text)
	}
	if err := os.WriteFile(netlist, []byte(broken), 0o644); err != nil {
		t.Fatal(err)
	}
	sdir := filepath.Join(dir, slug(v.Scenarios[0].Name))
	r := simulate(context.Background(), s, sdir, filepath.Base(sdir), LevelNet, filepath.Join(sdir, "tb.v"),
		[]string{netlist, filepath.Join(s.Root, "share", "yosys", "gatemate", "cells_sim.v")}, &v.Scenarios[0])
	if r.Status != "fail" || r.Mismatch == nil || r.Mismatch.Port != "led" || r.Mismatch.Cycle != 250001 {
		t.Fatalf("broken netlist: %+v", r)
	}
	t.Logf("broken netlist: %s", r.Message)
}

// breakOutput ties the netlist's output port to 0: whatever drives it (an assign, or a cell's output pin) is
// redirected to a dangling wire.
func breakOutput(netlist, port string) (string, int) {
	n := 0
	var out []string
	for _, line := range strings.Split(netlist, "\n") {
		trim := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(trim, "assign "+port+" ") || strings.HasPrefix(trim, "assign "+port+"["):
			n++
			continue
		case strings.Contains(trim, "("+port+")") && strings.HasPrefix(trim, "."):
			line = strings.Replace(line, "("+port+")", "(weft_broken)", 1)
			n++
		case trim == "endmodule" && n > 0:
			out = append(out, "  assign "+port+" = 1'b0; // weft_broken is an implicit, undriven net")
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n"), n
}
