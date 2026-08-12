package telemetry

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
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
		// ReadAll, not one Read: an io.Reader may return fewer bytes than asked
		// for, so a single Read keeps only the first segment of an export the
		// runner happened to split — dropping whichever metric names sit past
		// the cut and failing the assertions below on a payload that was fine.
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("reading export body: %v", err)
		}
		mu.Lock()
		bodies = append(bodies, r.URL.Path+"\x00"+string(body))
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
	RecordDepsRestore(context.Background(), "no-install", 7, "warm")
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
	RecordDepsRestore(context.Background(), "miss", 1, "warm")
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

func TestRecordGoldenSweepKeepsCardinalityFlat(t *testing.T) {
	// The uploader runs on every node forever, so this is the instrument most able
	// to blow up a metrics backend. Two invariants, both easy to break later by
	// "just adding" a useful-looking attribute:
	//   - the only attribute is the outcome, from a closed set. No repo, no org,
	//     no node: those are one series per value and they live in the log line.
	//   - a zero count emits nothing, so the steady state does not carry four
	//     empty series per node per sweep.
	// Bound directly, NOT via otel.SetMeterProvider: the global delegates once per
	// process and another test in this package already claimed it, so going
	// through the global here would observe nothing and pass vacuously.
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader), sdkmetric.WithView(views()...))
	bindInstruments(provider.Meter(scopeName))
	t.Cleanup(func() { bindInstruments(otel.Meter(scopeName)) })

	RecordGoldenSweep(context.Background(), 33_554, map[string]int{
		"uploaded":      1,
		"present":       2,
		"no-provenance": 0,
		"other-env":     0,
		"failed":        0,
	})

	var rm metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &rm); err != nil {
		t.Fatalf("collect: %v", err)
	}

	counts := map[string]int64{}
	sawDuration := false
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			switch m.Name {
			case "sandbox.daemon.golden.upload":
				sum, ok := m.Data.(metricdata.Sum[int64])
				if !ok {
					t.Fatalf("golden.upload should be a counter, got %T", m.Data)
				}
				for _, dp := range sum.DataPoints {
					if n := dp.Attributes.Len(); n != 1 {
						t.Errorf("want exactly 1 attribute (outcome), got %d: %v", n, dp.Attributes.ToSlice())
					}
					outcome, _ := dp.Attributes.Value(attribute.Key("outcome"))
					counts[outcome.AsString()] = dp.Value
				}
			case "sandbox.daemon.golden.upload.duration":
				h, ok := m.Data.(metricdata.Histogram[int64])
				if !ok || len(h.DataPoints) == 0 {
					t.Fatalf("upload duration should have a datapoint, got %T", m.Data)
				}
				if h.DataPoints[0].Sum != 33_554 {
					t.Errorf("duration sum = %d, want 33554", h.DataPoints[0].Sum)
				}
				sawDuration = true
			}
		}
	}

	if counts["uploaded"] != 1 || counts["present"] != 2 {
		t.Errorf("uploaded/present = %d/%d, want 1/2", counts["uploaded"], counts["present"])
	}
	for _, zero := range []string{"no-provenance", "other-env", "failed"} {
		if _, emitted := counts[zero]; emitted {
			t.Errorf("outcome %q had count 0 and must not emit a series", zero)
		}
	}
	if !sawDuration {
		t.Error("sweep duration was never recorded")
	}
}

func TestRecordDepsRestoreCarriesPkgCache(t *testing.T) {
	// The whole point of pkg_cache is splitting a slow `miss` into "downloaded the
	// internet" and "had a warm cache and still took 35s". If the attribute is
	// dropped on the metric — it is carried separately on the stdout line, which is
	// sampled — the two collapse into one bar and the question stays unanswerable.
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader), sdkmetric.WithView(views()...))
	bindInstruments(provider.Meter(scopeName))
	t.Cleanup(func() { bindInstruments(otel.Meter(scopeName)) })

	RecordDepsRestore(context.Background(), "miss", 34_815, "warm")
	// Empty must not become an empty-string attribute value: an unset series is
	// findable, a series labelled "" reads as a real state that does not exist.
	RecordDepsRestore(context.Background(), "l1", 900, "")

	var rm metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &rm); err != nil {
		t.Fatalf("collect: %v", err)
	}

	got := map[string]string{} // source -> pkg_cache
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name != "sandbox.daemon.deps.restore" {
				continue
			}
			sum := m.Data.(metricdata.Sum[int64])
			for _, dp := range sum.DataPoints {
				source, _ := dp.Attributes.Value(attribute.Key("source"))
				cache, ok := dp.Attributes.Value(attribute.Key("pkg_cache"))
				if !ok {
					t.Errorf("source=%s has no pkg_cache attribute", source.AsString())
					continue
				}
				got[source.AsString()] = cache.AsString()
			}
		}
	}

	if got["miss"] != "warm" {
		t.Errorf("miss pkg_cache = %q, want warm", got["miss"])
	}
	if got["l1"] != "unknown" {
		t.Errorf("unset pkg_cache = %q, want it normalised to unknown", got["l1"])
	}
}
