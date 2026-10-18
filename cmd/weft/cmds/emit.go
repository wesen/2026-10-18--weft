package cmds

import (
	"context"
	"os"

	"github.com/go-go-golems/glazed/pkg/cmds"
	"github.com/go-go-golems/glazed/pkg/cmds/fields"
	"github.com/go-go-golems/glazed/pkg/cmds/schema"
	"github.com/go-go-golems/glazed/pkg/cmds/values"
	"github.com/wesen/2026-10-18--weft/pkg/emitter"
)

// EmitSettings are the flags of `weft emit`.
type EmitSettings struct {
	Script string `glazed:"script"`
	Board  string `glazed:"board"`
	Out    string `glazed:"out"`
	Node   string `glazed:"node"`
}

// EmitCommand compiles a Weft script into a hardware bundle.
type EmitCommand struct{ *cmds.CommandDescription }

var _ cmds.BareCommand = (*EmitCommand)(nil)

// NewEmitCommand describes `weft emit`.
func NewEmitCommand() *EmitCommand {
	return &EmitCommand{cmds.NewCommandDescription("emit",
		cmds.WithShort("Compile a Weft script into a hardware bundle (weft.hw-bundle/v1 JSON)"),
		cmds.WithArguments(scriptArg("Weft design script (e.g. weft-lab/examples/F-01-blinky.js)")),
		cmds.WithFlags(
			boardFlag(),
			fields.New("out", fields.TypeString, fields.WithHelp("Write the bundle here instead of stdout")),
			nodeFlag(),
		),
	)}
}

// Run writes the bundle.
func (c *EmitCommand) Run(ctx context.Context, parsed *values.Values) error {
	s := &EmitSettings{}
	if err := parsed.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return err
	}
	_, raw, err := emitter.Emit(ctx, s.Node, s.Script, s.Board)
	if err != nil {
		return err
	}
	if s.Out == "" {
		_, err = os.Stdout.Write(raw)
		return err
	}
	return os.WriteFile(s.Out, raw, 0o644)
}
