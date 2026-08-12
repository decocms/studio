// Package telemetry exports daemon-internal metrics over OTLP.
//
// Scope is deliberately narrow: only what the daemon alone knows. Sandbox
// counts, cold-start ratio and proxy latency are already emitted by Studio
// (studio.sandbox.*), from outside the pod, where they cannot be influenced by
// the user code running inside it. Duplicating them here would produce two
// disagreeing numbers for the same thing.
//
// # Reachability
//
// A sandbox pod's egress is otherwise locked to 53/443, and the chart opens
// exactly one extra destination for this (an iptables ACCEPT scoped to the
// collector's ClusterIP and port). Two consequences:
//
//   - OTEL_EXPORTER_OTLP_ENDPOINT must be an IP. Sandboxes run dnsPolicy: None
//     against public resolvers, so `gateway-otlp.opentelemetry-collector` is
//     NXDOMAIN in here. The chart derives the endpoint and the firewall rule
//     from one value so they cannot disagree.
//   - The endpoint is the off switch. Unset → no exporter is started at all,
//     and every Record* call below lands on the OTel no-op provider.
//
// # Failure posture
//
// Telemetry must never take a sandbox down: a failed export is logged once per
// interval by the SDK and dropped. There is no retry queue on disk and no
// blocking flush on the request path. Losing metrics is a worse outcome than
// losing a user's uncommitted work by an order of magnitude, and this file is
// the boundary that keeps those two outcomes from being connected.
package telemetry

import (
	"context"
	"log/slog"
	"os"
	"strconv"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/metric"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	semconv "go.opentelemetry.io/otel/semconv/v1.41.0"
)

const scopeName = "github.com/decocms/studio/sandbox-daemon"

// Instruments are created from the GLOBAL meter provider at package init, not
// from a provider handed in by Init. otel's global provider delegates to the
// real one once SetMeterProvider is called, so this works in both orders and
// needs no nil checks at any call site. With no provider ever installed these
// stay no-ops.
//
// They are assigned in bindInstruments rather than inline in the var block so a
// test can point them at a ManualReader and assert on the datapoints a Record
// call actually produces. That is not cosmetic: the global provider delegates
// exactly ONCE per process, so a test that installs its own provider after any
// other test has installed one silently observes nothing — every instrument
// stays bound to the first. Attribute sets are the part of this file most likely
// to be broken by a well-meant edit, and they are unassertable without this.
var (
	phaseDuration        metric.Int64Histogram
	depsRestore          metric.Int64Counter
	goldenUpload         metric.Int64Counter
	goldenUploadDuration metric.Int64Histogram
	depsRestoreDuration  metric.Int64Histogram
	readyDuration        metric.Int64Histogram
	loopLag              metric.Int64Histogram
	proxyDuration        metric.Int64Histogram
	devServerExit        metric.Int64Counter
	publishDuration      metric.Int64Histogram
)

func init() { bindInstruments(otel.Meter(scopeName)) }

// bindInstruments (re)creates every instrument from meter.
func bindInstruments(meter metric.Meter) {
	phaseDuration, _ = meter.Int64Histogram(
		"sandbox.daemon.phase.duration",
		metric.WithUnit("ms"),
		metric.WithDescription(
			"Wall-clock duration of each setup phase (clone, install, dev-server start). The per-phase boot cost breakdown, which exists nowhere outside the daemon: Studio sees only the total time until the sandbox answers.",
		),
	)

	depsRestore, _ = meter.Int64Counter(
		"sandbox.daemon.deps.restore",
		metric.WithUnit("{step}"),
		metric.WithDescription(
			"Dependency-install outcomes by cache tier (l1 / l2 / miss / no-install). The golden-cache hit rate. Also emitted as a stdout line for parity with the TS daemon, but that path is sampled at 1% by the log pipeline and cannot be counted on.",
		),
	)

	goldenUpload, _ = meter.Int64Counter(
		"sandbox.daemon.golden.upload",
		metric.WithUnit("{golden}"),
		metric.WithDescription(
			"Node-local goldens seen by one uploader sweep, by outcome (uploaded / present / no-provenance / other-env / failed). Emitted by the golden-uploader DaemonSet, not by a sandbox. `failed` rising, or `no-provenance` staying non-zero, is the signal that the shared tier is quietly doing nothing — the latter means the org is not reaching the daemon, which is exactly how this tier stayed broken unnoticed.",
		),
	)

	goldenUploadDuration, _ = meter.Int64Histogram(
		"sandbox.daemon.golden.upload.duration",
		metric.WithUnit("ms"),
		metric.WithDescription(
			"Wall-clock duration of one uploader sweep. Compression is the cost and it shares a node with tenant sandboxes, so this is what to watch if the sandbox NodePool starts provisioning extra nodes — a boot made faster by a node added is not a win.",
		),
	)

	depsRestoreDuration, _ = meter.Int64Histogram(
		"sandbox.daemon.deps.restore.duration",
		metric.WithUnit("ms"),
		metric.WithDescription(
			"Wall-clock duration of the dependency step, split by cache tier. A cache hit that is not meaningfully faster than a miss is the signal that the cache is not paying for itself.",
		),
	)

	readyDuration, _ = meter.Int64Histogram(
		"sandbox.daemon.ready.duration",
		metric.WithUnit("ms"),
		metric.WithDescription(
			"Daemon boot to the dev server answering, recorded once per boot. The in-pod half of cold start: Studio's own claim-to-answering number folds in scheduling and image pull, which no daemon change can move.",
		),
	)

	loopLag, _ = meter.Int64Histogram(
		"sandbox.daemon.loop.lag",
		metric.WithUnit("ms"),
		metric.WithDescription(
			"Scheduling delay of a fixed-interval timer. A blocked loop (TS) or a descheduled process (both) stops the daemon answering its health probe, and Studio tears the sandbox down on a single miss — this is the only signal that says why, while the pod is still alive to say it.",
		),
	)

	proxyDuration, _ = meter.Int64Histogram(
		"sandbox.daemon.proxy.duration",
		metric.WithUnit("ms"),
		metric.WithDescription(
			"Time to proxy one request to the user's dev server. Separates a slow sandbox from a slow app — nothing outside the pod can see this hop.",
		),
	)

	devServerExit, _ = meter.Int64Counter(
		"sandbox.daemon.devserver.exit",
		metric.WithUnit("{exit}"),
		metric.WithDescription(
			"Dev-server process exits, split by whether the daemon asked for it. Unintentional exits are a crashlooping user app, which reads identically to a broken sandbox from the outside.",
		),
	)

	publishDuration, _ = meter.Int64Histogram(
		"sandbox.daemon.publish.duration",
		metric.WithUnit("ms"),
		metric.WithDescription(
			"The SIGTERM git sync — the one irrecoverable step of a teardown, and the reason the pod grace period is 90s. How close this runs to the grace period is how much of the user's work is one slow push from being lost.",
		),
	)
}

