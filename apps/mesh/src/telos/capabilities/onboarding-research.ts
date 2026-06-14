import { buildStudioGoal } from "@/telos/goal";
import { researchUser } from "@/telos/research";
import { telosBus } from "../durable/bus";
import { defineCapability } from "../durable/capability";
import { publishThought } from "../durable/thought";

// On user.signup, install the org's FIXED Goal (set by us, deterministic — no LLM,
// no research) and arm its pursuit, then gather facts about the owner in the
// background to personalize the recommendations. Steps journal, so a crash after
// the goal install or after research resumes without re-charging the LLM/scrape.
defineCapability({
  name: "onboarding-research",
  version: "v4",
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

    // Install the fixed Goal first — deterministic, never fails — so the user
    // always has their Goal even if research later errors out.
    const goal = buildStudioGoal();
    const mover = await step("install-goal", () =>
      Promise.resolve(ledger.install(event.organizationId, goal, "authority")),
    );

    await telosBus.publish({
      type: "goal.installed",
      organizationId: event.organizationId,
      version: mover.version,
      title: goal.title,
    });

    // Facts are personalization, not the Goal: research the owner best-effort and
    // attach what we can cite. Network + LLM + scrape — retry transient failures
    // with backoff; journaled, so a success never re-charges.
    const result = await step(
      "research",
      () =>
        researchUser({ email: event.email, name: event.name }, (text) =>
          publishThought(event.organizationId, { text, phase: "research" }),
        ),
      {
        retriesAllowed: true,
        maxAttempts: 5,
        intervalSeconds: 2,
      },
    );
    if (result.facts.length > 0) {
      await step("persist-facts", () =>
        facts.insertMany(event.organizationId, result.facts),
      );
      await telosBus.publish({
        type: "facts.updated",
        organizationId: event.organizationId,
      });
    }
  },
});
