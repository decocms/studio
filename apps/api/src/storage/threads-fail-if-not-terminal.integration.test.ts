/**
 * Real-Postgres coverage for `failIfNotTerminal` — the takeover write behind a
 * manual task re-run.
 *
 * This is a SQL predicate (`status in ('in_progress','requires_action')`), so it
 * only means anything against a real database: an in-memory fake would accept
 * any status and the `update()` column whitelist would silently drop the
 * failure columns. The distinction from `markRunFailed` — which deliberately
 * refuses a `requires_action` row — is the whole point, so both are exercised
 * side by side.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { SqlThreadStorage } from "./threads";

const ORG = "org_fail_not_terminal";
const USER = "user_fail_not_terminal";

describe("failIfNotTerminal (real Postgres)", () => {
  let database: StudioDatabase;
  let threads: SqlThreadStorage;

  const threadWith = async (status: string) => {
    const thread = await threads.create({
      organization_id: ORG,
      title: "run",
      status: status as never,
      message_storage_version: 2,
      created_by: USER,
    });
    return thread;
  };

  /** The columns only a raw read surfaces — `Thread` doesn't carry them. */
  const failureColumnsOf = async (id: string) =>
    await database.db
      .selectFrom("threads")
      .select(["status", "failure_reason", "failure_kind"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await database.db
      .insertInto("organization")
      .values({
        id: ORG,
        name: ORG,
        slug: "org-fail-not-terminal",
        createdAt: new Date().toISOString(),
      })
      .execute();
    // threads.created_by is a real FK — the runs need an actual user row.
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"fail@notterminal.test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    threads = new SqlThreadStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("fails an in_progress run and records the reason", async () => {
    const thread = await threadWith("in_progress");

    const result = await threads.failIfNotTerminal(
      thread.id,
      ORG,
      "Superseded by a manual re-run of this task",
      "superseded",
    );

    expect(result).not.toBeNull();
    expect(await failureColumnsOf(thread.id)).toEqual({
      status: "failed",
      failure_reason: "Superseded by a manual re-run of this task",
      failure_kind: "superseded",
    });
  });

  // The reason this method exists: `requires_action` is non-terminal to
  // `shouldAdvanceToReview`, so a leftover one blocks the card's auto-advance
  // forever no matter how many later runs succeed.
  it("fails a run parked on requires_action, which markRunFailed refuses", async () => {
    const parked = await threadWith("requires_action");

    // The narrow writer leaves it alone — that guard is deliberate.
    expect(
      await threads.markRunFailed(parked.id, ORG, "nope", "superseded"),
    ).toBeNull();
    expect((await failureColumnsOf(parked.id)).status).toBe("requires_action");

    // The takeover writer closes it out.
    expect(
      await threads.failIfNotTerminal(
        parked.id,
        ORG,
        "taken over",
        "superseded",
      ),
    ).not.toBeNull();
    expect((await failureColumnsOf(parked.id)).status).toBe("failed");
  });

  it("never clobbers a run that already settled", async () => {
    for (const status of ["completed", "failed"] as const) {
      const settled = await threadWith(status);

      expect(
        await threads.failIfNotTerminal(
          settled.id,
          ORG,
          "should not apply",
          "superseded",
        ),
      ).toBeNull();

      const row = await failureColumnsOf(settled.id);
      expect(row.status).toBe(status);
      expect(row.failure_reason).toBeNull();
    }
  });

  it("is org-scoped — another org's thread is untouched", async () => {
    const thread = await threadWith("in_progress");

    expect(
      await threads.failIfNotTerminal(
        thread.id,
        "org_someone_else",
        "cross-org",
        "superseded",
      ),
    ).toBeNull();
    expect((await failureColumnsOf(thread.id)).status).toBe("in_progress");
  });
});
