// Package hil speaks the protocol of the weft_hil bridge (hdl/hil/weft_hil.v) over the board's serial port:
// it parses the bridge's lines, keeps the history of output changes stamped with board cycles, sends one
// command at a time and waits for its acknowledgement, and waits for the board to pass a given cycle.
//
// Every line from the bridge leaves its event queue in cycle order. A line stamped c therefore proves that
// every output change up to c has arrived before it; WaitCycle relies on that.
package hil

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pkg/errors"
	"github.com/wesen/2026-10-18--weft/pkg/board"
)

// ErrBridge marks a failure of the bridge or its serial port (no answer, a rejected command, a closed port),
// as opposed to a bad request.
var ErrBridge = errors.New("HIL bridge")

// ErrNotInput is a Set naming a resource the bridge does not drive.
var ErrNotInput = errors.New("not a HIL input")

// Line is one line from the bridge.
type Line struct {
	Kind  byte   // O, H, A, E or X
	Seq   uint8  // line counter, wrapping
	Cycle uint64 // O, H, A, E
	Outs  string // O: the output field, hex
	Lost  int    // X: changes the bridge could not report
}

// ParseLine parses one line (without its newline). nout is the number of outputs the bridge reports.
func ParseLine(s string, nout int) (Line, error) {
	f := strings.Fields(s)
	bad := func(why string) (Line, error) { return Line{}, errors.Errorf("malformed HIL line %q: %s", s, why) }
	if len(f) < 3 || len(f[0]) != 1 || len(f[1]) != 2 {
		return bad("want a kind, a sequence number and a value")
	}
	seq, err := strconv.ParseUint(f[1], 16, 8)
	if err != nil {
		return bad("sequence number")
	}
	l := Line{Kind: f[0][0], Seq: uint8(seq)}
	switch l.Kind {
	case 'X':
		if len(f) != 3 || len(f[2]) != 4 {
			return bad("X takes a 4-digit count")
		}
		n, err := strconv.ParseUint(f[2], 16, 16)
		if err != nil {
			return bad("lost count")
		}
		l.Lost = int(n)
		return l, nil
	case 'O', 'H', 'A', 'E':
	default:
		return bad("unknown kind")
	}
	if len(f[2]) != 14 {
		return bad("the cycle has 14 digits")
	}
	if l.Cycle, err = strconv.ParseUint(f[2], 16, 64); err != nil {
		return bad("cycle")
	}
	if l.Kind == 'O' {
		if len(f) != 4 || len(f[3]) != (max(nout, 1)+3)/4 {
			return bad(fmt.Sprintf("O takes %d output digits", (max(nout, 1)+3)/4))
		}
		if strings.Trim(f[3], "0123456789abcdef") != "" {
			return bad("outputs")
		}
		l.Outs = f[3]
	} else if len(f) != 3 {
		return bad("too many fields")
	}
	return l, nil
}

// bit returns bit i of a hex field (bit 0 is the low bit of the last digit).
func bit(hex string, i int) int {
	d := len(hex) - 1 - i/4
	if d < 0 {
		return 0
	}
	v, err := strconv.ParseUint(hex[d:d+1], 16, 8)
	if err != nil {
		return 0
	}
	return int(v>>(i%4)) & 1
}

// hexBits formats bits (bit i = v[i]) as n hex digits.
func hexBits(v []int, n int) string {
	var sb strings.Builder
	for d := n - 1; d >= 0; d-- {
		x := 0
		for k := 0; k < 4; k++ {
			if i := 4*d + k; i < len(v) && v[i] != 0 {
				x |= 1 << k
			}
		}
		sb.WriteString(strconv.FormatInt(int64(x), 16))
	}
	return sb.String()
}

// Change is the outputs after one O line.
type Change struct {
	Seq   int            `json:"seq"`
	Cycle uint64         `json:"cycle"`
	Outs  map[string]int `json:"outs"`
}

