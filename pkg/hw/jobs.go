package hw

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pkg/errors"
	"github.com/rs/zerolog/log"
	"github.com/wesen/2026-10-18--weft/pkg/board"
	"github.com/wesen/2026-10-18--weft/pkg/bundle"
	"github.com/wesen/2026-10-18--weft/pkg/toolchain"
	"github.com/wesen/2026-10-18--weft/pkg/validate"
)

// Job states. While a stage runs, the job's state is that stage's name (synth, pnr, pack, load).
const (
	StateQueued      = "queued"
	StateDone        = "done"
	StateFailed      = "failed"
	StateInterrupted = "interrupted" // the server stopped while the job ran
)

// Refusals a caller can act on; the HTTP layer maps each to a status and an error code.
var (
	ErrBusy         = errors.New("this build is still running")
	ErrNoBitstream  = errors.New("this build has no bitstream")
	ErrBoardSession = errors.New("a board session owns the board; close it before loading")
	ErrNoToolchain  = errors.New("the OSS CAD Suite is not available")
)

const (
	logTail   = 500  // log lines a late subscriber receives
	subBuffer = 1024 // events buffered per subscriber before log lines are dropped
)

// Options configure a Manager.
type Options struct {
	WorkDir   string
	MaxBuilds int
	Serial    string
	Board     *board.Board // the attached board (detection and the serial hint)
}

// Manager runs builds and loads for `weft serve`: up to MaxBuilds builds at once, one board operation at a
// time, every job's progress fanned out to subscribers.
type Manager struct {
	opt      Options
	suite    *toolchain.Suite
	suiteErr error
	ctx      context.Context
	cancel   context.CancelFunc
	sem      chan struct{}
	wg       sync.WaitGroup

	boardMu   sync.Mutex // one board operation (load, detect, session) at a time
	boardBusy atomic.Bool
	session   atomic.Bool // set by the board session (P8): loads answer 409 instead of waiting

	mu   sync.Mutex
	jobs map[string]*Job

	status statusCache
}

// NewManager opens the build table. suite may be nil (suiteErr says why): status still answers and builds
// are refused. Builds already on disk are listed as finished jobs.
func NewManager(ctx context.Context, suite *toolchain.Suite, suiteErr error, opt Options) *Manager {
	if opt.MaxBuilds < 1 {
		opt.MaxBuilds = 1
	}
	if opt.Board == nil {
		opt.Board = board.GateMateA1EVB
	}
	ctx, cancel := context.WithCancel(ctx)
	m := &Manager{opt: opt, suite: suite, suiteErr: suiteErr, ctx: ctx, cancel: cancel,
		sem: make(chan struct{}, opt.MaxBuilds), jobs: map[string]*Job{}}
	m.loadExisting()
	return m
}

// Close cancels running jobs and waits for them to write their final state.
func (m *Manager) Close() error {
	m.cancel()
	m.wg.Wait()
	return nil
}

// SetSession marks the board as owned by a board session (or releases it).
func (m *Manager) SetSession(open bool) { m.session.Store(open) }

// BuildRequest is one build submitted through the API.
type BuildRequest struct {
	Bundle      *bundle.Bundle
	Seed        int
	Load        bool
	Force       bool
	ButtonReset string
	Validate    []string          // ladder levels to run after the build
	Vectors     *validate.Vectors // needed by the rtl and net levels
}

// Submit wraps the bundle (refusals come back synchronously) and starts the build in the background.
func (m *Manager) Submit(req BuildRequest) (*Job, error) {
	if m.suite == nil {
		return nil, errors.Wrap(ErrNoToolchain, errMsg(m.suiteErr))
	}
	if err := checkLevels(req.Validate, req.Vectors); err != nil {
		return nil, err
	}
	p, err := prepare(req.Bundle, BuildOptions{WorkDir: m.opt.WorkDir, Seed: req.Seed, ButtonReset: req.ButtonReset})
	if err != nil {
		return nil, err
	}
	j := newJob(m, p.id, req.Bundle.Design, p.dir, p.created, req.Seed)
	j.estimate = req.Bundle.Estimate
	j.state = StateQueued
	for _, s := range []string{"synth", "pnr", "pack"} {
		j.stages = append(j.stages, StageView{Name: s, State: "queued"})
	}
	if req.Load {
		j.stages = append(j.stages, StageView{Name: "load", State: "queued"})
	}
	j.persist()
	m.mu.Lock()
	m.jobs[j.ID] = j
	m.mu.Unlock()
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		m.run(j, p, req)
	}()
	return j, nil
}

