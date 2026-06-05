/**
 * Work-poll loop for the pull transport (Phase D, spec §3.2).
 *
 * Continuously long-polls GET /api/:org/links/work. On a 200 response, parses
 * and validates the JSON body as a WorkItem (envelope carrying harnessInput +
 * runFenceToken) and invokes `onWork`. On 204 (no work), immediately re-polls.
 * On errors, backs off using exponentialBackoffWithJitter from @decocms/std.
 *
 * The loop runs until `signal` is aborted. Each poll refreshes the presence
 * claim by piggy-backing on the request (the server updates `studio_links`
 * TTL on every work-poll hit, per spec §3.2).
 *
 * NOTE — org multiplicity: this module takes a single `orgSlug` parameter.
 * The daemon connects one pull loop per org. How the daemon discovers its
 * org(s) (e.g. from the session claim or a startup argument) is the concern
 * of the pull-loop-entry task (Task 8 / index.ts), not this module.
 *
 * ⚠️ SHIPPED DAEMON — needs human review before merge.
 */
import { exponentialBackoffWithJitter, sleep } from "@decocms/std";
import {
  workItemSchema,
  type WorkItem,
} from "../api/routes/decopilot/link-work-queue";

export interface WorkPollerDeps {
  /** Fully-qualified base URL, e.g. "https://studio.deco.cx". */
  baseUrl: string;
  /**
   * Org slug for the org-scoped route /api/:org/links/work.
   *
   * NOTE: the daemon links a user who may span multiple orgs. For this module,
   * `orgSlug` is taken as a parameter; how the daemon discovers its org(s) is
   * the pull-loop-entry task's concern (see Task 8).
   */
  orgSlug: string;
  /**
   * Called with each validated work item. Must not throw — errors are swallowed
   * by the loop; the item is not retried (best-effort, ACK-on-delivery per spec).
   */
  onWork: (item: WorkItem) => Promise<void>;
  /**
   * Bearer token resolver. Called before each request so a refreshed token
   * reaches every poll without pinning a stale credential (per spec §3.2,
   * mirrors the WS path's getAccessToken in cluster-connection.ts).
   */
  getAccessToken: () => Promise<string>;
  /** Abort signal. The loop exits cleanly when aborted. */
  signal: AbortSignal;
  /**
   * Injected fetch implementation. Defaults to global `fetch`.
   * Tests inject a stub here to avoid real HTTP.
   */
  fetchImpl?: typeof fetch;
  /** Long-poll timeout in seconds sent as ?timeout= query param (default 29). */
  pollTimeoutSecs?: number;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

/**
 * Runs the work-poll loop. Resolves when the signal is aborted.
 *
 * The loop:
 *   1. Resolves a fresh bearer token (mirrors cluster-connection.ts's per-(re)connect pattern).
 *   2. GETs /api/:org/links/work?timeout=<N>.
 *   3. On 200: parses + validates the WorkItem via workItemSchema; calls onWork.
 *      On 204: no work available (server held the long-poll window); re-polls immediately.
 *      On error / bad-status: backs off with exponential-backoff-with-jitter.
 *   4. Stops immediately when signal is aborted.
 */
export async function runWorkPollLoop(deps: WorkPollerDeps): Promise<void> {
  const { baseUrl, orgSlug, onWork, getAccessToken, signal } = deps;
  const fetcher = deps.fetchImpl ?? fetch;
  const pollTimeout = deps.pollTimeoutSecs ?? 29;
  const url = `${baseUrl}/api/${orgSlug}/links/work?timeout=${pollTimeout}`;
  let errorStreak = 0;

  while (!signal.aborted) {
    // Step 1: resolve a fresh token before each poll (mirrors the WS
    // cluster-connection.ts getAccessToken pattern to avoid stale credentials).
    let token: string;
    try {
      token = await getAccessToken();
    } catch (err) {
      if (signal.aborted) return;
      console.error("[work-poller] getAccessToken failed", err);
      const delay = exponentialBackoffWithJitter(
        MAX_DELAY_MS,
        BASE_DELAY_MS,
        errorStreak,
        2,
        0.5,
      );
      errorStreak++;
      await sleep(delay, { signal }).catch(() => {});
      continue;
    }

    // Step 2: issue the long-poll request.
    let res: Response;
    try {
      res = await fetcher(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
    } catch (err) {
      if (signal.aborted) return;
      console.error("[work-poller] fetch error", err);
      const delay = exponentialBackoffWithJitter(
        MAX_DELAY_MS,
        BASE_DELAY_MS,
        errorStreak,
        2,
        0.5,
      );
      errorStreak++;
      await sleep(delay, { signal }).catch(() => {});
      continue;
    }

    // Step 3a: 204 — server held the long-poll window with no work; re-poll immediately.
    if (res.status === 204) {
      errorStreak = 0;
      continue;
    }

    // Step 3b: 200 — parse and validate the work item.
    if (res.status === 200) {
      errorStreak = 0;
      let raw: unknown;
      try {
        raw = await res.json();
      } catch (err) {
        console.error("[work-poller] failed to JSON-parse work item", err);
        continue;
      }
      const parsed = workItemSchema.safeParse(raw);
      if (!parsed.success) {
        console.error(
          "[work-poller] work item failed schema validation — skipping",
          parsed.error.format(),
        );
        continue;
      }
      try {
        await onWork(parsed.data);
      } catch (err) {
        console.error("[work-poller] onWork threw (swallowed)", err);
      }
      continue;
    }

    // Step 3c: any other status (4xx/5xx) — back off.
    console.error(
      `[work-poller] unexpected status ${res.status} from work poll`,
    );
    const delay = exponentialBackoffWithJitter(
      MAX_DELAY_MS,
      BASE_DELAY_MS,
      errorStreak,
      2,
      0.5,
    );
    errorStreak++;
    await sleep(delay, { signal }).catch(() => {});
  }
}
