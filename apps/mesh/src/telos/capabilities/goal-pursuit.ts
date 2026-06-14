import { onboardingDomain } from "@/telos/domain";
import { resolvePursuitModel } from "@/telos/model";
import type { OnboardingTarget } from "@/telos/target";
import { type DomainEvent, Eudaimon, type EventBus } from "@decocms/telos";
import { telosBus } from "../durable/bus";
import { defineCapability } from "../durable/capability";
import { adaptiveDeliberator } from "./deliberator";

// Bridge the package's in-process pursuit events onto mesh's durable bus. The
// Eudaimon publishes here as it pursues; we surface the lifecycle moment mesh
// cares about (the goal being reached) and drop the rest — there are no
// in-process subscribers, since the capability calls pursue() directly.
function meshPursuitBus(organizationId: string): EventBus<OnboardingTarget> {
  return {
    async publish(event: DomainEvent<OnboardingTarget>) {
      if (event.type === "unmovedMover.reached") {
        await telosBus.publish({
          type: "goal.reached",
          organizationId,
          version: event.moverVersion,
        });
      }
    },
    subscribe() {},
  };
}

// After a goal is installed, run one pursuit cycle: observe the org, measure the
// gap, deliberate (AI when a model is configured, deterministic otherwise), and
// emit goal.reached once the target is met. OAOO on (org, version) dedupes
// re-fires of the same installed goal.
defineCapability({
  name: "goal-pursuit",
  version: "v1",
  on: "goal.installed",
  key: (event) => `${event.organizationId}:${event.version}`,
  run: async (event, { runtime, step }) => {
    await step("pursue", async () => {
      const eudaimon = new Eudaimon({
        tenant: event.organizationId,
        ledger: runtime.store.ledger,
        domain: onboardingDomain(runtime.db),
        bus: meshPursuitBus(event.organizationId),
        deliberator: adaptiveDeliberator({ resolveModel: resolvePursuitModel }),
      });
      await eudaimon.pursue();
    });
  },
});