// Explicit buckets for the boot-cost histograms, shared verbatim with the TS
// daemon's telemetry.ts. Two panels can only be compared if their buckets
// agree, and the OTel default set stops at 10s — a clone or install routinely
// exceeds that, so on the default every interesting boot lands in +Inf and
// every percentile above p50 is a fabrication.
var durationBucketsMs = []float64{
	50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 20_000, 30_000, 60_000,
	120_000, 300_000,
}

// Loop lag lives in a different range entirely — sub-millisecond when healthy,
// and the interesting question is "did it cross ~1s", not "was it 30s or 60s".
var lagBucketsMs = []float64{1, 5, 10, 25, 50, 100, 250, 500, 1_000, 5_000, 30_000}

// How often the lag sampler ticks. Cheap enough to leave on always, fine-grained
// enough to catch the multi-second stalls that make the daemon miss its probe.
const lagSampleInterval = time.Second

// views pins the histogram boundaries. Split out from Init so a test can assert
// the bounds off a manual reader: the OTLP exporter here speaks protobuf, so
// boundaries are binary on the wire and cannot be asserted by inspecting it.
func views() []sdkmetric.View {
	return []sdkmetric.View{
		// Lag first: it must not also match the ms-duration view below, which
		// would register the same instrument twice.
		sdkmetric.NewView(
			sdkmetric.Instrument{Name: "sandbox.daemon.loop.lag"},
			sdkmetric.Stream{Aggregation: sdkmetric.AggregationExplicitBucketHistogram{
				Boundaries: lagBucketsMs,
			}},
		),
		// Everything else measured in ms. Matched by wildcard so an instrument
		// added later inherits the shared buckets instead of silently falling
		// back to the 10s-capped default.
		sdkmetric.NewView(
			sdkmetric.Instrument{Name: "sandbox.daemon.*.duration"},
			sdkmetric.Stream{Aggregation: sdkmetric.AggregationExplicitBucketHistogram{
				Boundaries: durationBucketsMs,
			}},
		),
	}
}

