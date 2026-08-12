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

import {
  flushBootstrapTiming,
  setOrganizationGroup,
} from "@/lib/posthog-client";
import { useExperiment } from "@/hooks/use-experiment";

/**
 * A/A test validating the experiment pipeline end to end: assignment is
 * org-aggregated, both variants render the identical (empty) UI, so any
 * difference the analysis reports between them is pipeline noise, not a
 * product effect. Keep it running as the baseline for reading real
 * experiments — it is what tells us a "win" is bigger than the floor.
 *
 * Must render below the `setOrganizationGroup` call: the exposure has to
 * carry the org group, or an org-aggregated flag falls back to per-user
 * bucketing.
 */
function ExperimentPipelineCheck() {
  useExperiment("experiment-pipeline-check");
  return null;
}

export function PostHogGroupSync({
  activeOrg,
}: {
  activeOrg: {
    id: string;
    name?: string | null;
    slug?: string | null;
  } | null;
}) {
  if (!activeOrg) return null;

  setOrganizationGroup(activeOrg.id, {
    name: activeOrg.name ?? undefined,
    slug: activeOrg.slug ?? undefined,
  });
  flushBootstrapTiming();

  return <ExperimentPipelineCheck />;
}
