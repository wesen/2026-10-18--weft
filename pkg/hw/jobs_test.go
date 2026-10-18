package hw

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wesen/2026-10-18--weft/pkg/toolchain"
)

// fakeSuite is an OSS CAD Suite whose tools replay real logs: yosys prints a stat block, nextpnr prints
// pnrLog (after sleeping pnrDelay), gmpack copies, openFPGALoader reports Done.
func fakeSuite(t *testing.T, pnrLog string, pnrDelay time.Duration) *toolchain.Suite {
	t.Helper()
	root := t.TempDir()
	bin := filepath.Join(root, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	fixture := func(name string) string {
		p, err := filepath.Abs(filepath.Join("..", "toolchain", "testdata", name))
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	scripts := map[string]string{
		"yosys":              fmt.Sprintf("cat %q\necho '{}' > top.json\n", fixture("yosys-stat.log")),
		"nextpnr-himbaechel": fmt.Sprintf("sleep %.2f\ncat %q\necho config > top.txt\n", pnrDelay.Seconds(), fixture(pnrLog)),
		"gmpack":             "cp \"$1\" \"$2\"\n",
		"openFPGALoader":     "echo 'Load SRAM via JTAG: [==========] 100.00% Done'\n",
	}
	for name, body := range scripts {
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\n"+body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	s, err := toolchain.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

type fixture struct {
	m   *Manager
	srv *httptest.Server
	dir string
}

func newFixture(t *testing.T, suite *toolchain.Suite) *fixture {
	t.Helper()
	dir := t.TempDir()
	m := NewManager(context.Background(), suite, nil, Options{WorkDir: dir, MaxBuilds: 2})
	mux := http.NewServeMux()
	m.Register(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(func() { srv.Close(); _ = m.Close() })
	return &fixture{m: m, srv: srv, dir: dir}
}

func bundleJSON(t *testing.T, mutate func(map[string]any)) json.RawMessage {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "board", "testdata", "F-01-blinky.bundle.json"))
	if err != nil {
		t.Fatal(err)
	}
	if mutate == nil {
		return data
	}
	var v map[string]any
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	mutate(v)
	out, _ := json.Marshal(v)
	return out
}

func (f *fixture) do(t *testing.T, method, path string, body any) (int, map[string]any) {
	t.Helper()
	var rd *strings.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = strings.NewReader(string(b))
	} else {
		rd = strings.NewReader("")
	}
	req, _ := http.NewRequest(method, f.srv.URL+path, rd)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func (f *fixture) build(t *testing.T, body map[string]any) string {
	t.Helper()
	code, out := f.do(t, "POST", "/api/hw/builds", body)
	if code != http.StatusAccepted {
		t.Fatalf("POST /api/hw/builds = %d %v", code, out)
	}
	return out["id"].(string)
}

func (f *fixture) wait(t *testing.T, id string) map[string]any {
	t.Helper()
	code, out := f.do(t, "GET", "/api/hw/builds/"+id+"?wait=20s", nil)
	if code != http.StatusOK {
		t.Fatalf("GET build = %d %v", code, out)
	}
	if st := out["state"]; st != StateDone && st != StateFailed {
		t.Fatalf("build still %v after waiting", st)
	}
	return out
}

func stageStates(v map[string]any) string {
	var parts []string
	for _, s := range v["stages"].([]any) {
		st := s.(map[string]any)
		parts = append(parts, fmt.Sprintf("%s:%s", st["name"], st["state"]))
	}
	return strings.Join(parts, " ")
}

func TestBuildAndLoad(t *testing.T) {
	f := newFixture(t, fakeSuite(t, "nextpnr-pass-pll.log", 0))
	id := f.build(t, map[string]any{"bundle": bundleJSON(t, nil), "load": true})
	v := f.wait(t, id)
	if v["state"] != StateDone || v["ok"] != true || v["timingOk"] != true {
		t.Fatalf("state %v ok %v timingOk %v error %v", v["state"], v["ok"], v["timingOk"], v["error"])
	}
	if got := stageStates(v); got != "synth:done pnr:done pack:done load:done" {
		t.Errorf("stages = %s", got)
	}
	if l, _ := v["loaded"].(map[string]any); l == nil || l["ok"] != true {
		t.Errorf("loaded = %v", v["loaded"])
	}
	// summaries come from the report and the load result, not the tools' "done" events
	summaries := map[string]string{}
	for _, st := range v["stages"].([]any) {
		m := st.(map[string]any)
		summaries[m["name"].(string)], _ = m["summary"].(string)
	}
	if !strings.Contains(summaries["pnr"], "CPE_LT") || !strings.Contains(summaries["pack"], "bytes") || summaries["load"] != "loaded into SRAM" {
		t.Errorf("stage summaries = %v", summaries)
	}
	if v["estimate"] == nil {
		t.Error("the bundle's estimate is missing from the build")
	}
	files := fmt.Sprint(v["files"])
	for _, want := range []string{"top.bit", "pnr.log", "report.json", "job.json", "board/board.ccf", "rtl/"} {
		if !strings.Contains(files, want) {
			t.Errorf("files %s lack %s", files, want)
		}
	}

	res, err := http.Get(f.srv.URL + "/api/hw/builds/" + id + "/files/board/board.ccf")
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != 200 || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/plain") {
		t.Errorf("board.ccf: %d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}
	for _, bad := range []string{"nope.v", ".hidden", "rtl//x.v"} {
		if code, _ := f.do(t, "GET", "/api/hw/builds/"+id+"/files/"+bad, nil); code == 200 {
			t.Errorf("files/%s served", bad)
		}
	}

	code, list := f.doList(t)
	if code != 200 || len(list) != 1 || list[0]["id"] != id {
		t.Errorf("list = %d %v", code, list)
	}
}

func (f *fixture) doList(t *testing.T) (int, []map[string]any) {
	t.Helper()
	res, err := http.Get(f.srv.URL + "/api/hw/builds")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	var out []map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func TestEventsStream(t *testing.T) {
	f := newFixture(t, fakeSuite(t, "nextpnr-pass-pll.log", 300*time.Millisecond))
	id := f.build(t, map[string]any{"bundle": bundleJSON(t, nil)})
	res, err := http.Get(f.srv.URL + "/api/hw/builds/" + id + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	if ct := res.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content type %q", ct)
	}
	sc := bufio.NewScanner(res.Body)
	var types []string
	sawTiming := false
	deadline := time.AfterFunc(20*time.Second, func() { _ = res.Body.Close() })
	defer deadline.Stop()
	for sc.Scan() {
		line, ok := strings.CutPrefix(sc.Text(), "data: ")
		if !ok {
			continue
		}
		var ev Event
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatal(err)
		}
		types = append(types, ev.Type)
		if ev.Type == "log" && strings.Contains(ev.Line, "Max frequency") {
			sawTiming = true
		}
		if ev.Type == "done" {
			if ev.OK == nil || !*ev.OK {
				t.Errorf("done not ok: %+v", ev)
			}
			break
		}
	}
	if len(types) == 0 || types[0] != "snapshot" {
		t.Fatalf("stream must start with a snapshot: %v", types)
	}
	joined := strings.Join(types, " ")
	for _, want := range []string{"stage", "report", "done"} {
		if !strings.Contains(joined, want) {
			t.Errorf("stream lacks %s events: %s", want, joined)
		}
	}
	if !sawTiming {
		t.Error("nextpnr's timing lines did not reach the stream")
	}
}

func TestTimingFailureNeedsForce(t *testing.T) {
	f := newFixture(t, fakeSuite(t, "nextpnr-timing-fail-allowed.log", 0))
	id := f.build(t, map[string]any{"bundle": bundleJSON(t, nil), "load": true})
	v := f.wait(t, id)
	if v["ok"] != true || v["timingOk"] != false {
		t.Fatalf("ok %v timingOk %v", v["ok"], v["timingOk"])
	}
	if got := stageStates(v); got != "synth:done pnr:done pack:done load:skipped" {
		t.Errorf("stages = %s", got)
	}
	code, out := f.do(t, "POST", "/api/hw/builds/"+id+"/load", nil)
	if code != http.StatusConflict || errCode(out) != "needs_force" {
		t.Fatalf("load without force = %d %v", code, out)
	}
	f.m.SetSession(true)
	if code, out := f.do(t, "POST", "/api/hw/builds/"+id+"/load", map[string]any{"force": true}); code != http.StatusConflict || errCode(out) != "board_session" {
		t.Fatalf("load during a session = %d %v", code, out)
	}
	f.m.SetSession(false)
	if code, out := f.do(t, "POST", "/api/hw/builds/"+id+"/load", map[string]any{"force": true}); code != http.StatusAccepted {
		t.Fatalf("load with force = %d %v", code, out)
	}
	v = f.wait(t, id)
	if l, _ := v["loaded"].(map[string]any); l == nil || l["ok"] != true {
		t.Errorf("loaded = %v", v["loaded"])
	}
}

func TestRefusalsAndBusy(t *testing.T) {
	f := newFixture(t, fakeSuite(t, "nextpnr-pass-pll.log", 500*time.Millisecond))
	hdmi := bundleJSON(t, func(v map[string]any) {
		v["ports"].([]any)[0].(map[string]any)["bits"].([]any)[0].(map[string]any)["resource"] = "hdmi"
	})
	if code, out := f.do(t, "POST", "/api/hw/builds", map[string]any{"bundle": hdmi}); code != http.StatusUnprocessableEntity || errCode(out) != "refused" {
		t.Errorf("unknown resource = %d %v", code, out)
	}
	if code, out := f.do(t, "POST", "/api/hw/builds", map[string]any{"bundle": map[string]any{"schema": "nope"}}); code != http.StatusUnprocessableEntity || errCode(out) != "bad_bundle" {
		t.Errorf("bad bundle = %d %v", code, out)
	}
	if code, _ := f.do(t, "POST", "/api/hw/builds", map[string]any{"bundle": bundleJSON(t, nil), "hil": true}); code != http.StatusNotImplemented {
		t.Errorf("hil = %d", code)
	}
	id := f.build(t, map[string]any{"bundle": bundleJSON(t, nil)})
	if code, out := f.do(t, "POST", "/api/hw/builds/"+id+"/load", nil); code != http.StatusConflict || errCode(out) != "busy" {
		t.Errorf("load while building = %d %v", code, out)
	}
	if code, _ := f.do(t, "GET", "/api/hw/builds/nope", nil); code != http.StatusNotFound {
		t.Errorf("unknown build = %d", code)
	}
	f.wait(t, id)
}

func TestRestartListsBuilds(t *testing.T) {
	suite := fakeSuite(t, "nextpnr-pass-pll.log", 0)
	f := newFixture(t, suite)
	id := f.build(t, map[string]any{"bundle": bundleJSON(t, nil), "load": true})
	f.wait(t, id)
	m2 := NewManager(context.Background(), suite, nil, Options{WorkDir: f.dir})
	defer func() { _ = m2.Close() }()
	j := m2.Job(id)
	if j == nil {
		t.Fatalf("build %s not listed after a restart", id)
	}
	v := j.View()
	if v.State != StateDone || !v.OK || v.Loaded == nil || !v.Loaded.OK || len(v.Estimate) == 0 || len(v.Stages) != 4 {
		t.Errorf("restored view = %+v", v)
	}
}

func errCode(out map[string]any) string {
	e, _ := out["error"].(map[string]any)
	s, _ := e["code"].(string)
	return s
}
