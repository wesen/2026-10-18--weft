package cmds

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/go-go-golems/glazed/pkg/cmds"
	"github.com/go-go-golems/glazed/pkg/cmds/fields"
	"github.com/go-go-golems/glazed/pkg/cmds/schema"
	"github.com/go-go-golems/glazed/pkg/cmds/values"
	"github.com/go-go-golems/glazed/pkg/middlewares"
	"github.com/go-go-golems/glazed/pkg/types"
	"github.com/wesen/2026-10-18--weft/pkg/toolchain"
	"github.com/wesen/2026-10-18--weft/pkg/web"
)

// DoctorSettings are the flags of `weft doctor`.
type DoctorSettings struct {
	Suite     string `glazed:"oss-cad-suite"`
	Serial    string `glazed:"serial"`
	SkipBoard bool   `glazed:"skip-board"`
	Node      string `glazed:"node"`
}

// DoctorCommand checks everything a build and a board session need, one row per check.
type DoctorCommand struct{ *cmds.CommandDescription }

var _ cmds.GlazeCommand = (*DoctorCommand)(nil)

// NewDoctorCommand describes `weft doctor`.
func NewDoctorCommand() *DoctorCommand {
	return &DoctorCommand{cmds.NewCommandDescription("doctor",
		cmds.WithShort("Check the toolchain, Node, the board and its serial port"),
		cmds.WithFlags(
			suiteFlag(),
			serialFlag(),
			fields.New("skip-board", fields.TypeBool, fields.WithDefault(false), fields.WithHelp("Do not touch the JTAG cable")),
			fields.New("node", fields.TypeString, fields.WithDefault("node"), fields.WithHelp("Node executable (runs the headless Weft emitter)")),
		),
	)}
}

// RunIntoGlazeProcessor emits one row per check: check, ok, detail.
func (c *DoctorCommand) RunIntoGlazeProcessor(ctx context.Context, parsed *values.Values, gp middlewares.Processor) error {
	s := &DoctorSettings{}
	if err := parsed.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return err
	}
	row := func(check string, ok bool, detail string) error {
		return gp.AddRow(ctx, types.NewRow(types.MRP("check", check), types.MRP("ok", ok), types.MRP("detail", detail)))
	}
	suite, err := toolchain.Open(s.Suite)
	if err != nil {
		if err := row("oss-cad-suite", false, err.Error()); err != nil {
			return err
		}
	} else {
		if err := row("oss-cad-suite", true, fmt.Sprintf("%s (VERSION %s)", suite.Root, suite.Version())); err != nil {
			return err
		}
		for _, v := range suite.Versions(ctx) {
			detail := v.Version
			if v.Err != nil {
				detail = v.Err.Error()
			}
			if err := row(v.Tool, v.Err == nil, detail); err != nil {
				return err
			}
		}
	}
	if out, err := exec.CommandContext(ctx, s.Node, "--version").Output(); err != nil {
		if err := row("node", false, err.Error()); err != nil {
			return err
		}
	} else if err := row("node", true, strings.TrimSpace(string(out))); err != nil {
		return err
	}
	if _, err := web.Lab(""); err != nil {
		if err := row("lab page", false, err.Error()); err != nil {
			return err
		}
	} else if err := row("lab page", true, "embedded"); err != nil {
		return err
	}
	switch {
	case s.SkipBoard:
		if err := row("board", true, "skipped (--skip-board)"); err != nil {
			return err
		}
	case suite == nil:
		if err := row("board", false, "no toolchain to talk to the board"); err != nil {
			return err
		}
	default:
		chip, err := suite.Detect(ctx, "olimex_gatemateevb")
		if err != nil {
			if err := row("board", false, err.Error()); err != nil {
				return err
			}
		} else if err := row("board", true, fmt.Sprintf("%s %s %s (idcode %s)", chip.Manufacturer, chip.Family, chip.Model, chip.IDCode)); err != nil {
			return err
		}
	}
	if st, err := os.Stat(s.Serial); err != nil {
		hint := err.Error()
		if os.IsNotExist(err) {
			hint = s.Serial + " does not exist: load the CDC driver with `sudo modprobe cdc_acm` (board UART checks need it)"
		}
		return row("serial", false, hint)
	} else {
		return row("serial", true, fmt.Sprintf("%s (%s)", s.Serial, st.Mode()))
	}
}