func (m *Manager) run(j *Job, p *prepared, req BuildRequest) {
	select {
	case m.sem <- struct{}{}:
	case <-m.ctx.Done():
		j.finish(StateInterrupted, "the server stopped before the build started")
		return
	}
	rep, err := m.suite.Build(m.ctx, p.req, j.events())
	j.setReport(rep)
	if err == nil && rep != nil && rep.OK && len(req.Validate) > 0 {
		m.runValidation(j, req.Vectors, req.Validate)
	}
	<-m.sem
	switch {
	case m.ctx.Err() != nil:
		j.finish(StateInterrupted, "the server stopped during the build")
		return
	case err != nil:
		j.skipStage("", "an earlier stage failed")
		j.finish(StateFailed, err.Error())
		return
	case rep == nil || !rep.OK:
		msg := "the build produced no report"
		if rep != nil {
			msg = rep.Error
		}
		j.skipStage("", "an earlier stage failed")
		j.finish(StateFailed, msg)
		return
	}
	if req.Load {
		if lerr := j.loadable(req.Force); lerr != nil {
			j.skipStage("load", lerr.Error())
			j.finish(StateDone, lerr.Error())
			return
		}
		m.load(j)
		return
	}
	j.finish(StateDone, "")
}

// Validate runs ladder levels for a finished build in the background (the build's slot rules apply).
func (m *Manager) Validate(id string, levels []string, vec *validate.Vectors) (*Job, error) {
	j := m.Job(id)
	if j == nil {
		return nil, os.ErrNotExist
	}
	if m.suite == nil {
		return nil, errors.Wrap(ErrNoToolchain, errMsg(m.suiteErr))
	}
	if err := checkLevels(levels, vec); err != nil {
		return nil, err
	}
	j.mu.Lock()
	if j.active() {
		j.mu.Unlock()
		return nil, ErrBusy
	}
	j.setStateLocked(StateQueued)
	j.mu.Unlock()
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		select {
		case m.sem <- struct{}{}:
		case <-m.ctx.Done():
			j.finish(StateInterrupted, "the server stopped before validation started")
			return
		}
		m.runValidation(j, vec, levels)
		<-m.sem
		if m.ctx.Err() != nil {
			j.finish(StateInterrupted, "the server stopped during validation")
			return
		}
		j.finish(StateDone, "")
	}()
	return j, nil
}

// Load loads a finished build's bitstream. It returns once the load is queued; progress goes to the
// build's subscribers.
func (m *Manager) Load(id string, force bool) (*Job, error) {
	j := m.Job(id)
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
	if m.session.Load() {
		j.mu.Unlock()
		return nil, ErrBoardSession
	}
	j.dropStage("load")
	j.stages = append(j.stages, StageView{Name: "load", State: "queued"})
	j.setStateLocked("load")
	j.mu.Unlock()
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		m.load(j)
	}()
	return j, nil
}

// load runs openFPGALoader under the board lock and finishes the job.
func (m *Manager) load(j *Job) {
	m.boardMu.Lock()
	m.boardBusy.Store(true)
	defer func() { m.boardBusy.Store(false); m.boardMu.Unlock() }()
	if m.session.Load() {
		j.skipStage("load", ErrBoardSession.Error())
		j.finish(StateDone, ErrBoardSession.Error())
		return
	}
	j.mu.Lock()
	bit := filepath.Join(j.Dir, j.report.Bitstream.Path)
	j.mu.Unlock()
	res, err := m.suite.Load(m.ctx, j.Dir, m.opt.Board.Loader, bit, j.events())
	lv := &LoadView{At: time.Now(), OK: err == nil}
	if res != nil {
		lv.Ms, lv.Summary = res.Stage.Ms, res.Stage.Summary
	}
	if err != nil {
		lv.Summary = err.Error()
	}
	j.mu.Lock()
	j.loaded = lv
	if res != nil {
		j.setStageLocked(stageView(res.Stage))
	}
	j.mu.Unlock()
	if m.ctx.Err() != nil {
		j.finish(StateInterrupted, "the server stopped during the load")
		return
	}
	if err != nil {
		j.finish(StateDone, "load failed: "+err.Error())
		return
	}
	j.finish(StateDone, "")
}

// Job returns a job by id, or nil.
func (m *Manager) Job(id string) *Job {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.jobs[id]
}

// Jobs lists jobs newest first.
func (m *Manager) Jobs() []*Job {
	m.mu.Lock()
	out := make([]*Job, 0, len(m.jobs))
	for _, j := range m.jobs {
		out = append(out, j)
	}
	m.mu.Unlock()
	sort.Slice(out, func(a, b int) bool { return out[a].CreatedAt.After(out[b].CreatedAt) })
	return out
}

