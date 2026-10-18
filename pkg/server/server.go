// Package server assembles the HTTP surface of `weft serve`: the Lab page, the artifact runtime
// (pkg/artifacthost) and the hardware API (pkg/hw), all on one loopback origin.
package server

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/pkg/errors"
	"github.com/rs/zerolog/log"
)

// Server is one listening `weft serve` instance.
type Server struct {
	Listen string
	Mux    *http.ServeMux
}

// New creates a server for a loopback address; the Host header must match it exactly (DNS rebinding guard).
func New(listen string) (*Server, error) {
	host, _, err := net.SplitHostPort(listen)
	if err != nil {
		return nil, errors.Wrapf(err, "parse --listen %q", listen)
	}
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return nil, errors.Errorf("--listen must be a loopback address (got %q): the server can load your FPGA and run model calls", listen)
	}
	return &Server{Listen: listen, Mux: http.NewServeMux()}, nil
}

// Handler wraps the mux with the host/origin guard and no-store caching.
func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != s.Listen {
			fail(w, http.StatusForbidden, "forbidden_host", "open the Lab at http://"+s.Listen+"/")
			return
		}
		if o := r.Header.Get("Origin"); o != "" && o != "http://"+s.Listen {
			fail(w, http.StatusForbidden, "forbidden_origin", "cross-origin requests are not allowed")
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		s.Mux.ServeHTTP(w, r)
	})
}

// Run serves until ctx is cancelled, then shuts down gracefully.
func (s *Server) Run(ctx context.Context) error {
	srv := &http.Server{Addr: s.Listen, Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second}
	ln, err := net.Listen("tcp", s.Listen)
	if err != nil {
		return errors.Wrap(err, "listen")
	}
	log.Info().Str("url", "http://"+s.Listen+"/").Msg("weft serve: Weft Lab is up")
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	select {
	case <-ctx.Done():
		shut, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return srv.Shutdown(shut)
	case err := <-errc:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

// Respond writes v as JSON.
func Respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, code, message string) {
	Respond(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

// Fail writes the francois-style error envelope {"error":{"code","message"}}.
func Fail(w http.ResponseWriter, status int, code, message string) { fail(w, status, code, message) }

// IsAPI reports whether a path belongs to the JSON API.
func IsAPI(path string) bool { return strings.HasPrefix(path, "/api/") }
