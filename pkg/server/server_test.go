package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNewRejectsNonLoopback(t *testing.T) {
	for _, listen := range []string{"0.0.0.0:8088", "192.168.1.2:8088", "example.com:80"} {
		if _, err := New(listen); err == nil {
			t.Errorf("New(%q) accepted a non-loopback address", listen)
		}
	}
	for _, listen := range []string{"127.0.0.1:8088", "localhost:8088", "[::1]:8088"} {
		if _, err := New(listen); err != nil {
			t.Errorf("New(%q): %v", listen, err)
		}
	}
}

func TestHandlerGuards(t *testing.T) {
	s, err := New("127.0.0.1:8088")
	if err != nil {
		t.Fatal(err)
	}
	s.Mux.HandleFunc("GET /ok", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	cases := []struct {
		name, host, origin string
		want               int
	}{
		{"same origin", "127.0.0.1:8088", "", http.StatusNoContent},
		{"same origin with Origin", "127.0.0.1:8088", "http://127.0.0.1:8088", http.StatusNoContent},
		{"rebound host", "evil.example:8088", "", http.StatusForbidden},
		{"cross origin", "127.0.0.1:8088", "http://evil.example", http.StatusForbidden},
	}
	for _, c := range cases {
		r := httptest.NewRequest("GET", "/ok", nil)
		r.Host = c.host
		if c.origin != "" {
			r.Header.Set("Origin", c.origin)
		}
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != c.want {
			t.Errorf("%s: status %d, want %d", c.name, w.Code, c.want)
		}
	}
}
