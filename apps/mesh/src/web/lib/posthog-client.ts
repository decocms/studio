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

let initialized = false;
let lastOrgGroupKey: string | null = null;

export function initPostHog(key: string, host: string) {
  if (initialized || typeof window === "undefined") return;
  posthog.init(key, {
    api_host: host,
    capture_pageview: "history_change",
    capture_pageleave: true,
    autocapture: true,
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
}
