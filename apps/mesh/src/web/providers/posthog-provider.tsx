/**
 * Initializes PostHog from the runtime public config and syncs the
 * Better Auth session into it.
 *
 * - Calls `initPostHog(key, host)` once on mount when `posthog` config
 *   is present (server returns `posthog: null` when unconfigured).
 * - Calls `identify` when a logged-in user is present.
 * - Calls `reset` when the session clears (logout).
 *
 * Must render below the Suspense boundary that fetches /api/config.
 */

import { authClient } from "@/web/lib/auth-client";
import { identifyUser, initPostHog, resetUser } from "@/web/lib/posthog-client";
import { usePublicConfig } from "@/web/hooks/use-public-config";

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

  return <>{children}</>;
}
