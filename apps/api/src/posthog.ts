/**
 * PostHog analytics client (server-side singleton).
 *
 * Enabled only when POSTHOG_KEY is set. On self-hosted / open-source
 * deployments without the env var, all methods are no-ops so the rest of
 * the app can call `posthog.capture(...)` unconditionally.
 *
 * Host defaults to PostHog US cloud and can be overridden with
 * POSTHOG_HOST (e.g. https://eu.i.posthog.com for EU region or a
 * self-hosted instance). The same env vars are read by the
 * /api/config handler and exposed to the browser at runtime.
 */

import { PostHog } from "posthog-node";

const apiKey = process.env.POSTHOG_KEY;
const host = process.env.POSTHOG_HOST;

type PostHogLike = Pick<
  PostHog,
  "capture" | "identify" | "captureException" | "groupIdentify" | "shutdown"
>;

function createNoopClient(): PostHogLike {
  return {
    capture: () => {},
    identify: () => {},
    captureException: () => {},
    groupIdentify: () => {},
    shutdown: async () => {},
  } as unknown as PostHogLike;
}

export const posthog: PostHogLike = apiKey
  ? new PostHog(apiKey, {
      ...(host ? { host } : {}),
      enableExceptionAutocapture: true,
      // Flush every event immediately. Short-lived request contexts
      // otherwise drop batched events before shutdown runs.
      flushAt: 1,
      flushInterval: 0,
    })
  : createNoopClient();

if (apiKey) {
  const shutdown = () => {
    posthog.shutdown().catch(() => {});
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
