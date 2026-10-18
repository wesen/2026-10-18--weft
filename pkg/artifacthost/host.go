// Package artifacthost serves one claude.ai-style artifact page (Weft Lab) with the window.claude runtime.
//
// It follows francois's pkg/host (github.com/go-go-golems/francois at commit d847ba4), reduced to a single
// artifact and the two capabilities the Lab uses:
//
//   - sample: window.claude.use("sample") streams model calls through a sampler.Backend; page tools
//     (the Lab agent's eval) run in the browser and post their results back.
//   - downloads: handled entirely by runtime.js (a confirm() and an <a download>); declaring it is enough.
//
// The page is served with a boot block and runtime.js injected right after <head>. runtime.js then opens a
// view (POST /api/views), holds its event stream (GET /api/views/{view}/events) and makes calls with the
// X-Francois-View header.
package artifacthost

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/pkg/errors"
	"github.com/wesen/2026-10-18--weft/pkg/sampler"
	"github.com/wesen/2026-10-18--weft/pkg/server"
	"github.com/wesen/2026-10-18--weft/pkg/web"
	"golang.org/x/net/html"
	"golang.org/x/sync/errgroup"
)

// ArtifactID names the hosted page in the boot block.
const ArtifactID = "weft-lab"

// Page returns the current HTML of the hosted page.
type Page func() ([]byte, error)

// Host owns the views of the hosted page and their model calls.
type Host struct {
	Backend  sampler.Backend
	Page     Page
	Manifest map[string]json.RawMessage
	// Version is the page version the boot block announces; views must open with it.
	Version int64

	ctx    context.Context
	cancel context.CancelFunc
	group  *errgroup.Group
	mu     sync.Mutex
	views  map[string]*View
	active chan struct{} // model calls running at once
	queued chan struct{} // model calls admitted (running or waiting)
}

// View is one open tab of the page.
type View struct {
	ID        string
	ctx       context.Context
	cancel    context.CancelFunc
	mu        sync.Mutex
	connected bool
	events    chan any
	calls     map[string]*call
}

type call struct {
	cancel context.CancelFunc
	tools  map[string]chan sampler.ToolResult
	names  map[string]bool
}

// New creates a host for page. The Lab declares sample and downloads.
func New(ctx context.Context, backend sampler.Backend, page Page) *Host {
	ctx, cancel := context.WithCancel(ctx)
	g, ctx := errgroup.WithContext(ctx)
	return &Host{
		Backend:  backend,
		Page:     page,
		Manifest: map[string]json.RawMessage{"sample": json.RawMessage(`{}`), "downloads": json.RawMessage(`{}`)},
		Version:  1,
		ctx:      ctx, cancel: cancel, group: g,
		views:  map[string]*View{},
		active: make(chan struct{}, 2),
		queued: make(chan struct{}, 10),
	}
}

// Close ends every view and waits for running calls to stop.
func (h *Host) Close() error {
	h.cancel()
	return h.group.Wait()
}

// Broadcast sends an event without a callId to every connected view; runtime.js hands it to subscribers.
func (h *Host) Broadcast(event any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, v := range h.views {
		v.emit(event)
	}
}

// Register mounts the page, runtime.js and the view API on mux.
func (h *Host) Register(m *http.ServeMux) {
	m.HandleFunc("GET /{$}", h.servePage)
	m.HandleFunc("GET /static/runtime.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		_, _ = w.Write(web.Runtime())
	})
	m.HandleFunc("GET /api/models", func(w http.ResponseWriter, r *http.Request) {
		server.Respond(w, http.StatusOK, h.Backend.Models())
	})
	m.HandleFunc("POST /api/views", h.openView)
	m.HandleFunc("GET /api/views/{view}/events", h.events)
	m.HandleFunc("POST /api/views/{view}/calls", h.sample)
	m.HandleFunc("POST /api/views/{view}/calls/{call}/cancel", h.cancelCall)
	m.HandleFunc("POST /api/views/{view}/calls/{call}/tools/{tool}/result", h.toolResult)
	m.HandleFunc("POST /api/views/{view}/rpc", func(w http.ResponseWriter, r *http.Request) {
		if h.view(w, r) == nil {
			return
		}
		// db, room, files, assets, comments... are not declared, so runtime.js never gets that far.
		server.Fail(w, http.StatusForbidden, "not_declared", "Capability not declared")
	})
}

func (h *Host) servePage(w http.ResponseWriter, r *http.Request) {
	source, err := h.Page()
	if err != nil {
		server.Fail(w, http.StatusServiceUnavailable, "no_lab", err.Error())
		return
	}
	// json.Marshal escapes <, > and &, so the boot block cannot close its <script> early.
	boot, err := json.Marshal(map[string]any{
		"artifactId": ArtifactID, "version": h.Version, "manifest": h.Manifest, "owner": nil, "models": h.Backend.Models(),
	})
	if err != nil {
		server.Fail(w, http.StatusInternalServerError, "unavailable", err.Error())
		return
	}
	script := []byte(`<script type="application/json" id="francois-view">` + string(boot) + `</script><script src="/static/runtime.js"></script>`)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(Inject(source, script))
}

