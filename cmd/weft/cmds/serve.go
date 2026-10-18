package cmds

import (
	"context"
	"net/http"
	"os"
	"path/filepath"

	"github.com/go-go-golems/glazed/pkg/cmds"
	"github.com/go-go-golems/glazed/pkg/cmds/fields"
	"github.com/go-go-golems/glazed/pkg/cmds/schema"
	"github.com/go-go-golems/glazed/pkg/cmds/values"
	"github.com/pkg/errors"
	"github.com/rs/zerolog/log"
	"github.com/wesen/2026-10-18--weft/pkg/artifacthost"
	"github.com/wesen/2026-10-18--weft/pkg/sampler"
	"github.com/wesen/2026-10-18--weft/pkg/server"
	"github.com/wesen/2026-10-18--weft/pkg/toolchain"
	"github.com/wesen/2026-10-18--weft/pkg/web"
)

// ServeSettings are the flags of `weft serve`.
type ServeSettings struct {
	Listen     string `glazed:"listen"`
	LabFile    string `glazed:"lab-file"`
	WorkDir    string `glazed:"work-dir"`
	Suite      string `glazed:"oss-cad-suite"`
	Serial     string `glazed:"serial"`
	Sampler    string `glazed:"sampler"`
	Node       string `glazed:"node"`
	Worker     string `glazed:"worker"`
	PiAgentDir string `glazed:"pi-agent-dir"`
	Quick      string `glazed:"model-quick"`
	Default    string `glazed:"model-default"`
	Complex    string `glazed:"model-complex"`
}

// ServeCommand hosts the Lab page, the artifact runtime and the hardware API.
type ServeCommand struct{ *cmds.CommandDescription }

var _ cmds.BareCommand = (*ServeCommand)(nil)

// NewServeCommand describes `weft serve`.
func NewServeCommand() *ServeCommand {
	return &ServeCommand{cmds.NewCommandDescription("serve",
		cmds.WithShort("Serve Weft Lab with the artifact runtime and the GateMate hardware API"),
		cmds.WithLong(`Serve Weft Lab on one loopback origin, with window.claude.use("sample") and use("downloads").

The Lab's agent samples through francois's Pi worker (--sampler pi, the default), which uses your Pi
provider login in --pi-agent-dir. If the worker cannot start, the Lab still loads and its agent reports
that sampling is unavailable. --sampler fake answers deterministically, for testing the wiring offline.

The page keeps saved designs in localStorage, which belongs to the origin: keep the same --listen
address between runs to keep them.`),
		cmds.WithFlags(
			fields.New("listen", fields.TypeString, fields.WithDefault("127.0.0.1:8088"), fields.WithHelp("Loopback address; the Host header must match it")),
			fields.New("lab-file", fields.TypeString, fields.WithHelp("Serve this Lab page from disk instead of the embedded copy (e.g. weft-lab/app/dist/index.html)")),
			workDirFlag(),
			suiteFlag(),
			serialFlag(),
			fields.New("sampler", fields.TypeChoice, fields.WithChoices("pi", "fake", "none"), fields.WithDefault("pi"), fields.WithHelp("Model backend for the Lab's agent")),
			nodeFlag(),
			fields.New("worker", fields.TypeString, fields.WithDefault("~/code/wesen/go-go-golems/francois/worker/dist/main.js"), fields.WithHelp("francois's built Pi worker (npm ci && npm run build in the francois checkout)")),
			fields.New("pi-agent-dir", fields.TypeString, fields.WithDefault("~/.pi/agent"), fields.WithHelp("Pi configuration and provider login")),
			fields.New("model-quick", fields.TypeString, fields.WithHelp("Pi provider/model for quick calls")),
			fields.New("model-default", fields.TypeString, fields.WithHelp("Pi provider/model for default calls")),
			fields.New("model-complex", fields.TypeString, fields.WithHelp("Pi provider/model for complex calls")),
		),
	)}
}

// Run serves until interrupted.
func (c *ServeCommand) Run(ctx context.Context, parsed *values.Values) error {
	s := &ServeSettings{}
	if err := parsed.DecodeSectionInto(schema.DefaultSlug, s); err != nil {
		return err
	}
	srv, err := server.New(s.Listen)
	if err != nil {
		return err
	}
	if _, err := web.Lab(s.LabFile); err != nil {
		return err
	}
	backend := startSampler(ctx, s)
	defer func() { _ = backend.Close() }()
	host := artifacthost.New(ctx, backend, func() ([]byte, error) { return web.Lab(s.LabFile) })
	defer func() { _ = host.Close() }()
	host.Register(srv.Mux)
	srv.Mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		server.Respond(w, http.StatusOK, map[string]any{"ok": true, "models": len(backend.Models())})
	})
	return srv.Run(ctx)
}

// startSampler never fails the server: a Lab without its agent is still a working Lab.
func startSampler(ctx context.Context, s *ServeSettings) sampler.Backend {
	switch s.Sampler {
	case "fake":
		return &sampler.Fake{}
	case "none":
		return sampler.None{}
	}
	b, err := startPi(ctx, s)
	if err != nil {
		log.Warn().Err(err).Msg("sampling is off: the Lab's agent will report it unavailable (use --sampler fake to test offline)")
		return sampler.None{}
	}
	log.Info().Int("models", len(b.Models())).Msg("Pi worker ready")
	return b
}

func startPi(ctx context.Context, s *ServeSettings) (*sampler.Client, error) {
	worker, err := toolchain.ExpandPath(s.Worker)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(worker); err != nil {
		return nil, errors.Wrap(err, "Pi worker not built")
	}
	agentDir, err := toolchain.ExpandPath(s.PiAgentDir)
	if err != nil {
		return nil, err
	}
	cwd, err := toolchain.ExpandPath(filepath.Join(s.WorkDir, "worker"))
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(cwd, 0o700); err != nil {
		return nil, err
	}
	return sampler.Start(ctx, s.Node, worker, agentDir, cwd, map[string]string{"quick": s.Quick, "default": s.Default, "complex": s.Complex})
}
