// Package hdl holds weft's hand-written Verilog: the cores of the native cells (guide §6.6) and the HIL bridge
// (§6.10). The adapters the emitter generates per design instantiate the cores by module name
// (weft_core_<kind>); weft build adds the cores a bundle's cells name, and the bridge (which uses the UART
// cores) when a build asks for HIL. Each module has a self-checking testbench in cells/tb/ or hil/tb/
// (go test ./hdl runs them).
package hdl

import (
	"embed"
	"io/fs"
	"sort"
	"strings"
)

//go:embed cells/*.v
var cells embed.FS

//go:embed hil/weft_hil.v
var hil string

// HILModule is the bridge's module name.
const HILModule = "weft_hil"

// HIL returns the bridge's Verilog source. It instantiates weft_core_uart_rx and weft_core_uart_tx.
func HIL() string { return hil }

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
