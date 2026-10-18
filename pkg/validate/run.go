package validate

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/pkg/errors"
	"github.com/wesen/2026-10-18--weft/pkg/toolchain"
)

// Levels of the ladder this package runs.
const (
	LevelRTL = "rtl" // L1: the emitted RTL
	LevelNet = "net" // L2: a GateMate netlist of that RTL
)

// Result is one level of one scenario.
type Result struct {
	Level    string    `json:"level"`
	Scenario string    `json:"scenario,omitempty"`
	Status   string    `json:"status"` // pass | fail | skip
	Cycles   int64     `json:"cycles,omitempty"`
	Ms       int64     `json:"ms"`
	Message  string    `json:"message,omitempty"`
	Mismatch *Mismatch `json:"mismatch,omitempty"`
	Dir      string    `json:"dir,omitempty"` // relative to the validation directory
}

// Events receives results as they finish; it may be nil.
type Events func(Result)

// Run co-simulates every scenario at the requested levels in dir: rtl/ holds the RTL, net/ the netlist, and
// each scenario gets its own directory with the change list, the testbench and the logs.
func Run(ctx context.Context, suite *toolchain.Suite, dir string, v *Vectors, levels []string, ev Events) ([]Result, error) {
	var out []Result
	emit := func(r Result) {
		out = append(out, r)
		if ev != nil {
			ev(r)
		}
	}
	want := map[string]bool{}
	for _, l := range levels {
		if l != LevelRTL && l != LevelNet {
			return nil, errors.Errorf("unknown co-simulation level %q (rtl, net)", l)
		}
		want[l] = true
	}
	ordered := []string{}
	for _, l := range []string{LevelRTL, LevelNet} {
		if want[l] {
			ordered = append(ordered, l)
		}
	}
	if v.Skip != "" {
		for _, l := range ordered {
			emit(Result{Level: l, Status: "skip", Message: v.Skip})
		}
		return out, nil
	}
	rtl, err := writeRTL(dir, v)
	if err != nil {
		return nil, err
	}
	var netErr error
	var netlist string
	if want[LevelNet] {
		netlist, netErr = synthNetlist(ctx, suite, dir, v)
	}
	cellsSim := filepath.Join(suite.Root, "share", "yosys", "gatemate", "cells_sim.v")
	for i := range v.Scenarios {
		s := &v.Scenarios[i]
		if s.Skip != "" {
			for _, l := range ordered {
				emit(Result{Level: l, Scenario: s.Name, Status: "skip", Message: s.Skip})
			}
			continue
		}
		sdir := filepath.Join(dir, slug(s.Name))
		tb, err := writeTestbench(sdir, v, s)
		if err != nil {
			for _, l := range ordered {
				emit(Result{Level: l, Scenario: s.Name, Status: "fail", Message: err.Error()})
			}
			continue
		}
		for _, l := range ordered {
			if ctx.Err() != nil {
				return out, ctx.Err()
			}
			var sources []string
			switch l {
			case LevelRTL:
				sources = rtl
			case LevelNet:
				if netErr != nil {
					emit(Result{Level: l, Scenario: s.Name, Status: "fail", Message: netErr.Error(), Dir: "net"})
					continue
				}
				sources = []string{netlist, cellsSim}
			}
			emit(simulate(ctx, suite, sdir, filepath.Base(sdir), l, tb, sources, s))
		}
	}
	return out, nil
}

func writeRTL(dir string, v *Vectors) ([]string, error) {
	rdir := filepath.Join(dir, "rtl")
	if err := os.MkdirAll(rdir, 0o755); err != nil {
		return nil, err
	}
	var files []string
	for _, f := range v.Bundle.Files {
		p := filepath.Join(rdir, f.Path)
		if err := os.WriteFile(p, []byte(f.Text), 0o644); err != nil {
			return nil, err
		}
		files = append(files, p)
	}
	return files, nil
}

