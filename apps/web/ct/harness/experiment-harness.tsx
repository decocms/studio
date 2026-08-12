/**
 * Mounts `useExperiment` against a REAL posthog-js instance under the real
 * provider, with variants supplied through posthog's `bootstrap` option so the
 * browser needs no network and no PostHog project.
 *
 * What it guards: the wiring. `useExperiment` reads from React context, so a
 * missing `PostHogProvider` throws at mount rather than degrading — the kind of
 * break that otherwise only shows up in production, on the one screen running
 * an experiment.
 */

import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";

import { useExperiment } from "@/hooks/use-experiment";

/** Unroutable: requests fail fast, so flags can only come from bootstrap. */
const OFFLINE_API_HOST = "http://127.0.0.1:1/ph";

let initialized = false;

function Variant({ flag }: { flag: string }) {
  const variant = useExperiment(flag);
  return <div>{variant ?? "(unassigned)"}</div>;
}

export function ExperimentHarness({
  flag,
  flags,
}: {
  flag: string;
  flags: Record<string, string | boolean>;
}) {
  if (!initialized) {
    initialized = true;
    posthog.init("phc_component_test_key", {
      api_host: OFFLINE_API_HOST,
      autocapture: false,
      capture_pageview: false,
      capture_exceptions: false,
      disable_session_recording: true,
      bootstrap: { featureFlags: flags },
    });
  }

  return (
    <PostHogProvider client={posthog}>
      <Variant flag={flag} />
    </PostHogProvider>
  );
}
