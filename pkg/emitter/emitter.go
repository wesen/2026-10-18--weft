// Package emitter runs the Weft compiler headlessly to turn a script into a hardware bundle. The compiler is
// JavaScript (weft-lab/app/src/core); `go generate` bundles it with tools/weft-hw.mjs into js/weft-hw.mjs,
// which the binary embeds and runs with Node, so `weft emit` and `weft build` need no checkout of the Lab.
package emitter

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/pkg/errors"
	"github.com/wesen/2026-10-18--weft/pkg/bundle"
	"github.com/wesen/2026-10-18--weft/pkg/validate"
)

//go:generate sh -c "cd ../../weft-lab/app && node_modules/.bin/esbuild tools/weft-hw.mjs --bundle --platform=node --format=esm --log-level=warning --outfile=../../pkg/emitter/js/weft-hw.mjs"

//go:embed js
var js embed.FS

// ErrNotEmbedded means the binary was built without `go generate ./pkg/emitter`.
var ErrNotEmbedded = errors.New("the Weft emitter is not embedded in this binary: run `make web` (or go generate ./pkg/emitter) and rebuild")

// Error is a design the compiler refuses to send to hardware (weft-hw.mjs exit 2).
type Error struct {
	Code    string           `json:"code"`
	Message string           `json:"message"`
	Details []map[string]any `json:"details,omitempty"`
}

func (e *Error) Error() string { return e.Message }

// Script returns the bundled emitter.
func Script() ([]byte, error) {
	b, err := js.ReadFile("js/weft-hw.mjs")
	if err != nil {
		return nil, ErrNotEmbedded
	}
	return b, nil
}

// Emit compiles script (a Weft design file) for board and returns the parsed bundle and its raw JSON.
func Emit(ctx context.Context, node, script, board string) (*bundle.Bundle, []byte, error) {
	out, err := run(ctx, node, "bundle", script, "--board", board)
	if err != nil {
		return nil, nil, err
	}
	b, err := bundle.Parse(out)
	if err != nil {
		return nil, nil, err
	}
	return b, out, nil
}

// VectorsOptions select what weft-hw.mjs vectors records.
type VectorsOptions struct {
	Board    string
	Scenario string  // "" for every scenario
	CosimHz  float64 // 0 for the default (1 MHz)
}

// Vectors runs the design's scenarios on its co-simulation variant and returns the port changes.
func Vectors(ctx context.Context, node, script string, opt VectorsOptions) (*validate.Vectors, error) {
	args := []string{"vectors", script, "--board", opt.Board}
	if opt.Scenario != "" {
		args = append(args, "--scenario", opt.Scenario)
	}
	if opt.CosimHz > 0 {
		args = append(args, "--cosim-hz", strconv.FormatFloat(opt.CosimHz, 'g', -1, 64))
	}
	out, err := run(ctx, node, args...)
	if err != nil {
		return nil, err
	}
	return validate.Parse(out)
}

// run executes the embedded weft-hw.mjs; exit 2 is a refusal (*Error).
func run(ctx context.Context, node string, args ...string) ([]byte, error) {
	code, err := Script()
	if err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp("", "weft-emit-")
	if err != nil {
		return nil, err
	}
	defer func() { _ = os.RemoveAll(dir) }()
	tool := filepath.Join(dir, "weft-hw.mjs")
	if err := os.WriteFile(tool, code, 0o644); err != nil {
		return nil, err
	}
	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, node, append([]string{tool}, args...)...)
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == 2 {
			var refused struct {
				Error *Error `json:"error"`
			}
			if json.Unmarshal(stderr.Bytes(), &refused) == nil && refused.Error != nil {
				return nil, refused.Error
			}
		}
		return nil, errors.Wrapf(err, "weft-hw.mjs: %s", strings.TrimSpace(stderr.String()))
	}
	return stdout.Bytes(), nil
}
