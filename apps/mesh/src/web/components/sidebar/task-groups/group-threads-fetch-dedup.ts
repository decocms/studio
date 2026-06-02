import { enqueueGroupThreadsFetch } from "./group-threads-fetch-queue";

export interface GroupProbeResult {
  serverHasMore: boolean;
}

function pageCacheKey(identity: string, offset: number, limit: number): string {
  return `${identity}|o:${offset}|l:${limit}`;
}

const probeResultCache = new Map<string, GroupProbeResult>();
const probeInFlight = new Map<string, Promise<GroupProbeResult>>();
const pageInFlight = new Map<string, Promise<unknown>>();

/**
 * One in-flight / cached probe per `identity`. Survives hook remounts and
 * duplicate expanded groups re-rendering in the same tick.
 */
export function fetchGroupProbeDeduped(
  identity: string,
  run: () => Promise<GroupProbeResult>,
): Promise<GroupProbeResult> {
  const cached = probeResultCache.get(identity);
  if (cached) return Promise.resolve(cached);

  const existing = probeInFlight.get(identity);
  if (existing) return existing;

  const promise = enqueueGroupThreadsFetch(run)
    .then((result) => {
      probeResultCache.set(identity, result);
      return result;
    })
    .finally(() => {
      probeInFlight.delete(identity);
    });

  probeInFlight.set(identity, promise);
  return promise;
}

export function getCachedGroupProbe(
  identity: string,
): GroupProbeResult | undefined {
  return probeResultCache.get(identity);
}

export function isGroupProbeInFlight(identity: string): boolean {
  return probeInFlight.has(identity);
}

/**
 * Dedupes identical `COLLECTION_THREADS_LIST` page fetches (same identity,
 * offset, limit) while a request is in flight.
 */
export function fetchGroupPageDeduped<T>(
  identity: string,
  offset: number,
  limit: number,
  run: () => Promise<T>,
): Promise<T> {
  const key = pageCacheKey(identity, offset, limit);
  const existing = pageInFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const promise = enqueueGroupThreadsFetch(run).finally(() => {
    pageInFlight.delete(key);
  });

  pageInFlight.set(key, promise);
  return promise;
}

/** Test-only reset. */
export function resetGroupThreadsFetchDedupForTests(): void {
  probeResultCache.clear();
  probeInFlight.clear();
  pageInFlight.clear();
}
