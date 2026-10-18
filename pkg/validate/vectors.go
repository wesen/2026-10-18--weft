// Package validate runs the co-simulation levels of the validation ladder (guide §6.10): L1 replays a
// scenario's port changes, recorded from the Lab's simulator, against the emitted RTL in iverilog; L2 does the
// same against a GateMate netlist of that RTL with the vendor cell models.
package validate

import (
	"encoding/json"
	"fmt"

	"github.com/pkg/errors"
	"github.com/wesen/2026-10-18--weft/pkg/bundle"
)

// Schema is the vectors format written by weft-hw.mjs vectors (src/core/vectors.js).
const Schema = "weft.vectors/v1"

// Vectors are the co-simulation inputs for one design: the bundle of its co-simulation variant (the main clock
// replaced by CosimHz) and one change list per scenario.
type Vectors struct {
	Schema    string            `json:"schema"`
	CosimHz   float64           `json:"cosimHz"`
	Bundle    *bundle.Bundle    `json:"-"`
	RawBundle json.RawMessage   `json:"bundle"`
	Skip      string            `json:"skip,omitempty"`
	Scenarios []ScenarioVectors `json:"scenarios"`
}

// ScenarioVectors is one scenario's recording. Cycle k is the k-th rising edge of the main clock: an input
// change at k is applied before edge k, an output value at k is what the design drives just before edge k.
// Every port is 0 until its first change.
type ScenarioVectors struct {
	Name    string     `json:"name"`
	Skip    string     `json:"skip,omitempty"`
	Cycles  int64      `json:"cycles"`
	Changes []Change   `json:"changes"`
	Sim     *SimResult `json:"sim,omitempty"`
}

// SimResult is how the scenario itself went in the Lab's simulator.
type SimResult struct {
	Status  string `json:"status"`
	Message string `json:"message"`
}

// Change is one [cycle, port index, hex value] entry.
type Change struct {
	Cycle int64
	Port  int
	Value string
}

// UnmarshalJSON reads the [cycle, port, hex] array form.
func (c *Change) UnmarshalJSON(b []byte) error {
	var a []json.RawMessage
	if err := json.Unmarshal(b, &a); err != nil || len(a) != 3 {
		return errors.Errorf("a change is [cycle, port, hex], got %s", b)
	}
	if err := json.Unmarshal(a[0], &c.Cycle); err != nil {
		return err
	}
	if err := json.Unmarshal(a[1], &c.Port); err != nil {
		return err
	}
	return json.Unmarshal(a[2], &c.Value)
}

// MarshalJSON writes the array form.
func (c Change) MarshalJSON() ([]byte, error) { return json.Marshal([]any{c.Cycle, c.Port, c.Value}) }

// Parse reads and checks vectors.
func Parse(data []byte) (*Vectors, error) {
	v := &Vectors{}
	if err := json.Unmarshal(data, v); err != nil {
		return nil, errors.Wrap(err, "decode vectors")
	}
	if v.Schema != Schema {
		return nil, errors.Errorf("vectors schema %q, want %q", v.Schema, Schema)
	}
	b, err := bundle.Parse(v.RawBundle)
	if err != nil {
		return nil, errors.Wrap(err, "vectors bundle")
	}
	v.Bundle = b
	for _, s := range v.Scenarios {
		var prev int64
		for _, c := range s.Changes {
			if c.Port < 0 || c.Port >= len(b.Ports) {
				return nil, errors.Errorf("scenario %q: change for port %d, but the design has %d ports", s.Name, c.Port, len(b.Ports))
			}
			if c.Cycle < 1 || c.Cycle < prev || c.Cycle > s.Cycles {
				return nil, errors.Errorf("scenario %q: change at cycle %d out of order or outside 1..%d", s.Name, c.Cycle, s.Cycles)
			}
			prev = c.Cycle
		}
	}
	return v, nil
}

// ChangesText renders a scenario's change list for people: a header naming the ports, then one
// "<cycle> <port> <hex>" line per change.
func (v *Vectors) ChangesText(s *ScenarioVectors) string {
	out := fmt.Sprintf("# weft co-simulation change list: %s, scenario %q, %d cycles at %g Hz\n", v.Bundle.Design, s.Name, s.Cycles, v.CosimHz)
	for _, p := range v.Bundle.Ports {
		out += fmt.Sprintf("# port %s %s %d\n", p.Name, p.Dir, p.Width)
	}
	for _, c := range s.Changes {
		out += fmt.Sprintf("%d %s %s\n", c.Cycle, v.Bundle.Ports[c.Port].Name, c.Value)
	}
	return out
}
