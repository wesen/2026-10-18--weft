// Package cmds holds the weft CLI's Glazed commands.
package cmds

import (
	"github.com/go-go-golems/glazed/pkg/cli"
	"github.com/go-go-golems/glazed/pkg/cmds"
	"github.com/go-go-golems/glazed/pkg/cmds/fields"
	"github.com/spf13/cobra"
	"github.com/wesen/2026-10-18--weft/pkg/toolchain"
)

// Register builds every command before mounting any, so a flag collision leaves the tree untouched.
func Register(root *cobra.Command) error {
	commands := []cmds.Command{NewServeCommand(), NewDoctorCommand(), NewEmitCommand(), NewBuildCommand(), NewFlashCommand()}
	built := make([]*cobra.Command, 0, len(commands))
	for _, c := range commands {
		cc, err := cli.BuildCobraCommandFromCommand(c)
		if err != nil {
			return err
		}
		built = append(built, cc)
	}
	root.AddCommand(built...)
	return nil
}

// Shared flag definitions, so every command spells them the same way.
func suiteFlag() *fields.Definition {
	return fields.New("oss-cad-suite", fields.TypeString, fields.WithDefault(toolchain.DefaultSuiteRoot),
		fields.WithHelp("OSS CAD Suite root (yosys, nextpnr-himbaechel, gmpack, openFPGALoader, iverilog)"))
}

func boardFlag() *fields.Definition {
	return fields.New("board", fields.TypeChoice, fields.WithChoices("gatemate-a1-evb"), fields.WithDefault("gatemate-a1-evb"),
		fields.WithHelp("Target board"))
}

func workDirFlag() *fields.Definition {
	return fields.New("work-dir", fields.TypeString, fields.WithDefault("var/weft"), fields.WithHelp("Builds, logs and bitstreams (builds/<id>/)"))
}

func nodeFlag() *fields.Definition {
	return fields.New("node", fields.TypeString, fields.WithDefault("node"), fields.WithHelp("Node executable (runs the embedded Weft compiler)"))
}

func scriptArg(help string) *fields.Definition {
	return fields.New("script", fields.TypeString, fields.WithIsArgument(true), fields.WithRequired(true), fields.WithHelp(help))
}

func serialFlag() *fields.Definition {
	return fields.New("serial", fields.TypeString, fields.WithDefault("/dev/ttyACM0"),
		fields.WithHelp("The board's FPGA UART (first CDC port of the RP2040)"))
}
