package toolchain

import (
	"regexp"
	"strconv"
	"strings"
)

// ClockTiming is nextpnr's verdict for one clock (the last "Max frequency" line wins: it follows routing).
type ClockTiming struct {
	Name      string  `json:"name"`
	FmaxMHz   float64 `json:"fmaxMHz"`
	TargetMHz float64 `json:"targetMHz"`
	Pass      bool    `json:"pass"`
}

// PLLFout is one "PLL fout=" line: what CC_PLL really produces for a requested OUT_CLK.
type PLLFout struct {
	FoutMHz  float64 `json:"foutMHz"`
	WantMHz  float64 `json:"wantMHz"`
	ErrorPct float64 `json:"errorPct"`
}

// PnrLog is what a nextpnr-himbaechel log says about a run.
type PnrLog struct {
	Utilization map[string][2]int `json:"utilization"` // CPE_LT → {used, available}
	Clocks      []ClockTiming     `json:"clocks"`
	PLLs        []PLLFout         `json:"plls"`
	Errors      []string          `json:"errors,omitempty"` // ERROR lines other than timing
	Finished    bool              `json:"finished"`         // "Program finished normally."
}

// TimingOK reports whether nextpnr checked at least one clock and every clock passed.
func (p *PnrLog) TimingOK() bool {
	if len(p.Clocks) == 0 {
		return false
	}
	for _, c := range p.Clocks {
		if !c.Pass {
			return false
		}
	}
	return true
}

var (
	reUtil   = regexp.MustCompile(`^Info:\s+([A-Z][A-Z0-9_]*):\s+(\d+)/\s*(\d+)\s+\d+%\s*$`)
	reTiming = regexp.MustCompile(`^(?:Info|Warning|ERROR): Max frequency for clock '([^']+)': ([\d.]+) MHz \((PASS|FAIL) at ([\d.]+) MHz\)`)
	rePLL    = regexp.MustCompile(`PLL fout=\s*([\d.]+) MHz \(fout error ([\d.]+)% of requested ([\d.]+) MHz\)`)
	reError  = regexp.MustCompile(`^ERROR: (.*)$`)
	reCells  = regexp.MustCompile(`^\s+(\d+)\s+(CC_\w+)\s*$`)
)

// ParseNextpnr reads a nextpnr-himbaechel log (GateMate).
func ParseNextpnr(log string) *PnrLog {
	p := &PnrLog{Utilization: map[string][2]int{}}
	clocks := map[string]int{}
	for line := range strings.SplitSeq(log, "\n") {
		line = strings.TrimRight(line, "\r")
		if m := reTiming.FindStringSubmatch(line); m != nil {
			c := ClockTiming{Name: m[1], FmaxMHz: atof(m[2]), Pass: m[3] == "PASS", TargetMHz: atof(m[4])}
			if i, ok := clocks[c.Name]; ok {
				p.Clocks[i] = c
			} else {
				clocks[c.Name] = len(p.Clocks)
				p.Clocks = append(p.Clocks, c)
			}
			continue // a timing ERROR (strict mode) is a timing result, not a failure of the run
		}
		if m := reUtil.FindStringSubmatch(line); m != nil {
			p.Utilization[m[1]] = [2]int{atoi(m[2]), atoi(m[3])}
		} else if m := rePLL.FindStringSubmatch(line); m != nil {
			p.PLLs = append(p.PLLs, PLLFout{FoutMHz: atof(m[1]), ErrorPct: atof(m[2]), WantMHz: atof(m[3])})
		} else if m := reError.FindStringSubmatch(line); m != nil {
			p.Errors = append(p.Errors, m[1])
		} else if strings.HasPrefix(line, "Info: Program finished normally.") {
			p.Finished = true
		}
	}
	return p
}

// ParseYosysStat returns the CC_* cell counts of the last "Printing statistics" block.
func ParseYosysStat(log string) map[string]int {
	i := strings.LastIndex(log, "Printing statistics")
	if i < 0 {
		return nil
	}
	cells := map[string]int{}
	for line := range strings.SplitSeq(log[i:], "\n") {
		if m := reCells.FindStringSubmatch(line); m != nil {
			cells[m[2]] = atoi(m[1])
		}
	}
	return cells
}

func atof(s string) float64 { f, _ := strconv.ParseFloat(s, 64); return f }
func atoi(s string) int     { n, _ := strconv.Atoi(s); return n }
