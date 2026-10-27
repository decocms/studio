import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";

/** Whether the app answers: resolves `true` on any HTTP answer. */
export type AppProbe = (url: string, signal: AbortSignal) => Promise<boolean>;

/**
 * Any HTTP answer from the app counts (a 404 or a 500 is still a server that
 * is listening). `no-cors` can't read the status, but it only rejects when
 * nothing answered: connection refused, a reset, or the timeout.
 */
const fetchAppProbe: AppProbe = async (url, signal) => {
  try {
    await fetch(url, {
      method: "HEAD",
      mode: "no-cors",
      cache: "no-store",
      credentials: "omit",
      signal,
    });
    return true;
  } catch {
    return false;
  }
};

/** How long one probe waits for an answer (a cold dev server is slow). */
const PROBE_TIMEOUT_MS = 10_000;
/** While it answers, how often it is checked again. */
const UP_RECHECK_MS = 10_000;
/** While it doesn't, the backoff cap. */
const DOWN_RECHECK_CAP_MS = 5_000;
/**
 * Failed probes in a row before an app that answered is called gone, so a
 * dev server's quick restart doesn't flash the guide.
 */
export const APP_GONE_AFTER_FAILURES = 2;

/** The wait before the next probe. */
export function nextAppProbeDelay(up: boolean, failures: number): number {
  if (up && failures === 0) return UP_RECHECK_MS;
  return Math.min(1_000 * 2 ** Math.max(0, failures - 1), DOWN_RECHECK_CAP_MS);
}

/** Whether the app counts as answering after one more probe. */
export function nextAppReachable(
  wasUp: boolean | null,
  ok: boolean,
  failures: number,
): boolean {
  if (ok) return true;
  return wasUp === true && failures < APP_GONE_AFTER_FAILURES;
}

/**
 * Whether the local app `deco serve` reports (its preview) is answering, from
 * this browser. `null` while the first probe runs, or with no URL.
 *
 * `deco serve` can answer before the app is listening (`vite dev` still
 * starting), and the app can restart on its own; an iframe pointed at it then
 * stays on Chrome's error page. The preview waits on this instead: it shows
 * a guide until the app answers, then loads it, and does it again when the
 * app goes away and comes back. It keeps checking on its own, with backoff.
 */
export function useLocalAppReachable(
  url: string | null,
  probe: AppProbe = fetchAppProbe,
): boolean | null {
  const queryClient = useQueryClient();
  const queryKey = KEYS.localAppReachable(url ?? "");
  const { data } = useQuery({
    queryKey,
    queryFn: async ({ signal }): Promise<AppReachability> => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort);
      const timeout = setTimeout(abort, PROBE_TIMEOUT_MS);
      const ok = await probe(url!, controller.signal).catch(() => false);
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      const previous = queryClient.getQueryData<AppReachability>(queryKey);
      const failures = ok ? 0 : (previous?.failures ?? 0) + 1;
      return {
        up: nextAppReachable(previous?.up ?? null, ok, failures),
        failures,
      };
    },
    enabled: !!url,
    // Never throws: every answer is data, so the poll below keeps going.
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: (query) =>
      query.state.data
        ? nextAppProbeDelay(query.state.data.up, query.state.data.failures)
        : false,
  });
  return url ? (data?.up ?? null) : null;
}

interface AppReachability {
  up: boolean;
  /** Failed probes in a row. */
  failures: number;
}