// running counts jobs that hold or wait for a build slot.
func (m *Manager) running() (building, queued int) {
	for _, j := range m.Jobs() {
		switch st := j.State(); st {
		case StateQueued:
			queued++
		case "synth", "pnr", "pack":
			building++
		}
	}
	return
}

// loadExisting lists builds from earlier runs: job.json when the server made them, report.json when the
// CLI did.
func (m *Manager) loadExisting() {
	entries, err := os.ReadDir(BuildsDir(m.opt.WorkDir))
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir, err := filepath.Abs(filepath.Join(BuildsDir(m.opt.WorkDir), e.Name()))
		if err != nil {
			continue
		}
		if j := m.openJob(e.Name(), dir); j != nil {
			m.jobs[j.ID] = j
		}
	}
}

func (m *Manager) openJob(id, dir string) *Job {
	var rec jobRecord
	if data, err := os.ReadFile(filepath.Join(dir, "job.json")); err == nil {
		if json.Unmarshal(data, &rec) != nil {
			return nil
		}
	} else {
		rec = jobRecord{ID: id, CreatedAt: createdFromID(id, dir)}
	}
	j := newJob(m, id, rec.Design, dir, rec.CreatedAt, rec.Seed)
	j.loaded, j.validation, j.errMsg = rec.Loaded, rec.Validation, rec.Error
	if b, err := OpenBuild(m.opt.WorkDir, dir); err == nil {
		j.report, j.Seed = b.Report, b.Report.Seed
		if j.Design == "" {
			j.Design = b.Report.Design
		}
		for _, st := range b.Report.Stages {
			j.stages = append(j.stages, stageView(st))
		}
	}
	if l := rec.Loaded; l != nil {
		sv := StageView{Name: "load", State: "done", Ms: l.Ms, Summary: l.Summary}
		if !l.OK {
			sv.State = "failed"
		}
		j.stages = append(j.stages, sv)
	}
	if data, err := os.ReadFile(filepath.Join(dir, "bundle.json")); err == nil {
		var bn struct {
			Estimate json.RawMessage `json:"estimate"`
		}
		if json.Unmarshal(data, &bn) == nil {
			j.estimate = bn.Estimate
		}
	}
	switch {
	case rec.State == StateDone || rec.State == StateFailed || rec.State == StateInterrupted:
		j.state = rec.State
	case rec.State != "":
		j.state, j.errMsg = StateInterrupted, "the server stopped while this job ran"
	case j.report != nil && j.report.OK:
		j.state = StateDone
	default:
		j.state = StateFailed
	}
	return j
}

func createdFromID(id, dir string) time.Time {
	if len(id) >= 15 {
		if t, err := time.ParseInLocation("20060102-150405", id[:15], time.Local); err == nil {
			return t
		}
	}
	if st, err := os.Stat(dir); err == nil {
		return st.ModTime()
	}
	return time.Time{}
}

func errMsg(err error) string {
	if err == nil {
		return "no suite configured"
	}
	return err.Error()
}

// StageView is one stage as the API shows it.
type StageView struct {
	Name    string `json:"name"`
	State   string `json:"state"` // queued | running | done | failed | skipped
	Ms      int64  `json:"ms,omitempty"`
	Exit    int    `json:"exit,omitempty"`
	Summary string `json:"summary,omitempty"`
}

func stageView(st toolchain.Stage) StageView {
	state := "done"
	if !st.OK {
		state = "failed"
	}
	return StageView{Name: st.Name, State: state, Ms: st.Ms, Exit: st.Exit, Summary: st.Summary}
}

// LoadView is the last load of a build.
type LoadView struct {
	At      time.Time `json:"at"`
	OK      bool      `json:"ok"`
	Ms      int64     `json:"ms,omitempty"`
	Summary string    `json:"summary,omitempty"`
}

// Event is one message on a build's event stream.
type Event struct {
	Type    string            `json:"type"` // snapshot | state | stage | log | report | validation | done
	State   string            `json:"state,omitempty"`
	Name    string            `json:"name,omitempty"`
	Ms      int64             `json:"ms,omitempty"`
	Summary string            `json:"summary,omitempty"`
	Stage   string            `json:"stage,omitempty"`
	Line    string            `json:"line,omitempty"`
	Report  *toolchain.Report `json:"report,omitempty"`
	OK      *bool             `json:"ok,omitempty"`
	Error   string            `json:"error,omitempty"`
	Job     *JobView          `json:"job,omitempty"`
	Result  *validate.Result  `json:"result,omitempty"`
}

