import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { exponentialBackoffWithJitter } from "@decocms/shared/std";

/**
 * No `load` event within this window after (re)pointing the iframe at a sandbox
 * URL → treat the navigation as failed. When the dev server is unreachable the
 * browser paints its own connection-refused page and fires *neither* `load` nor
 * `error` on the (cross-origin) iframe element, so a timeout is the only
 * client-side signal that the load never happened. Kept generous so a merely
 * slow — but succeeding — page load isn't mistaken for a failure.
 */
const LOAD_TIMEOUT_MS = 10_000;
/** First backoff delay before re-pointing the iframe after a failed load. */
const RETRY_BASE_MS = 1_000;
/** Backoff ceiling — retries keep going at this cadence until a `load` fires. */
const RETRY_CAP_MS = 30_000;

/**
 * Self-healing for the preview iframe.
 *
 * When the sandbox dev server is down or still starting, the iframe can end up
 * on the browser's connection-refused page and stay there: the failed
 * cross-origin navigation fires no `load`/`error` event, so nothing tells the
 * app to retry once the server is back (SSE reload signals only fire on port
 * changes / `.deco` writes / explicit daemon events — not on this recovery).
 *
 * This watchdog arms a timer each time the iframe is pointed at a sandbox URL;
 * if no `load` arrives in {@link LOAD_TIMEOUT_MS} it reassigns `src` to retry,
 * backing off with jitter up to {@link RETRY_CAP_MS} and re-arming, until a
 * `load` finally fires — at which point the attempt budget resets. Wire the
 * returned `handleLoad`/`handleError` into the iframe's `onLoad`/`onError`.
 *
 * Only run this for the sandbox surface (`active`): the production fallback is a
 * best-effort, short-lived cross-origin frame we must not thrash.
 */
export function useIframeLoadRecovery({
  iframeRef,
  src,
  active,
}: {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  /** The desired sandbox iframe `src`, or `null` when no sandbox frame is shown. */
  src: string | null;
  /** Whether recovery should run (sandbox surface active). */
  active: boolean;
}) {
  const attemptRef = useRef(0);
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read inside timer callbacks so a retry always reloads the current URL, not
  // the one captured when the watchdog was first armed.
  const srcRef = useRef(src);
  const activeRef = useRef(active);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- keep timer callbacks reading the latest src/active
  srcRef.current = src;
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- keep timer callbacks reading the latest src/active
  activeRef.current = active;

  const clearTimers = () => {
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    loadTimerRef.current = null;
    retryTimerRef.current = null;
  };

  // Arm the load watchdog: if `load` doesn't fire before it elapses, the
  // navigation failed silently — schedule a backoff reload.
  const armWatchdog = () => {
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    loadTimerRef.current = setTimeout(() => {
      loadTimerRef.current = null;
      scheduleReload();
    }, LOAD_TIMEOUT_MS);
  };

  const scheduleReload = () => {
    if (!activeRef.current || !srcRef.current) return;
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    const delay = exponentialBackoffWithJitter(
      RETRY_CAP_MS,
      RETRY_BASE_MS,
      attemptRef.current,
      2,
      0.5,
    );
    attemptRef.current += 1;
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      const iframe = iframeRef.current;
      const currentSrc = srcRef.current;
      if (!iframe || !currentSrc || !activeRef.current) return;
      // Reassigning `src` to the identical string is a no-op in some browsers
      // (e.g. Firefox skips the navigation entirely when the URL is unchanged) —
      // exactly the case here, since the stuck frame never left this URL. Force
      // a real reload via a blank interstitial before restoring the target.
      iframe.src = "about:blank";
      iframe.src = currentSrc;
      armWatchdog();
    }, delay);
  };

  // A `load` fired: the frame reached *some* document. We can't read
  // cross-origin content to tell a real page from an error page, but a
  // connection-refused failure fires no `load` at all — so any `load` here means
  // the request was answered. Treat it as healthy and reset the attempt budget.
  const handleLoad = () => {
    attemptRef.current = 0;
    clearTimers();
  };

  // `error` on an iframe is unreliable (rarely fires for cross-origin nav
  // failures), but when it does it's an unambiguous failure — retry immediately.
  const handleError = () => {
    if (loadTimerRef.current) {
      clearTimeout(loadTimerRef.current);
      loadTimerRef.current = null;
    }
    scheduleReload();
  };

  // Arm on each new sandbox navigation target (and on (re)activation); a changed
  // `src` is a fresh navigation, so reset the attempt budget. Disarm entirely
  // while inactive or without a sandbox src.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- imperative iframe load watchdog + backoff reload lifecycle
  useEffect(() => {
    clearTimers();
    attemptRef.current = 0;
    if (!active || !src) return;
    armWatchdog();
    return clearTimers;
    // oxlint-disable-next-line eslint-plugin-react-hooks/exhaustive-deps -- timer helpers read refs; only src/active gate arming
  }, [src, active]);

  return { handleLoad, handleError };
}
