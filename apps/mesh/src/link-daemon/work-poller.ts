/**
 * Work-poll loop for the pull transport (Phase D, spec §3.2).
 *
 * Continuously long-polls GET /api/links/work. On a 200 response, parses
 * and validates the JSON body as a WorkItem (envelope carrying harnessInput +
 * runFenceToken) and invokes `onWork`. On 204 (no work), immediately re-polls.
 * On errors, backs off using exponentialBackoffWithJitter from @decocms/std.
 *
 * The loop runs until `signal` is aborted. Each poll refreshes the presence
 * claim by piggy-backing on the request (the server updates `studio_links`
 * TTL on every work-poll hit, per spec §3.2).
 *
 * NOTE — the route is user-scoped (no org segment). The org is carried inside
 * the WorkItem payload (orgSlug field) so the daemon can route work to the
 * correct org without needing to know it upfront.
 *
 * ⚠️ SHIPPED DAEMON — needs human review before merge.
 */
import { exponentialBackoffWithJitter, sleep } from "@decocms/std";
import {
  workItemSchema,
  type WorkItem,
} from "../api/routes/decopilot/link-work-queue";
import type { Capability } from "../links/protocol";

export interface WorkPollerDeps {
  /** Fully-qualified base URL, e.g. "https://studio.deco.cx". */
  baseUrl: string;
  /**
   * Called with each validated work item. Must not throw — errors are swallowed
   * by the loop; the item is not retried (best-effort, ACK-on-delivery per spec).
   */
  onWork: (item: WorkItem) => Promise<void>;
  /**
   * Bearer token resolver. Called before each request so a refreshed token
   * reaches every poll without pinning a stale credential (per spec §3.2).
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
  /**
   * Daemon capabilities to advertise on every poll via x-link-capabilities
   * header. The server mints the presence claim with these so
   * resolveDispatchTarget can route pull-transport threads correctly.
   * Mirrors the `capabilities` field in the WS hello frame.
   */
  capabilities?: Capability[];
  /**
   * Stable machine identifier, forwarded as x-link-machine-id.
   * Mirrors the `machineId` field in the WS hello frame.
   */
  machineId?: string;
  /**
   * Daemon CLI version string, forwarded as x-link-cli-version.
   * Mirrors the `cliVersion` field in the WS hello frame.
   */
  cliVersion?: string;
  /**
   * Local preview server port, forwarded as x-link-preview-port.
   * Mirrors the `previewPort` field in the WS hello frame.
   */
  previewPort?: number;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

/**
 * Runs the work-poll loop. Resolves when the signal is aborted.
 *
 * The loop:
 *   1. Resolves a fresh bearer token via `getAccessToken` before each poll (per-poll resolver avoids pinning a stale credential).
 *   2. GETs /api/links/work?timeout=<N>.
 *   3. On 200: parses + validates the WorkItem via workItemSchema; calls onWork.
 *      On 204: no work available (server held the long-poll window); re-polls immediately.
 *      On error / bad-status: backs off with exponential-backoff-with-jitter.
 *   4. Stops immediately when signal is aborted.
 */
export async function runWorkPollLoop(deps: WorkPollerDeps): Promise<void> {
  const { baseUrl, onWork, getAccessToken, signal } = deps;
  const fetcher = deps.fetchImpl ?? fetch;
  const pollTimeout = deps.pollTimeoutSecs ?? 29;
  const url = `${baseUrl}/api/links/work?timeout=${pollTimeout}`;
  let errorStreak = 0;

  // Build the static presence headers once — these don't change between polls.
  const presenceHeaders: Record<string, string> = {};
  if (deps.capabilities && deps.capabilities.length > 0) {
    presenceHeaders["x-link-capabilities"] = deps.capabilities.join(",");
  }
  if (deps.machineId) {
    presenceHeaders["x-link-machine-id"] = deps.machineId;
  }
  if (deps.cliVersion) {
    presenceHeaders["x-link-cli-version"] = deps.cliVersion;
  }
  if (deps.previewPort !== undefined) {
    presenceHeaders["x-link-preview-port"] = String(deps.previewPort);
  }

  while (!signal.aborted) {
    // Step 1: resolve a fresh token before each poll so a rotated credential
    // is used on every request without pinning a stale one.
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
        headers: { Authorization: `Bearer ${token}`, ...presenceHeaders },
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
