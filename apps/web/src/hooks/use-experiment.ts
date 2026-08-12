/**
 * Read the variant a PostHog experiment assigned to the current visitor.
 *
 * Reading the variant IS the exposure: posthog-js emits `$feature_flag_called`
 * on the first read, and PostHog's experiment analysis is built on that event.
 * So call this only where the experiment actually applies — never "just to
 * know", or the control group fills up with people who never saw the surface.
 *
 * Returns `undefined` until flags load, and forever on deployments without
 * `POSTHOG_KEY` (self-hosted / open-source). Every caller therefore needs a
 * fallback that renders the control experience. Boolean (non-multivariate)
 * flags also read as `undefined` — an experiment is always multivariate.
 *
 * ## Randomization unit
 *
 * In-product experiments are randomized by ORGANIZATION: two teammates in one
 * workspace must never see different UIs. That is a property of the flag in
 * PostHog ("aggregate by" the `organization` group type), not of this hook —
 * `PostHogGroupSync` already binds the active org to the session, so an
 * org-aggregated flag resolves correctly here with no extra wiring.
 *
 * Randomize by user only on pre-signup surfaces (landing → signup), where no
 * org exists yet.
 *
 * ## Not the same as org flags
 *
 * `useOrgFlag()` reads `organization_settings.flags` — deterministic product
 * gating we own and set per org. This hook reads a randomized assignment we
 * do not control. Don't use one for the other's job.
 */

import { useFeatureFlagVariantKey } from "posthog-js/react";

export function useExperiment(key: string): string | undefined {
  const variant = useFeatureFlagVariantKey(key);
  return typeof variant === "string" ? variant : undefined;
}
