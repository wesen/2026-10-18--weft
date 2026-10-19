package hdl_test

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wesen/2026-10-18--weft/hdl"
	"github.com/wesen/2026-10-18--weft/pkg/toolchain"
)

func TestModules(t *testing.T) {
	want := []string{"weft_core_debounce", "weft_core_uart_rx", "weft_core_uart_tx"}
	if got := hdl.Modules(); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("Modules() = %v, want %v", got, want)
	}
	for _, m := range want {
		src, ok := hdl.Core(m)
		if !ok || !strings.Contains(src, "module "+m+" ") {
			t.Errorf("Core(%s): ok %v, declares the module %v", m, ok, strings.Contains(src, "module "+m+" "))
		}
	}
	if _, ok := hdl.Core("weft_core_nope"); ok {
		t.Error("Core found a module that does not exist")
	}
}

// Each core's testbench (cells/tb) checks it against the Lab model's rules at transaction level.
func TestCoreTestbenches(t *testing.T) {
	if testing.Short() {
		t.Skip("runs iverilog")
	}
	suite, err := toolchain.Open("")
	if err != nil {
		t.Skipf("no OSS CAD Suite: %v", err)
	}
	for _, m := range hdl.Modules() {
		t.Run(m, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			dir := t.TempDir()
			vvp := filepath.Join(dir, "tb.vvp")
			src, _ := filepath.Abs(filepath.Join("cells", m+".v"))
			tb, _ := filepath.Abs(filepath.Join("cells", "tb", m+"_tb.v"))
			if out, err := suite.Command(ctx, dir, "iverilog", "-g2005", "-Wall", "-s", m+"_tb", "-o", vvp, tb, src).CombinedOutput(); err != nil {
				t.Fatalf("iverilog: %v\n%s", err, out)
			}
			out, err := suite.Command(ctx, dir, "vvp", "-n", vvp).CombinedOutput()
			if err != nil || !strings.Contains(string(out), "WEFT-TB PASS "+m) || strings.Contains(string(out), "WEFT-TB FAIL") {
				t.Fatalf("testbench: %v\n%s", err, out)
			}
			t.Log(strings.TrimSpace(strings.Split(string(out), "\n")[0]))
		})
	}
}
