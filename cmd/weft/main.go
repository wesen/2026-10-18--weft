// Command weft serves Weft Lab and builds, loads and validates Weft designs on the Olimex GateMateA1-EVB.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/go-go-golems/glazed/pkg/cmds/logging"
	"github.com/go-go-golems/glazed/pkg/help"
	help_cmd "github.com/go-go-golems/glazed/pkg/help/cmd"
	"github.com/pkg/errors"
	"github.com/spf13/cobra"
	"github.com/wesen/2026-10-18--weft/cmd/weft/cmds"
	"github.com/wesen/2026-10-18--weft/pkg/doc"
)

func run(ctx context.Context) error {
	root := &cobra.Command{
		Use:          "weft",
		Short:        "Weft Lab server and GateMate hardware flow",
		Long:         "Serve Weft Lab locally (with the artifact runtime its agent needs) and turn Weft designs into bitstreams for the Olimex GateMateA1-EVB.",
		Version:      "dev",
		SilenceUsage: true, SilenceErrors: true,
		PersistentPreRunE: func(cmd *cobra.Command, _ []string) error {
			return logging.InitLoggerFromCobra(cmd)
		},
	}
	if err := logging.AddLoggingSectionToRootCommand(root, "weft"); err != nil {
		return errors.Wrap(err, "configure logging")
	}
	hs := help.NewHelpSystem()
	if err := doc.AddDocToHelpSystem(hs); err != nil {
		return errors.Wrap(err, "load help")
	}
	help_cmd.SetupCobraRootCommand(hs, root)
	if err := cmds.Register(root); err != nil {
		return errors.Wrap(err, "register commands")
	}
	return root.ExecuteContext(ctx)
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "weft:", err)
		os.Exit(1)
	}
}
