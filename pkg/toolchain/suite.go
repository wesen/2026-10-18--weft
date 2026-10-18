// Package toolchain locates the OSS CAD Suite and runs its GateMate tools (yosys, nextpnr-himbaechel,
// gmpack, openFPGALoader, iverilog) with the environment the suite's own `environment` script would set.
package toolchain

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/pkg/errors"
)

// DefaultSuiteRoot is where the user's OSS CAD Suite lives (VERSION 20260825 at the time of writing).
const DefaultSuiteRoot = "~/fpga/oss-cad-suite"

// Suite is one OSS CAD Suite installation.
type Suite struct {
	Root string // absolute path of the extracted suite
}

// Open resolves root ("~/" is expanded) and checks that it looks like an OSS CAD Suite.
func Open(root string) (*Suite, error) {
	if root == "" {
		root = DefaultSuiteRoot
	}
	abs, err := ExpandPath(root)
	if err != nil {
		return nil, err
	}
	if st, err := os.Stat(filepath.Join(abs, "bin")); err != nil || !st.IsDir() {
		return nil, errors.Errorf("%s does not look like an OSS CAD Suite (no bin/ directory)", abs)
	}
	return &Suite{Root: abs}, nil
}

// Version is the suite's release date from its VERSION file, or "" when the file is missing.
func (s *Suite) Version() string {
	b, err := os.ReadFile(filepath.Join(s.Root, "VERSION"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// Env is the process environment with the suite activated: bin/ and py3bin/ first on PATH, VIRTUAL_ENV set
// and PYTHONHOME removed, exactly what `source environment` does.
func (s *Suite) Env() []string {
	out := make([]string, 0, len(os.Environ())+2)
	path := filepath.Join(s.Root, "bin") + string(os.PathListSeparator) + filepath.Join(s.Root, "py3bin")
	for _, kv := range os.Environ() {
		switch {
		case strings.HasPrefix(kv, "PATH="):
			path += string(os.PathListSeparator) + strings.TrimPrefix(kv, "PATH=")
		case strings.HasPrefix(kv, "PYTHONHOME="), strings.HasPrefix(kv, "VIRTUAL_ENV="):
		default:
			out = append(out, kv)
		}
	}
	return append(out, "PATH="+path, "VIRTUAL_ENV="+s.Root)
}

// Bin is the absolute path of a suite tool.
func (s *Suite) Bin(tool string) string { return filepath.Join(s.Root, "bin", tool) }

// Command prepares a suite tool to run in dir with the suite environment.
func (s *Suite) Command(ctx context.Context, dir, tool string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, s.Bin(tool), args...)
	cmd.Dir = dir
	cmd.Env = s.Env()
	cmd.WaitDelay = 5 * time.Second
	return cmd
}

// Output runs a suite tool and returns its combined output, bounded by timeout.
func (s *Suite) Output(ctx context.Context, timeout time.Duration, tool string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var buf bytes.Buffer
	cmd := s.Command(ctx, "", tool, args...)
	cmd.Stdout, cmd.Stderr = &buf, &buf
	err := cmd.Run()
	return buf.String(), err
}

// ToolVersion is one tool's version line.
type ToolVersion struct {
	Tool    string
	Version string
	Err     error
}

var versionArgs = []struct {
	tool string
	args []string
	re   *regexp.Regexp
}{
	{"yosys", []string{"-V"}, regexp.MustCompile(`Yosys \S+`)},
	{"nextpnr-himbaechel", []string{"--version"}, regexp.MustCompile(`Version (nextpnr-[\w.\-]+)`)},
	{"openFPGALoader", []string{"--Version"}, regexp.MustCompile(`v\d+\.\d+\.\d+`)},
	{"iverilog", []string{"-V"}, regexp.MustCompile(`version \S+(?: \(\w+\))?`)},
}

// Versions asks each tool for its version. gmpack has no version flag, so only its presence is checked.
func (s *Suite) Versions(ctx context.Context) []ToolVersion {
	out := []ToolVersion{}
	for _, v := range versionArgs {
		text, err := s.Output(ctx, 15*time.Second, v.tool, v.args...)
		tv := ToolVersion{Tool: v.tool, Err: err}
		if m := v.re.FindStringSubmatch(text); m != nil {
			tv.Version, tv.Err = m[len(m)-1], nil // the capture group when there is one, else the match
		} else if err == nil {
			tv.Err = fmt.Errorf("unrecognized version output: %q", firstLine(text))
		}
		out = append(out, tv)
	}
	if _, err := os.Stat(s.Bin("gmpack")); err != nil {
		out = append(out, ToolVersion{Tool: "gmpack", Err: err})
	} else {
		out = append(out, ToolVersion{Tool: "gmpack", Version: "present"})
	}
	return out
}

// ExpandPath expands a leading "~/" and makes the path absolute.
func ExpandPath(p string) (string, error) {
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", errors.Wrap(err, "resolve home directory")
		}
		p = filepath.Join(home, strings.TrimPrefix(p, "~"))
	}
	return filepath.Abs(p)
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
