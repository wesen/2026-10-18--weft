// Package web embeds the browser assets `weft serve` hosts:
//
//   - static/lab.html: the Weft Lab page, built by weft-lab/app/build.mjs and copied here by `go generate`
//     (gitignored; `make web` produces it).
//   - static/runtime.js: the window.claude artifact runtime shim, copied from francois
//     (github.com/go-go-golems/francois, pkg/web/static/runtime.js at commit d847ba4). It implements
//     use("sample"), use("downloads") and friends against the /api/views endpoints of pkg/artifacthost.
//     One local patch: the downloads extension allowlist also accepts v, sv, js, ccf, sdc, vcd, bit and
//     yaml, because the Lab saves its Verilog (.v) and scripts (.js) through use("downloads").
package web

import (
	"embed"
	"io/fs"
	"os"

	"github.com/pkg/errors"
)

//go:generate sh -c "cd ../../weft-lab/app && node build.mjs && cp dist/index.html ../../pkg/web/static/lab.html"

//go:embed static
var static embed.FS

// Static is the embedded static directory (lab.html when built, runtime.js always).
func Static() fs.FS {
	sub, _ := fs.Sub(static, "static")
	return sub
}

// ErrNoLab means the binary was built without running `go generate ./pkg/web` (or `make web`).
var ErrNoLab = errors.New("the Weft Lab page is not embedded in this binary: run `make web` (or go generate ./pkg/web) and rebuild, or pass --lab-file")

// Lab returns the Lab page: from file when set (development override), otherwise the embedded copy.
func Lab(file string) ([]byte, error) {
	if file != "" {
		b, err := os.ReadFile(file)
		return b, errors.Wrap(err, "read --lab-file")
	}
	b, err := fs.ReadFile(Static(), "lab.html")
	if err != nil {
		return nil, ErrNoLab
	}
	return b, nil
}

// Runtime returns the artifact runtime shim.
func Runtime() []byte {
	b, _ := fs.ReadFile(Static(), "runtime.js")
	return b
}
