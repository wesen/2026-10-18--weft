package hil_test

import (
	"context"
	"testing"
	"time"

	"github.com/wesen/2026-10-18--weft/pkg/board"
	"github.com/wesen/2026-10-18--weft/pkg/hil"
	"github.com/wesen/2026-10-18--weft/pkg/hil/hiltest"
)

func TestParseLine(t *testing.T) {
	good := map[string]hil.Line{
		"O 1a 00000002faf080 01": {Kind: 'O', Seq: 0x1a, Cycle: 50_000_000, Outs: "01"},
		"H ff 00000000c00000":    {Kind: 'H', Seq: 0xff, Cycle: 0xc00000},
		"A 00 00000000000000":    {Kind: 'A'},
		"X 1c 0003":              {Kind: 'X', Seq: 0x1c, Lost: 3},
	}
	for s, want := range good {
		got, err := hil.ParseLine(s, 8)
		if err != nil || got != want {
			t.Errorf("ParseLine(%q) = %+v, %v; want %+v", s, got, err, want)
		}
	}
	for _, s := range []string{"", "7 00000008d00000", "O 1a 2faf080 01", "O 1a 00000002faf080 1", "O 1a 00000002faf080 0g",
		"Q 00 00000000000000", "X 1c 3", "H 01 00000000c00000 00", "A 100 00000000000000"} {
		if _, err := hil.ParseLine(s, 8); err == nil {
			t.Errorf("ParseLine(%q) accepted a malformed line", s)
		}
	}
}

// a map like F-05's on a 100 kHz board: one physical and one virtual input, two outputs
var testMap = &board.HILMap{Baud: 115200, Hz: 100e3, TX: "uart.tx", RX: "uart.rx",
	Inputs:  []board.HILPin{{Resource: "btn:0", Index: 0, Physical: true}, {Resource: "sw:0", Index: 1}},
	Outputs: []board.HILPin{{Resource: "led:0", Index: 0}, {Resource: "led:1", Index: 1}}}

// led:0 blinks (toggles every 2500 cycles, 25 ms); led:1 follows btn:0
func blinkEcho(c uint64, in []int) []int { return []int{int(c/2500) % 2, in[0]} }

func TestConnAgainstFake(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	br := hiltest.New(testMap, blinkEcho)
	var events []hil.Event
	evc := make(chan hil.Event, 256)
	c := hil.Open(br, testMap, func(e hil.Event) { evc <- e })
	defer func() { _ = c.Close() }()

	snap, err := c.Reset(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Cycle > 2 || snap.Outs["led:0"] != 0 || snap.Changes != 1 {
		t.Fatalf("after reset: %+v", snap)
	}
	// "blinks": four toggles of led:0 by cycle 11000, counted from the history
	got, err := c.WaitCycle(ctx, 11000)
	if err != nil || got < 11000 {
		t.Fatalf("WaitCycle: %d %v", got, err)
	}
	ch, cur, err := c.Changes(snap.Epoch, 0)
	if err != nil {
		t.Fatal(err)
	}
	toggles := 0
	for i := 1; i < len(ch); i++ {
		if ch[i].Cycle <= 11000 && ch[i].Outs["led:0"] != ch[i-1].Outs["led:0"] {
			toggles++
		}
	}
	if toggles != 4 {
		t.Errorf("%d toggles of led:0 by cycle 11000, want 4 (%+v)", toggles, ch)
	}

	// a physical input taken over: led:1 follows, stamped no later than the ack
	one := 1
	at, err := c.Set(ctx, map[string]*int{"btn:0": &one})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.WaitCycle(ctx, at); err != nil {
		t.Fatal(err)
	}
	ch, _, _ = c.Changes(snap.Epoch, cur)
	if len(ch) == 0 || ch[len(ch)-1].Outs["led:1"] != 1 || ch[len(ch)-1].Cycle > at {
		t.Errorf("after btn:0 = 1 at %d: %+v", at, ch)
	}
	if s := c.Snapshot(); s.Inputs["btn:0"] != 1 || len(s.Overr) != 1 || s.Overr[0] != "btn:0" {
		t.Errorf("snapshot inputs %v overrides %v", s.Inputs, s.Overr)
	}
	if _, err := c.Set(ctx, map[string]*int{"btn:9": &one}); err == nil {
		t.Error("Set accepted an input the bridge does not drive")
	}

	// a reset voids old cursors
	if _, err := c.Reset(ctx); err != nil {
		t.Fatal(err)
	}
	if _, _, err := c.Changes(snap.Epoch, 0); err == nil {
		t.Error("a cursor from before the reset was accepted")
	}
	close(evc)
	for e := range evc {
		events = append(events, e)
	}
	kinds := map[string]int{}
	for _, e := range events {
		kinds[e.Type]++
	}
	if kinds["pins"] < 5 || kinds["reset"] != 2 || kinds["gap"] != 0 {
		t.Errorf("events %v", kinds)
	}
}

// A line lost between the bridge and the host is counted, so a check across it can fail.
func TestConnSequenceGap(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	br := hiltest.New(testMap, blinkEcho)
	dropped := false
	br.Drop = func(seq uint8) bool {
		if seq == 4 && !dropped {
			dropped = true
			return true
		}
		return false
	}
	c := hil.Open(br, testMap, nil)
	defer func() { _ = c.Close() }()
	if _, err := c.Reset(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := c.WaitCycle(ctx, 15000); err != nil {
		t.Fatal(err)
	}
	if s := c.Snapshot(); s.Gaps != 1 {
		t.Errorf("gaps = %d, want 1", s.Gaps)
	}
}
