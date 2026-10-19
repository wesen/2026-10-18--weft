package hw

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/pkg/errors"
	"github.com/wesen/2026-10-18--weft/pkg/board"
	"github.com/wesen/2026-10-18--weft/pkg/bundle"
	"github.com/wesen/2026-10-18--weft/pkg/hil"
)

// Session modes: what a board session can observe and drive.
const (
	ModeHIL  = "hil"  // the build carries weft_hil: outputs stamped with board cycles, HIL inputs settable
	ModeUART = "uart" // the design owns the UART: the session relays its text, timed by the host's clock
	ModeNone = "none" // nothing to observe: the session only holds the board with the design loaded
)

var (
	ErrSessionOpen = errors.New("a board session is already open; close it first")
	ErrNoSession   = errors.New("no board session is open")
	ErrBoardBusy   = errors.New("the board is busy with a load; try again when it ends")
	ErrMode        = errors.New("this board session cannot do that")
)

// openPort opens the board's serial port; tests replace it.
var openPort = defaultOpenPort

func defaultOpenPort(dev string, baud int) (io.ReadWriteCloser, error) {
	p, err := openSerial(dev, baud)
	if err != nil {
		return nil, err
	}
	p.drain(300 * time.Millisecond)
	return p, nil
}

// Session is the open board session: it holds the board lock, the serial port and the loaded build.
type Session struct {
	ID       string
	Build    string
	Design   string
	Mode     string
	HIL      *board.HILMap
	OpenedAt time.Time

	port io.ReadWriteCloser
	conn *hil.Conn // ModeHIL
	baud int

	umu   sync.Mutex // ModeUART: the design's text since the session opened
	text  []byte
	uwake chan struct{}
	udone chan struct{}

	smu    sync.Mutex
	subs   map[chan hil.Event]struct{}
	closed bool
}

// SessionView is the session as the API returns it.
type SessionView struct {
	Session  string         `json:"session"`
	Build    string         `json:"build"`
	Design   string         `json:"design"`
	Mode     string         `json:"mode"`
	Hz       float64        `json:"hz,omitempty"`
	Inputs   []board.HILPin `json:"inputs"`
	Outputs  []board.HILPin `json:"outputs"`
	UART     bool           `json:"uart"` // the design's own UART is relayed (ModeUART)
	OpenedAt time.Time      `json:"openedAt"`
	State    *hil.Snapshot  `json:"state,omitempty"`
	Error    string         `json:"error,omitempty"` // the serial port failed
}

// View snapshots the session.
func (s *Session) View() SessionView {
	v := SessionView{Session: s.ID, Build: s.Build, Design: s.Design, Mode: s.Mode, Inputs: []board.HILPin{},
		Outputs: []board.HILPin{}, UART: s.Mode == ModeUART, OpenedAt: s.OpenedAt}
	if s.HIL != nil {
		v.Hz = s.HIL.Hz
		v.Inputs = append(v.Inputs, s.HIL.Inputs...)
		v.Outputs = append(v.Outputs, s.HIL.Outputs...)
	}
	if s.conn != nil {
		st := s.conn.Snapshot()
		v.State = &st
		if err := s.conn.Err(); err != nil {
			v.Error = err.Error()
		}
	}
	return v
}

// Session returns the open session, or nil.
func (m *Manager) Session() *Session {
	m.sessMu.Lock()
	defer m.sessMu.Unlock()
	return m.sess
}

