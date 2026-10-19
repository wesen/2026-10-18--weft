// Package hdl holds the hand-written Verilog cores of Weft's native cells (guide §6.6). The adapters the
// emitter generates per design instantiate them by module name (weft_core_<kind>); weft build adds the cores
// a bundle's cells name. Each core has a self-checking testbench in cells/tb/ (go test ./hdl runs them).
package hdl

import (
	"embed"
	"io/fs"
	"sort"
	"strings"
)

//go:embed cells/*.v
var cells embed.FS

// Core returns the Verilog source of a core module and whether it exists.
func Core(module string) (string, bool) {
	b, err := fs.ReadFile(cells, "cells/"+module+".v")
	if err != nil {
		return "", false
	}
	return string(b), true
}

// Modules lists the core modules.
func Modules() []string {
	entries, _ := fs.ReadDir(cells, "cells")
	var out []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".v") {
			out = append(out, strings.TrimSuffix(e.Name(), ".v"))
		}
	}
	sort.Strings(out)
	return out
}
