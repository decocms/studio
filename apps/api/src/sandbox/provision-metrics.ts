import type { Counter, Histogram } from "@opentelemetry/api";
import {
  RUNNER_KIND,
  sandboxProviderOfError,
  type Sandbox,
  type SandboxProviderKind,
} from "@decocms/sandbox/provider";
import { meter } from "@/observability";

let histogram: Histogram | undefined;
let placements: Counter | undefined;

/**
 * Time from asking for a sandbox to its daemon taking config, by provider:
 * the number the Kubernetes/Freestyle comparison is made on.
 */
export async function timeProvision<
  T extends Pick<Sandbox, "provider" | "placement">,
>(
  attrs: { start: "fresh" | "resume"; purpose: string },
  ensure: () => Promise<T>,
): Promise<T> {
  histogram ??= meter.createHistogram("studio.sandbox.provision.duration_ms", {
    description:
      "Wall-clock time of one sandbox ensure, by provider (runner_kind), outcome, the provider a fallback left (fallback_from), and whether a sandbox was already recorded (start=resume) or not (start=fresh).",
    unit: "ms",
    advice: {
      explicitBucketBoundaries: [
        500, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 60_000, 120_000,
        300_000, 600_000,
      ],
    },
  });
  placements ??= meter.createCounter("studio.sandbox.placement", {
    description:
      "Sandbox ensures by the provider that served them (runner_kind) and why it was chosen (reason).",
  });
  const started = performance.now();
  const record = (
    kind: SandboxProviderKind | undefined,
    outcome: string,
    fallbackFrom?: SandboxProviderKind,
  ) =>
    histogram?.record(performance.now() - started, {
      ...attrs,
      runner_kind: kind ? RUNNER_KIND[kind] : "unknown",
      outcome,
      ...(fallbackFrom && { fallback_from: RUNNER_KIND[fallbackFrom] }),
    });
  try {
    const sandbox = await ensure();
    record(sandbox.provider, "ok", sandbox.placement?.fallbackFrom);
    if (sandbox.placement) {
      placements.add(1, {
        runner_kind: RUNNER_KIND[sandbox.provider],
        reason: sandbox.placement.reason,
      });
    }
    return sandbox;
  } catch (err) {
    record(sandboxProviderOfError(err), "error");
    throw err;
  }
}
