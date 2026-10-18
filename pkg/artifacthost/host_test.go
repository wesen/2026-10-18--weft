package artifacthost

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/wesen/2026-10-18--weft/pkg/sampler"
)

const page = `<!doctype html><html><head><title>Lab</title></head><body></body></html>`

func newTestHost(t *testing.T, b sampler.Backend) *httptest.Server {
	t.Helper()
	h := New(context.Background(), b, func() ([]byte, error) { return []byte(page), nil })
	mux := http.NewServeMux()
	h.Register(mux)
	ts := httptest.NewServer(mux)
	t.Cleanup(func() { ts.Close(); _ = h.Close() })
	return ts
}

func post(t *testing.T, ts *httptest.Server, path, view string, body any) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", ts.URL+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if view != "" {
		req.Header.Set("X-Francois-View", view)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	out := map[string]any{}
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

// connect opens a view and returns its id and a channel of decoded events (after "ready").
func connect(t *testing.T, ts *httptest.Server) (string, <-chan map[string]any) {
	t.Helper()
	status, out := post(t, ts, "/api/views", "", map[string]any{"version": 1})
	if status != 200 {
		t.Fatalf("open view: %d %v", status, out)
	}
	view := out["viewId"].(string)
	req, _ := http.NewRequest("GET", ts.URL+"/api/views/"+view+"/events", nil)
	req.Header.Set("X-Francois-View", view)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = res.Body.Close() })
	events := make(chan map[string]any, 16)
	scan := bufio.NewScanner(res.Body)
	if !scan.Scan() || scan.Text() != `data: {"type":"ready"}` {
		t.Fatalf("first frame: %q", scan.Text())
	}
	go func() {
		defer close(events)
		for scan.Scan() {
			line := scan.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			e := map[string]any{}
			if json.Unmarshal([]byte(line[6:]), &e) == nil {
				events <- e
			}
		}
	}()
	return view, events
}

func next(t *testing.T, events <-chan map[string]any) map[string]any {
	t.Helper()
	select {
	case e, ok := <-events:
		if !ok {
			t.Fatal("event stream closed")
		}
		return e
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for an event")
	}
	return nil
}

func TestPageInjection(t *testing.T) {
	ts := newTestHost(t, &sampler.Fake{})
	res, err := http.Get(ts.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(res.Body)
	body := buf.String()
	if !strings.HasPrefix(body, `<!doctype html><html><head><script type="application/json" id="francois-view">`) {
		t.Fatalf("boot block not injected after <head>: %s", body)
	}
	for _, want := range []string{`"sample":{}`, `"downloads":{}`, `<script src="/static/runtime.js"></script><title>`} {
		if !strings.Contains(body, want) {
			t.Errorf("page lacks %s", want)
		}
	}
}

func TestSampleWithPageTool(t *testing.T) {
	ts := newTestHost(t, &sampler.Fake{})
	view, events := connect(t, ts)
	status, out := post(t, ts, "/api/views/"+view+"/calls", view, map[string]any{
		"callId": "c1", "input": "hello", "options": map[string]any{"modelTier": "default"},
		"tools": []map[string]any{{"name": "eval", "description": "run code", "inputSchema": map[string]any{"type": "object"}}},
	})
	if status != http.StatusAccepted {
		t.Fatalf("call: %d %v", status, out)
	}
	tool := next(t, events)
	if tool["type"] != "tool" || tool["name"] != "eval" || tool["callId"] != "c1" {
		t.Fatalf("expected the eval tool event, got %v", tool)
	}
	status, out = post(t, ts, "/api/views/"+view+"/calls/c1/tools/"+tool["toolCallId"].(string)+"/result", view, map[string]any{"value": map[string]any{"lines": 12}, "isError": false})
	if status != 200 {
		t.Fatalf("tool result: %d %v", status, out)
	}
	if e := next(t, events); e["type"] != "text" {
		t.Fatalf("expected text, got %v", e)
	}
	result := next(t, events)
	if result["type"] != "result" || !strings.Contains(result["result"].(map[string]any)["text"].(string), `{"lines":12}`) {
		t.Fatalf("expected a result quoting the tool value, got %v", result)
	}
}

func TestSamplingDisabled(t *testing.T) {
	ts := newTestHost(t, sampler.None{})
	view, _ := connect(t, ts)
	status, out := post(t, ts, "/api/views/"+view+"/calls", view, map[string]any{"callId": "c1", "input": "hi", "options": map[string]any{"modelTier": "default"}})
	if status != http.StatusServiceUnavailable || out["error"].(map[string]any)["code"] != "sampling_disabled" {
		t.Fatalf("got %d %v", status, out)
	}
}

func TestViewHeaderRequired(t *testing.T) {
	ts := newTestHost(t, &sampler.Fake{})
	view, _ := connect(t, ts)
	if status, _ := post(t, ts, "/api/views/"+view+"/calls", "", map[string]any{}); status != http.StatusNotFound {
		t.Fatalf("call without X-Francois-View: %d", status)
	}
	if status, _ := post(t, ts, "/api/views", "", map[string]any{"version": 7}); status != http.StatusBadRequest {
		t.Fatalf("stale page version: %d", status)
	}
}
