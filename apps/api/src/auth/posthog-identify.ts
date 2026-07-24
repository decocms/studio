/**
 * Builds the PostHog `identify` payload tagging the person record with
 * email/name/email_verified ($set, last-write-wins) and first-seen
 * metadata ($set_once, written only on the first identify per user).
 *
 * Pure for testability — all inputs are explicit. The impure wrapper
 * `identifyAuthenticatedUser` below calls `posthog.identify` with the
 * payload.
 */

import { posthog } from "@/posthog";

export interface IdentifiableUser {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
}

export interface PostHogIdentifyPayload {
  distinctId: string;
  properties: {
    $set: {
      email: string;
      name: string | null;
      email_verified: boolean;
    };
    $set_once: {
      first_seen_at: string;
      signup_email_domain: string | null;
    };
  };
}

export function buildIdentifyPayload(
  user: IdentifiableUser,
  now: Date,
): PostHogIdentifyPayload {
  const domain = user.email.split("@")[1]?.toLowerCase() ?? null;
  return {
    distinctId: user.id,
    properties: {
      $set: {
        email: user.email,
        name: user.name,
        email_verified: user.emailVerified,
      },
      $set_once: {
        first_seen_at: now.toISOString(),
        signup_email_domain: domain,
      },
    },
  };
}

export function identifyAuthenticatedUser(user: IdentifiableUser): void {
  posthog.identify(buildIdentifyPayload(user, new Date()));
}
