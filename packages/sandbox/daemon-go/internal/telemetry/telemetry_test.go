package telemetry

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// The exporter is the whole point of this package and the one part that cannot
// be verified by reading it: a wrong endpoint shape, a resource that fails to
// merge, or an instrument bound to the wrong provider all compile fine and
// produce silence in production. This drives Init against a real HTTP server.
func TestInitExportsToEndpoint(t *testing.T) {
	var mu sync.Mutex
	var bodies []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 1<<16)
		n, _ := r.Body.Read(buf)
		mu.Lock()
		bodies = append(bodies, r.URL.Path+"\x00"+string(buf[:n]))
		mu.Unlock()
		w.Write([]byte("{}"))
	}))
	defer srv.Close()

	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", srv.URL)
	// The SDK negotiates gzip by default; keep the payload greppable.
	t.Setenv("OTEL_EXPORTER_OTLP_COMPRESSION", "none")

	shutdown, err := Init(context.Background(), "boot-test", "go")
	if err != nil {
		t.Fatalf("Init: %v", err)
	}

	RecordPhase(context.Background(), "install", "done", 1234)
	RecordDepsRestore(context.Background(), "no-install", 7)

	// Shutdown force-flushes, so this asserts on a real export rather than
	// racing the periodic reader.
	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(bodies) == 0 {
		t.Fatal("exporter sent nothing")
	}
	all := strings.Join(bodies, "\n")

	// The SDK appends the signal path to the configured endpoint. Getting this
	// wrong is the classic silent misconfiguration.
	if !strings.Contains(all, "/v1/metrics") {
		t.Errorf("expected export to /v1/metrics, got paths in: %q", firstLine(all))
	}
	for _, want := range []string{
		"sandbox.daemon.phase.duration",
		"sandbox.daemon.deps.restore",
		"install",
		"no-install",
		// The rollout comparison dimension has to reach the wire, not just the
		// resource struct.
		"daemon.impl",
		"studio-sandbox-daemon",
	} {
		if !strings.Contains(all, want) {
			t.Errorf("export missing %q", want)
		}
	}
}

func TestInitIsNoopWithoutEndpoint(t *testing.T) {
	// The normal case everywhere OTLP is not configured: desktop, local dev, CI,
	// and any deploy that has not opted in. Must not error and must not leave a
	// provider behind that buffers records forever.
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")

	shutdown, err := Init(context.Background(), "boot-test", "go")
	if err != nil {
		t.Fatalf("Init without endpoint should not error: %v", err)
	}
	RecordPhase(context.Background(), "install", "done", 1)
	RecordDepsRestore(context.Background(), "miss", 1)
	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("no-op shutdown should not error: %v", err)
	}
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
