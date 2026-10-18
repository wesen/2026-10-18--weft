package cmds

import (
	"context"
	"net/http"

	"github.com/go-go-golems/glazed/pkg/cmds"
	"github.com/go-go-golems/glazed/pkg/cmds/fields"
	"github.com/go-go-golems/glazed/pkg/cmds/schema"
	"github.com/go-go-golems/glazed/pkg/cmds/values"
	"github.com/wesen/2026-10-18--weft/pkg/server"
	"github.com/wesen/2026-10-18--weft/pkg/web"
)

// ServeSettings are the flags of `weft serve`.
type ServeSettings struct {
	Listen  string `glazed:"listen"`
	LabFile string `glazed:"lab-file"`
	Suite   string `glazed:"oss-cad-suite"`
	Serial  string `glazed:"serial"`
	WorkDir string `glazed:"work-dir"`
}

// ServeCommand hosts the Lab page, the artifact runtime and the hardware API.
type ServeCommand struct{ *cmds.CommandDescription }

var _ cmds.BareCommand = (*ServeCommand)(nil)

// NewServeCommand describes `weft serve`.
func NewServeCommand() *ServeCommand {
	return &ServeCommand{cmds.NewCommandDescription("serve",
		cmds.WithShort("Serve Weft Lab with the artifact runtime and the GateMate hardware API"),
		cmds.WithLong(`Serve Weft Lab on one loopback origin.

The page keeps saved designs in localStorage, which belongs to the origin: keep the same --listen
address between runs to keep them.`),
		cmds.WithFlags(
			fields.New("listen", fields.TypeString, fields.WithDefault("127.0.0.1:8088"), fields.WithHelp("Loopback address; the Host header must match it")),
			fields.New("lab-file", fields.TypeString, fields.WithHelp("Serve this Lab page from disk instead of the embedded copy (e.g. weft-lab/app/dist/index.html)")),
			fields.New("work-dir", fields.TypeString, fields.WithDefault("var/weft"), fields.WithHelp("Builds, logs and bitstreams")),
			suiteFlag(),
			serialFlag(),
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
	srv.Mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		page, err := web.Lab(s.LabFile)
		if err != nil {
			server.Fail(w, http.StatusServiceUnavailable, "no_lab", err.Error())
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(page)
	})
	srv.Mux.HandleFunc("GET /static/runtime.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		_, _ = w.Write(web.Runtime())
	})
	srv.Mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		server.Respond(w, http.StatusOK, map[string]bool{"ok": true})
	})
	return srv.Run(ctx)
}
