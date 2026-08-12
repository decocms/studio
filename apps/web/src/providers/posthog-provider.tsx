/**
 * Initializes PostHog from the runtime public config and syncs the
 * Better Auth session into it.
 *
 * - Calls `initPostHog(key, host)` once on mount when `posthog` config
 *   is present (server returns `posthog: null` when unconfigured).
 * - Calls `identify` when a logged-in user is present.
 * - Calls `reset` when the session clears (logout).
 * - Puts the singleton on React context so `useExperiment` (and any other
 *   posthog-js/react hook) can subscribe to feature-flag loads.
 *
 * Must render below the Suspense boundary that fetches /api/config.
 */

import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";

import { authClient } from "@/lib/auth-client";
import { identifyUser, initPostHog, resetUser } from "@/lib/posthog-client";
import { usePublicConfig } from "@/hooks/use-public-config";

let lastUserId: string | null = null;

export function PostHogIdentitySync({
  children,
}: {
  children: React.ReactNode;
}) {
  const publicConfig = usePublicConfig();
  const { data: session } = authClient.useSession();

  if (publicConfig.posthog) {
    initPostHog(publicConfig.posthog.key, publicConfig.posthog.host);

    const userId = session?.user?.id ?? null;

    if (userId && userId !== lastUserId) {
      identifyUser(userId, {
        email: session?.user?.email,
        name: session?.user?.name,
      });
      lastUserId = userId;
    } else if (!userId && lastUserId) {
      resetUser();
      lastUserId = null;
    }
  }

  return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
}
