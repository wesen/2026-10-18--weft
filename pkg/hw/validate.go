package hw

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"

	"github.com/wesen/2026-10-18--weft/pkg/toolchain"
	"github.com/wesen/2026-10-18--weft/pkg/validate"
)

// Ladder levels in order (guide §6.10).
var Levels = []string{"build", validate.LevelRTL, validate.LevelNet, "board"}

// BuildResult is the ladder's L0 verdict for a build: a bitstream exists, every clock meets timing, and no
// resource is over capacity.
func BuildResult(id string, rep *toolchain.Report) validate.Result {
	r := validate.Result{Level: "build", Status: "pass"}
	if rep == nil {
		r.Status, r.Message = "fail", "no build report"
		return r
	}
	for _, st := range rep.Stages {
		r.Ms += st.Ms
	}
	switch {
	case !rep.OK:
		r.Status, r.Message = "fail", fmt.Sprintf("%s (build %s)", rep.Error, id)
	case !rep.TimingOK:
		r.Status, r.Message = "fail", fmt.Sprintf("timing failed (build %s)", id)
	default:
		r.Message = "build " + id
		for _, c := range rep.Clocks {
			r.Message += fmt.Sprintf(", %s %.2f MHz", c.Name, c.FmaxMHz)
		}
	}
	for name, u := range rep.Utilization {
		if u[1] > 0 && u[0] > u[1] {
			r.Status, r.Message = "fail", fmt.Sprintf("%s over capacity: %d of %d", name, u[0], u[1])
		}
	}
	return r
}

// checkLevels refuses unknown levels and co-simulation levels without vectors.
func checkLevels(levels []string, vec *validate.Vectors) error {
	for _, l := range levels {
		if !slices.Contains(Levels, l) {
			return &Refusal{Err: fmt.Errorf("unknown validation level %q (build, rtl, net, board)", l)}
		}
		if (l == validate.LevelRTL || l == validate.LevelNet) && vec == nil {
			return &Refusal{Err: fmt.Errorf("level %s needs vectors (weft-hw.mjs vectors, or vectors() in the page)", l)}
		}
	}
	return nil
}

// runValidation runs the requested levels for a finished build; results go to the job as they come.
func (m *Manager) runValidation(j *Job, vec *validate.Vectors, levels []string) {
	j.mu.Lock()
	j.validation = nil
	j.setStateLocked("validate")
	rep, id := j.report, j.ID
	j.mu.Unlock()
	for _, l := range Levels {
		if !slices.Contains(levels, l) {
			continue
		}
		switch l {
		case "build":
			j.addValidation(BuildResult(id, rep))
		case "board":
			j.addValidation(validate.Result{Level: "board", Status: "skip", Message: "board-level scenarios are not implemented yet"})
		}
	}
	var co []string
	for _, l := range []string{validate.LevelRTL, validate.LevelNet} {
		if slices.Contains(levels, l) {
			co = append(co, l)
		}
	}
	if len(co) == 0 {
		return
	}
	dir := filepath.Join(j.Dir, "validate")
	_ = os.RemoveAll(dir)
	if _, err := validate.Run(m.ctx, m.suite, dir, vec, co, j.addValidation); err != nil {
		j.addValidation(validate.Result{Level: co[0], Status: "fail", Message: err.Error()})
	}
}

func (j *Job) addValidation(r validate.Result) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if r.Dir != "" {
		r.Dir = "validate/" + r.Dir
	}
	j.validation = append(j.validation, r)
	j.publishLocked(Event{Type: "validation", Result: &r})
}
