// Package bundle reads hardware bundles (schema weft.hw-bundle/v1): the JSON contract between the Weft
// compiler (weft-lab/app/src/core/hardware.js, buildBundle) and the Go board flow. A bundle carries the
// emitted Verilog plus the facts needed to wrap it for a board; Go never parses the Verilog.
package bundle

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"regexp"
	"strings"

	"github.com/pkg/errors"
)

// Schema is the only bundle schema this package reads.
const Schema = "weft.hw-bundle/v1"

// Bundle is one compiled design, ready to wrap for its board.
type Bundle struct {
	Schema    string          `json:"schema"`
	Design    string          `json:"design"`
	Board     string          `json:"board"`
	Part      string          `json:"part"`
	Source    *Source         `json:"source,omitempty"`
	Header    *Header         `json:"header,omitempty"`
	Top       string          `json:"top"`
	Files     []File          `json:"files"`
	Clocks    []Clock         `json:"clocks"`
	Reset     Reset           `json:"reset"`
	Ports     []Port          `json:"ports"`
	Cells     []Cell          `json:"cells"`
	Knobs     []Knob          `json:"knobs"`
	Estimate  json.RawMessage `json:"estimate,omitempty"`
	Scenarios []Scenario      `json:"scenarios"`
}

type Source struct {
	File   string `json:"file"`
	SHA256 string `json:"sha256,omitempty"`
}

type Header struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// File is one emitted Verilog file; exactly one has Top set.
type File struct {
	Path string `json:"path"`
	Text string `json:"text"`
	Top  bool   `json:"top,omitempty"`
}

// Clock is one clock domain and the design top's input port that carries it.
type Clock struct {
	Domain string  `json:"domain"`
	Port   string  `json:"port"`
	Hz     float64 `json:"hz"`
	// Kind is board/pin (the board oscillator), pll (derived from From) or port (an external clock).
	Kind   string          `json:"kind"`
	Main   bool            `json:"main"`
	WantHz float64         `json:"wantHz,omitempty"`
	From   string          `json:"from,omitempty"`
	Pin    string          `json:"pin,omitempty"`
	PLL    json.RawMessage `json:"pll,omitempty"`
}

type Reset struct {
	Port        string `json:"port"`
	ActiveHigh  bool   `json:"activeHigh"`
	Synchronous bool   `json:"synchronous"`
}

// Port is one top-level design port bound to board resources, bit by bit.
type Port struct {
	Name    string `json:"name"`
	Dir     string `json:"dir"` // in | out
	Width   int    `json:"width"`
	Indexed bool   `json:"indexed"`
	Bits    []Bit  `json:"bits"`
}

// Bit maps one bit of a design port to a board resource ("led:0", "uart.tx").
type Bit struct {
	Bit      int    `json:"bit"`
	Resource string `json:"resource"`
	Kind     string `json:"kind,omitempty"`
	Domain   string `json:"domain,omitempty"`
	Cell     string `json:"cell,omitempty"` // the native cell instance driving or reading the pin
}

type Cell struct {
	Path   string         `json:"path"`
	Kind   string         `json:"kind"`
	Domain string         `json:"domain"`
	Module string         `json:"module,omitempty"`
	Params map[string]any `json:"params,omitempty"`
}

type Knob struct {
	Path   string `json:"path"`
	Kind   string `json:"kind"`
	Type   string `json:"type"`
	Width  *int   `json:"width"`
	Reset  any    `json:"reset"`
	Min    any    `json:"min"`
	Max    any    `json:"max"`
	Addr   *int   `json:"addr"`
	Domain string `json:"domain"`
}

type Scenario struct {
	Name     string   `json:"name"`
	Kind     string   `json:"kind"`
	Portable bool     `json:"portable"`
	Steps    []string `json:"steps"`
	Skip     string   `json:"skip,omitempty"`
}

var identifier = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_$]*$`)

// Parse decodes and validates a bundle.
func Parse(data []byte) (*Bundle, error) {
	b := &Bundle{}
	if err := json.Unmarshal(data, b); err != nil {
		return nil, errors.Wrap(err, "decode bundle")
	}
	if err := b.Validate(); err != nil {
		return nil, err
	}
	return b, nil
}

// Load reads and validates a bundle file.
func Load(file string) (*Bundle, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	b, err := Parse(data)
	return b, errors.Wrapf(err, "bundle %s", file)
}

// Validate checks the structural rules Go relies on: names are Verilog identifiers, files are flat and
// unique with one top, exactly one main clock, and every bound bit lies inside its port.
func (b *Bundle) Validate() error {
	if b.Schema != Schema {
		return errors.Errorf("unsupported bundle schema %q (want %s)", b.Schema, Schema)
	}
	if !identifier.MatchString(b.Top) {
		return errors.Errorf("top %q is not a Verilog identifier", b.Top)
	}
	tops, seen := 0, map[string]bool{}
	for _, f := range b.Files {
		if f.Path == "" || path.Base(f.Path) != f.Path || !strings.HasSuffix(f.Path, ".v") || seen[f.Path] {
			return errors.Errorf("bad or duplicate file name %q (want unique flat *.v names)", f.Path)
		}
		seen[f.Path] = true
		if f.Top {
			tops++
		}
	}
	if tops != 1 {
		return errors.Errorf("bundle has %d top files, want 1", tops)
	}
	mains := 0
	for _, c := range b.Clocks {
		if !identifier.MatchString(c.Port) || c.Hz <= 0 {
			return errors.Errorf("clock %q: bad port %q or frequency %v", c.Domain, c.Port, c.Hz)
		}
		if c.Main {
			mains++
		}
	}
	if mains != 1 {
		return errors.Errorf("bundle has %d main clocks, want 1", mains)
	}
	if !identifier.MatchString(b.Reset.Port) || !b.Reset.ActiveHigh || !b.Reset.Synchronous {
		return errors.New("only a synchronous active-high reset port is supported")
	}
	if len(b.Ports) == 0 {
		return errors.New("bundle binds no board resources")
	}
	for _, p := range b.Ports {
		if !identifier.MatchString(p.Name) || (p.Dir != "in" && p.Dir != "out") || p.Width < 1 {
			return errors.Errorf("port %q: bad name, direction %q or width %d", p.Name, p.Dir, p.Width)
		}
		for _, bit := range p.Bits {
			if bit.Bit < 0 || bit.Bit >= p.Width {
				return errors.Errorf("port %s: bit %d (%s) outside width %d", p.Name, bit.Bit, bit.Resource, p.Width)
			}
		}
	}
	return nil
}

// TopFile returns the file that declares the design top.
func (b *Bundle) TopFile() File {
	for _, f := range b.Files {
		if f.Top {
			return f
		}
	}
	return File{}
}

// MainClock returns the domain fed by the board oscillator.
func (b *Bundle) MainClock() Clock {
	for _, c := range b.Clocks {
		if c.Main {
			return c
		}
	}
	return Clock{}
}

// Name is a short label: "F-01 blinky" when the header has an id.
func (b *Bundle) Name() string {
	if b.Header != nil && b.Header.ID != "" {
		return fmt.Sprintf("%s %s", b.Header.ID, b.Design)
	}
	return b.Design
}
