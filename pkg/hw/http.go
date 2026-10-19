package hw

import (
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/pkg/errors"
	"github.com/wesen/2026-10-18--weft/pkg/bundle"
	"github.com/wesen/2026-10-18--weft/pkg/hil"
	"github.com/wesen/2026-10-18--weft/pkg/server"
	"github.com/wesen/2026-10-18--weft/pkg/validate"
)

const maxWait = 60 * time.Second

// Register mounts the hardware API (guide §6.12) on mux.
func (m *Manager) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/hw/status", m.handleStatus)
	mux.HandleFunc("POST /api/hw/builds", m.handleCreate)
	mux.HandleFunc("GET /api/hw/builds", m.handleList)
	mux.HandleFunc("GET /api/hw/builds/{id}", m.handleGet)
	mux.HandleFunc("GET /api/hw/builds/{id}/events", m.handleEvents)
	mux.HandleFunc("GET /api/hw/builds/{id}/files/{name...}", m.handleFile)
	mux.HandleFunc("POST /api/hw/builds/{id}/load", m.handleLoad)
	mux.HandleFunc("POST /api/hw/builds/{id}/validate", m.handleValidate)
	m.registerSession(mux)
}

func (m *Manager) handleStatus(w http.ResponseWriter, r *http.Request) {
	server.Respond(w, http.StatusOK, m.Status(r.Context(), r.URL.Query().Get("detect") != "0"))
}

type createRequest struct {
	Bundle      json.RawMessage `json:"bundle"`
	Seed        *int            `json:"seed"`
	Load        bool            `json:"load"`
	Force       bool            `json:"force"`
	ButtonReset string          `json:"buttonReset"`
	HIL         bool            `json:"hil"`
	Validate    []string        `json:"validate"`
	Vectors     json.RawMessage `json:"vectors"`
}

func parseVectors(raw json.RawMessage) (*validate.Vectors, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	return validate.Parse(raw)
}