// JobView is a job as the API returns it.
type JobView struct {
	ID         string            `json:"id"`
	Design     string            `json:"design"`
	State      string            `json:"state"`
	CreatedAt  time.Time         `json:"createdAt"`
	Seed       int               `json:"seed"`
	OK         bool              `json:"ok"`
	TimingOK   bool              `json:"timingOk"`
	Stages     []StageView       `json:"stages,omitempty"`
	Report     *toolchain.Report `json:"report,omitempty"`
	Estimate   json.RawMessage   `json:"estimate,omitempty"`
	Loaded     *LoadView         `json:"loaded,omitempty"`
	Validation []validate.Result `json:"validation,omitempty"`
	Error      string            `json:"error,omitempty"`
}

type jobRecord struct {
	ID         string            `json:"id"`
	Design     string            `json:"design"`
	CreatedAt  time.Time         `json:"createdAt"`
	Seed       int               `json:"seed"`
	State      string            `json:"state"`
	Loaded     *LoadView         `json:"loaded,omitempty"`
	Validation []validate.Result `json:"validation,omitempty"`
	Error      string            `json:"error,omitempty"`
}

// Job is one build and the loads of its bitstream.
type Job struct {
	ID        string
	Design    string
	Dir       string
	CreatedAt time.Time
	Seed      int

	m          *Manager
	mu         sync.Mutex
	state      string
	stages     []StageView
	report     *toolchain.Report
	estimate   json.RawMessage
	loaded     *LoadView
	validation []validate.Result
	errMsg     string
	logs       []Event
	subs       map[*subscriber]struct{}
	changed    chan struct{} // closed and replaced on every state change
}

func newJob(m *Manager, id, design, dir string, created time.Time, seed int) *Job {
	return &Job{ID: id, Design: design, Dir: dir, CreatedAt: created, Seed: seed, m: m,
		subs: map[*subscriber]struct{}{}, changed: make(chan struct{})}
}

// State is the job's current state.
func (j *Job) State() string {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.state
}

func (j *Job) active() bool {
	switch j.state {
	case StateDone, StateFailed, StateInterrupted:
		return false
	}
	return true
}

// View snapshots the job.
func (j *Job) View() JobView {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.viewLocked()
}

func (j *Job) viewLocked() JobView {
	v := JobView{ID: j.ID, Design: j.Design, State: j.state, CreatedAt: j.CreatedAt, Seed: j.Seed,
		Stages: append([]StageView(nil), j.stages...), Report: j.report, Estimate: j.estimate, Loaded: j.loaded,
		Validation: append([]validate.Result(nil), j.validation...), Error: j.errMsg}
	if j.report != nil {
		v.OK, v.TimingOK = j.report.OK, j.report.TimingOK
	}
	return v
}

// Wait blocks until the job is idle (done, failed, interrupted) or d passes, then returns its view.
func (j *Job) Wait(ctx context.Context, d time.Duration) JobView {
	timer := time.NewTimer(d)
	defer timer.Stop()
	for {
		j.mu.Lock()
		if !j.active() {
			v := j.viewLocked()
			j.mu.Unlock()
			return v
		}
		ch := j.changed
		j.mu.Unlock()
		select {
		case <-ch:
		case <-timer.C:
			return j.View()
		case <-ctx.Done():
			return j.View()
		}
	}
}

func (j *Job) loadable(force bool) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.loadableLocked(force)
}

func (j *Job) loadableLocked(force bool) error {
	if j.report == nil || !j.report.OK || j.report.Bitstream == nil {
		return ErrNoBitstream
	}
	if !j.report.TimingOK && !force {
		return ErrNeedsForce
	}
	return nil
}

// events adapts toolchain progress to the job's stages and subscribers.
func (j *Job) events() toolchain.Events {
	return toolchain.Events{
		Stage: func(name, state string, st *toolchain.Stage) {
			j.mu.Lock()
			defer j.mu.Unlock()
			if state == "running" {
				j.setStateLocked(name)
			}
			j.setStageLocked(StageView{Name: name, State: state, Ms: st.Ms, Exit: st.Exit, Summary: st.Summary})
		},
		Log: func(stage, line string) {
			j.mu.Lock()
			defer j.mu.Unlock()
			ev := Event{Type: "log", Stage: stage, Line: line}
			j.logs = append(j.logs, ev)
			if len(j.logs) > 2*logTail {
				j.logs = append(j.logs[:0:0], j.logs[len(j.logs)-logTail:]...)
			}
			j.publishLocked(ev)
		},
	}
}

