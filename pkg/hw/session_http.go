package hw

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/wesen/2026-10-18--weft/pkg/server"
)

// registerSession mounts the board session API (guide §6.12).
func (m *Manager) registerSession(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/hw/board/session", m.handleSessionOpen)
	mux.HandleFunc("GET /api/hw/board/session", m.handleSessionGet)
	mux.HandleFunc("DELETE /api/hw/board/session", m.handleSessionClose)
	mux.HandleFunc("GET /api/hw/board/session/events", m.handleSessionEvents)
	mux.HandleFunc("POST /api/hw/board/session/reset", m.handleSessionReset)
	mux.HandleFunc("POST /api/hw/board/session/inputs", m.handleSessionInputs)
	mux.HandleFunc("POST /api/hw/board/session/wait", m.handleSessionWait)
	mux.HandleFunc("POST /api/hw/board/session/uart", m.handleSessionUARTSend)
	mux.HandleFunc("GET /api/hw/board/session/uart", m.handleSessionUARTRead)
}

// sessionOrFail returns the open session, or answers 404.
func (m *Manager) sessionOrFail(w http.ResponseWriter) *Session {
	s := m.Session()
	if s == nil {
		server.Fail(w, http.StatusNotFound, "no_session", ErrNoSession.Error())
	}
	return s
}

type sessionOpenRequest struct {
	Build string `json:"build"`
	Force bool   `json:"force"`
}

func (m *Manager) handleSessionOpen(w http.ResponseWriter, r *http.Request) {
	var req sessionOpenRequest
	if err := readJSON(w, r, &req); err != nil || req.Build == "" {
		server.Fail(w, http.StatusBadRequest, "bad_request", "the body is {build, force?}")
		return
	}
	// the load outlives a client that gives up; the server's context bounds it
	ctx, cancel := context.WithTimeout(m.ctx, 2*time.Minute)
	defer cancel()
	s, err := m.OpenSession(ctx, req.Build, req.Force)
	if err != nil {
		m.failWith(w, err)
		return
	}
	server.Respond(w, http.StatusOK, s.View())
}

// handleSessionGet answers null when no session is open (a page asks on every load; that is not an error).
func (m *Manager) handleSessionGet(w http.ResponseWriter, r *http.Request) {
	if s := m.Session(); s != nil {
		server.Respond(w, http.StatusOK, s.View())
		return
	}
	server.Respond(w, http.StatusOK, nil)
}

func (m *Manager) handleSessionClose(w http.ResponseWriter, r *http.Request) {
	if err := m.CloseSession(); err != nil {
		m.failWith(w, err)
		return
	}
	server.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (m *Manager) handleSessionEvents(w http.ResponseWriter, r *http.Request) {
	s := m.sessionOrFail(w)
	if s == nil {
		return
	}
	flush, ok := w.(http.Flusher)
	if !ok {
		server.Fail(w, http.StatusInternalServerError, "unavailable", "streaming unavailable")
		return
	}
	ch, unsubscribe := s.Subscribe()
	defer unsubscribe()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	send := func(v any) bool {
		b, err := json.Marshal(v)
		if err != nil {
			return false
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", b); err != nil {
			return false
		}
		flush.Flush()
		return true
	}
	if !send(map[string]any{"type": "session", "session": s.View()}) {
		return
	}
	tick := time.NewTicker(15 * time.Second)
	defer tick.Stop()
	for {
		select {
		case ev, open := <-ch:
			if !open || !send(ev) || ev.Type == "closed" {
				return
			}
		case <-tick.C:
			if _, err := io.WriteString(w, ": keepalive\n\n"); err != nil {
				return
			}
			flush.Flush()
		case <-r.Context().Done():
			return
		case <-m.ctx.Done():
			return
		}
	}
}

func (m *Manager) handleSessionReset(w http.ResponseWriter, r *http.Request) {
	s := m.sessionOrFail(w)
	if s == nil {
		return
	}
	snap, err := s.Reset(r.Context())
	if err != nil {
		m.failWith(w, err)
		return
	}
	server.Respond(w, http.StatusOK, snap)
}

type inputsRequest struct {
	Set map[string]*int `json:"set"`
}

func (m *Manager) handleSessionInputs(w http.ResponseWriter, r *http.Request) {
	s := m.sessionOrFail(w)
	if s == nil {
		return
	}
	var req inputsRequest
	if err := readJSON(w, r, &req); err != nil || len(req.Set) == 0 {
		server.Fail(w, http.StatusBadRequest, "bad_request", `the body is {set: {"btn:1": 1, "btn:0": null}}`)
		return
	}
	cycle, err := s.SetInputs(r.Context(), req.Set)
	if err != nil {
		m.failWith(w, err)
		return
	}
	server.Respond(w, http.StatusOK, map[string]any{"ok": true, "cycle": cycle})
}

type waitRequest struct {
	Cycle   uint64 `json:"cycle"`
	Epoch   int    `json:"epoch"`
	Since   int    `json:"since"`
	Timeout string `json:"timeout"`
}

func (m *Manager) handleSessionWait(w http.ResponseWriter, r *http.Request) {
	s := m.sessionOrFail(w)
	if s == nil {
		return
	}
	var req waitRequest
	if err := readJSON(w, r, &req); err != nil {
		server.Fail(w, http.StatusBadRequest, "bad_request", "the body is {cycle, epoch, since, timeout?}")
		return
	}
	d := maxWait / 2
	if req.Timeout != "" {
		v, err := time.ParseDuration(req.Timeout)
		if err != nil || v < 0 {
			server.Fail(w, http.StatusBadRequest, "bad_request", "timeout takes a duration such as 10s")
			return
		}
		d = min(v, maxWait)
	}
	res, err := s.Wait(r.Context(), req.Cycle, req.Epoch, req.Since, d)
	if err != nil {
		m.failWith(w, err)
		return
	}
	server.Respond(w, http.StatusOK, res)
}

type uartRequest struct {
	Text string `json:"text"`
}

func (m *Manager) handleSessionUARTSend(w http.ResponseWriter, r *http.Request) {
	s := m.sessionOrFail(w)
	if s == nil {
		return
	}
	var req uartRequest
	if err := readJSON(w, r, &req); err != nil {
		server.Fail(w, http.StatusBadRequest, "bad_request", "the body is {text}")
		return
	}
	if err := s.SendUART(req.Text); err != nil {
		m.failWith(w, err)
		return
	}
	server.Respond(w, http.StatusOK, map[string]any{"ok": true, "bytes": len(req.Text)})
}

func (m *Manager) handleSessionUARTRead(w http.ResponseWriter, r *http.Request) {
	s := m.sessionOrFail(w)
	if s == nil {
		return
	}
	q := r.URL.Query()
	since, _ := strconv.Atoi(q.Get("since"))
	var d time.Duration
	if v := q.Get("wait"); v != "" {
		var err error
		if d, err = time.ParseDuration(v); err != nil || d < 0 {
			server.Fail(w, http.StatusBadRequest, "bad_request", "wait takes a duration such as 50ms")
			return
		}
		d = min(d, maxWait)
	}
	text, cursor, err := s.UARTText(r.Context(), since, d)
	if err != nil {
		m.failWith(w, err)
		return
	}
	server.Respond(w, http.StatusOK, map[string]any{"text": text, "cursor": cursor})
}
