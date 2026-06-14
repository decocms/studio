import type { Database } from "@/storage/types";
import type { GoalLedger } from "@decocms/telos";
import {
  createPostgresFactStore,
  createPostgresGoalLedger,
  migrateTelos,
  type TelosTables,
} from "@decocms/telos/postgres";
import type { Kysely } from "kysely";
import type { OnboardingTarget } from "./target";

// telos owns its storage (the `telos` schema). Mesh just binds it to the app's
// target type + connection, mapping org → tenant. The cast is the one boundary
// where mesh's Kysely<Database> meets telos's own tables over the same Postgres.
const asTelos = (db: Kysely<Database>) => db as unknown as Kysely<TelosTables>;

export function onboardingLedger(
  db: Kysely<Database>,
): GoalLedger<OnboardingTarget> {
  return createPostgresGoalLedger<OnboardingTarget>(asTelos(db));
}

export function onboardingFacts(db: Kysely<Database>) {
  return createPostgresFactStore(asTelos(db));
}

export function migrateTelosStore(db: Kysely<Database>): Promise<void> {
  return migrateTelos(asTelos(db));
}
