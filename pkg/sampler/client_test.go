package sampler

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"testing"
	"time"
)

var helperWorker = flag.Bool("worker-helper", false, "run the private protocol test worker")

func TestMain(m *testing.M) {
	flag.Parse()
	if *helperWorker {
		runHelperWorker()
		os.Exit(0)
	}
	os.Exit(m.Run())
}
func runHelperWorker() {
	scan := bufio.NewScanner(os.Stdin)
	for scan.Scan() {
		var frame map[string]json.RawMessage
		if json.Unmarshal(scan.Bytes(), &frame) != nil {
			return
		}
		var kind, callID string
		_ = json.Unmarshal(frame["type"], &kind)
		_ = json.Unmarshal(frame["callId"], &callID)
		switch kind {
		case "init":
			_ = json.NewEncoder(os.Stdout).Encode(Event{Type: "ready", Models: []Model{{Provider: "test", ID: "protocol"}}})
		case "cancel":
			time.Sleep(80 * time.Millisecond)
			_ = json.NewEncoder(os.Stdout).Encode(Event{Type: "ended", CallID: callID})
		case "sample":
			var input string
			_ = json.Unmarshal(frame["input"], &input)
			if input == "invalid-frame" {
				_, _ = fmt.Fprintln(os.Stdout, "this is not JSON")
				continue
			}
			if input == "thinking" {
				_ = json.NewEncoder(os.Stdout).Encode(Event{Type: "thinking", CallID: callID, Text: "Inspecting the scene.", Delta: "Inspecting the scene."})
				_ = json.NewEncoder(os.Stdout).Encode(Event{Type: "result", CallID: callID, Result: &Result{Text: "done", Thinking: "Inspecting the scene."}})
				_ = json.NewEncoder(os.Stdout).Encode(Event{Type: "ended", CallID: callID})
				continue
			}
			if input == "wait" {
				continue
			}
			_ = json.NewEncoder(os.Stdout).Encode(Event{Type: "text", CallID: callID, Text: "before tool", Delta: "before tool"})
			_ = json.NewEncoder(os.Stdout).Encode(Event{Type: "tool", CallID: callID, ToolCallID: "one", Name: "lookup", Input: json.RawMessage(`{"value":7}`)})
		case "tool_result":
			var result map[string]any
			if json.Unmarshal(frame["value"], &result) != nil {
				return
			}
			text := "wrong tool result"
			if result["echo"] == float64(7) {
				text = "tool accepted"
			}
			_ = json.NewEncoder(os.Stdout).Encode(Event{Type: "result", CallID: callID, Result: &Result{Text: text, ModelTierApplied: "quick"}})
			_ = json.NewEncoder(os.Stdout).Encode(Event{Type: "ended", CallID: callID})
		}
	}
}
func testClient(t *testing.T) *Client {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	client, err := Start(ctx, exe, "-worker-helper", t.TempDir(), t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}
func TestClientToolsCancellationAndWorkerExit(t *testing.T) {
	t.Run("tool round", func(t *testing.T) {
		c := testClient(t)
		seen := []string{}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		err := c.Sample(ctx, Request{CallID: "call", Input: json.RawMessage(`"tool"`)}, func(e Event) {
			seen = append(seen, e.Type)
			if e.Type == "result" && e.Result.Text != "tool accepted" {
				t.Error("result not returned to worker")
			}
		}, func(ctx context.Context, e Event) (ToolResult, error) {
			if e.ToolCallID != "one" || e.Name != "lookup" {
				t.Fatal("wrong tool")
			}
			return ToolResult{Value: json.RawMessage(`{"echo":7}`)}, nil
		})
		if err != nil {
			t.Fatal(err)
		}
		if len(seen) != 2 || seen[0] != "text" || seen[1] != "result" {
			t.Fatalf("unexpected events %v", seen)
		}
	})
	t.Run("cancel", func(t *testing.T) {
		c := testClient(t)
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		defer cancel()
		started := time.Now()
		err := c.Sample(ctx, Request{CallID: "cancel", Input: json.RawMessage(`"wait"`)}, func(Event) {}, nil)
		if time.Since(started) < 80*time.Millisecond {
			t.Fatal("released before worker completion")
		}
		if err != context.DeadlineExceeded {
			t.Fatalf("cancellation error: %v", err)
		}
	})
	t.Run("invalid worker frame", func(t *testing.T) {
		c := testClient(t)
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		err := c.Sample(ctx, Request{CallID: "bad", Input: json.RawMessage(`"invalid-frame"`)}, func(Event) {}, nil)
		if err == nil {
			t.Fatal("worker protocol error was ignored")
		}
		if len(c.Models()) != 0 {
			t.Fatal("dead worker still advertised models")
		}
	})
}

func TestClientForwardsThinkingSeparately(t *testing.T) {
	c := testClient(t)
	var events []Event
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	err := c.Sample(ctx, Request{CallID: "thinking", Input: json.RawMessage(`"thinking"`)}, func(e Event) { events = append(events, e) }, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].Type != "thinking" || events[0].Delta != "Inspecting the scene." || events[1].Result.Thinking != events[0].Text || events[1].Result.Text != "done" {
		t.Fatalf("thinking/text separation lost: %+v", events)
	}
}