// Event is what a session streams to its subscribers.
type Event struct {
	Type    string         `json:"type"` // pins | heartbeat | overflow | gap | reset | uart | error | closed
	Seq     int            `json:"seq,omitempty"`
	Cycle   uint64         `json:"cycle,omitempty"`
	Outs    map[string]int `json:"outs,omitempty"`
	Lost    int            `json:"lost,omitempty"`
	Text    string         `json:"text,omitempty"` // uart: what the design sent (sessions without the bridge)
	Message string         `json:"message,omitempty"`
}

// Snapshot is the bridge's state as the host knows it.
type Snapshot struct {
	Epoch   int            `json:"epoch"` // counts resets: cursors from another epoch are void
	Cycle   uint64         `json:"cycle"` // the latest cycle a line carried
	Outs    map[string]int `json:"outs"`
	Inputs  map[string]int `json:"inputs"`    // the HIL values the host set
	Overr   []string       `json:"overrides"` // physical inputs the host has taken over
	Changes int            `json:"changes"`   // the cursor after the last change
	Lost    int            `json:"lost"`      // changes the bridge reported lost since the reset
	Gaps    int            `json:"gaps"`      // lines missing from the sequence since the reset
}

// Conn is one bridge on one serial port.
type Conn struct {
	rw   io.ReadWriteCloser
	m    *board.HILMap
	emit func(Event)

	cmdMu sync.Mutex // one command at a time

	mu      sync.Mutex
	wake    chan struct{} // closed and replaced whenever a line arrives
	ack     chan Line     // the outstanding command's answer
	synced  bool          // a reset's A has arrived: sequence numbers are checked from here
	seq     uint8         // the next sequence number expected
	epoch   int
	cycle   uint64
	at      time.Time // when the line carrying cycle arrived
	outs    []int
	vins    []int
	ovr     []int
	changes []Change
	lost    int
	gaps    int
	err     error
	done    chan struct{}
}

// AckTimeout bounds the wait for a command's A line. The bridge queue can hold 512 lines ahead of it (2 ms
// each at 115200 baud), so a busy bridge may take about a second.
var AckTimeout = 2 * time.Second

// Open starts reading the bridge's lines from rw. emit (optional) receives every event and must not block.
func Open(rw io.ReadWriteCloser, m *board.HILMap, emit func(Event)) *Conn {
	if emit == nil {
		emit = func(Event) {}
	}
	c := &Conn{rw: rw, m: m, emit: emit, wake: make(chan struct{}), done: make(chan struct{}),
		outs: make([]int, len(m.Outputs)), vins: make([]int, len(m.Inputs)), ovr: make([]int, len(m.Inputs))}
	go c.read()
	return c
}

// Close closes the port and waits for the reader.
func (c *Conn) Close() error {
	err := c.rw.Close()
	<-c.done
	return err
}

// Err is the reader's error once the port failed or closed.
func (c *Conn) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

func (c *Conn) read() {
	defer close(c.done)
	sc := bufio.NewScanner(c.rw)
	sc.Buffer(make([]byte, 256), 4096)
	for sc.Scan() {
		c.line(strings.TrimRight(sc.Text(), "\r"))
	}
	err := sc.Err()
	if err == nil {
		err = io.EOF
	}
	c.mu.Lock()
	c.err = errors.Wrapf(ErrBridge, "serial port: %v", err)
	c.broadcastLocked()
	c.mu.Unlock()
}

func (c *Conn) broadcastLocked() {
	close(c.wake)
	c.wake = make(chan struct{})
}

func (c *Conn) outsMap(v []int) map[string]int {
	o := make(map[string]int, len(c.m.Outputs))
	for _, p := range c.m.Outputs {
		o[p.Resource] = v[p.Index]
	}
	return o
}