// Init installs the OTLP metric pipeline. Returns a shutdown func that is safe
// to call whether or not an exporter was started.
//
// No endpoint configured is the normal, expected case (desktop, local dev, any
// deploy that has not opted in) — it returns a no-op shutdown and no error.
func Init(ctx context.Context, bootID, impl string) (func(context.Context) error, error) {
	noop := func(context.Context) error { return nil }
	if os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") == "" {
		return noop, nil
	}

	exporter, err := otlpmetrichttp.New(ctx)
	if err != nil {
		return noop, err
	}

	// Hostname is the pod name — the join key back to the k8s labels Studio
	// stamps (org, user, sandbox handle, daemon-impl). Carrying tenant identity
	// in the metric itself would put org and user ids on every series; the pod
	// name keeps cardinality flat and the join available.
	host, _ := os.Hostname()

	// Merge, not replace: resource.Default() carries service.name fallback and
	// telemetry.sdk.*. Its schema URL must match the semconv import above —
	// a mismatch makes Merge fail, which would disable metrics with nothing but
	// a warning line to show for it (caught by TestInitExportsToEndpoint).
	res, err := resource.Merge(resource.Default(), resource.NewWithAttributes(
		semconv.SchemaURL,
		semconv.ServiceName("studio-sandbox-daemon"),
		semconv.K8SPodName(host),
		// The comparison dimension for the Go rollout. Also on the pod label and
		// the boot log line; all three must agree.
		attribute.String("daemon.impl", impl),
		attribute.String("daemon.boot_id", bootID),
	))
	if err != nil {
		return noop, err
	}

	// 30s: a sandbox's median life is minutes, so the SDK's 60s default would
	// lose short-lived pods entirely, and faster buys nothing — these
	// instruments fire a handful of times per sandbox, at boot. Applied only as
	// a default: passing WithInterval unconditionally would shadow
	// OTEL_METRIC_EXPORT_INTERVAL, and silently ignoring a standard OTel knob
	// is how you lose an afternoon proving the exporter works.
	readerOpts := []sdkmetric.PeriodicReaderOption{}
	if os.Getenv("OTEL_METRIC_EXPORT_INTERVAL") == "" {
		readerOpts = append(readerOpts, sdkmetric.WithInterval(30*time.Second))
	}

	provider := sdkmetric.NewMeterProvider(
		sdkmetric.WithResource(res),
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exporter, readerOpts...)),
		sdkmetric.WithView(views()...),
	)
	otel.SetMeterProvider(provider)

	stopLag := startLoopLagSampler()

	slog.Info("otlp metrics enabled",
		"endpoint", os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
		"impl", impl, "boot_id", bootID)

	return func(ctx context.Context) error {
		stopLag()
		return provider.Shutdown(ctx)
	}, nil
}

// startLoopLagSampler samples how late a fixed-interval ticker actually fires.
// On a starved node that lateness is the scheduler; on the TS daemon the same
// instrument catches a blocked event loop. Same failure from the sandbox's
// point of view, which is why both daemons sample it under one name.
func startLoopLagSampler() func() {
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(lagSampleInterval)
		defer ticker.Stop()
		expected := time.Now().Add(lagSampleInterval)
		for {
			select {
			case <-done:
				return
			case now := <-ticker.C:
				lag := now.Sub(expected).Milliseconds()
				if lag < 0 {
					lag = 0
				}
				loopLag.Record(context.Background(), lag)
				expected = now.Add(lagSampleInterval)
			}
		}
	}()
	return func() { close(done) }
}

// RecordPhase reports one finished setup phase. `status` is "done" or "failed"
// — a failed phase is a boot that produced a duration but not a sandbox, and
// averaging the two together hides exactly the regression a canary looks for.
func RecordPhase(ctx context.Context, name, status string, durationMs int64) {
	phaseDuration.Record(ctx, durationMs, metric.WithAttributes(
		attribute.String("phase", name),
		attribute.String("status", status),
	))
}

// RecordGoldenSweep reports one uploader sweep. Attributes are the outcome only:
// no repo, no org, no node — those are log fields, and as metric attributes they
// would be one series per repo. The uploader runs on every node, forever, so its
// cardinality has to stay flat.
func RecordGoldenSweep(ctx context.Context, durationMs int64, outcomes map[string]int) {
	for outcome, n := range outcomes {
		if n == 0 {
			// Zeroes still cost a series. `present` is the steady state and would
			// otherwise dominate a dashboard with nothing happening.
			continue
		}
		goldenUpload.Add(ctx, int64(n), metric.WithAttributes(
			attribute.String("outcome", outcome),
		))
	}
	goldenUploadDuration.Record(ctx, durationMs)
}

// RecordDepsRestore reports one dependency step and which cache tier served it.
func RecordDepsRestore(ctx context.Context, source string, durationMs int64, pkgCache string) {
	// pkg_cache splits a slow `miss` into "downloaded everything" and
	// "materialised a warm cache", which the single install timing cannot.
	if pkgCache == "" {
		pkgCache = "unknown"
	}
	attrs := metric.WithAttributes(
		attribute.String("source", source),
		attribute.String("pkg_cache", pkgCache),
	)
	depsRestore.Add(ctx, 1, attrs)
	depsRestoreDuration.Record(ctx, durationMs, attrs)
}

// RecordReady reports the boot that produced a serving sandbox. Called once per
// boot — a dev server that crashes and comes back is a restart, not a second
// cold start, and counting it as one would flatter every average.
func RecordReady(ctx context.Context, durationMs int64) {
	readyDuration.Record(ctx, durationMs)
}

// RecordProxy reports one proxied request to the user's dev server.
func RecordProxy(ctx context.Context, durationMs int64, statusClass string) {
	proxyDuration.Record(ctx, durationMs, metric.WithAttributes(
		attribute.String("status_class", statusClass),
	))
}

// RecordDevServerExit reports one dev-server process exit.
func RecordDevServerExit(ctx context.Context, intentional bool) {
	devServerExit.Add(ctx, 1, metric.WithAttributes(
		attribute.String("intentional", strconv.FormatBool(intentional)),
	))
}

// RecordPublish reports the shutdown git sync. `status` is "done" or "failed".
func RecordPublish(ctx context.Context, status string, durationMs int64) {
	publishDuration.Record(ctx, durationMs, metric.WithAttributes(
		attribute.String("status", status),
	))
}
