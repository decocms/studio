package telemetry

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
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
	RecordReady(context.Background(), 9876)
	RecordProxy(context.Background(), 12, "2xx")
	RecordDevServerExit(context.Background(), false)
	RecordPublish(context.Background(), "done", 345)
	// Loop lag has no Record* of its own — Init's sampler is the only producer,
	// so waiting is what proves the sampler runs. Two intervals, not one: a
	// single delayed tick on a loaded CI host would fail a run that is fine. It has to be asserted
	// here rather than in a test of its own: otel-go binds these package-level
	// instruments to the FIRST provider installed in the process, so a second
	// Init in the same binary would record into this test's dead exporter.
	time.Sleep(2*lagSampleInterval + 400*time.Millisecond)

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
		"sandbox.daemon.ready.duration",
		"sandbox.daemon.proxy.duration",
		"sandbox.daemon.devserver.exit",
		"sandbox.daemon.publish.duration",
		"sandbox.daemon.loop.lag",
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

// Bounds are asserted off a manual reader rather than the wire: the OTLP
// exporter speaks protobuf, so boundaries are binary there and a passing
// string-match would prove nothing. Getting this wrong is silent — the SDK
// falls back to a default set that stops at 10s, which buckets a 45s install
// and a 5-minute one identically, and makes these panels incomparable to the TS
// daemon's (which pins the same boundaries).
func TestViewsPinSharedBuckets(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(
		sdkmetric.WithReader(reader),
		sdkmetric.WithView(views()...),
	)
	meter := provider.Meter(scopeName)
	phase, _ := meter.Int64Histogram("sandbox.daemon.phase.duration")
	lag, _ := meter.Int64Histogram("sandbox.daemon.loop.lag")
	phase.Record(context.Background(), 45_000)
	lag.Record(context.Background(), 2)

	var rm metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &rm); err != nil {
		t.Fatalf("collect: %v", err)
	}

	bounds := map[string][]float64{}
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			if h, ok := m.Data.(metricdata.Histogram[int64]); ok && len(h.DataPoints) > 0 {
				bounds[m.Name] = h.DataPoints[0].Bounds
			}
		}
	}

	if got := bounds["sandbox.daemon.phase.duration"]; !contains(got, 300_000) {
		t.Errorf("phase duration bounds missing 300000: %v", got)
	}
	// Lag must NOT inherit the duration set: on those bounds every healthy
	// sample sits in the first bucket and the metric says nothing.
	if got := bounds["sandbox.daemon.loop.lag"]; !contains(got, 1) || contains(got, 300_000) {
		t.Errorf("loop lag should use the lag bounds, got: %v", got)
	}
}

func contains(xs []float64, want float64) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
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
