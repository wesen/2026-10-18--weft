package sampler

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"os/exec"
	"sync"
	"time"

	"github.com/pkg/errors"
	"golang.org/x/sync/errgroup"
)

type Client struct {
	cmd     *exec.Cmd
	in      io.WriteCloser
	cancel  context.CancelFunc
	writeMu sync.Mutex
	mu      sync.Mutex
	pending map[string]chan Event
	models  []Model
	done    chan struct{}
	group   *errgroup.Group
	err     error
}

var _ Backend = (*Client)(nil)

func Start(ctx context.Context, node, worker, agentDir, cwd string, tiers map[string]string) (*Client, error) {
	ctx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(ctx, node, worker)
	cmd.Dir = cwd
	cmd.Stderr = io.Discard
	in, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		cancel()
		return nil, errors.Wrap(err, "start Pi worker")
	}
	group, _ := errgroup.WithContext(ctx)
	c := &Client{cmd: cmd, in: in, cancel: cancel, pending: map[string]chan Event{}, done: make(chan struct{}), group: group}
	ready := make(chan Event, 1)
	group.Go(func() error {
		defer close(c.done)
		scan := bufio.NewScanner(out)
		scan.Buffer(make([]byte, 65536), 16<<20)
		for scan.Scan() {
			var event Event
			if err := json.Unmarshal(scan.Bytes(), &event); err != nil {
				c.cancel()
				c.setError(errors.Wrap(err, "invalid worker frame"))
				break
			}
			if event.Type == "ready" || event.Type == "fatal" {
				select {
				case ready <- event:
				default:
				}
				if event.Type == "fatal" {
					c.setError(event.Error)
					c.cancel()
					break
				}
				continue
			}
			c.mu.Lock()
			ch := c.pending[event.CallID]
			c.mu.Unlock()
			if ch != nil {
				select {
				case ch <- event:
				case <-ctx.Done():
					return nil
				}
			}
		}
		err := scan.Err()
		if err == nil {
			err = errors.New("Pi worker exited")
		}
		c.setError(err)
		c.cancel()
		return nil
	})
	if err = c.send(map[string]any{"type": "init", "agentDir": agentDir, "cwd": cwd, "tiers": tiers}); err != nil {
		_ = c.Close()
		return nil, err
	}
	timer := time.NewTimer(30 * time.Second)
	defer timer.Stop()
	select {
	case event := <-ready:
		if event.Type == "fatal" {
			_ = c.Close()
			return nil, event.Error
		}
		c.models = event.Models
		return c, nil
	case <-timer.C:
		_ = c.Close()
		return nil, errors.New("Pi worker initialization timed out")
	case <-c.done:
		_ = c.Close()
		return nil, c.lastError()
	case <-ctx.Done():
		_ = c.Close()
		return nil, ctx.Err()
	}
}
func (c *Client) setError(err error) { c.mu.Lock(); defer c.mu.Unlock(); c.err = err }
func (c *Client) lastError() error   { c.mu.Lock(); defer c.mu.Unlock(); return c.err }
func (c *Client) Models() []Model {
	select {
	case <-c.done:
		return []Model{}
	default:
	}
	return append([]Model(nil), c.models...)
}
func (c *Client) send(v any) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return json.NewEncoder(c.in).Encode(v)
}
func (c *Client) Close() error {
	c.cancel()
	_ = c.in.Close()
	_ = c.group.Wait()
	_ = c.cmd.Wait()
	return nil
}
func (c *Client) Sample(ctx context.Context, r Request, emit func(Event), execute ExecuteTool) error {
	ch := make(chan Event, 64)
	wireID := rand.Text()
	c.mu.Lock()
	c.pending[wireID] = ch
	c.mu.Unlock()
	defer func() { c.mu.Lock(); delete(c.pending, wireID); c.mu.Unlock() }()
	wire := struct {
		Type string `json:"type"`
		Request
	}{Type: "sample", Request: r}
	wire.CallID = wireID
	if err := c.send(wire); err != nil {
		return err
	}
	toolBase, stopTools := context.WithCancel(ctx)
	tools, toolCtx := errgroup.WithContext(toolBase)
	defer func() { stopTools(); _ = tools.Wait() }()
	ctxDone := ctx.Done()
	var cancelErr error
	var cancelTimer *time.Timer
	var cancelDeadline <-chan time.Time
	defer func() {
		if cancelTimer != nil {
			cancelTimer.Stop()
		}
	}()
	for {
		select {
		case e := <-ch:
			if e.Type == "ended" {
				return cancelErr
			}
			e.CallID = r.CallID
			if cancelErr != nil {
				if e.Type == "usage" {
					emit(e)
				}
				continue
			}
			if e.Type == "tool" {
				tools.Go(func() error {
					res, err := execute(toolCtx, e)
					if err != nil {
						res = ToolResult{Value: json.RawMessage(`"Tool cancelled or unavailable"`), IsError: true}
					}
					return c.send(map[string]any{"type": "tool_result", "callId": wireID, "toolCallId": e.ToolCallID, "value": res.Value, "isError": res.IsError})
				})
				continue
			}
			emit(e)
		case <-ctxDone:
			cancelErr = ctx.Err()
			ctxDone = nil
			stopTools()
			if err := c.send(map[string]any{"type": "cancel", "callId": wireID}); err != nil {
				return err
			}
			cancelTimer = time.NewTimer(5 * time.Second)
			cancelDeadline = cancelTimer.C
		case <-cancelDeadline:
			// An unresponsive worker must stop before its admission slot is reused.
			c.setError(errors.New("Pi worker did not acknowledge cancellation"))
			c.cancel()
			<-c.done
			return cancelErr
		case <-c.done:
			return c.lastError()
		}
	}
}
