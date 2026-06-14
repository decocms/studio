import type { Database } from "@/storage/types";
import type { GoalLedger } from "@decocms/telos";
import {
  createPostgresGoalLedger,
  type TelosLedgerTables,
} from "@decocms/telos/postgres";
import type { Kysely } from "kysely";
import type { OnboardingTarget } from "./target";

// The telos ledger storage lives in @decocms/telos/postgres (it owns the
// telos_goal table). Mesh just binds it to the app's target type + connection.
// The cast is the one boundary where mesh's Kysely<Database> meets the ledger's
// own table view over the same Postgres.
export function onboardingLedger(
  db: Kysely<Database>,
): GoalLedger<OnboardingTarget> {
  return createPostgresGoalLedger<OnboardingTarget>(
    db as unknown as Kysely<TelosLedgerTables>,
  );
}
