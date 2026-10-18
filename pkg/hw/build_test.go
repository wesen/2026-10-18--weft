package hw

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/wesen/2026-10-18--weft/pkg/bundle"
	"github.com/wesen/2026-10-18--weft/pkg/toolchain"
)

// TestBuildBlinky runs the real flow (yosys, nextpnr-himbaechel, gmpack) on F-01; it needs the OSS CAD Suite.
func TestBuildBlinky(t *testing.T) {
	if testing.Short() {
		t.Skip("runs the toolchain")
	}
	suite, err := toolchain.Open(toolchain.DefaultSuiteRoot)
	if err != nil {
		t.Skipf("no OSS CAD Suite: %v", err)
	}
	bn, err := bundle.Load("../board/testdata/F-01-blinky.bundle.json")
	if err != nil {
		t.Fatal(err)
	}
	work := t.TempDir()
	stages := []string{}
	b, err := RunBuild(context.Background(), suite, bn, BuildOptions{WorkDir: work, Seed: 1}, toolchain.Events{
		Stage: func(name, state string, _ *toolchain.Stage) {
			if state != "running" {
				stages = append(stages, name+":"+state)
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	r := b.Report
	if !r.OK || !r.TimingOK || r.Bitstream == nil || r.Bitstream.Bytes == 0 {
		t.Fatalf("report: %+v", r)
	}
	if got := len(stages); got != 3 || stages[2] != "pack:done" {
		t.Errorf("stages = %v", stages)
	}
	if r.Cells["CC_USR_RSTN"] != 1 || r.Utilization["IOSEL"][0] != 2 {
		t.Errorf("cells %v utilization %v", r.Cells, r.Utilization)
	}
	for _, f := range []string{"report.json", "top.bit", "synth.log", "pnr.log", "board/weft_board_top.v", "rtl/blinky.v"} {
		if _, err := os.Stat(filepath.Join(b.Dir, f)); err != nil {
			t.Errorf("missing %s", f)
		}
	}
	again, err := OpenBuild(work, b.ID)
	if err != nil || again.Report.Bitstream.SHA256 != r.Bitstream.SHA256 {
		t.Fatalf("OpenBuild: %v %+v", err, again)
	}
	if err := again.Loadable(false); err != nil {
		t.Errorf("a passing build should be loadable: %v", err)
	}
	again.Report.TimingOK = false
	if err := again.Loadable(false); err != ErrNeedsForce {
		t.Errorf("timing failure without force: %v", err)
	}
	if err := again.Loadable(true); err != nil {
		t.Errorf("timing failure with force: %v", err)
	}
}
