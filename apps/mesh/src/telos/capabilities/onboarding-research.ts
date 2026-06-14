import { FactStore } from "@/telos/fact-store";
import { KyselyGoalLedger } from "@/telos/ledger";
import { researchUser } from "@/telos/research";
import { telosBus } from "../durable/bus";
import { defineCapability } from "../durable/capability";

// Capability #1 — the elenchus, made durable. On user.signup we research the
// owner (Firecrawl + Perplexity via OpenRouter) and let the telos engine set the
// org's first goal. Each step journals: a crash after `research` resumes at
// `persist-facts` without re-charging the LLM/scrape. OAOO on the workflow ID
// (key = organizationId) makes a double-signup collapse onto one run.
defineCapability({
  name: "onboarding-research",
  version: "v1",
  on: "user.signup",
  key: (event) => event.organizationId,
  run: async (event, { runtime, step }) => {
    const ledger = new KyselyGoalLedger(runtime.db);
    const facts = new FactStore(runtime.db);

    // Skip orgs already seeded (e.g. before this capability existed). OAOO covers
    // re-fires; this covers a pre-existing goal from an earlier seeding path.
    const seeded = await step("check-existing", () =>
      ledger.history(event.organizationId).then((h) => h.length > 0),
    );
    if (seeded) return;

    const result = await step("research", () => researchUser(event.email));
    await step("persist-facts", () =>
      facts.insertMany(event.organizationId, result.facts),
    );
    const mover = await step("install-goal", () =>
      ledger.install(event.organizationId, result.target, "authority"),
    );

    // Notify connected clients the goal landed (best-effort live push).
    await telosBus.publish({
      type: "goal.installed",
      organizationId: event.organizationId,
      version: mover.version,
      title: result.target.title,
    });
  },
});
