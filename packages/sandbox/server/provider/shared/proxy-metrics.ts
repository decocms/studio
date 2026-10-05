import type { Meter } from "@opentelemetry/api";

/** `runner_kind` values, as `AgentSandboxProvider` already reports Kubernetes. */
export const RUNNER_KIND = {
  kubernetes: "agent-sandbox",
  freestyle: "freestyle",
} as const;

/**
 * Times a daemon request into `studio.sandbox.proxy.duration_ms`, the
 * histogram `AgentSandboxProvider` records in-process, so both providers
 * land in one series split by `runner_kind`.
 */
export function daemonProxyTimer(meter: Meter | undefined) {
  const histogram = meter?.createHistogram("studio.sandbox.proxy.duration_ms", {
    description:
      "Wall-clock latency of studio-mediated requests to the sandbox daemon: tool exec proxies (source=daemon) and preview iframe traffic (source=preview).",
    unit: "ms",
  });
  return async (
    runnerKind: string,
    send: () => Promise<Response>,
  ): Promise<Response> => {
    if (!histogram) return send();
    const start = performance.now();
    const record = (statusCode: number) =>
      histogram.record(performance.now() - start, {
        runner_kind: runnerKind,
        source: "daemon",
        status_code: statusCode,
      });
    try {
      const res = await send();
      record(res.status);
      return res;
    } catch (err) {
      record(0);
      throw err;
    }
  };
}
