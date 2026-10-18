package hw

import (
	"context"
	"os"
	"sync"
	"time"
)

const detectTTL = 10 * time.Second

// Status is GET /api/hw/status.
type Status struct {
	Toolchain ToolchainStatus `json:"toolchain"`
	Board     BoardStatus     `json:"board"`
	Serial    SerialStatus    `json:"serial"`
	Busy      BusyStatus      `json:"busy"`
}

type ToolchainStatus struct {
	OK       bool              `json:"ok"`
	Suite    string            `json:"suite,omitempty"`
	Version  string            `json:"version,omitempty"`
	Versions map[string]string `json:"versions,omitempty"`
	Error    string            `json:"error,omitempty"`
}

type BoardStatus struct {
	Name     string    `json:"name"`
	Title    string    `json:"title"`
	Detected bool      `json:"detected"`
	IDCode   string    `json:"idcode,omitempty"`
	Chip     string    `json:"chip,omitempty"`
	Error    string    `json:"error,omitempty"`
	At       time.Time `json:"at,omitzero"`
}

type SerialStatus struct {
	Device  string `json:"device"`
	Present bool   `json:"present"`
}

type BusyStatus struct {
	Board   bool `json:"board"`
	Session bool `json:"session"`
	Builds  int  `json:"builds"`
	Queued  int  `json:"queued"`
}

type statusCache struct {
	mu       sync.Mutex
	versions map[string]string
	verErr   string
	board    BoardStatus
}

// Status reports the toolchain, the board and what is running. Tool versions are asked once; detection
// runs at most every 10 s, and never while a load or session holds the board (the last result is kept).
func (m *Manager) Status(ctx context.Context, detect bool) Status {
	st := Status{Serial: SerialStatus{Device: m.opt.Serial}}
	if m.opt.Serial != "" {
		_, err := os.Stat(m.opt.Serial)
		st.Serial.Present = err == nil
	}
	st.Busy.Builds, st.Busy.Queued = m.running()
	st.Busy.Board, st.Busy.Session = m.boardBusy.Load(), m.session.Load()

	c := &m.status
	c.mu.Lock()
	defer c.mu.Unlock()
	if m.suite == nil {
		st.Toolchain.Error = errMsg(m.suiteErr)
	} else {
		st.Toolchain.Suite, st.Toolchain.Version = m.suite.Root, m.suite.Version()
		if c.versions == nil {
			c.versions = map[string]string{}
			for _, v := range m.suite.Versions(ctx) {
				if v.Err != nil {
					c.verErr = v.Tool + ": " + v.Err.Error()
					continue
				}
				c.versions[v.Tool] = v.Version
			}
		}
		st.Toolchain.Versions, st.Toolchain.Error = c.versions, c.verErr
		st.Toolchain.OK = c.verErr == ""
	}

	b := m.opt.Board
	if c.board.Name == "" {
		c.board = BoardStatus{Name: b.Name, Title: b.Title}
	}
	if detect && m.suite != nil && time.Since(c.board.At) > detectTTL && m.boardMu.TryLock() {
		chip, err := m.suite.Detect(ctx, b.Loader)
		m.boardMu.Unlock()
		c.board = BoardStatus{Name: b.Name, Title: b.Title, At: time.Now()}
		if err != nil {
			c.board.Error = err.Error()
		} else {
			c.board.Detected, c.board.IDCode = true, chip.IDCode
			c.board.Chip = chip.Manufacturer + " " + chip.Family + " " + chip.Model
		}
	}
	st.Board = c.board
	return st
}
