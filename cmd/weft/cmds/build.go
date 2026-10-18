package cmds

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/go-go-golems/glazed/pkg/cmds"
	"github.com/go-go-golems/glazed/pkg/cmds/fields"
	"github.com/go-go-golems/glazed/pkg/cmds/schema"
	"github.com/go-go-golems/glazed/pkg/cmds/values"
	"github.com/go-go-golems/glazed/pkg/middlewares"
	"github.com/go-go-golems/glazed/pkg/types"
	"github.com/pkg/errors"
	"github.com/wesen/2026-10-18--weft/pkg/bundle"
	"github.com/wesen/2026-10-18--weft/pkg/emitter"
	"github.com/wesen/2026-10-18--weft/pkg/hw"
	"github.com/wesen/2026-10-18--weft/pkg/toolchain"
)

// BuildSettings are the flags of `weft build`.
type BuildSettings struct {
	Input       string `glazed:"script"`
	Board       string `glazed:"board"`
	Seed        int    `glazed:"seed"`
	Load        bool   `glazed:"load"`
	Force       bool   `glazed:"force"`
	ButtonReset string `glazed:"button-reset"`
	WorkDir     string `glazed:"work-dir"`
	Suite       string `glazed:"oss-cad-suite"`
	Node        string `glazed:"node"`
	Verbose     bool   `glazed:"verbose"`
}

// BuildCommand turns a script or bundle into a bitstream, one row per stage.
type BuildCommand struct{ *cmds.CommandDescription }

var _ cmds.GlazeCommand = (*BuildCommand)(nil)

// NewBuildCommand describes `weft build`.
func NewBuildCommand() *BuildCommand {
	return &BuildCommand{cmds.NewCommandDescription("build",
		cmds.WithShort("Build a Weft script or bundle into a GateMate bitstream (and optionally load it)"),
		cmds.WithLong(`Build a design for the board: emit (for a .js script), wrap, synthesize (yosys), place and route
(nextpnr-himbaechel), pack (gmpack), and with --load write it to the FPGA's SRAM.

A build that fails timing still produces a bitstream; --load refuses it unless --force is given.
Everything lands in <work-dir>/builds/<id>/ (sources, logs, report.json, top.bit).`),
		cmds.WithArguments(scriptArg("Weft design script (.js) or hardware bundle (.json)")),
		cmds.WithFlags(
			boardFlag(),
			fields.New("seed", fields.TypeInteger, fields.WithDefault(1), fields.WithHelp("nextpnr placement seed")),
			fields.New("load", fields.TypeBool, fields.WithDefault(false), fields.WithHelp("Load the bitstream into SRAM after a successful build")),
			fields.New("force", fields.TypeBool, fields.WithDefault(false), fields.WithHelp("With --load: load even when timing failed")),
			fields.New("button-reset", fields.TypeString, fields.WithHelp("Also reset the design while this physical input is active (e.g. btn:user)")),
			workDirFlag(),
			suiteFlag(),
			nodeFlag(),
			fields.New("verbose", fields.TypeBool, fields.WithDefault(false), fields.WithHelp("Stream tool output to stderr")),
		),
	)}
}

// RunIntoGlazeProcessor builds and emits one row per stage.
func (c *BuildCommand) RunIntoGlazeProcessor(ctx context.Context, parsed *values.Values, gp middlewares.Processor) error {
	s := &BuildSettings{}
	if err := parsed.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return err
	}
	suite, err := toolchain.Open(s.Suite)
	if err != nil {
		return err
	}
	bn, err := loadInput(ctx, s.Input, s.Node, s.Board)
	if err != nil {
		return err
	}
	ev := progress(s.Verbose)
	b, err := hw.RunBuild(ctx, suite, bn, hw.BuildOptions{WorkDir: s.WorkDir, Seed: s.Seed, ButtonReset: s.ButtonReset}, ev)
	if err != nil && b == nil {
		return err
	}
	for _, st := range b.Report.Stages {
		if rerr := gp.AddRow(ctx, stageRow(b.ID, st)); rerr != nil {
			return rerr
		}
	}
	if err != nil {
		return err
	}
	if !b.Report.OK {
		return errors.Errorf("build %s failed: %s (logs in %s)", b.ID, b.Report.Error, b.Dir)
	}
	if !b.Report.TimingOK && !s.Load {
		fmt.Fprintf(os.Stderr, "weft: build %s failed timing; the bitstream exists but loads only with --force\n", b.ID)
	}
	if !s.Load {
		return nil
	}
	res, err := b.Load(ctx, suite, s.Force, ev)
	if errors.Is(err, hw.ErrNeedsForce) {
		return errors.Errorf("build %s failed timing, so it was not loaded; load it anyway with: weft flash %s --force", b.ID, b.ID)
	}
	if res != nil {
		if rerr := gp.AddRow(ctx, stageRow(b.ID, res.Stage)); rerr != nil {
			return rerr
		}
	}
	return err
}

func loadInput(ctx context.Context, input, node, board string) (*bundle.Bundle, error) {
	if strings.HasSuffix(input, ".json") {
		return bundle.Load(input)
	}
	bn, _, err := emitter.Emit(ctx, node, input, board)
	return bn, err
}

func stageRow(build string, st toolchain.Stage) types.Row {
	return types.NewRow(types.MRP("build", build), types.MRP("stage", st.Name), types.MRP("ok", st.OK),
		types.MRP("ms", st.Ms), types.MRP("summary", st.Summary))
}

// progress reports stages (and with verbose, tool output) on stderr while the table waits for the end.
func progress(verbose bool) toolchain.Events {
	ev := toolchain.Events{Stage: func(name, state string, st *toolchain.Stage) {
		switch state {
		case "running":
			fmt.Fprintf(os.Stderr, "weft: %s…\n", name)
		case "done":
			fmt.Fprintf(os.Stderr, "weft: %s ok (%.2f s)\n", name, float64(st.Ms)/1000)
		case "failed":
			fmt.Fprintf(os.Stderr, "weft: %s failed (%.2f s): %s\n", name, float64(st.Ms)/1000, st.Summary)
		}
	}}
	if verbose {
		ev.Log = func(stage, line string) { fmt.Fprintf(os.Stderr, "  %s| %s\n", stage, line) }
	}
	return ev
}