// Inject inserts script right after the page's <head> start tag (or before everything when there is none).
func Inject(source, script []byte) []byte {
	tokenizer := html.NewTokenizer(bytes.NewReader(source))
	offset := 0
	for {
		t := tokenizer.Next()
		if t == html.ErrorToken {
			break
		}
		offset += len(tokenizer.Raw())
		if t == html.StartTagToken {
			if tag, _ := tokenizer.TagName(); strings.EqualFold(string(tag), "head") {
				out := append([]byte{}, source[:offset]...)
				out = append(out, script...)
				return append(out, source[offset:]...)
			}
		}
	}
	return append(append([]byte{}, script...), source...)
}

func (h *Host) openView(w http.ResponseWriter, r *http.Request) {
	var loaded struct {
		Version int64 `json:"version"`
	}
	if err := readJSON(w, r, &loaded); err != nil || loaded.Version != h.Version {
		server.Fail(w, http.StatusBadRequest, "invalid_request", "Reload the page: it was served by another weft serve")
		return
	}
	ctx, cancel := context.WithCancel(h.ctx)
	v := &View{ID: newID("v_"), ctx: ctx, cancel: cancel, events: make(chan any, 128), calls: map[string]*call{}}
	h.mu.Lock()
	h.views[v.ID] = v
	h.mu.Unlock()
	// A view that never connects must not remain in memory.
	h.group.Go(func() error {
		timer := time.NewTimer(15 * time.Second)
		defer timer.Stop()
		select {
		case <-timer.C:
			v.mu.Lock()
			up := v.connected
			v.mu.Unlock()
			if !up {
				h.closeView(v)
			}
		case <-v.ctx.Done():
		}
		return nil
	})
	server.Respond(w, http.StatusOK, map[string]any{"viewId": v.ID, "version": h.Version})
}

func (h *Host) events(w http.ResponseWriter, r *http.Request) {
	v := h.view(w, r)
	if v == nil {
		return
	}
	flush, ok := w.(http.Flusher)
	if !ok {
		server.Fail(w, http.StatusInternalServerError, "unavailable", "Streaming unavailable")
		return
	}
	v.mu.Lock()
	if v.connected {
		v.mu.Unlock()
		server.Fail(w, http.StatusConflict, "unavailable", "View already connected")
		return
	}
	v.connected = true
	v.mu.Unlock()
	defer h.closeView(v)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Connection", "keep-alive")
	_, _ = io.WriteString(w, "data: {\"type\":\"ready\"}\n\n")
	flush.Flush()
	tick := time.NewTicker(15 * time.Second)
	defer tick.Stop()
	for {
		select {
		case e := <-v.events:
			b, err := json.Marshal(e)
			if err != nil {
				return
			}
			if _, err = fmt.Fprintf(w, "data: %s\n\n", b); err != nil {
				return
			}
			flush.Flush()
		case <-tick.C:
			if _, err := io.WriteString(w, ": keepalive\n\n"); err != nil {
				return
			}
			flush.Flush()
		case <-r.Context().Done():
			return
		case <-v.ctx.Done():
			return
		}
	}
}

