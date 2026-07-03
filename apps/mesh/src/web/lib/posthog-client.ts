/**
 * PostHog analytics client (browser-side).
 *
 * Init is deferred until the SPA fetches /api/config and reads
 * `posthog: { key, host } | null`. When PostHog isn't configured, the
 * `init` call is skipped and every track/identify shim is a no-op.
 *
 * Calls fired before `initPostHog()` runs are silently dropped — there
 * is no in-memory queue. See the spec for the rationale.
 */

import posthog from "posthog-js";

import { wasCacheRestored, wasOrgCacheRestored } from "@/web/lib/query-persist";

let initialized = false;
let lastOrgGroupKey: string | null = null;
let bootstrapTimingSent = false;

const LP_DISTINCT_ID_STASH = "mesh:lp-distinct-id";

/**
 * Cross-domain identity handoff from the marketing LP: diagnostic-deck CTAs
 * stamp the visitor's PostHog distinct_id onto the studio URL as `ph_did`.
 * Bootstrapping init with that id makes this browser continue the LP person,
 * so the eventual `identify(user.id)` merges the whole anonymous LP journey
 * (URL submitted → slides viewed → CTA) into the signed-up user.
 *
 * Two guards:
 * - the param is stashed in sessionStorage (survives the auth round-trip)
 *   and scrubbed from the URL so it can't be copied around;
 * - it's only honored when PostHog has no persisted state on this domain —
 *   a returning visitor keeps their own identity even if they open a
 *   forwarded LP link carrying someone else's id.
 */
function lpBootstrapDistinctId(): string | undefined {
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get("ph_did");
    if (fromUrl) {
      sessionStorage.setItem(LP_DISTINCT_ID_STASH, fromUrl);
      url.searchParams.delete("ph_did");
      window.history.replaceState(window.history.state, "", url.toString());
    }
    const candidate = fromUrl ?? sessionStorage.getItem(LP_DISTINCT_ID_STASH);
    if (!candidate) return undefined;
    const hasOwnState = Object.keys(window.localStorage).some(
      (k) => k.startsWith("ph_") && k.endsWith("_posthog"),
    );
    return hasOwnState ? undefined : candidate;
  } catch {
    return undefined;
  }
}

export function initPostHog(key: string, host: string) {
  if (initialized || typeof window === "undefined") return;
  const lpDistinctId = lpBootstrapDistinctId();
  posthog.init(key, {
    api_host: host,
    // api_host is a first-party reverse proxy so ad blockers (which block
    // *.posthog.com) don't drop events. ui_host must stay real PostHog so the
    // toolbar and "open in PostHog" links resolve.
    ui_host: "https://us.posthog.com",
    ...(lpDistinctId ? { bootstrap: { distinctID: lpDistinctId } } : {}),
    capture_pageview: "history_change",
    capture_pageleave: true,
    autocapture: true,
    // Real-user Core Web Vitals (LCP, FCP, CLS, INP) as $web_vitals events.
    // On a cold refresh LCP ≈ when the app shell paints, so this is the
    // headline "how slow is the load" signal, sliceable by org/route/device.
    capture_performance: { web_vitals: true, network_timing: true },
    // Capture unhandled JS exceptions (DOMError, TypeError, unhandled promise
    // rejections) as $exception events — gives us client-side error tracking
    // without hand-wiring every try/catch.
    capture_exceptions: true,
    // Session replay is on, but gated by project-level sampling (10%) and
    // minimum duration (10s). See PostHog project settings.
    // - `maskAllInputs: true` masks every native <input>/<textarea>/<select>
    //   by default. The Decopilot chat input is a TipTap contenteditable, so
    //   it's NOT an input and stays visible on purpose.
    // - `blockClass: "ph-no-capture"` → add to any element that should be
    //   fully hidden from recordings (shown as a solid block). Use on secret
    //   fields (API keys, connection tokens).
    session_recording: {
      maskAllInputs: true,
      blockClass: "ph-no-capture",
    },
    person_profiles: "identified_only",
  });
  initialized = true;
}