// OpenSession takes the board for a session: it loads the build and, with the HIL bridge, resets the design
// so the session starts at cycle 0. Loads answer 409 until CloseSession.
func (m *Manager) OpenSession(ctx context.Context, build string, force bool) (*Session, error) {
	m.sessMu.Lock()
	defer m.sessMu.Unlock()
	if m.sess != nil {
		return nil, ErrSessionOpen
	}
	j := m.Job(build)
	if j == nil {
		return nil, os.ErrNotExist
	}
	if m.suite == nil {
		return nil, errors.Wrap(ErrNoToolchain, errMsg(m.suiteErr))
	}
	j.mu.Lock()
	if j.active() {
		j.mu.Unlock()
		return nil, ErrBusy
	}
	if err := j.loadableLocked(force); err != nil {
		j.mu.Unlock()
		return nil, err
	}
	rep := j.report
	j.mu.Unlock()

	s := &Session{ID: newSessionID(), Build: j.ID, Design: j.Design, OpenedAt: time.Now(), HIL: rep.HIL,
		subs: map[chan hil.Event]struct{}{}}
	switch {
	case rep.HIL != nil:
		s.Mode, s.baud = ModeHIL, rep.HIL.Baud
	case usesUART(j.Dir):
		s.Mode, s.baud = ModeUART, board.HILBaud
	default:
		s.Mode = ModeNone
	}
	if s.Mode != ModeNone && m.opt.Serial == "" {
		return nil, errors.New("no serial port is configured (weft serve --serial)")
	}
	if !m.boardMu.TryLock() {
		return nil, ErrBoardBusy
	}
	m.session.Store(true)
	release := func() { m.session.Store(false); m.boardMu.Unlock() }

	j.mu.Lock()
	j.dropStage("load")
	j.stages = append(j.stages, StageView{Name: "load", State: "queued"})
	j.setStateLocked("load")
	j.mu.Unlock()
	if err := m.loadLocked(j); err != nil {
		release()
		return nil, errors.Wrap(err, "load")
	}
	if s.Mode != ModeNone {
		p, err := openPort(m.opt.Serial, s.baud)
		if err != nil {
			release()
			return nil, err
		}
		s.port = p
	}
	switch s.Mode {
	case ModeHIL:
		s.conn = hil.Open(s.port, s.HIL, s.publish)
		if _, err := s.conn.Reset(ctx); err != nil {
			_ = s.conn.Close()
			release()
			return nil, err
		}
	case ModeUART:
		s.uwake, s.udone = make(chan struct{}), make(chan struct{})
		go s.readUART()
	}
	m.sess = s
	return s, nil
}

// CloseSession releases the serial port and the board.
func (m *Manager) CloseSession() error {
	m.sessMu.Lock()
	defer m.sessMu.Unlock()
	s := m.sess
	if s == nil {
		return ErrNoSession
	}
	s.close()
	m.sess = nil
	m.session.Store(false)
	m.boardMu.Unlock()
	return nil
}

func (s *Session) close() {
	switch {
	case s.conn != nil:
		_ = s.conn.Close()
	case s.port != nil:
		_ = s.port.Close()
		<-s.udone
	}
	s.smu.Lock()
	s.closed = true
	for ch := range s.subs {
		select {
		case ch <- hil.Event{Type: "closed"}:
		default:
		}
		close(ch)
	}
	s.subs = map[chan hil.Event]struct{}{}
	s.smu.Unlock()
}

func newSessionID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return "s-" + hex.EncodeToString(b)
}

// usesUART tells whether the build's design binds the board's UART.
func usesUART(dir string) bool {
	bn, err := bundle.Load(filepath.Join(dir, "bundle.json"))
	if err != nil {
		return false
	}
	for _, p := range bn.Ports {
		for _, b := range p.Bits {
			if strings.HasPrefix(b.Resource, "uart.") {
				return true
			}
		}
	}
	return false
}

// Subscribe streams the session's events; the channel closes with the session.
func (s *Session) Subscribe() (<-chan hil.Event, func()) {
	ch := make(chan hil.Event, subBuffer)
	s.smu.Lock()
	if s.closed {
		close(ch)
	} else {
		s.subs[ch] = struct{}{}
	}
	s.smu.Unlock()
	return ch, func() {
		s.smu.Lock()
		if _, ok := s.subs[ch]; ok {
			delete(s.subs, ch)
			close(ch)
		}
		s.smu.Unlock()
	}
}

