// Package validate runs the co-simulation levels of the validation ladder (guide §6.10): L1 replays a
// scenario's port changes, recorded from the Lab's simulator, against the emitted RTL in iverilog; L2 does the
// same against a GateMate netlist of that RTL with the vendor cell models.
package validate

import (
	"encoding/json"
	"fmt"
	"math/big"
	"regexp"
	"slices"

	"github.com/pkg/errors"
	"github.com/wesen/2026-10-18--weft/pkg/bundle"
)

var identifier = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_$]*$`)

// Schema is the vectors format written by weft-hw.mjs vectors (src/core/vectors.js).
const Schema = "weft.vectors/v1"

// Vectors are the co-simulation inputs for one design: the bundle of its co-simulation variant (the main clock
// replaced by CosimHz) and one change list per scenario.
type Vectors struct {
	Schema    string            `json:"schema"`
	CosimHz   float64           `json:"cosimHz"`
	Bundle    *bundle.Bundle    `json:"-"`
	RawBundle json.RawMessage   `json:"bundle"`
	DUT       *DUT              `json:"dut,omitempty"`
	Skip      string            `json:"skip,omitempty"`
	Scenarios []ScenarioVectors `json:"scenarios"`
}

// DUT is set for a design with native cells, which co-simulation cuts at the cell boundary: the device under
// test is the main domain's module (clk, rst and these ports), not the design top. Changes index these ports.
// Inputs include the values cells drive into the graph; outputs include the values cells read (x_<id>).
type DUT struct {
	Module string    `json:"module"`
	File   string    `json:"file"`
	Ports  []DUTPort `json:"ports"`
}

// DUTPort is one domain-module port. Check is false for an output the simulator cannot observe.
type DUTPort struct {
	Name  string `json:"name"`
	Dir   string `json:"dir"`
	Width int    `json:"width"`
	Check bool   `json:"check,omitempty"`
}

// port is one port of the device under test as the testbench sees it.
type port struct {
	name  string
	dir   string // in | out
	width int
	mask  *big.Int // output bits to compare; nil compares none
}

// ports lists the device under test's ports in change-index order, its module and its clock port.
func (v *Vectors) ports() (module, clk string, out []port) {
	if v.DUT != nil {
		for _, p := range v.DUT.Ports {
			q := port{name: p.Name, dir: p.Dir, width: p.Width}
			if p.Dir == "out" && p.Check {
				q.mask = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), uint(p.Width)), big.NewInt(1))
			}
			out = append(out, q)
		}
		return v.DUT.Module, "clk", out
	}
	for _, p := range v.Bundle.Ports {
		q := port{name: p.Name, dir: p.Dir, width: p.Width}
		if p.Dir != "in" {
			q.mask = new(big.Int)
			for _, bit := range p.Bits {
				q.mask.SetBit(q.mask, bit.Bit, 1)
			}
		}
		out = append(out, q)
	}
	return v.Bundle.Top, v.Bundle.MainClock().Port, out
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
	if d := v.DUT; d != nil {
		if !identifier.MatchString(d.Module) || !slices.ContainsFunc(b.Files, func(f bundle.File) bool { return f.Path == d.File }) {
			return nil, errors.Errorf("dut: bad module %q or file %q not in the bundle", d.Module, d.File)
		}
		for _, p := range d.Ports {
			if !identifier.MatchString(p.Name) || (p.Dir != "in" && p.Dir != "out") || p.Width < 1 {
				return nil, errors.Errorf("dut port %q: bad name, direction %q or width %d", p.Name, p.Dir, p.Width)
			}
		}
	}
	_, _, ports := v.ports()
	for _, s := range v.Scenarios {
		var prev int64
		for _, c := range s.Changes {
			if c.Port < 0 || c.Port >= len(ports) {
				return nil, errors.Errorf("scenario %q: change for port %d, but the device under test has %d ports", s.Name, c.Port, len(ports))
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
	module, _, ports := v.ports()
	out := fmt.Sprintf("# weft co-simulation change list: %s, scenario %q, %d cycles at %g Hz, device under test %s\n", v.Bundle.Design, s.Name, s.Cycles, v.CosimHz, module)
	for _, p := range ports {
		out += fmt.Sprintf("# port %s %s %d\n", p.name, p.dir, p.width)
	}
	for _, c := range s.Changes {
		out += fmt.Sprintf("%d %s %s\n", c.Cycle, ports[c.Port].name, c.Value)
	}
	return out
}
