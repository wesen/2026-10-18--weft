package toolchain

import (
	"os"
	"testing"
)

func readFixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestParseNextpnrPass(t *testing.T) {
	p := ParseNextpnr(readFixture(t, "nextpnr-pass-pll.log"))
	if got := p.Utilization["CPE_LT"]; got != [2]int{28, 40960} {
		t.Errorf("CPE_LT = %v", got)
	}
	if got := p.Utilization["IOSEL"]; got != [2]int{2, 162} {
		t.Errorf("IOSEL = %v", got)
	}
	if len(p.Clocks) != 1 || p.Clocks[0].Name != "gclk" || p.Clocks[0].FmaxMHz != 281.29 || !p.Clocks[0].Pass {
		t.Errorf("clocks = %+v (want the post-route line, 281.29 MHz)", p.Clocks)
	}
	if len(p.PLLs) != 1 || p.PLLs[0].FoutMHz != 25.2778 || p.PLLs[0].WantMHz != 25.175 {
		t.Errorf("plls = %+v", p.PLLs)
	}
	if !p.TimingOK() || !p.Finished || len(p.Errors) != 0 {
		t.Errorf("timingOK=%v finished=%v errors=%v", p.TimingOK(), p.Finished, p.Errors)
	}
}

func TestParseNextpnrTimingFail(t *testing.T) {
	for _, f := range []string{"nextpnr-timing-fail-allowed.log", "nextpnr-timing-fail-strict.log"} {
		p := ParseNextpnr(readFixture(t, f))
		if p.TimingOK() {
			t.Errorf("%s: timing should fail", f)
		}
		if len(p.Errors) != 0 {
			t.Errorf("%s: a timing ERROR must not count as a run error: %v", f, p.Errors)
		}
		if c := p.Clocks[0]; c.FmaxMHz != 281.29 || c.TargetMHz != 400 || c.Pass {
			t.Errorf("%s: clock = %+v", f, c)
		}
	}
}

func TestParseYosysStat(t *testing.T) {
	cells := ParseYosysStat(readFixture(t, "yosys-stat.log"))
	want := map[string]int{"CC_ADDF": 25, "CC_BUFG": 1, "CC_DFF": 25, "CC_IBUF": 1, "CC_LUT2": 1, "CC_OBUF": 1, "CC_PLL": 1}
	if len(cells) != len(want) {
		t.Fatalf("cells = %v", cells)
	}
	for k, v := range want {
		if cells[k] != v {
			t.Errorf("%s = %d, want %d", k, cells[k], v)
		}
	}
}
