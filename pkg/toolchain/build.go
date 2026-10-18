package toolchain

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pkg/errors"
	"github.com/wesen/2026-10-18--weft/pkg/board"
	"github.com/wesen/2026-10-18--weft/pkg/bundle"
)

// Stage is one step of a build or load, as reported.
type Stage struct {
	Name    string `json:"name"`
	OK      bool   `json:"ok"`
	Ms      int64  `json:"ms"`
	Exit    int    `json:"exit"`
	Summary string `json:"summary,omitempty"`
}

// Bitstream is the packed result of a build.
type Bitstream struct {
	Path   string `json:"path"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

// PLLCheck compares what the compiler modelled for a PLL domain with what nextpnr configured.
type PLLCheck struct {
	Domain   string  `json:"domain"`
	WantMHz  float64 `json:"wantMHz"`
	ModelMHz float64 `json:"modelMHz"`
	FoutMHz  float64 `json:"foutMHz"`
	OK       bool    `json:"ok"`
}

// Report is report.json: everything a build established.
type Report struct {
	OK          bool              `json:"ok"`       // a bitstream exists
	TimingOK    bool              `json:"timingOk"` // every clock met its target
	Design      string            `json:"design"`
	Board       string            `json:"board"`
	Seed        int               `json:"seed"`
	Stages      []Stage           `json:"stages"`
	Cells       map[string]int    `json:"cells,omitempty"`
	Utilization map[string][2]int `json:"utilization,omitempty"`
	Clocks      []ClockTiming     `json:"clocks,omitempty"`
	PLLs        []PLLCheck        `json:"plls,omitempty"`
	Virtual     []string          `json:"virtual,omitempty"`
	Bitstream   *Bitstream        `json:"bitstream,omitempty"`
	Error       string            `json:"error,omitempty"`
}

// Events receives progress; both callbacks may be nil and must not block.
type Events struct {
	Stage func(name, state string, s *Stage) // state: running | done | failed
	Log   func(stage, line string)
}

func (e Events) stage(name, state string, s *Stage) {
	if e.Stage != nil {
		e.Stage(name, state, s)
	}
}

// BuildRequest is one build in its own directory.
type BuildRequest struct {
	Dir     string
	Bundle  *bundle.Bundle
	Board   *board.Board
	Wrapped *board.Wrapped
	Seed    int
}

// Build runs synth → pnr → pack in req.Dir and writes report.json there. The returned report says whether a
// bitstream exists (OK) and whether timing passed (TimingOK); the error is non-nil only when the build could
// not be attempted (files, toolchain) or the context ended.
func (s *Suite) Build(ctx context.Context, req BuildRequest, ev Events) (*Report, error) {
	r := &Report{Design: req.Bundle.Design, Board: req.Board.Name, Seed: req.Seed, Virtual: req.Wrapped.Virtual}
	if err := writeSources(req); err != nil {
		return nil, err
	}
	finish := func(err error) (*Report, error) {
		if err != nil && r.Error == "" {
			r.Error = err.Error()
		}
		if werr := writeJSON(filepath.Join(req.Dir, "report.json"), r); werr != nil {
			return r, werr
		}
		return r, ctx.Err()
	}

	// synth
	st, out, err := s.step(ctx, req.Dir, "synth", ev, "yosys", "-s", "synth.ys")
	r.Stages = append(r.Stages, *st)
	if err != nil {
		return finish(err)
	}
	r.Cells = ParseYosysStat(out)
	if _, err := os.Stat(filepath.Join(req.Dir, "top.json")); err != nil {
		return finish(errors.New("yosys did not write top.json"))
	}

	// pnr
	st, out, err = s.step(ctx, req.Dir, "pnr", ev, "nextpnr-himbaechel",
		"--device", req.Board.Device, "--json", "top.json", "-o", "ccf=board/board.ccf", "-o", "out=top.txt",
		"--sdc", "board/board.sdc", "--router", "router2", "--seed", strconv.Itoa(req.Seed), "--timing-allow-fail")
	pnr := ParseNextpnr(out)
	r.Utilization, r.Clocks, r.TimingOK = pnr.Utilization, pnr.Clocks, pnr.TimingOK()
	if err == nil && len(pnr.Errors) > 0 {
		err = errors.Errorf("nextpnr: %s", pnr.Errors[0])
		st.OK, st.Summary = false, err.Error()
	}
	if err == nil {
		if _, serr := os.Stat(filepath.Join(req.Dir, "top.txt")); serr != nil {
			err = errors.New("nextpnr did not write top.txt")
			st.OK, st.Summary = false, err.Error()
		}
	}
	if err == nil {
		r.PLLs, err = checkPLLs(req.Wrapped.PLLs, pnr.PLLs)
		if err != nil {
			st.OK, st.Summary = false, err.Error()
		}
	}
	if err == nil {
		st.Summary = pnrSummary(pnr)
	}
	r.Stages = append(r.Stages, *st)
	if err != nil {
		return finish(err)
	}

	// pack: runs even when timing failed, so the result can be inspected or loaded with force
	st, _, err = s.step(ctx, req.Dir, "pack", ev, "gmpack", "top.txt", "top.bit")
	if err == nil {
		bs, berr := bitstreamInfo(req.Dir, "top.bit", filepath.Join(req.Dir, "pnr.log"))
		if berr != nil {
			err = berr
			st.OK, st.Summary = false, berr.Error()
		} else {
			r.Bitstream = bs
			st.Summary = fmt.Sprintf("%d bytes, sha256 %s", bs.Bytes, bs.SHA256[:12])
		}
	}
	r.Stages = append(r.Stages, *st)
	if err != nil {
		return finish(err)
	}
	r.OK = true
	return finish(nil)
}

// LoadResult describes one openFPGALoader run.
type LoadResult struct {
	Stage Stage  `json:"stage"`
	Log   string `json:"-"`
}

// Load writes a bitstream to the FPGA's SRAM (lost at power-off; the flash keeps its own design).
func (s *Suite) Load(ctx context.Context, dir, loaderBoard, bitfile string, ev Events) (*LoadResult, error) {
	st, out, err := s.step(ctx, dir, "load", ev, "openFPGALoader", "-b", loaderBoard, bitfile)
	if err == nil && !strings.Contains(out, "Done") {
		err = errors.New("openFPGALoader did not report Done")
	}
	if err != nil {
		if lerr := LoaderError(out); lerr != nil {
			err = lerr
		}
		st.OK, st.Summary = false, err.Error()
	} else {
		st.Summary = "loaded into SRAM"
	}
	return &LoadResult{Stage: *st, Log: out}, err
}

// step runs one tool in dir, streaming its combined output to ev.Log and to <stage>.log.
func (s *Suite) step(ctx context.Context, dir, stage string, ev Events, tool string, args ...string) (*Stage, string, error) {
	st := &Stage{Name: stage}
	ev.stage(stage, "running", st)
	start := time.Now()
	logFile, err := os.Create(filepath.Join(dir, stage+".log"))
	if err != nil {
		return st, "", err
	}
	defer func() { _ = logFile.Close() }()
	cmd := s.Command(ctx, dir, tool, args...)
	pr, pw := io.Pipe()
	cmd.Stdout, cmd.Stderr = pw, pw
	var out strings.Builder
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 64<<10), 4<<20)
		for sc.Scan() {
			line := sc.Text()
			out.WriteString(line)
			out.WriteByte('\n')
			_, _ = fmt.Fprintln(logFile, line)
			if ev.Log != nil {
				ev.Log(stage, line)
			}
		}
		_, _ = io.Copy(io.Discard, pr)
	}()
	err = cmd.Run()
	_ = pw.Close()
	wg.Wait()
	st.Ms = time.Since(start).Milliseconds()
	if cmd.ProcessState != nil {
		st.Exit = cmd.ProcessState.ExitCode()
	}
	if err != nil {
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		err = errors.Wrapf(err, "%s", tool)
		st.Summary = err.Error()
		ev.stage(stage, "failed", st)
		return st, out.String(), err
	}
	st.OK = true
	ev.stage(stage, "done", st)
	return st, out.String(), nil
}

func writeSources(req BuildRequest) error {
	for _, d := range []string{"rtl", "board"} {
		if err := os.MkdirAll(filepath.Join(req.Dir, d), 0o755); err != nil {
			return err
		}
	}
	var reads []string
	for _, f := range req.Bundle.Files {
		if err := os.WriteFile(filepath.Join(req.Dir, "rtl", f.Path), []byte(f.Text), 0o644); err != nil {
			return err
		}
		reads = append(reads, "rtl/"+f.Path)
	}
	for _, f := range req.Wrapped.Files {
		if err := os.WriteFile(filepath.Join(req.Dir, "board", f.Path), []byte(f.Text), 0o644); err != nil {
			return err
		}
		reads = append(reads, "board/"+f.Path)
	}
	files := map[string]string{"board/board.ccf": req.Wrapped.CCF, "board/board.sdc": req.Wrapped.SDC,
		"synth.ys": fmt.Sprintf("read_verilog -defer %s\nsynth_gatemate -top %s -luttree -nomx8\nstat\nwrite_json top.json\n",
			strings.Join(reads, " "), req.Wrapped.TopModule)}
	for name, text := range files {
		if err := os.WriteFile(filepath.Join(req.Dir, name), []byte(text), 0o644); err != nil {
			return err
		}
	}
	return writeJSON(filepath.Join(req.Dir, "bundle.json"), req.Bundle)
}

// checkPLLs fails when nextpnr configured a PLL to another frequency than the compiler modelled: the
// simulator (and baud dividers computed from CLK_HZ) would then disagree with the board.
func checkPLLs(want []board.PLL, got []PLLFout) ([]PLLCheck, error) {
	var out []PLLCheck
	for _, p := range want {
		w, _ := strconv.ParseFloat(p.WantMHz, 64)
		c := PLLCheck{Domain: p.Domain, WantMHz: w, ModelMHz: p.Hz / 1e6}
		found := false
		for _, g := range got {
			if math.Abs(g.WantMHz-w) < 5e-5 {
				c.FoutMHz, found = g.FoutMHz, true
				break
			}
		}
		if !found {
			return out, errors.Errorf("nextpnr did not report the PLL for domain %s (%s MHz)", p.Domain, p.WantMHz)
		}
		c.OK = math.Abs(c.FoutMHz-c.ModelMHz) < 1e-4 // nextpnr prints four decimals
		out = append(out, c)
		if !c.OK {
			return out, errors.Errorf("PLL %s: the compiler modelled %.4f MHz but nextpnr configured %.4f MHz", p.Domain, c.ModelMHz, c.FoutMHz)
		}
	}
	return out, nil
}

func pnrSummary(p *PnrLog) string {
	parts := []string{}
	for _, k := range []string{"CPE_LT", "CPE_FF", "IOSEL", "RAM_HALF"} {
		if u, ok := p.Utilization[k]; ok && u[0] > 0 {
			parts = append(parts, fmt.Sprintf("%s %d/%d", k, u[0], u[1]))
		}
	}
	for _, c := range p.Clocks {
		v := "PASS"
		if !c.Pass {
			v = "FAIL"
		}
		parts = append(parts, fmt.Sprintf("%s %.2f MHz (%s at %.2f)", c.Name, c.FmaxMHz, v, c.TargetMHz))
	}
	return strings.Join(parts, ", ")
}

func bitstreamInfo(dir, name, notOlderThan string) (*Bitstream, error) {
	p := filepath.Join(dir, name)
	st, err := os.Stat(p)
	if err != nil {
		return nil, errors.New("gmpack did not write " + name)
	}
	if ref, err := os.Stat(notOlderThan); err == nil && st.ModTime().Before(ref.ModTime()) {
		return nil, errors.Errorf("%s is older than the place-and-route log", name)
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data)
	return &Bitstream{Path: name, Bytes: st.Size(), SHA256: hex.EncodeToString(sum[:])}, nil
}

func writeJSON(file string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(file, append(b, '\n'), 0o644)
}
