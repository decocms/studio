/**
 * Binds the current PostHog browser session to the active organization
 * group. Render once `activeOrg` is resolved so that every subsequent
 * autocaptured event carries `$groups: { organization: <id> }`.
 *
 * Side-effect during render is intentional and matches the project's
 * existing `PostHogIdentitySync` pattern (see ban on `useEffect` in
 * plugins/ban-use-effect.ts). De-duplication lives in
 * `setOrganizationGroup` itself, so re-renders are cheap.
 */

import { setOrganizationGroup } from "@/web/lib/posthog-client";

export function PostHogGroupSync({
  activeOrg,
}: {
  activeOrg: {
    id: string;
    name?: string | null;
    slug?: string | null;
  } | null;
}) {
  if (activeOrg) {
    setOrganizationGroup(activeOrg.id, {
      name: activeOrg.name ?? undefined,
      slug: activeOrg.slug ?? undefined,
    });
  }
  return null;
}
