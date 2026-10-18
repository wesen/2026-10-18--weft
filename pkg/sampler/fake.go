package sampler

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

// Fake is an explicitly selected deterministic backend for offline verification of the page wiring.
//
// With tools (the Lab agent passes exactly one, eval) it runs one read-only eval that counts the editor's
// lines, then reports whether the page answered. "fixture:stream" streams three text deltas.
type Fake struct{}

var _ Backend = (*Fake)(nil)

func (f *Fake) Models() []Model {
	return []Model{{Provider: "test", ID: "fake", Name: "Deterministic test model", Tier: "all"}}
}
func (f *Fake) Close() error { return nil }
func (f *Fake) Sample(ctx context.Context, r Request, emit func(Event), execute ExecuteTool) error {
	text := "weft serve is connected."
	if strings.Contains(string(r.Input), "fixture:stream") {
		text = ""
		for _, delta := range []string{"first ", "second ", "third"} {
			timer := time.NewTimer(250 * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
			}
			text += delta
			emit(Event{Type: "text", CallID: r.CallID, Text: text, Delta: delta})
		}
		emit(Event{Type: "result", CallID: r.CallID, Result: &Result{Text: text, ModelTierApplied: r.Options.ModelTier, ModelUsed: "test/fake"}})
		return nil
	}
	if len(r.Tools) > 0 {
		args := json.RawMessage(`{}`)
		if r.Tools[0].Name == "eval" {
			args = json.RawMessage(`{"code":"return { lines: editor.get().split('\\n').length };"}`)
		}
		result, err := execute(ctx, Event{Type: "tool", CallID: r.CallID, ToolCallID: "fake-tool", Name: r.Tools[0].Name, Input: args})
		if err != nil {
			return err
		}
		if result.IsError {
			text = "The page tool reported an error: " + string(result.Value)
		} else {
			text = "The page tool answered: " + string(result.Value)
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	emit(Event{Type: "text", CallID: r.CallID, Text: text, Delta: text})
	emit(Event{Type: "result", CallID: r.CallID, Result: &Result{Text: text, ModelTierApplied: r.Options.ModelTier, ModelApplied: r.Options.Model, ModelUsed: "test/fake"}})
	return nil
}

// None is the backend when sampling is off: no models, so the host answers sampling_disabled and the
// Lab shows its agent as unavailable while everything else keeps working.
type None struct{}

var _ Backend = None{}

func (None) Models() []Model { return []Model{} }
func (None) Close() error    { return nil }
func (None) Sample(context.Context, Request, func(Event), ExecuteTool) error {
	return &Failure{Code: "sampling_disabled", Message: "Sampling is off in this weft serve"}
}
