package board

import "fmt"

// GateMateA1EVB is the Olimex GateMateA1-EVB: a CCGM1A1 with a 10 MHz oscillator, one user LED and one
// user button (both active-low), a PMOD header and the FPGA UART on the RP2040's first CDC port. The
// RP2040 is also the JTAG programmer (DirtyJTAG, USB 1209:c0ca). Pins verified against the CCGM1A1 pinout
// and past projects on this board (uxn constraints/olimex_gatematea1_evb.ccf, the WEFT-001 spike).
var GateMateA1EVB = &Board{
	Name:       "gatemate-a1-evb",
	Title:      "Olimex GateMateA1-EVB (CCGM1A1)",
	Device:     "CCGM1A1",
	Loader:     "olimex_gatemateevb",
	ClockPort:  "clk_10m",
	ClockPin:   Pin{Name: "IO_SB_A8", Attrs: "SCHMITT_TRIGGER=true"},
	ClockHz:    10e6,
	SerialHint: "/dev/ttyACM0",
	Resources:  map[string]Resource{},
}

func init() {
	r := GateMateA1EVB.Resources
	add := func(id, dir, kind string, pin *Pin) { r[id] = Resource{ID: id, Dir: dir, Kind: kind, Pin: pin} }
	// led:0 is the board's LED; led:1..7 are PMOD pins (active-high: wire your own LEDs)
	add("led:0", "out", "led", &Pin{Name: "IO_SB_B6", ActiveLow: true})
	for i, pin := range []string{"IO_EA_A4", "IO_EA_A5", "IO_EA_A6", "IO_EA_A7", "IO_EA_B4", "IO_EA_B5", "IO_EA_B6"} {
		add(fmt.Sprintf("led:%d", i+1), "out", "led", &Pin{Name: pin})
	}
	// one button, two names: btn:user (as on pico) and btn:0 (as on dev); btn:1..3 and the switches are virtual
	button := Pin{Name: "IO_SB_B7", ActiveLow: true}
	add("btn:user", "in", "button", &button)
	add("btn:0", "in", "button", &button)
	for _, id := range []string{"btn:1", "btn:2", "btn:3"} {
		add(id, "in", "button", nil)
	}
	for i := range 8 {
		add(fmt.Sprintf("sw:%d", i), "in", "switch", nil)
	}
	add("uart.tx", "out", "uart", &Pin{Name: "IO_SA_B6"})
	add("uart.rx", "in", "uart", &Pin{Name: "IO_SA_A6"})
	register(GateMateA1EVB)
}
