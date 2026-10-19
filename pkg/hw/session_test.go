package hw

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wesen/2026-10-18--weft/pkg/hil/hiltest"
)

// A HIL build of F-05 (btn:0 physical, btn:1..3 and sw:0 virtual, led:0..7) against the fake bridge: the
// session loads the build, resets the design, drives the physical button through its override and sees the
// LED follow, stamped in board cycles; loads wait for the session to close.
func TestBoardSessionHIL(t *testing.T) {
	f := newFixture(t, fakeSuite(t, "nextpnr-pass-pll.log", 0))
	f.m.opt.Serial = "/dev/fake-acm0"
	var bridge *hiltest.Bridge
	openPort = func(dev string, baud int) (io.ReadWriteCloser, error) { return bridge, nil }
	t.Cleanup(func() { openPort = defaultOpenPort })

	f05, err := os.ReadFile(filepath.Join("..", "board", "testdata", "F-05-buttons.bundle.json"))
	if err != nil {
		t.Fatal(err)
	}
	id := f.build(t, map[string]any{"bundle": json.RawMessage(f05), "hil": true})
	v := f.wait(t, id)
	rep := v["report"].(map[string]any)
	if rep["hil"] == nil {
		t.Fatalf("the report of a hil build has no hil map: %v", rep)
	}
	j := f.m.Job(id)
	m := j.View().Report.HIL
	// led:0 follows btn:0 (index 1 of the HIL inputs) once the host overrides it
	bridge = hiltest.New(m, func(c uint64, in []int) []int { out := make([]int, 8); out[0] = in[1]; return out })

	code, out := f.do(t, "POST", "/api/hw/board/session", map[string]any{"build": id})
	if code != http.StatusOK || out["mode"] != ModeHIL {
		t.Fatalf("open = %d %v", code, out)
	}
	if ins := out["inputs"].([]any); len(ins) != 5 || ins[1].(map[string]any)["resource"] != "btn:0" || ins[1].(map[string]any)["physical"] != true {
		t.Errorf("inputs = %v", ins)
	}
	st := out["state"].(map[string]any)
	epoch := int(st["epoch"].(float64))

	if code, out := f.do(t, "POST", "/api/hw/board/session", map[string]any{"build": id}); code != http.StatusConflict || errCode(out) != "session_open" {
		t.Errorf("second open = %d %v", code, out)
	}
	if code, out := f.do(t, "POST", "/api/hw/builds/"+id+"/load", nil); code != http.StatusConflict || errCode(out) != "board_session" {
		t.Errorf("load during the session = %d %v", code, out)
	}

	// events: the session view first, then pins
	req, _ := http.NewRequest("GET", f.srv.URL+"/api/hw/board/session/events", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	events := make(chan map[string]any, 64)
	go func() {
		sc := bufio.NewScanner(res.Body)
		for sc.Scan() {
			if line, ok := strings.CutPrefix(sc.Text(), "data: "); ok {
				var ev map[string]any
				_ = json.Unmarshal([]byte(line), &ev)
				events <- ev
			}
		}
		close(events)
	}()
	if ev := <-events; ev["type"] != "session" {
		t.Fatalf("first event %v", ev)
	}

	code, out = f.do(t, "POST", "/api/hw/board/session/inputs", map[string]any{"set": map[string]any{"btn:0": 1}})
	if code != http.StatusOK {
		t.Fatalf("inputs = %d %v", code, out)
	}
	at := uint64(out["cycle"].(float64))
	code, out = f.do(t, "POST", "/api/hw/board/session/wait", map[string]any{"cycle": at + 1000, "epoch": epoch, "since": 0})
	if code != http.StatusOK || out["reached"] != true {
		t.Fatalf("wait = %d %v", code, out)
	}
	ch := out["changes"].([]any)
	last := ch[len(ch)-1].(map[string]any)
	if len(ch) != 2 || last["outs"].(map[string]any)["led:0"] != 1.0 || uint64(last["cycle"].(float64)) > at {
		t.Errorf("changes after btn:0 = 1 at %d: %v", at, ch)
	}
	deadline := time.After(5 * time.Second)
	for got := false; !got; {
		select {
		case ev := <-events:
			got = ev["type"] == "pins" && ev["outs"].(map[string]any)["led:0"] == 1.0
		case <-deadline:
			t.Fatal("no pins event for led:0")
		}
	}

	if code, out := f.do(t, "POST", "/api/hw/board/session/inputs", map[string]any{"set": map[string]any{"led:0": 1}}); code != http.StatusBadRequest || errCode(out) != "not_input" {
		t.Errorf("setting an output = %d %v", code, out)
	}
	if code, out := f.do(t, "POST", "/api/hw/board/session/uart", map[string]any{"text": "hi"}); code != http.StatusConflict || errCode(out) != "mode" {
		t.Errorf("uart in a HIL session = %d %v", code, out)
	}
	code, out = f.do(t, "POST", "/api/hw/board/session/reset", nil)
	if code != http.StatusOK || out["epoch"].(float64) != float64(epoch+1) || out["outs"].(map[string]any)["led:0"] != 0.0 {
		t.Errorf("reset = %d %v", code, out)
	}

	if code, out := f.do(t, "DELETE", "/api/hw/board/session", nil); code != http.StatusOK {
		t.Fatalf("close = %d %v", code, out)
	}
	if code, out := f.do(t, "DELETE", "/api/hw/board/session", nil); code != http.StatusNotFound || errCode(out) != "no_session" {
		t.Errorf("second close = %d %v", code, out)
	}
	if code, out := f.do(t, "POST", "/api/hw/builds/"+id+"/load", nil); code != http.StatusAccepted {
		t.Errorf("load after the session = %d %v", code, out)
	}
}