func (m *Manager) handleCreate(w http.ResponseWriter, r *http.Request) {
	var req createRequest
	if err := readJSON(w, r, &req); err != nil {
		server.Fail(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	vec, err := parseVectors(req.Vectors)
	if err != nil {
		server.Fail(w, http.StatusUnprocessableEntity, "bad_vectors", err.Error())
		return
	}
	if len(req.Bundle) == 0 {
		server.Fail(w, http.StatusBadRequest, "bad_request", "the request has no bundle")
		return
	}
	bn, err := bundle.Parse(req.Bundle)
	if err != nil {
		server.Fail(w, http.StatusUnprocessableEntity, "bad_bundle", err.Error())
		return
	}
	seed := 1
	if req.Seed != nil {
		seed = *req.Seed
	}
	j, err := m.Submit(BuildRequest{Bundle: bn, Seed: seed, Load: req.Load, Force: req.Force, ButtonReset: req.ButtonReset, HIL: req.HIL, Validate: req.Validate, Vectors: vec})
	if err != nil {
		m.failWith(w, err)
		return
	}
	server.Respond(w, http.StatusAccepted, map[string]string{"id": j.ID})
}

type listEntry struct {
	ID        string    `json:"id"`
	Design    string    `json:"design"`
	State     string    `json:"state"`
	CreatedAt time.Time `json:"createdAt"`
	OK        bool      `json:"ok"`
	TimingOK  bool      `json:"timingOk"`
	Loaded    *LoadView `json:"loaded,omitempty"`
}

func (m *Manager) handleList(w http.ResponseWriter, r *http.Request) {
	out := []listEntry{}
	for _, j := range m.Jobs() {
		v := j.View()
		out = append(out, listEntry{ID: v.ID, Design: v.Design, State: v.State, CreatedAt: v.CreatedAt, OK: v.OK, TimingOK: v.TimingOK, Loaded: v.Loaded})
		if len(out) == 100 {
			break
		}
	}
	server.Respond(w, http.StatusOK, out)
}

// buildView is GET /api/hw/builds/{id}: the job plus its files.
type buildView struct {
	JobView
	Files []string `json:"files"`
}

func (m *Manager) handleGet(w http.ResponseWriter, r *http.Request) {
	j := m.job(w, r)
	if j == nil {
		return
	}
	var v JobView
	if s := r.URL.Query().Get("wait"); s != "" {
		d, err := time.ParseDuration(s)
		if err != nil || d < 0 {
			server.Fail(w, http.StatusBadRequest, "bad_request", "wait takes a duration such as 30s")
			return
		}
		v = j.Wait(r.Context(), min(d, maxWait))
	} else {
		v = j.View()
	}
	server.Respond(w, http.StatusOK, buildView{JobView: v, Files: j.Files()})
}

func (m *Manager) handleEvents(w http.ResponseWriter, r *http.Request) {
	j := m.job(w, r)
	if j == nil {
		return
	}
	flush, ok := w.(http.Flusher)
	if !ok {
		server.Fail(w, http.StatusInternalServerError, "unavailable", "streaming unavailable")
		return
	}
	sub, unsubscribe := j.Subscribe()
	defer unsubscribe()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	tick := time.NewTicker(15 * time.Second)
	defer tick.Stop()
	for {
		select {
		case ev := <-sub.ch:
			b, err := json.Marshal(ev)
			if err != nil {
				return
			}
			if _, err := fmt.Fprintf(w, "data: %s\n\n", b); err != nil {
				return
			}
			flush.Flush()
		case <-tick.C:
			if _, err := io.WriteString(w, ": keepalive\n\n"); err != nil {
				return
			}
			flush.Flush()
		case <-sub.closed:
			return
		case <-r.Context().Done():
			return
		case <-m.ctx.Done():
			return
		}
	}
}

func (m *Manager) handleFile(w http.ResponseWriter, r *http.Request) {
	j := m.job(w, r)
	if j == nil {
		return
	}
	name := r.PathValue("name")
	clean := path.Clean("/" + name)[1:]
	if clean == "" || clean != name || strings.HasPrefix(clean, ".") || strings.Contains(clean, "/.") {
		server.Fail(w, http.StatusBadRequest, "bad_request", "invalid file name")
		return
	}
	p := filepath.Join(j.Dir, filepath.FromSlash(clean))
	st, err := os.Stat(p)
	if err != nil || st.IsDir() {
		server.Fail(w, http.StatusNotFound, "not_found", "no file "+name+" in build "+j.ID)
		return
	}
	w.Header().Set("Content-Type", contentType(clean))
	if strings.HasSuffix(clean, ".bit") {
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", j.ID+".bit"))
	}
	http.ServeFile(w, r, p)
}

func contentType(name string) string {
	switch ext := path.Ext(name); ext {
	case ".bit":
		return "application/octet-stream"
	case ".json":
		return "application/json"
	case ".v", ".ccf", ".sdc", ".ys", ".log", ".txt":
		return "text/plain; charset=utf-8"
	default:
		if t := mime.TypeByExtension(ext); t != "" {
			return t
		}
		return "text/plain; charset=utf-8"
	}
}

type loadRequest struct {
	Force bool `json:"force"`
}

func (m *Manager) handleLoad(w http.ResponseWriter, r *http.Request) {
	var req loadRequest
	if r.ContentLength != 0 {
		if err := readJSON(w, r, &req); err != nil {
			server.Fail(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
	}
	j, err := m.Load(r.PathValue("id"), req.Force)
	if err != nil {
		m.failWith(w, err)
		return
	}
	server.Respond(w, http.StatusAccepted, map[string]string{"id": j.ID})
}

type validateRequest struct {
	Levels  []string        `json:"levels"`
	Vectors json.RawMessage `json:"vectors"`
}

func (m *Manager) handleValidate(w http.ResponseWriter, r *http.Request) {
	var req validateRequest
	if err := readJSON(w, r, &req); err != nil {
		server.Fail(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	vec, err := parseVectors(req.Vectors)
	if err != nil {
		server.Fail(w, http.StatusUnprocessableEntity, "bad_vectors", err.Error())
		return
	}
	if len(req.Levels) == 0 {
		server.Fail(w, http.StatusBadRequest, "bad_request", "levels is empty (build, rtl, net, board)")
		return
	}
	j, err := m.Validate(r.PathValue("id"), req.Levels, vec)
	if err != nil {
		m.failWith(w, err)
		return
	}
	server.Respond(w, http.StatusAccepted, map[string]string{"id": j.ID})
}

func (m *Manager) job(w http.ResponseWriter, r *http.Request) *Job {
	id := r.PathValue("id")
	j := m.Job(id)
	if j == nil {
		server.Fail(w, http.StatusNotFound, "not_found", "no build "+id)
	}
	return j
}

// failWith maps the manager's refusals to HTTP statuses and error codes.
func (m *Manager) failWith(w http.ResponseWriter, err error) {
	var refused *Refusal
	switch {
	case errors.Is(err, os.ErrNotExist):
		server.Fail(w, http.StatusNotFound, "not_found", "no such build")
	case errors.Is(err, ErrNoToolchain):
		server.Fail(w, http.StatusServiceUnavailable, "no_toolchain", err.Error())
	case errors.Is(err, ErrBusy):
		server.Fail(w, http.StatusConflict, "busy", err.Error())
	case errors.Is(err, ErrBoardSession):
		server.Fail(w, http.StatusConflict, "board_session", err.Error())
	case errors.Is(err, ErrSessionOpen):
		server.Fail(w, http.StatusConflict, "session_open", err.Error())
	case errors.Is(err, ErrNoSession):
		server.Fail(w, http.StatusNotFound, "no_session", err.Error())
	case errors.Is(err, ErrBoardBusy):
		server.Fail(w, http.StatusConflict, "board_busy", err.Error())
	case errors.Is(err, ErrMode):
		server.Fail(w, http.StatusConflict, "mode", err.Error())
	case errors.Is(err, hil.ErrNotInput):
		server.Fail(w, http.StatusBadRequest, "not_input", err.Error())
	case errors.Is(err, hil.ErrBridge):
		server.Fail(w, http.StatusBadGateway, "board", err.Error())
	case errors.Is(err, ErrNeedsForce):
		server.Fail(w, http.StatusConflict, "needs_force", "this build failed timing; load it with force to try it anyway")
	case errors.Is(err, ErrNoBitstream):
		server.Fail(w, http.StatusConflict, "no_bitstream", err.Error())
	case errors.As(err, &refused):
		server.Fail(w, http.StatusUnprocessableEntity, "refused", err.Error())
	default:
		server.Fail(w, http.StatusInternalServerError, "internal", err.Error())
	}
}

func readJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<20)
	d := json.NewDecoder(r.Body)
	if err := d.Decode(dst); err != nil {
		return err
	}
	var more any
	if d.Decode(&more) != io.EOF {
		return errors.New("expected one JSON value")
	}
	return nil
}