func (c *Conn) line(s string) {
	l, err := ParseLine(s, len(c.m.Outputs))
	c.mu.Lock()
	defer c.mu.Unlock()
	defer c.broadcastLocked()
	if err != nil {
		if c.synced { // a garbled line is a lost line; before the first reset it is leftover noise
			c.gaps++
			c.emit(Event{Type: "gap", Message: err.Error()})
		}
		return
	}
	if !c.synced {
		// before a reset is acknowledged, lines belong to whatever ran before; only R's A matters
		if l.Kind == 'A' && c.ack != nil && l.Cycle == 0 {
			c.synced = true
			c.seq = l.Seq + 1
			c.stampLocked(l.Cycle)
			c.deliverLocked(l)
		}
		return
	}
	if l.Seq != c.seq {
		missing := int(uint8(l.Seq - c.seq))
		c.gaps += missing
		c.emit(Event{Type: "gap", Lost: missing, Message: fmt.Sprintf("%d HIL line(s) lost between the bridge and the host", missing)})
	}
	c.seq = l.Seq + 1
	switch l.Kind {
	case 'O':
		c.stampLocked(l.Cycle)
		for i := range c.outs {
			c.outs[i] = bit(l.Outs, i)
		}
		ch := Change{Seq: int(l.Seq), Cycle: l.Cycle, Outs: c.outsMap(c.outs)}
		c.changes = append(c.changes, ch)
		c.emit(Event{Type: "pins", Seq: ch.Seq, Cycle: ch.Cycle, Outs: ch.Outs})
	case 'H':
		c.stampLocked(l.Cycle)
		c.emit(Event{Type: "heartbeat", Seq: int(l.Seq), Cycle: l.Cycle})
	case 'A', 'E':
		c.stampLocked(l.Cycle)
		c.deliverLocked(l)
	case 'X':
		c.lost += l.Lost
		c.emit(Event{Type: "overflow", Seq: int(l.Seq), Lost: l.Lost, Message: fmt.Sprintf("HIL overflow: %d output changes lost", l.Lost)})
	}
}

func (c *Conn) stampLocked(cycle uint64) {
	c.cycle, c.at = cycle, time.Now()
}

func (c *Conn) deliverLocked(l Line) {
	if c.ack != nil {
		c.ack <- l
		c.ack = nil
	}
}

// command sends the line build returns (build runs under the state lock, so it can update the state the
// command changes) and waits for its A (or E) line.
func (c *Conn) command(ctx context.Context, build func() string) (Line, error) {
	c.cmdMu.Lock()
	defer c.cmdMu.Unlock()
	ack := make(chan Line, 1)
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return Line{}, c.err
	}
	cmd := build()
	c.ack = ack
	c.mu.Unlock()
	if _, err := io.WriteString(c.rw, cmd+"\n"); err != nil {
		return Line{}, errors.Wrapf(ErrBridge, "serial port: %v", err)
	}
	t := time.NewTimer(AckTimeout)
	defer t.Stop()
	select {
	case l := <-ack:
		if l.Kind == 'E' {
			return l, errors.Wrapf(ErrBridge, "the bridge rejected %q", cmd)
		}
		return l, nil
	case <-t.C:
	case <-ctx.Done():
	case <-c.done:
	}
	c.mu.Lock()
	c.ack = nil
	err := c.err
	c.mu.Unlock()
	if err == nil {
		err = ctx.Err()
	}
	if err == nil {
		err = errors.Wrapf(ErrBridge, "no answer to %q within %s (is a HIL build loaded?)", cmd, AckTimeout)
	}
	return Line{}, err
}

// Reset sends R: the design restarts, the HIL inputs clear and the cycle count restarts at 0. It returns once
// the bridge has reported the outputs out of reset. History, losses and gaps start over.
func (c *Conn) Reset(ctx context.Context) (Snapshot, error) {
	_, err := c.command(ctx, func() string {
		c.synced = false
		c.epoch++
		c.changes, c.lost, c.gaps = nil, 0, 0
		for i := range c.vins {
			c.vins[i], c.ovr[i] = 0, 0
		}
		return "R"
	})
	if err != nil {
		return Snapshot{}, err
	}
	// the bridge forces an O line right after R's A
	deadline := time.Now().Add(AckTimeout)
	for {
		c.mu.Lock()
		n, wake, rerr := len(c.changes), c.wake, c.err
		c.mu.Unlock()
		if n > 0 {
			break
		}
		if rerr != nil {
			return Snapshot{}, rerr
		}
		if time.Now().After(deadline) {
			return Snapshot{}, errors.Wrap(ErrBridge, "R was acknowledged but the outputs were not reported")
		}
		select {
		case <-wake:
		case <-time.After(10 * time.Millisecond):
		case <-ctx.Done():
			return Snapshot{}, ctx.Err()
		}
	}
	snap := c.Snapshot()
	c.emit(Event{Type: "reset", Cycle: snap.Cycle, Outs: snap.Outs})
	return snap, nil
}

