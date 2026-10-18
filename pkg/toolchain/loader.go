package toolchain

import (
	"context"
	"regexp"
	"strings"
	"time"

	"github.com/pkg/errors"
)

// Chip is what `openFPGALoader --detect` reports for the first device on the JTAG chain.
type Chip struct {
	IDCode       string // "0x20000001"
	Manufacturer string // "colognechip"
	Family       string // "GateMate Series"
	Model        string // "GM1Ax"
}

var detectField = regexp.MustCompile(`(?m)^\s*(idcode|manufacturer|family|model)\s+(.+?)\s*$`)

// ParseDetect reads `openFPGALoader --detect` output.
func ParseDetect(out string) (*Chip, error) {
	c := &Chip{}
	for _, m := range detectField.FindAllStringSubmatch(out, -1) {
		switch m[1] {
		case "idcode":
			if c.IDCode == "" {
				c.IDCode = m[2]
			}
		case "manufacturer":
			c.Manufacturer = m[2]
		case "family":
			c.Family = m[2]
		case "model":
			c.Model = m[2]
		}
	}
	if c.IDCode == "" {
		return nil, LoaderError(out)
	}
	return c, nil
}

// Detect asks openFPGALoader which chip sits behind the board's cable. board is an openFPGALoader board
// name such as "olimex_gatemateevb"; without it openFPGALoader assumes an FTDI cable and says "no FTDI".
func (s *Suite) Detect(ctx context.Context, board string) (*Chip, error) {
	out, err := s.Output(ctx, 30*time.Second, "openFPGALoader", "-b", board, "--detect")
	if c, perr := ParseDetect(out); perr == nil {
		return c, nil
	}
	if err != nil {
		return nil, errors.Wrapf(LoaderError(out), "openFPGALoader --detect: %v", err)
	}
	return nil, LoaderError(out)
}

// LoaderError turns openFPGALoader output into an error that names the likely cause.
func LoaderError(out string) error {
	text := strings.TrimSpace(out)
	switch {
	case strings.Contains(text, "fails to open device"):
		return errors.Errorf("cannot open the board's DirtyJTAG device (unplugged, owned by another process, or missing udev rule for 1209:c0ca): %s", firstLine(text))
	case strings.Contains(text, "no FTDI"), strings.Contains(text, "No cable"):
		return errors.Errorf("no JTAG cable found: %s", firstLine(text))
	case text == "":
		return errors.New("openFPGALoader printed nothing")
	default:
		lines := strings.Split(text, "\n")
		return errors.Errorf("openFPGALoader: %s", strings.TrimSpace(lines[len(lines)-1]))
	}
}
