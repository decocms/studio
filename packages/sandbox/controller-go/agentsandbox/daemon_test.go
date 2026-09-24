package agentsandbox

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	daemon "github.com/decocms/studio/sandbox-daemon/pkg/protocol"
)

func testClient() *daemonClient {
	c := newDaemonClient(nil)
	c.sleep = func(context.Context, time.Duration) error { return nil }
	c.configTimeout = 100 * time.Millisecond
	return c
}

func TestPostConfigRetries(t *testing.T) {
	ctx := context.Background()

	t.Run("a stalled daemon is retried when the request is replayable", func(t *testing.T) {
		var hits atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if hits.Add(1) < 3 {
				time.Sleep(300 * time.Millisecond)
			}
			_, _ = io.WriteString(w, `{"bootId":"b","transition":"bootstrap","config":{}}`)
		}))
		defer srv.Close()
		res, err := testClient().postConfig(ctx, srv.URL, "tok", &daemon.TenantConfig{}, "")
		if err != nil || res.Transition != "bootstrap" || hits.Load() != 3 {
			t.Fatalf("res=%+v err=%v hits=%d", res, err, hits.Load())
		}
	})

	t.Run("a rotateToken POST is never replayed after a timeout: the first may have rotated", func(t *testing.T) {
		var hits atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			hits.Add(1)
			time.Sleep(300 * time.Millisecond)
		}))
		defer srv.Close()
		_, err := testClient().postConfig(ctx, srv.URL, "sentinel", &daemon.TenantConfig{}, strings.Repeat("t", 64))
		if err == nil || hits.Load() != 1 {
			t.Fatalf("err=%v hits=%d, want one attempt", err, hits.Load())
		}
		if !strings.Contains(err.Error(), "[SANDBOX_UNREACHABLE] sandbox daemon /_sandbox/config request failed") {
			t.Fatalf("unlabelled: %v", err)
		}
	})

	t.Run("a rotateToken POST that never connected is retried", func(t *testing.T) {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		addr := l.Addr().String()
		l.Close()
		attempts := 0
		c := testClient()
		c.sleep = func(context.Context, time.Duration) error { attempts++; return nil }
		_, err = c.postConfig(ctx, "http://"+addr, "sentinel", nil, strings.Repeat("t", 64))
		if err == nil || attempts != requestAttempts-1 {
			t.Fatalf("err=%v backoffs=%d, want %d", err, attempts, requestAttempts-1)
		}
	})

	t.Run("non-2xx is a typed ConfigRequestError carrying the status, not retried", func(t *testing.T) {
		var hits atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			hits.Add(1)
			if r.Header.Get("authorization") != "Bearer sentinel" {
				t.Errorf("authorization = %q", r.Header.Get("authorization"))
			}
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"error":"unauthorized"}`)
		}))
		defer srv.Close()
		_, err := testClient().postConfig(ctx, srv.URL, "sentinel", nil, "")
		var cfgErr *ConfigRequestError
		if !errors.As(err, &cfgErr) || cfgErr.Status != 401 || hits.Load() != 1 {
			t.Fatalf("err=%v hits=%d", err, hits.Load())
		}
	})

	t.Run("a malformed 2xx body is labelled with its endpoint", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.WriteString(w, "<html>proxy error</html>")
		}))
		defer srv.Close()
		_, err := testClient().postConfig(ctx, srv.URL, "t", nil, "")
		if err == nil || !strings.Contains(err.Error(), "/_sandbox/config returned a malformed JSON body: <html>") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("the rotation rides beside the patch", func(t *testing.T) {
		var body string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			b, _ := io.ReadAll(r.Body)
			body = string(b)
			_, _ = io.WriteString(w, `{"bootId":"b","transition":"bootstrap","config":{}}`)
		}))
		defer srv.Close()
		if _, err := testClient().postConfig(ctx, srv.URL, "s", &daemon.TenantConfig{OrgId: "o"}, "new"); err != nil {
			t.Fatal(err)
		}
		if body != `{"orgId":"o","auth":{"rotateToken":"new"}}` {
			t.Fatalf("body = %s", body)
		}
	})
}

func TestProbeHealth(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		ok     bool
	}{
		{"a daemon's answer", 200, `{"ready":false,"bootId":"b1","configured":false,"setup":{"running":true,"done":false},"orchestrator":{"running":true,"pending":1}}`, true},
		{"no bootId is not a daemon", 200, `{"ready":true,"setup":{"running":false,"done":true}}`, false},
		{"missing setup is not a daemon", 200, `{"ready":true,"bootId":"b"}`, false},
		{"non-2xx", 503, `{"ready":true,"bootId":"b","setup":{"running":false,"done":true}}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer srv.Close()
			if got := testClient().probeHealth(context.Background(), srv.URL) != nil; got != tc.ok {
				t.Fatalf("probeHealth ok = %v, want %v", got, tc.ok)
			}
		})
	}
}
