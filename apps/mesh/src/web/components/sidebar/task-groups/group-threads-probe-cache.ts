import { enqueueGroupThreadsFetch } from "./group-threads-fetch-queue";
import { GROUP_PAGE_SIZE } from "./next-page-offset";

const probeResults = new Map<string, boolean>();
const probeInflight = new Map<string, Promise<boolean>>();

/**
 * When the global thread list is fully loaded, per-group visible counts are
 * authoritative and no server probe is needed.
 */
export function inferServerHasMoreWithoutProbe(
  visibleCount: number,
  globalHasMore: boolean,
): boolean | null {
  if (!globalHasMore) return false;
  if (visibleCount >= GROUP_PAGE_SIZE) return true;
  return null;
}

export function getCachedGroupProbeResult(
  identity: string,
): boolean | undefined {
  return probeResults.get(identity);
}

export function cacheGroupProbeResult(
  identity: string,
  serverHasMore: boolean,
): void {
  probeResults.set(identity, serverHasMore);
}

/**
 * Resolve whether a group has more rows on the server. Deduplicates in-flight
 * probes across hook instances, remounts, and concurrent renders.
 */
export function ensureGroupProbe(
  identity: string,
  probe: () => Promise<boolean>,
  onResolved: (serverHasMore: boolean) => void,
): void {
  const cached = probeResults.get(identity);
  if (cached !== undefined) {
    onResolved(cached);
    return;
  }

  let inflight = probeInflight.get(identity);
  if (!inflight) {
    inflight = enqueueGroupThreadsFetch(probe)
      .then((result) => {
        probeResults.set(identity, result);
        probeInflight.delete(identity);
        return result;
      })
      .catch(() => {
        probeInflight.delete(identity);
        return Promise.reject(new Error("group probe failed"));
      });
    probeInflight.set(identity, inflight);
  }

  void inflight.then(onResolved, () => onResolved(false));
}

export function clearGroupThreadsProbeCacheForTests(): void {
  probeResults.clear();
  probeInflight.clear();
}