func (h *Host) sample(w http.ResponseWriter, r *http.Request) {
	v := h.view(w, r)
	if v == nil {
		return
	}
	if len(h.Backend.Models()) == 0 {
		server.Fail(w, http.StatusServiceUnavailable, "sampling_disabled", "No model is available: start weft serve with --sampler pi (and a working Pi login) or --sampler fake")
		return
	}
	var req sampler.Request
	if err := readJSON(w, r, &req); err != nil {
		server.Fail(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if len(req.Images) > 0 {
		server.Fail(w, http.StatusBadRequest, "images_unavailable", "Images are not declared")
		return
	}
	if req.CallID == "" || len(req.CallID) > 100 {
		server.Fail(w, http.StatusBadRequest, "invalid_request", "Invalid call id")
		return
	}
	req.MaxRounds = 0
	if err := sampler.ValidateRequest(req); err != nil {
		server.Fail(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	select {
	case h.queued <- struct{}{}:
	default:
		server.Fail(w, http.StatusTooManyRequests, "rate_limited", "The model request queue is full")
		return
	}
	ctx, cancel := context.WithTimeout(v.ctx, 5*time.Minute)
	c := &call{cancel: cancel, tools: map[string]chan sampler.ToolResult{}, names: map[string]bool{}}
	for _, t := range req.Tools {
		c.names[t.Name] = true
	}
	v.mu.Lock()
	if !v.connected || v.calls[req.CallID] != nil {
		v.mu.Unlock()
		cancel()
		<-h.queued
		server.Fail(w, http.StatusConflict, "invalid_request", "View disconnected or call id already active")
		return
	}
	v.calls[req.CallID] = c
	v.mu.Unlock()
	h.group.Go(func() error {
		defer func() { cancel(); <-h.queued; v.mu.Lock(); delete(v.calls, req.CallID); v.mu.Unlock() }()
		h.run(ctx, v, c, req)
		return nil
	})
	server.Respond(w, http.StatusAccepted, map[string]string{"callId": req.CallID})
}

// run drives one admitted call to exactly one terminal event (result or error).
func (h *Host) run(ctx context.Context, v *View, c *call, req sampler.Request) {
	select {
	case h.active <- struct{}{}:
		defer func() { <-h.active }()
	case <-ctx.Done():
		v.emit(sampler.Event{Type: "error", CallID: req.CallID, Error: &sampler.Failure{Code: "cancelled", Message: "Stopped while queued"}})
		return
	}
	settled := false
	emit := func(e sampler.Event) {
		if settled || e.Type == "usage" {
			return
		}
		if e.Type == "result" || e.Type == "error" {
			settled = true
		}
		v.emit(e)
	}
	execute := func(ctx context.Context, event sampler.Event) (sampler.ToolResult, error) {
		if !c.names[event.Name] {
			return sampler.ToolResult{}, errors.New("Unknown page tool")
		}
		child, stop := context.WithTimeout(ctx, 150*time.Second)
		defer stop()
		ch := make(chan sampler.ToolResult, 1)
		v.mu.Lock()
		if c.tools[event.ToolCallID] != nil {
			v.mu.Unlock()
			return sampler.ToolResult{}, errors.New("Duplicate tool call")
		}
		c.tools[event.ToolCallID] = ch
		v.mu.Unlock()
		defer func() { v.mu.Lock(); delete(c.tools, event.ToolCallID); v.mu.Unlock() }()
		v.emit(event)
		select {
		case result := <-ch:
			return result, nil
		case <-child.Done():
			return sampler.ToolResult{}, child.Err()
		}
	}
	err := h.Backend.Sample(ctx, req, emit, execute)
	if !settled {
		code, message := "upstream_error", "Model request failed"
		if ctx.Err() != nil {
			code = "cancelled"
		}
		var f *sampler.Failure
		if errors.As(err, &f) {
			code, message = f.Code, f.Message
		} else if err != nil {
			message = err.Error()
		}
		emit(sampler.Event{Type: "error", CallID: req.CallID, Error: &sampler.Failure{Code: code, Message: message}})
	}
}

func (h *Host) cancelCall(w http.ResponseWriter, r *http.Request) {
	v := h.view(w, r)
	if v == nil {
		return
	}
	v.mu.Lock()
	if c := v.calls[r.PathValue("call")]; c != nil {
		c.cancel()
	}
	v.mu.Unlock()
	server.Respond(w, http.StatusOK, map[string]bool{"cancelled": true})
}

func (h *Host) toolResult(w http.ResponseWriter, r *http.Request) {
	v := h.view(w, r)
	if v == nil {
		return
	}
	var result sampler.ToolResult
	if err := readJSON(w, r, &result); err != nil || len(result.Value) > 32768 {
		server.Fail(w, http.StatusBadRequest, "invalid_request", "Invalid tool result")
		return
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	c := v.calls[r.PathValue("call")]
	if c == nil {
		server.Fail(w, http.StatusNotFound, "cancelled", "Call has ended")
		return
	}
	ch := c.tools[r.PathValue("tool")]
	if ch == nil {
		server.Fail(w, http.StatusNotFound, "invalid_request", "Unknown tool call")
		return
	}
	select {
	case ch <- result:
		server.Respond(w, http.StatusOK, map[string]bool{"accepted": true})
	default:
		server.Fail(w, http.StatusConflict, "invalid_request", "Tool result already received")
	}
}

func (h *Host) view(w http.ResponseWriter, r *http.Request) *View {
	h.mu.Lock()
	v := h.views[r.PathValue("view")]
	h.mu.Unlock()
	if v == nil || r.Header.Get("X-Francois-View") != v.ID {
		server.Fail(w, http.StatusNotFound, "unavailable", "View not found")
		return nil
	}
	return v
}

func (h *Host) closeView(v *View) {
	v.cancel()
	v.mu.Lock()
	v.connected = false
	for _, c := range v.calls {
		c.cancel()
	}
	v.mu.Unlock()
	h.mu.Lock()
	delete(h.views, v.ID)
	h.mu.Unlock()
}

// emit queues an event; a view that cannot keep up is closed rather than blocking its producers.
func (v *View) emit(event any) bool {
	select {
	case v.events <- event:
		return true
	case <-v.ctx.Done():
		return false
	default:
		v.cancel()
		return false
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

func newID(prefix string) string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return prefix + hex.EncodeToString(b)
}
