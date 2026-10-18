package cmds

import (
	"context"
	"path/filepath"
	"strings"

	"github.com/go-go-golems/glazed/pkg/cmds"
	"github.com/go-go-golems/glazed/pkg/cmds/fields"
	"github.com/go-go-golems/glazed/pkg/cmds/schema"
	"github.com/go-go-golems/glazed/pkg/cmds/values"
	"github.com/go-go-golems/glazed/pkg/middlewares"
	"github.com/wesen/2026-10-18--weft/pkg/board"
	"github.com/wesen/2026-10-18--weft/pkg/hw"
	"github.com/wesen/2026-10-18--weft/pkg/toolchain"
)

// FlashSettings are the flags of `weft flash`.
type FlashSettings struct {
	Target  string `glazed:"target"`
	Board   string `glazed:"board"`
	Force   bool   `glazed:"force"`
	WorkDir string `glazed:"work-dir"`
	Suite   string `glazed:"oss-cad-suite"`
	Verbose bool   `glazed:"verbose"`
}

// FlashCommand loads a bitstream or a build into the FPGA's SRAM.
type FlashCommand struct{ *cmds.CommandDescription }

var _ cmds.GlazeCommand = (*FlashCommand)(nil)

// NewFlashCommand describes `weft flash`.
func NewFlashCommand() *FlashCommand {
	return &FlashCommand{cmds.NewCommandDescription("flash",
		cmds.WithShort("Load a bitstream (top.bit) or a build (id or directory) into the FPGA's SRAM"),
		cmds.WithLong("Loads into SRAM: the design runs until power-off or the next load; the board's flash is untouched."),
		cmds.WithArguments(fields.New("target", fields.TypeString, fields.WithIsArgument(true), fields.WithRequired(true),
			fields.WithHelp("A .bit file, a build id from <work-dir>/builds, or a build directory"))),
		cmds.WithFlags(
			boardFlag(),
			fields.New("force", fields.TypeBool, fields.WithDefault(false), fields.WithHelp("Load a build that failed timing")),
			workDirFlag(),
			suiteFlag(),
			fields.New("verbose", fields.TypeBool, fields.WithDefault(false), fields.WithHelp("Stream openFPGALoader output to stderr")),
		),
	)}
}

// RunIntoGlazeProcessor loads and emits one row.
func (c *FlashCommand) RunIntoGlazeProcessor(ctx context.Context, parsed *values.Values, gp middlewares.Processor) error {
	s := &FlashSettings{}
	if err := parsed.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return err
	}
	suite, err := toolchain.Open(s.Suite)
	if err != nil {
		return err
	}
	ev := progress(s.Verbose)
	var res *toolchain.LoadResult
	label := s.Target
	if strings.HasSuffix(s.Target, ".bit") {
		bd, berr := board.Lookup(s.Board)
		if berr != nil {
			return berr
		}
		abs, aerr := filepath.Abs(s.Target)
		if aerr != nil {
			return aerr
		}
		res, err = suite.Load(ctx, filepath.Dir(abs), bd.Loader, filepath.Base(abs), ev)
	} else {
		b, oerr := hw.OpenBuild(s.WorkDir, s.Target)
		if oerr != nil {
			return oerr
		}
		label = b.ID
		res, err = b.Load(ctx, suite, s.Force, ev)
	}
	if res != nil {
		if rerr := gp.AddRow(ctx, stageRow(label, res.Stage)); rerr != nil {
			return rerr
		}
	}
	return err
}
