// Package hw runs builds and board operations for the CLI and the HTTP API: one build per directory under
// <work>/builds/<id>, the board wrapper, the toolchain run, and loading with the timing/force rules.
package hw

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/pkg/errors"
	"github.com/wesen/2026-10-18--weft/pkg/board"
	"github.com/wesen/2026-10-18--weft/pkg/bundle"
	"github.com/wesen/2026-10-18--weft/pkg/toolchain"
)

// BuildOptions tune one build.
type BuildOptions struct {
	WorkDir     string
	Seed        int
	ButtonReset string
}

// Build is one finished (or failed) build.
type Build struct {
	ID     string
	Dir    string
	Report *toolchain.Report
}

var unsafeID = regexp.MustCompile(`[^a-z0-9-]+`)

// NewID names a build: time, design and a short random suffix ("20261018-185600-blinky-3fa9").
func NewID(design string, now time.Time) string {
	b := make([]byte, 2)
	_, _ = rand.Read(b)
	name := strings.Trim(unsafeID.ReplaceAllString(strings.ToLower(design), "-"), "-")
	if name == "" {
		name = "design"
	}
	return now.Format("20060102-150405") + "-" + name + "-" + hex.EncodeToString(b)
}

// BuildsDir is where builds live.
func BuildsDir(workDir string) string { return filepath.Join(workDir, "builds") }

// Wrap resolves the bundle's board and generates its board files.
func Wrap(bn *bundle.Bundle, opt BuildOptions) (*board.Board, *board.Wrapped, error) {
	b, err := board.Lookup(bn.Board)
	if err != nil {
		return nil, nil, err
	}
	w, err := b.Wrap(bn, board.WrapOptions{ButtonReset: opt.ButtonReset})
	return b, w, err
}

// prepared is a wrapped bundle with a fresh build directory, ready for the toolchain.
type prepared struct {
	id      string
	dir     string
	created time.Time
	req     toolchain.BuildRequest
}

// Refusal is a bundle the board cannot host (unknown board or resource, wrong clock, shared pin).
type Refusal struct{ Err error }

func (r *Refusal) Error() string { return r.Err.Error() }
func (r *Refusal) Unwrap() error { return r.Err }

// prepare wraps the bundle (refusing what the board cannot host) and creates its build directory.
func prepare(bn *bundle.Bundle, opt BuildOptions) (*prepared, error) {
	b, w, err := Wrap(bn, opt)
	if err != nil {
		return nil, &Refusal{Err: err}
	}
	now := time.Now()
	id := NewID(bn.Design, now)
	dir, err := filepath.Abs(filepath.Join(BuildsDir(opt.WorkDir), id))
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &prepared{id: id, dir: dir, created: now,
		req: toolchain.BuildRequest{Dir: dir, Bundle: bn, Board: b, Wrapped: w, Seed: opt.Seed}}, nil
}

// RunBuild wraps and builds a bundle in a new build directory.
func RunBuild(ctx context.Context, suite *toolchain.Suite, bn *bundle.Bundle, opt BuildOptions, ev toolchain.Events) (*Build, error) {
	p, err := prepare(bn, opt)
	if err != nil {
		return nil, err
	}
	rep, err := suite.Build(ctx, p.req, ev)
	return &Build{ID: p.id, Dir: p.dir, Report: rep}, err
}

// ErrNeedsForce marks a bitstream that failed timing: it loads only when the caller insists.
var ErrNeedsForce = errors.New("this build failed timing; load it anyway with force")

// OpenBuild finds a build by id (under workDir) or by directory path and reads its report.
func OpenBuild(workDir, ref string) (*Build, error) {
	dir := ref
	if st, err := os.Stat(ref); err != nil || !st.IsDir() {
		if strings.ContainsAny(ref, `/\`) {
			return nil, errors.Errorf("no build directory %s", ref)
		}
		dir = filepath.Join(BuildsDir(workDir), ref)
	}
	data, err := os.ReadFile(filepath.Join(dir, "report.json"))
	if err != nil {
		return nil, errors.Wrapf(err, "build %s", ref)
	}
	rep := &toolchain.Report{}
	if err := json.Unmarshal(data, rep); err != nil {
		return nil, errors.Wrapf(err, "build %s: report.json", ref)
	}
	return &Build{ID: filepath.Base(dir), Dir: dir, Report: rep}, nil
}

// Loadable applies the load rules: a bitstream must exist, and a timing failure needs force.
func (b *Build) Loadable(force bool) error {
	if !b.Report.OK || b.Report.Bitstream == nil {
		return errors.Errorf("build %s has no bitstream (%s)", b.ID, b.Report.Error)
	}
	if !b.Report.TimingOK && !force {
		return ErrNeedsForce
	}
	return nil
}

// Load writes the build's bitstream to the board's SRAM.
func (b *Build) Load(ctx context.Context, suite *toolchain.Suite, force bool, ev toolchain.Events) (*toolchain.LoadResult, error) {
	if err := b.Loadable(force); err != nil {
		return nil, err
	}
	bd, err := board.Lookup(b.Report.Board)
	if err != nil {
		return nil, err
	}
	return suite.Load(ctx, b.Dir, bd.Loader, b.Report.Bitstream.Path, ev)
}
