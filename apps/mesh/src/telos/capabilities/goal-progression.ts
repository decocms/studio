import type { Goal } from "@/telos/target";
import { telosBus } from "../durable/bus";
import { defineCapability } from "../durable/capability";

// The whole onboarding curriculum lives inside the one fixed Goal (its ordered
// steps), so progression happens WITHIN a goal via the domain's gap/plan — there's
// no separate "next goal" to author here. Reaching the Goal means every step is
// done: a milestone, and the striver rests. A richer post-onboarding Goal (manage
// sites, drive metrics) would be installed here once its domain exists; until then,
// returning null is the whole lesson — better no goal than a dumb one.
function nextGoal(_reached: Goal): Goal | null {
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

    const next = nextGoal(reached);
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