// setStageLocked records a stage and tells subscribers.
func (j *Job) setStageLocked(sv StageView) {
	found := false
	for i := range j.stages {
		if j.stages[i].Name == sv.Name {
			j.stages[i], found = sv, true
		}
	}
	if !found {
		j.stages = append(j.stages, sv)
	}
	j.publishLocked(Event{Type: "stage", Name: sv.Name, State: sv.State, Ms: sv.Ms, Summary: sv.Summary})
}

// setReport stores the report and takes the final stage views from it: a tool's "done" event comes before
// the runner writes the stage's summary, or fails it after the fact (nextpnr ERROR lines, a PLL mismatch).
func (j *Job) setReport(r *toolchain.Report) {
	if r == nil {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	j.report = r
	for _, st := range r.Stages {
		j.setStageLocked(stageView(st))
	}
	j.publishLocked(Event{Type: "report", Report: r})
}

// skipStage marks a queued stage (every queued stage when name is "") as skipped.
func (j *Job) skipStage(name, why string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	for i := range j.stages {
		if (name == "" || j.stages[i].Name == name) && j.stages[i].State == "queued" {
			j.stages[i].State, j.stages[i].Summary = "skipped", why
			j.publishLocked(Event{Type: "stage", Name: name, State: "skipped", Summary: why})
		}
	}
}

func (j *Job) dropStage(name string) {
	out := j.stages[:0]
	for _, s := range j.stages {
		if s.Name != name {
			out = append(out, s)
		}
	}
	j.stages = out
}

func (j *Job) setStateLocked(state string) {
	if j.state == state {
		return
	}
	j.state = state
	close(j.changed)
	j.changed = make(chan struct{})
	j.publishLocked(Event{Type: "state", State: state})
}

func (j *Job) finish(state, msg string) {
	j.mu.Lock()
	j.errMsg = msg
	ok := state == StateDone && j.report != nil && j.report.OK
	j.setStateLocked(state)
	j.publishLocked(Event{Type: "done", OK: &ok, Error: msg})
	j.mu.Unlock()
	j.persist()
}

func (j *Job) persist() {
	j.mu.Lock()
	rec := jobRecord{ID: j.ID, Design: j.Design, CreatedAt: j.CreatedAt, Seed: j.Seed, State: j.state, Loaded: j.loaded, Validation: j.validation, Error: j.errMsg}
	j.mu.Unlock()
	data, _ := json.MarshalIndent(rec, "", "  ")
	if err := os.WriteFile(filepath.Join(j.Dir, "job.json"), append(data, '\n'), 0o644); err != nil {
		log.Warn().Err(err).Str("build", j.ID).Msg("could not write job.json")
	}
}

// subscriber is one event-stream reader. Log lines are dropped when it falls behind; any other event that
// does not fit closes it, so the client reconnects and starts from a fresh snapshot.
type subscriber struct {
	ch     chan Event
	closed chan struct{}
	once   sync.Once
	lost   int
}

func (s *subscriber) close() { s.once.Do(func() { close(s.closed) }) }

// Subscribe returns a stream that starts with a snapshot of the job and the tail of its log.
func (j *Job) Subscribe() (*subscriber, func()) {
	s := &subscriber{ch: make(chan Event, subBuffer), closed: make(chan struct{})}
	j.mu.Lock()
	v := j.viewLocked()
	s.ch <- Event{Type: "snapshot", Job: &v}
	tail := j.logs
	if len(tail) > logTail {
		tail = tail[len(tail)-logTail:]
	}
	for _, ev := range tail {
		s.ch <- ev
	}
	j.subs[s] = struct{}{}
	j.mu.Unlock()
	return s, func() {
		j.mu.Lock()
		delete(j.subs, s)
		j.mu.Unlock()
		s.close()
	}
}

func (j *Job) publishLocked(ev Event) {
	for s := range j.subs {
		select {
		case s.ch <- ev:
		default:
			if ev.Type == "log" {
				s.lost++
				continue
			}
			delete(j.subs, s)
			s.close()
		}
	}
}

// Files lists the build directory's files (relative paths), skipping directories.
func (j *Job) Files() []string {
	var out []string
	_ = filepath.WalkDir(j.Dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		rel, rerr := filepath.Rel(j.Dir, p)
		if rerr == nil && !strings.HasPrefix(rel, ".") {
			out = append(out, filepath.ToSlash(rel))
		}
		return nil
	})
	sort.Strings(out)
	return out
}
