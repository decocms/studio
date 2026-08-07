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

import { createHash } from "node:crypto";
import { PostHog } from "posthog-node";

// `bun test` sets NODE_ENV=test — a developer machine with POSTHOG_KEY
// exported must not emit fixture events into the production project.
const apiKey =
  process.env.NODE_ENV === "test" ? undefined : process.env.POSTHOG_KEY;
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

/** Deterministic v4-shaped uuid from a seed — same seed ⇒ same uuid, and
 *  PostHog collapses rows sharing (event, distinct_id, uuid, timestamp), so
 *  redundant emissions of one logical event (e.g. a redelivered Stripe
 *  webhook) dedupe server-side instead of "dedupe in analysis". */
export function deterministicUuid(seed: string): string {
  const b = createHash("sha256").update(seed).digest();
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = b.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Org-scoped funnel event. When no acting user exists (webhooks, system
 * reactions), identity is `org:<id>` with person processing off — an org must
 * not become a person in the persons table. Pass `userId` when one is known
 * (e.g. the interactive paywall); their person then owns the event.
 * Fire-and-forget; no-op without POSTHOG_KEY.
 */
export function captureOrgEvent(input: {
  event: string;
  organizationId: string;
  userId?: string;
  properties?: Record<string, unknown>;
  /** deterministicUuid(...) for events that can be emitted more than once
   *  per logical occurrence. PostHog's dedupe contract needs uuid + event +
   *  distinct_id + timestamp to ALL match — pass a stable `timestamp` too. */
  uuid?: string;
  timestamp?: Date;
}): void {
  posthog.capture({
    distinctId: input.userId ?? `org:${input.organizationId}`,
    event: input.event,
    groups: { organization: input.organizationId },
    ...(input.uuid ? { uuid: input.uuid } : {}),
    ...(input.timestamp ? { timestamp: input.timestamp } : {}),
    properties: {
      organization_id: input.organizationId,
      ...(input.userId ? {} : { $process_person_profile: false }),
      ...input.properties,
    },
  });
}
