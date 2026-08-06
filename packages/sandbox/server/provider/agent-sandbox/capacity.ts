/**
 * "Can the cluster place another sandbox right now?"
 *
 * The honest answer comes from the scheduler, and it only ever says so about
 * pods it has already tried to place: a pod it cannot fit stays `Pending` with
 * an `Unschedulable` condition (`FailedScheduling: 0/1 nodes are available: 1
 * Insufficient memory`). So the probe is "is anything currently unplaceable?",
 * not a capacity forecast — forecasting would mean summing requests against
 * allocatable across every node and re-implementing the scheduler's own
 * accounting, which would be wrong in a different way every release.
 *
 * Reading an already-failing pod is a lagging signal by one admission: the first
 * over-subscribed claim still gets made and still `Pending`s. That claim is what
 * makes the probe true for everyone behind it, which is the point — one run pays
 * the 180s timeout instead of eight.
 *
 * Cached, because this sits on the run-admission path and a burst asks the same
 * question N times in the same second.
 */

import type { KubeConfig } from "@kubernetes/client-node";
import { kubeFetch } from "./client";

/** How long an answer is reused. Short: a pod becoming schedulable is exactly
 *  the event a parked run is waiting for, and 3s is well under the time a node
 *  takes to free 2Gi. */
const CACHE_TTL_MS = 3_000;

/** Treat a probe failure as "capacity available" and admit. A broken probe must
 *  never become a global stop on running work — that would trade a bounded,
 *  retriable failure for a total outage. */
const FAIL_OPEN = true;

interface PodList {
  items?: Array<{
    status?: {
      phase?: string;
      conditions?: Array<{ type?: string; reason?: string; status?: string }>;
    };
  }>;
}

/**
 * True when at least one pod in `namespace` is Pending because the scheduler
 * could not place it. Exported for the unit test: the shape-reading is the part
 * worth pinning, since `PodScheduled=False/Unschedulable` is the contract here
 * (a pod Pending while pulling an image is NOT this — it has a node).
 */
export function hasUnschedulablePod(list: PodList): boolean {
  return (list.items ?? []).some((pod) => {
    if (pod.status?.phase !== "Pending") return false;
    return (pod.status?.conditions ?? []).some(
      (c) =>
        c.type === "PodScheduled" &&
        c.status === "False" &&
        c.reason === "Unschedulable",
    );
  });
}

export function createCapacityProbe(
  kc: KubeConfig,
  namespace: string,
): () => Promise<boolean> {
  let cachedAt = 0;
  let cached = true;
  let inFlight: Promise<boolean> | null = null;

  const read = async (): Promise<boolean> => {
    try {
      const resp = await kubeFetch(kc, {
        method: "GET",
        path:
          `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods` +
          // Only Pending pods can be unschedulable, so let the API server filter
          // — a busy namespace's Running pods are the bulk of the payload.
          `?fieldSelector=status.phase%3DPending`,
      });
      if (!resp.ok) return FAIL_OPEN;
      const list = (await resp.json()) as PodList;
      return !hasUnschedulablePod(list);
    } catch {
      return FAIL_OPEN;
    }
  };

  return async () => {
    const now = Date.now();
    if (now - cachedAt < CACHE_TTL_MS) return cached;
    // Coalesce a burst: N runs admitting in the same tick share one API call.
    inFlight ??= read().finally(() => {
      inFlight = null;
    });
    cached = await inFlight;
    cachedAt = Date.now();
    return cached;
  };
}
