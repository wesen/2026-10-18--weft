package toolchain

import "testing"

// Output of `openFPGALoader -b olimex_gatemateevb --detect` against the GateMateA1-EVB (v1.1.1).
const detectOutput = `Jtag frequency : requested 6000000 Hz -> real 6000000 Hz
index 0:
	idcode 0x20000001
	manufacturer colognechip
	family GateMate Series
	model  GM1Ax
	irlength 6
`

func TestParseDetect(t *testing.T) {
	chip, err := ParseDetect(detectOutput)
	if err != nil {
		t.Fatal(err)
	}
	want := Chip{IDCode: "0x20000001", Manufacturer: "colognechip", Family: "GateMate Series", Model: "GM1Ax"}
	if *chip != want {
		t.Fatalf("got %+v, want %+v", *chip, want)
	}
	if _, err := ParseDetect("unable to open ftdi device: -4 (usb_open() failed)\n"); err == nil {
		t.Fatal("expected an error without an idcode")
	}
}
