package cmds

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/go-go-golems/glazed/pkg/cmds"
	"github.com/go-go-golems/glazed/pkg/cmds/fields"
	"github.com/go-go-golems/glazed/pkg/cmds/schema"
	"github.com/go-go-golems/glazed/pkg/cmds/values"
	"github.com/go-go-golems/glazed/pkg/middlewares"
	"github.com/go-go-golems/glazed/pkg/types"
	"github.com/pkg/errors"
	"github.com/wesen/2026-10-18--weft/pkg/emitter"
	"github.com/wesen/2026-10-18--weft/pkg/hw"
	"github.com/wesen/2026-10-18--weft/pkg/toolchain"
	"github.com/wesen/2026-10-18--weft/pkg/validate"
)

// ValidateSettings are the flags of `weft validate`.
type ValidateSettings struct {
	Script   string   `glazed:"script"`
	Board    string   `glazed:"board"`
	Scenario string   `glazed:"scenario"`
	Levels   []string `glazed:"levels"`
	CosimHz  float64  `glazed:"cosim-hz"`
	Seed     int      `glazed:"seed"`
	WorkDir  string   `glazed:"work-dir"`
	Suite    string   `glazed:"oss-cad-suite"`
	Node     string   `glazed:"node"`
}

// ValidateCommand runs the validation ladder, one row per level and scenario.
type ValidateCommand struct{ *cmds.CommandDescription }

var _ cmds.GlazeCommand = (*ValidateCommand)(nil)

// NewValidateCommand describes `weft validate`.
func NewValidateCommand() *ValidateCommand {
	return &ValidateCommand{cmds.NewCommandDescription("validate",
		cmds.WithShort("Check a design against the Lab's simulator: build, RTL and netlist co-simulation"),
		cmds.WithLong(`Run the validation ladder for a Weft script, in order:

- build: synthesis, place and route and timing succeed for the board (a full weft build, not loaded)
- rtl (L1): the emitted Verilog, simulated by iverilog, drives the same pins as the Lab's simulator, cycle by cycle, over each scenario
- net (L2): the same, against a GateMate netlist of that Verilog (yosys synth_gatemate + cells_sim.v)
- board (L3): scenarios on the real board (not implemented yet)

rtl and net run a co-simulation variant of the design whose main clock is --cosim-hz (1 MHz by default),
so every prescaler shrinks by the same factor and whole scenarios stay short. A scenario that pokes
internal signals is skipped, as is a design with more than one clock domain. Files land in
<work-dir>/validate/<id>/ (the RTL, the netlist, each scenario's change list, testbench and logs).
See weft help validation-ladder.`),
		cmds.WithArguments(scriptArg("Weft design script (.js)")),
		cmds.WithFlags(
			boardFlag(),
			fields.New("scenario", fields.TypeString, fields.WithHelp("Only this scenario (default: all)")),
			fields.New("levels", fields.TypeChoiceList, fields.WithChoices("build", "rtl", "net", "board"),
				fields.WithDefault([]string{"rtl", "net"}), fields.WithHelp("Levels to run (always in ladder order)")),
			fields.New("cosim-hz", fields.TypeFloat, fields.WithDefault(1e6), fields.WithHelp("Main clock of the co-simulation variant")),
			fields.New("seed", fields.TypeInteger, fields.WithDefault(1), fields.WithHelp("nextpnr placement seed (build level)")),
			workDirFlag(),
			suiteFlag(),
			nodeFlag(),
		),
	)}
}

// RunIntoGlazeProcessor runs the requested levels and emits one row per result.
func (c *ValidateCommand) RunIntoGlazeProcessor(ctx context.Context, parsed *values.Values, gp middlewares.Processor) error {
	s := &ValidateSettings{}
	if err := parsed.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return err
	}
	suite, err := toolchain.Open(s.Suite)
	if err != nil {
		return err
	}
	failed := 0
	row := func(r validate.Result) error {
		fmt.Fprintf(os.Stderr, "weft: %s %s: %s %s\n", r.Level, quote(r.Scenario), r.Status, r.Message)
		if r.Status == "fail" {
			failed++
		}
		return gp.AddRow(ctx, types.NewRow(types.MRP("level", r.Level), types.MRP("scenario", r.Scenario), types.MRP("status", r.Status),
			types.MRP("cycles", r.Cycles), types.MRP("ms", r.Ms), types.MRP("message", r.Message)))
	}

	if slices.Contains(s.Levels, "build") {
		bn, _, err := emitter.Emit(ctx, s.Node, s.Script, s.Board)
		if err != nil {
			return err
		}
		b, err := hw.RunBuild(ctx, suite, bn, hw.BuildOptions{WorkDir: s.WorkDir, Seed: s.Seed}, progress(false))
		if err != nil && b == nil {
			return err
		}
		if rerr := row(hw.BuildResult(b.ID, b.Report)); rerr != nil {
			return rerr
		}
	}

	var co []string
	for _, l := range []string{validate.LevelRTL, validate.LevelNet} {
		if slices.Contains(s.Levels, l) {
			co = append(co, l)
		}
	}
	if len(co) > 0 {
		vec, err := emitter.Vectors(ctx, s.Node, s.Script, emitter.VectorsOptions{Board: s.Board, Scenario: s.Scenario, CosimHz: s.CosimHz})
		if err != nil {
			return err
		}
		dir, err := filepath.Abs(filepath.Join(s.WorkDir, "validate", hw.NewID(vec.Bundle.Design, time.Now())))
		if err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "weft: co-simulating %s at %g Hz in %s\n", vec.Bundle.Design, vec.CosimHz, dir)
		res, err := validate.Run(ctx, suite, dir, vec, co, nil)
		if err != nil {
			return err
		}
		for _, r := range res {
			if rerr := row(r); rerr != nil {
				return rerr
			}
		}
	}

	if slices.Contains(s.Levels, "board") {
		if err := row(validate.Result{Level: "board", Status: "skip", Message: "board-level scenarios are not implemented yet"}); err != nil {
			return err
		}
	}
	if failed > 0 {
		return errors.Errorf("%d validation check(s) failed", failed)
	}
	return nil
}

func quote(s string) string {
	if s == "" {
		return ""
	}
	return fmt.Sprintf("%q", s)
}
