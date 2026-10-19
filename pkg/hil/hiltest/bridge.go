// Package hiltest is a software weft_hil for tests: it speaks the bridge's protocol over a pipe and runs a
// model of the design on the wall clock at the map's rate (keep it low, e.g. 100 kHz).
package hiltest

import (
	"bufio"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wesen/2026-10-18--weft/pkg/board"
)

// Model gives the outputs at a cycle (since the last R), from the HIL inputs as they are at that cycle.
// Inputs here are the bridge's view: vins where ovr is set, else the pin (always 0 in the fake).
type Model func(cycle uint64, in []int) []int

// Bridge is a running fake.
type Bridge struct {
	m     *board.HILMap
	model Model
	// Drop, when set, makes the fake skip the line with this sequence number (a USB loss).
	Drop func(seq uint8) bool

	hostR *io.PipeReader // what the host reads
	outW  *io.PipeWriter
	inR   *io.PipeReader // what the host writes
	hostW *io.PipeWriter
	cmds  chan string
	stop  chan struct{}
	done  chan struct{}
	once  sync.Once
}

// New starts a fake bridge. Its host end is the returned bridge itself (an io.ReadWriteCloser).
func New(m *board.HILMap, model Model) *Bridge {
	b := &Bridge{m: m, model: model, cmds: make(chan string, 16), stop: make(chan struct{}), done: make(chan struct{})}
	b.hostR, b.outW = io.Pipe()
	b.inR, b.hostW = io.Pipe()
	go b.readCommands()
	go b.run()
	return b
}

func (b *Bridge) Read(p []byte) (int, error)  { return b.hostR.Read(p) }
func (b *Bridge) Write(p []byte) (int, error) { return b.hostW.Write(p) }

// Close stops the fake; the host's reads end.
func (b *Bridge) Close() error {
	b.once.Do(func() {
		close(b.stop)
		_ = b.hostW.Close()
		_ = b.outW.Close()
		_ = b.hostR.Close()
	})
	<-b.done
	return nil
}

func (b *Bridge) readCommands() {
	sc := bufio.NewScanner(b.inR)
	for sc.Scan() {
		select {
		case b.cmds <- sc.Text():
		case <-b.stop:
			return
		}
	}
}

func (b *Bridge) run() {
	defer close(b.done)
	nin, nout := max(len(b.m.Inputs), 1), max(len(b.m.Outputs), 1)
	vins, ovr := make([]int, nin), make([]int, nin)
	var seq uint8
	t0 := time.Now()
	cur := uint64(0)
	last := b.model(0, make([]int, nin))
	send := func(format string, args ...any) bool {
		line := fmt.Sprintf(format, args...)
		s := seq
		seq++
		if b.Drop != nil && b.Drop(s) {
			return true
		}
		_, err := io.WriteString(b.outW, fmt.Sprintf(line, s))
		return err == nil
	}
	in := func() []int {
		v := make([]int, nin)
		for i := range v {
			if ovr[i] != 0 || i >= len(b.m.Inputs) || !b.m.Inputs[i].Physical {
				v[i] = vins[i]
			}
		}
		return v
	}
	hex := func(v []int) string {
		n := (nout + 3) / 4
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
	// advance evaluates every cycle up to now, reporting changes and heartbeats in order
	advance := func() bool {
		target := uint64(time.Since(t0).Seconds() * b.m.Hz)
		inputs := in() // inputs change only between advances
		for cur < target {
			cur++
			o := b.model(cur, inputs)
			if !equal(o, last) {
				last = o
				if !send("O %%02x %014x %s\n", cur, hex(o)) {
					return false
				}
			}
			if cur%(1<<20) == 0 && !send("H %%02x %014x\n", cur) {
				return false
			}
		}
		return true
	}
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-b.stop:
			return
		case <-tick.C:
			if !advance() {
				return
			}
		case cmd := <-b.cmds:
			if !advance() {
				return
			}
			f := strings.Fields(cmd)
			ok := true
			switch {
			case len(f) == 1 && f[0] == "R":
				for i := range vins {
					vins[i], ovr[i] = 0, 0
				}
				t0, cur = time.Now(), 0
				last = b.model(0, in())
				ok = send("A %%02x %014x\n", 0) && send("O %%02x %014x %s\n", 1, hex(last))
				t0 = t0.Add(-time.Duration(float64(time.Second) / b.m.Hz)) // the O line was cycle 1
				cur = 1
			case len(f) == 1 && f[0] == "T":
				ok = send("A %%02x %014x\n", cur)
			case len(f) == 3 && f[0] == "I":
				v, e1 := strconv.ParseUint(f[1], 16, 64)
				o, e2 := strconv.ParseUint(f[2], 16, 64)
				if e1 != nil || e2 != nil {
					ok = send("E %%02x %014x\n", cur)
					break
				}
				for i := range vins {
					vins[i], ovr[i] = int(v>>i)&1, int(o>>i)&1
				}
				if out := b.model(cur, in()); !equal(out, last) {
					last = out
					ok = send("O %%02x %014x %s\n", cur, hex(out))
				}
				ok = ok && send("A %%02x %014x\n", cur)
			default:
				ok = send("E %%02x %014x\n", cur)
			}
			if !ok {
				return
			}
		}
	}
}

func equal(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
