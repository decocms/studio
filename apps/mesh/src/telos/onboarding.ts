import type { Database } from "@/storage/types";
import { inMemoryBus } from "@decocms/telos";
import type { Kysely } from "kysely";
import { researchElenchus } from "./elenchus";
import { KyselyGoalLedger } from "./ledger";
import type { OnboardingTarget } from "./target";

// On signup we research the new owner (mocked) and let the telos engine set the
// org's first goal: the elenchus births a candidate, then an authority
// `goal.updated` event lands it in the ledger as the anchor. The "engine
// reacting" is the goal.updated subscriber installing the goal.
export async function seedOnboardingGoal(opts: {
  db: Kysely<Database>;
  organizationId: string;
  email: string;
}): Promise<void> {
  const { db, organizationId, email } = opts;
  const ledger = new KyselyGoalLedger(db);

  // Idempotent: never double-seed if the creation hook is retried.
  if ((await ledger.history(organizationId)).length > 0) return;

  const bus = inMemoryBus<OnboardingTarget>();
  bus.subscribe("goal.updated", async ({ tenant, target }) => {
    const mover = await ledger.install(tenant, target, "authority");
    console.log(
      `[telos] anchor v${mover.version} set for org ${tenant}:`,
      mover.target,
    );
  });

  // Socratic intake: research → birth a candidate goal…
  const proposal = await researchElenchus(email).deliver(organizationId);
  console.log(`[telos] elenchus (research ${email}): ${proposal.rationale}`);

  // …then the engine reacts to set it as the org's first goal.
  await bus.publish({
    type: "goal.updated",
    tenant: organizationId,
    target: proposal.target,
  });
}
