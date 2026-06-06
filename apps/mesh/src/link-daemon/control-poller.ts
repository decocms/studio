/**
 * Control-poll loop for the pull-transport control channel (Phase C).
 *
 * Continuously long-polls GET /api/:org/links/control. On a 200 response,
 * decodes the body as a ControlFrame and dispatches:
 *   - `cancel`     → calls `onCancel(frame.runId)` to abort the in-flight RUN
 *                    (work-poll dispatch path → run-abort-registry).
 *   - `cancel_req` → calls `onCancelReq(frame.reqId)` to abort the in-flight
 *                    pull reverse-proxy REQUEST (proxy-poll path →
 *                    proxy-abort-registry). The outbound-only daemon can't
 *                    subscribe to `links.proxy.cancel.*`, so cancel rides this
 *                    control channel (Phase C-bis S2 — landmine #3).
 *   - `keep_alive` → ignored (server heartbeat to keep the poll alive).
 * On 204 (timeout with no frame), re-polls immediately.
 * On errors (network / unexpected status), backs off with
 * exponentialBackoffWithJitter from @decocms/std (mirrors work-poller.ts).
 *
 * The loop runs until `signal` is aborted. Each poll resolves a fresh bearer
 * token (same per-poll pattern as the work poller).
 *
 * ⚠️ SHIPPED DAEMON — needs human review before merge.
 */
import { exponentialBackoffWithJitter, sleep } from "@decocms/std";
import { decodeControlFrame } from "../api/routes/decopilot/control-frames";

export interface ControlPollerDeps {
  /** Fully-qualified base URL, e.g. "https://studio.deco.cx". */
  baseUrl: string;
  /** Org slug for the org-scoped route /api/:org/links/control. */
  orgSlug: string;
  /**
   * Bearer token resolver. Called before each request so a refreshed token
   * reaches every poll without pinning a stale credential (mirrors
   * work-poller.ts's getAccessToken pattern).
   */
  getAccessToken: () => Promise<string> | string;
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
   * Called when a `cancel` frame is received. The registry's `abort(runId)`
   * call is the intended implementation — but any callback is accepted for
   * testability.
   */
  onCancel: (runId: string) => void;
  /**
   * Called when a `cancel_req` frame is received (Phase C-bis S2). The
   * proxy-abort-registry's `abort(reqId)` is the intended implementation;
   * optional so the WS-only paths / older callers compile unchanged.
   */
  onCancelReq?: (reqId: string) => void;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

/**
 * Runs the control-poll loop. Resolves when the signal is aborted.
 *
 * Structural twin of `runWorkPollLoop` (work-poller.ts):
 *   1. Resolves a fresh bearer token.
 *   2. GETs /api/:org/links/control?timeout=<N>.
 *   3. On 200: decodes ControlFrame; dispatches cancel/keep_alive.
 *      On 204: server held the long-poll window; re-polls immediately.
 *      On error / bad-status: backs off with exponential-backoff-with-jitter.
 *   4. Stops cleanly when signal is aborted (no unhandled rejection).
 */
export async function runControlPollLoop(
  deps: ControlPollerDeps,
): Promise<void> {
  const { baseUrl, orgSlug, getAccessToken, signal, onCancel, onCancelReq } =
    deps;
  const fetcher = deps.fetchImpl ?? fetch;
  const pollTimeout = deps.pollTimeoutSecs ?? 29;
  const url = `${baseUrl}/api/${orgSlug}/links/control?timeout=${pollTimeout}`;
  let errorStreak = 0;

  while (!signal.aborted) {
    // Step 1: resolve a fresh token before each poll (mirrors work-poller.ts).
    let token: string;
    try {
      token = await getAccessToken();
    } catch (err) {
      if (signal.aborted) return;
      console.error("[control-poller] getAccessToken failed", err);
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
      console.error("[control-poller] fetch error", err);
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

    // Step 3a: 204 — server held the long-poll window with no frame; re-poll immediately.
    if (res.status === 204) {
      errorStreak = 0;
      continue;
    }

    // Step 3b: 200 — decode and dispatch the control frame.
    if (res.status === 200) {
      errorStreak = 0;
      let raw: string;
      try {
        raw = await res.text();
      } catch (err) {
        console.error(
          "[control-poller] failed to read control frame body",
          err,
        );
        continue;
      }
      let frame: ReturnType<typeof decodeControlFrame>;
      try {
        frame = decodeControlFrame(raw);
      } catch (err) {
        console.error(
          "[control-poller] control frame failed schema validation — skipping",
          err,
        );
        continue;
      }
      if (frame.type === "cancel") {
        try {
          onCancel(frame.runId);
        } catch (err) {
          console.error("[control-poller] onCancel threw (swallowed)", err);
        }
      } else if (frame.type === "cancel_req") {
        try {
          onCancelReq?.(frame.reqId);
        } catch (err) {
          console.error("[control-poller] onCancelReq threw (swallowed)", err);
        }
      }
      // keep_alive: no-op — continue to re-poll.
      continue;
    }

    // Step 3c: any other status (4xx/5xx) — back off.
    console.error(
      `[control-poller] unexpected status ${res.status} from control poll`,
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
