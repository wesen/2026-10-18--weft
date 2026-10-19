package cmds

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/pkg/errors"
	"github.com/wesen/2026-10-18--weft/pkg/bundle"
	"github.com/wesen/2026-10-18--weft/pkg/hw"
	"github.com/wesen/2026-10-18--weft/pkg/toolchain"
)

// boardAPI returns the hardware API the board level goes through: weft serve's when it answers on listen
// (serve then owns the build and the board lock, so the Lab and this run cannot collide), else the same
// handlers mounted in-process on an ephemeral loopback port for the length of the run.
func boardAPI(ctx context.Context, listen string, suite *toolchain.Suite, workDir, serial string) (string, func(), error) {
	base := "http://" + listen
	c := http.Client{Timeout: time.Second}
	if res, err := c.Get(base + "/api/hw/status?detect=0"); err == nil {
		_ = res.Body.Close()
		if res.StatusCode == http.StatusOK {
			fmt.Fprintf(os.Stderr, "weft: weft serve answers at %s: building and opening the board session there\n", base)
			return base, func() {}, nil
		}
	}
	m := hw.NewManager(ctx, suite, nil, hw.Options{WorkDir: workDir, MaxBuilds: 1, Serial: serial})
	mux := http.NewServeMux()
	m.Register(mux)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = m.Close()
		return "", nil, err
	}
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	stop := func() {
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
		_ = m.Close()
	}
	return "http://" + ln.Addr().String(), stop, nil
}

// apiBuild builds a bundle through the hardware API and waits for the result.
func apiBuild(ctx context.Context, base string, raw []byte, hil bool, seed int) (string, *toolchain.Report, error) {
	body, _ := json.Marshal(map[string]any{"bundle": json.RawMessage(raw), "hil": hil, "seed": seed})
	var created struct {
		ID string `json:"id"`
	}
	if err := apiCall(ctx, http.MethodPost, base+"/api/hw/builds", body, &created); err != nil {
		return "", nil, err
	}
	fmt.Fprintf(os.Stderr, "weft: building %s (hil %v)\n", created.ID, hil)
	for {
		var v struct {
			State  string            `json:"state"`
			Report *toolchain.Report `json:"report"`
			Error  string            `json:"error"`
		}
		if err := apiCall(ctx, http.MethodGet, base+"/api/hw/builds/"+created.ID+"?wait=50s", nil, &v); err != nil {
			return created.ID, nil, err
		}
		switch v.State {
		case hw.StateDone, hw.StateFailed:
			return created.ID, v.Report, nil
		case hw.StateInterrupted:
			return created.ID, v.Report, errors.Errorf("build %s was interrupted: %s", created.ID, v.Error)
		}
	}
}

func apiCall(ctx context.Context, method, url string, body []byte, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode >= 300 {
		var e struct {
			Error struct{ Code, Message string } `json:"error"`
		}
		_ = json.NewDecoder(res.Body).Decode(&e)
		return errors.Errorf("%s %s: %d %s: %s", method, url, res.StatusCode, e.Error.Code, e.Error.Message)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

// usesUART tells whether a design binds the board's UART itself (then it cannot have the HIL bridge).
func usesUART(bn *bundle.Bundle) bool {
	for _, p := range bn.Ports {
		for _, b := range p.Bits {
			if strings.HasPrefix(b.Resource, "uart.") {
				return true
			}
		}
	}
	return false
}
