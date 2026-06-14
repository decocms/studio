import { researchUser } from "@/telos/research";
import { telosBus } from "../durable/bus";
import { defineCapability } from "../durable/capability";

// On user.signup, research the owner and set the org's first goal. Steps journal
// so a crash after research resumes without re-charging the LLM/scrape.
defineCapability({
  name: "onboarding-research",
  version: "v1",
  on: "user.signup",
  key: (event) => event.organizationId,
  run: async (event, { runtime, step }) => {
    const { ledger, facts } = runtime.store;

    // Skip orgs that already have a goal (OAOO covers re-fires of the same org).
    const seeded = await step("check-existing", async () => {
      const history = await ledger.history(event.organizationId);
      return history.length > 0;
    });
    if (seeded) return;

    const result = await step("research", () => researchUser(event.email));
    await step("persist-facts", () =>
      facts.insertMany(event.organizationId, result.facts),
    );
    const mover = await step("install-goal", () =>
      Promise.resolve(
        ledger.install(event.organizationId, result.target, "authority"),
      ),
    );

    await telosBus.publish({
      type: "goal.installed",
      organizationId: event.organizationId,
      version: mover.version,
      title: result.target.title,
    });
  },
});
