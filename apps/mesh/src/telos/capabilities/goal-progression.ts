import type { OnboardingTarget } from "@/telos/target";
import { telosBus } from "../durable/bus";
import { defineCapability } from "../durable/capability";

// The onboarding curriculum: once a goal is reached, optionally author the next.
// A meaningful next goal must be SPECIFIC and grounded in the person (e.g. "now
// connect Slack to get notified") — which requires research, not a hardcoded
// rung. Until that's wired, the striver rests rather than inventing busywork:
// returning null is the whole lesson — better no goal than a dumb one.
function nextOnboardingGoal(
  _reached: OnboardingTarget,
): OnboardingTarget | null {
  return null;
}

// On goal.reached, progress to the next goal. OAOO on (org, reached version)
// dedupes re-fires so a rung is only ever advanced once.
defineCapability({
  name: "goal-progression",
  version: "v1",
  on: "goal.reached",
  key: (event) => `${event.organizationId}:${event.version}`,
  run: async (event, { runtime, step }) => {
    const { ledger } = runtime.store;

    // The reached goal is the latest until we install the next — only this
    // capability installs engine goals, so there's no race on `latest`.
    const reached = await step("load-reached", async () => {
      const mover = await ledger.latest(event.organizationId);
      return mover.target;
    });

    const next = nextOnboardingGoal(reached);
    if (!next) return;

    const mover = await step("install-next", () =>
      Promise.resolve(ledger.install(event.organizationId, next, "engine")),
    );

    await telosBus.publish({
      type: "goal.installed",
      organizationId: event.organizationId,
      version: mover.version,
      title: next.title,
    });
  },
});