// publish fans an event out; a subscriber that falls behind loses events rather than stalling the reader.
func (s *Session) publish(ev hil.Event) {
	s.smu.Lock()
	defer s.smu.Unlock()
	for ch := range s.subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

// Reset restarts the design at cycle 0 (ModeHIL).
func (s *Session) Reset(ctx context.Context) (hil.Snapshot, error) {
	if s.conn == nil {
		return hil.Snapshot{}, errors.Wrap(ErrMode, "only a build with the HIL bridge can reset the design (build with hil)")
	}
	return s.conn.Reset(ctx)
}

// SetInputs changes HIL inputs (ModeHIL); see hil.Conn.Set.
func (s *Session) SetInputs(ctx context.Context, set map[string]*int) (uint64, error) {
	if s.conn == nil {
		return 0, errors.Wrap(ErrMode, "only a build with the HIL bridge can drive inputs (build with hil)")
	}
	return s.conn.Set(ctx, set)
}

// WaitResult is what a wait returns: the cycle reached and the output changes since the caller's cursor.
type WaitResult struct {
	Reached bool         `json:"reached"` // the board passed the target (false: the wait timed out first)
	Cycle   uint64       `json:"cycle"`
	Epoch   int          `json:"epoch"`
	Changes []hil.Change `json:"changes"`
	Cursor  int          `json:"cursor"`
	Lost    int          `json:"lost"`
	Gaps    int          `json:"gaps"`
}

// Wait blocks until the board passes cycle target or d elapses, then returns the changes after cursor.
func (s *Session) Wait(ctx context.Context, target uint64, epoch, cursor int, d time.Duration) (*WaitResult, error) {
	if s.conn == nil {
		return nil, errors.Wrap(ErrMode, "only a build with the HIL bridge counts board cycles (build with hil)")
	}
	wctx, cancel := context.WithTimeout(ctx, d)
	defer cancel()
	cyc, err := s.conn.WaitCycle(wctx, target)
	if err != nil && !(errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil) {
		return nil, err
	}
	snap := s.conn.Snapshot()
	ch, cur, err := s.conn.Changes(epoch, cursor)
	if err != nil {
		return nil, err
	}
	return &WaitResult{Reached: cyc >= target, Cycle: max(cyc, snap.Cycle), Epoch: snap.Epoch, Changes: ch, Cursor: cur,
		Lost: snap.Lost, Gaps: snap.Gaps}, nil
}

func (s *Session) readUART() {
	defer close(s.udone)
	buf := make([]byte, 4096)
	for {
		n, err := s.port.Read(buf)
		if n > 0 {
			s.umu.Lock()
			s.text = append(s.text, buf[:n]...)
			close(s.uwake)
			s.uwake = make(chan struct{})
			s.umu.Unlock()
			s.publish(hil.Event{Type: "uart", Text: string(buf[:n])})
		}
		if err != nil {
			if !errors.Is(err, os.ErrClosed) {
				s.publish(hil.Event{Type: "error", Message: "serial port: " + err.Error()})
			}
			return
		}
	}
}

// SendUART writes text to the design's UART (ModeUART), paced for the USB bridge.
func (s *Session) SendUART(text string) error {
	if s.Mode != ModeUART {
		return errors.Wrap(ErrMode, "the UART belongs to the HIL bridge or is unused in this build")
	}
	return writePaced(s.port, []byte(text), s.baud, 1024)
}

// UARTText returns the design's text after byte offset since, waiting up to d for some to arrive.
func (s *Session) UARTText(ctx context.Context, since int, d time.Duration) (string, int, error) {
	if s.Mode != ModeUART {
		return "", 0, errors.Wrap(ErrMode, "this build does not use the UART")
	}
	t := time.NewTimer(d)
	defer t.Stop()
	for {
		s.umu.Lock()
		n, wake := len(s.text), s.uwake
		if since < 0 || since > n {
			s.umu.Unlock()
			return "", n, errors.Errorf("offset %d is outside 0..%d", since, n)
		}
		if n > since || d <= 0 {
			text := string(s.text[since:])
			s.umu.Unlock()
			return text, n, nil
		}
		s.umu.Unlock()
		select {
		case <-wake:
		case <-t.C:
			return "", n, nil
		case <-ctx.Done():
			return "", n, ctx.Err()
		case <-s.udone:
			return "", n, errors.New("the serial port closed")
		}
	}
}