export function identifyUser(
  userId: string,
  props?: { email?: string; name?: string },
) {
  if (!initialized) return;
  posthog.identify(userId, props);
}

export function resetUser() {
  if (!initialized) return;
  posthog.reset();
  lastOrgGroupKey = null;
}

export function track(event: string, properties?: Record<string, unknown>) {
  if (!initialized) return;
  posthog.capture(event, properties);
}

/** Whether `initPostHog` has run — for render-time one-shot trackers that
 *  must not burn their "fired" guard while calls would still be dropped. */
export function isPostHogInitialized() {
  return initialized;
}

/**
 * Emit a one-shot `perf_app_bootstrap` event breaking down how long the
 * initial load took, per phase. Call once the app shell has rendered (PostHog
 * is initialized by then). Phase durations come from the browser Performance
 * API, which records them regardless of when PostHog inits — the config fetch
 * happens *before* init, so a buffered/manual capture would miss it.
 *
 * `config_fetch_ms` / `active_org_fetch_ms` are absent when those queries were
 * served from the persisted cache (no network) — which is itself the signal
 * that persistence is doing its job (`cache_restored: true`).
 */
export function flushBootstrapTiming() {
  if (!initialized || bootstrapTimingSent) return;
  if (typeof performance === "undefined") return;
  bootstrapTimingSent = true;

  const nav = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;

  const measure = (name: string): number | undefined => {
    const entry = performance.getEntriesByName(name, "measure")[0];
    return entry ? Math.round(entry.duration) : undefined;
  };

  track("perf_app_bootstrap", {
    nav_type: nav?.type,
    // Network/document phases (relative to navigation start).
    ttfb_ms: nav ? Math.round(nav.responseStart) : undefined,
    dom_interactive_ms: nav ? Math.round(nav.domInteractive) : undefined,
    dom_content_loaded_ms: nav
      ? Math.round(nav.domContentLoadedEventEnd)
      : undefined,
    // SPA bootstrap phases that gate first paint (the suspense chain).
    config_fetch_ms: measure("mesh:config-fetch"),
    active_org_fetch_ms: measure("mesh:active-org-fetch"),
    // Whole thing: navigation start → shell rendered.
    time_to_shell_ms: Math.round(performance.now()),
    // Did localStorage hydration spare us the cold fetches this load?
    // `active_org_fetch_ms` still reflects the background revalidation when the
    // org was cached — `org_cache_restored` tells you it didn't block paint.
    cache_restored: wasCacheRestored(),
    org_cache_restored: wasOrgCacheRestored(),
  });
}

/**
 * Bind the current browser session to an organization group so that every
 * subsequent autocaptured event carries `$groups: { organization: <id> }`.
 * De-duped by orgId — calling this repeatedly with the same id is free.
 * `resetUser()` clears the cache so re-login re-fires.
 */
export function setOrganizationGroup(
  orgId: string,
  props?: { name?: string; slug?: string },
) {
  if (!initialized) return;
  if (orgId === lastOrgGroupKey) return;
  posthog.group("organization", orgId, props);
  lastOrgGroupKey = orgId;
}

/**
 * Report an exception to PostHog with optional structured context.
 *
 * Use from React error boundaries (`componentDidCatch`) where errors are
 * caught BEFORE bubbling to `window.onerror` — so the built-in
 * `capture_exceptions: true` autocapture never sees them. Wrap in
 * try/catch so a PostHog failure never blocks the fallback UI.
 */
export function captureException(
  error: unknown,
  properties?: Record<string, unknown>,
) {
  if (!initialized) return;
  try {
    posthog.captureException(error, properties);
  } catch {
    // Swallow — never let analytics break the error UI.
  }
}

/**
 * Test-only: reset module-level state between tests. Not exported from any
 * non-test consumer; kept here because module state is otherwise opaque.
 */
export function __resetForTest() {
  initialized = false;
  lastOrgGroupKey = null;
  bootstrapTimingSent = false;
}