// synthNetlist synthesizes the design top alone (no board top: CC_USR_RSTN and CC_PLL have no simulation
// model) and keeps I/O and clock buffers out so the netlist has the RTL's ports.
func synthNetlist(ctx context.Context, suite *toolchain.Suite, dir string, v *Vectors) (string, error) {
	ndir := filepath.Join(dir, "net")
	if err := os.MkdirAll(ndir, 0o755); err != nil {
		return "", err
	}
	var script strings.Builder
	for _, f := range v.Bundle.Files {
		fmt.Fprintf(&script, "read_verilog -defer ../rtl/%s\n", f.Path)
	}
	fmt.Fprintf(&script, "synth_gatemate -top %s -noiopad -noclkbuf -luttree -nomx8\nstat\nwrite_verilog -noattr netlist.v\n", v.Bundle.Top)
	if err := os.WriteFile(filepath.Join(ndir, "synth.ys"), []byte(script.String()), 0o644); err != nil {
		return "", err
	}
	out, err := run(ctx, suite, ndir, "synth.log", 5*time.Minute, "yosys", "-q", "-l", "synth.log", "-s", "synth.ys")
	if err != nil {
		return "", errors.Errorf("netlist synthesis failed: %s", lastLines(out, 3))
	}
	return filepath.Join(ndir, "netlist.v"), nil
}

func writeTestbench(sdir string, v *Vectors, s *ScenarioVectors) (string, error) {
	if err := os.MkdirAll(sdir, 0o755); err != nil {
		return "", err
	}
	tb, err := Generate(v.Bundle, s)
	if err != nil {
		return "", err
	}
	files := map[string]string{"tb.v": tb.Verilog, "changes.txt": v.ChangesText(s)}
	for name, text := range tb.Mems {
		files[name] = text
	}
	for name, text := range files {
		if err := os.WriteFile(filepath.Join(sdir, name), []byte(text), 0o644); err != nil {
			return "", err
		}
	}
	return filepath.Join(sdir, "tb.v"), nil
}

func simulate(ctx context.Context, suite *toolchain.Suite, sdir, rel, level, tb string, sources []string, s *ScenarioVectors) Result {
	t0 := time.Now()
	r := Result{Level: level, Scenario: s.Name, Dir: rel}
	vvp := level + ".vvp"
	args := append([]string{"-g2005", "-s", "weft_tb", "-o", vvp, tb}, sources...)
	if out, err := run(ctx, suite, sdir, level+"-compile.log", 2*time.Minute, "iverilog", args...); err != nil {
		r.Status, r.Message, r.Ms = "fail", "iverilog: "+lastLines(out, 3), time.Since(t0).Milliseconds()
		return r
	}
	out, err := run(ctx, suite, sdir, level+".log", 30*time.Minute, "vvp", "-n", vvp)
	r.Ms = time.Since(t0).Milliseconds()
	passed, cycles, mm := parseOutput(out)
	switch {
	case mm != nil:
		r.Status, r.Mismatch = "fail", mm
		r.Message = fmt.Sprintf("cycle %d: %s is %s, the simulator drove %s", mm.Cycle, mm.Port, mm.Got, mm.Want)
	case passed:
		r.Status, r.Cycles = "pass", cycles
		r.Message = fmt.Sprintf("%d cycles match", cycles)
	case err != nil:
		r.Status, r.Message = "fail", "vvp: "+lastLines(out, 3)
	default:
		r.Status, r.Message = "fail", "the testbench ended without a verdict: "+lastLines(out, 3)
	}
	return r
}

// run executes a suite tool in dir, keeping its combined output in logName.
func run(ctx context.Context, suite *toolchain.Suite, dir, logName string, timeout time.Duration, tool string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := suite.Command(ctx, dir, tool, args...)
	out, err := cmd.CombinedOutput()
	if logName != "" && tool != "yosys" {
		_ = os.WriteFile(filepath.Join(dir, logName), out, 0o644)
	}
	return string(out), err
}

var unsafe = regexp.MustCompile(`[^a-z0-9]+`)

func slug(name string) string {
	s := strings.Trim(unsafe.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if s == "" {
		s = "scenario"
	}
	return "sc-" + s
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " | ")
}