// Set changes HIL inputs: 1 or 0 sets the value (a physical input is taken over from its pin), nil gives a
// physical input back to its pin (a virtual one returns to 0). It returns the cycle the values took effect
// by.
func (c *Conn) Set(ctx context.Context, set map[string]*int) (uint64, error) {
	idx := map[string]int{}
	for _, p := range c.m.Inputs {
		idx[p.Resource] = p.Index
	}
	for r := range set {
		if _, ok := idx[r]; !ok {
			return 0, errors.Wrapf(ErrNotInput, "%s is not an input the HIL bridge drives (it drives %s)", r, strings.Join(c.Inputs(), ", "))
		}
	}
	l, err := c.command(ctx, func() string {
		for r, v := range set {
			i := idx[r]
			if v == nil {
				c.vins[i], c.ovr[i] = 0, 0
				continue
			}
			c.vins[i], c.ovr[i] = min(max(*v, 0), 1), 1
		}
		n := (max(len(c.m.Inputs), 1) + 3) / 4
		return "I " + hexBits(c.vins, n) + " " + hexBits(c.ovr, n)
	})
	return l.Cycle, err
}

// Time asks the bridge for its current cycle.
func (c *Conn) Time(ctx context.Context) (uint64, error) {
	l, err := c.command(ctx, func() string { return "T" })
	return l.Cycle, err
}

// Inputs lists the resources the bridge drives.
func (c *Conn) Inputs() []string {
	out := make([]string, len(c.m.Inputs))
	for i, p := range c.m.Inputs {
		out[i] = p.Resource
	}
	return out
}

// Snapshot returns the state as the host knows it.
func (c *Conn) Snapshot() Snapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := Snapshot{Epoch: c.epoch, Cycle: c.cycle, Outs: c.outsMap(c.outs), Inputs: map[string]int{}, Overr: []string{},
		Changes: len(c.changes), Lost: c.lost, Gaps: c.gaps}
	for _, p := range c.m.Inputs {
		s.Inputs[p.Resource] = c.vins[p.Index]
		if c.ovr[p.Index] != 0 && p.Physical {
			s.Overr = append(s.Overr, p.Resource)
		}
	}
	return s
}

// Changes returns the output changes since cursor (a Snapshot.Changes value of the same epoch).
func (c *Conn) Changes(epoch, cursor int) ([]Change, int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if epoch != c.epoch {
		return nil, 0, errors.Errorf("the board was reset since (epoch %d, now %d)", epoch, c.epoch)
	}
	if cursor < 0 || cursor > len(c.changes) {
		return nil, 0, errors.Errorf("cursor %d is outside 0..%d", cursor, len(c.changes))
	}
	return append([]Change{}, c.changes[cursor:]...), len(c.changes), nil
}

// WaitCycle returns once a line stamped target or later has arrived, so every output change up to target
// is in the history. It sleeps until the board should be there (by the latest stamp and the clock rate),
// then asks for the time, and repeats.
func (c *Conn) WaitCycle(ctx context.Context, target uint64) (uint64, error) {
	for {
		c.mu.Lock()
		cyc, at, rerr := c.cycle, c.at, c.err
		c.mu.Unlock()
		if rerr != nil {
			return cyc, rerr
		}
		if cyc >= target {
			return cyc, nil
		}
		ahead := time.Duration(float64(target-cyc) / c.m.Hz * float64(time.Second))
		if sleep := time.Until(at.Add(ahead)); sleep > 0 {
			t := time.NewTimer(sleep)
			select {
			case <-t.C:
			case <-ctx.Done():
				t.Stop()
				return cyc, ctx.Err()
			}
		}
		if _, err := c.Time(ctx); err != nil {
			return cyc, err
		}
	}
}
