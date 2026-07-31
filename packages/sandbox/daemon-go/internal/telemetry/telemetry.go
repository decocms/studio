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
var (
	meter = otel.Meter(scopeName)

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

	depsRestoreDuration, _ = meter.Int64Histogram(
		"sandbox.daemon.deps.restore.duration",
		metric.WithUnit("ms"),
		metric.WithDescription(
			"Wall-clock duration of the dependency step, split by cache tier. A cache hit that is not meaningfully faster than a miss is the signal that the cache is not paying for itself.",
		),
	)
)

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
	)
	otel.SetMeterProvider(provider)

	slog.Info("otlp metrics enabled",
		"endpoint", os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
		"impl", impl, "boot_id", bootID)

	return provider.Shutdown, nil
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

// RecordDepsRestore reports one dependency step and which cache tier served it.
func RecordDepsRestore(ctx context.Context, source string, durationMs int64) {
	attrs := metric.WithAttributes(attribute.String("source", source))
	depsRestore.Add(ctx, 1, attrs)
	depsRestoreDuration.Record(ctx, durationMs, attrs)
}
