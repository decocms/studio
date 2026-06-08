/**
 * Integration test for migration 097: drop retired `local-docker` sandbox
 * state.
 *
 * Covers both rewrites:
 *  1. `sandbox_runner_state` rows with sandbox_provider_kind = 'local-docker'
 *     are deleted; canonical (`cluster`, `user-desktop`) rows are preserved.
 *  2. The `local-docker` cell is removed from every
 *     `connections.metadata.sandboxMap[user][branch]`; sibling cells are
 *     preserved and branch/user buckets that become empty are dropped.
 *
 * Mirrors the 092 test harness pattern.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../src/database/test-db-pg";
import type { StudioDatabase } from "../src/database";
import { up as up097 } from "./097-drop-local-docker-sandbox-state";

const USER = "user_test";
const ORG = "org_test";

interface ConnectionRow {
  metadata: string | null;
}

interface RunnerStateRow {
  sandbox_provider_kind: string;
  handle: string;
}

async function getMetadata(
  database: StudioDatabase,
  id: string,
): Promise<Record<string, unknown>> {
  const row = (await sql<ConnectionRow>`
    SELECT metadata FROM connections WHERE id = ${id}
  `.execute(database.db)) as unknown as { rows: ConnectionRow[] };
  const raw = row.rows[0]?.metadata;
  if (!raw) throw new Error(`connection ${id} not found`);
  return JSON.parse(raw) as Record<string, unknown>;
}

async function insertVirtualConnection(
  database: StudioDatabase,
  id: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO connections (
      id, organization_id, created_by, title, connection_type,
      connection_url, metadata, status, created_at, updated_at
    ) VALUES (
      ${id}, ${ORG}, ${USER}, 'test-vm', 'VIRTUAL',
      'virtual://test', ${JSON.stringify(metadata)},
      'active', ${now}, ${now}
    )
  `.execute(database.db);
}

async function listRunnerState(
  database: StudioDatabase,
): Promise<RunnerStateRow[]> {
  const res = (await sql<RunnerStateRow>`
    SELECT sandbox_provider_kind, handle
    FROM sandbox_runner_state
    ORDER BY handle
  `.execute(database.db)) as unknown as { rows: RunnerStateRow[] };
  return res.rows;
}

async function insertRunnerState(
  database: StudioDatabase,
  handle: string,
  sandboxProviderKind: string,
): Promise<void> {
  await sql`
    INSERT INTO sandbox_runner_state (
      user_id, project_ref, sandbox_provider_kind, handle, state
    ) VALUES (
      ${USER}, ${"proj_" + handle}, ${sandboxProviderKind}, ${handle}, '{}'::jsonb
    )
  `.execute(database.db);
}

describe("migration 097 — drop local-docker sandbox state", () => {
  let database: StudioDatabase;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
  });

  it("deletes local-docker runner-state rows and keeps canonical ones", async () => {
    await insertRunnerState(database, "h-local-docker", "local-docker");
    await insertRunnerState(database, "h-cluster", "cluster");
    await insertRunnerState(database, "h-user-desktop", "user-desktop");

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up097(database.db as any);

    const rows = await listRunnerState(database);
    expect(rows.map((r) => r.handle).sort()).toEqual(
      ["h-cluster", "h-user-desktop"].sort(),
    );
    expect(rows.some((r) => r.sandbox_provider_kind === "local-docker")).toBe(
      false,
    );
  });

  it("removes the local-docker cell while preserving sibling kinds", async () => {
    await insertVirtualConnection(database, "vir_siblings", {
      sandboxMap: {
        [USER]: {
          "deco/branch-a": {
            "local-docker": {
              sandboxHandle: "vm-d",
              previewUrl: null,
              sandboxProviderKind: "local-docker",
              createdAt: 1,
            },
            cluster: {
              sandboxHandle: "vm-c",
              previewUrl: null,
              sandboxProviderKind: "cluster",
              createdAt: 2,
            },
          },
        },
      },
      otherField: "kept",
    });

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up097(database.db as any);

    const meta = (await getMetadata(database, "vir_siblings")) as {
      sandboxMap: Record<string, Record<string, Record<string, unknown>>>;
      otherField: string;
    };
    const branch = meta.sandboxMap[USER]!["deco/branch-a"]!;
    expect(Object.keys(branch)).toEqual(["cluster"]);
    expect(meta.otherField).toBe("kept");
  });

  it("drops branch and user buckets that become empty", async () => {
    await insertVirtualConnection(database, "vir_empty", {
      sandboxMap: {
        [USER]: {
          "deco/only-docker": {
            "local-docker": {
              sandboxHandle: "vm-d",
              previewUrl: null,
              sandboxProviderKind: "local-docker",
              createdAt: 1,
            },
          },
        },
      },
    });

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up097(database.db as any);

    const meta = (await getMetadata(database, "vir_empty")) as {
      sandboxMap: Record<string, unknown>;
    };
    expect(meta.sandboxMap).toEqual({});
  });

  it("is idempotent and leaves local-docker-free rows untouched", async () => {
    await insertRunnerState(database, "h-cluster", "cluster");
    await insertVirtualConnection(database, "vir_clean", {
      sandboxMap: {
        [USER]: {
          "deco/branch-c": {
            cluster: {
              sandboxHandle: "vm-c",
              previewUrl: null,
              sandboxProviderKind: "cluster",
              createdAt: 1,
            },
          },
        },
      },
    });

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up097(database.db as any);
    const after1 = await getMetadata(database, "vir_clean");
    const afterRunner1 = await listRunnerState(database);

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up097(database.db as any);
    const after2 = await getMetadata(database, "vir_clean");
    const afterRunner2 = await listRunnerState(database);

    expect(after2).toEqual(after1);
    expect(afterRunner2).toEqual(afterRunner1);
    expect(afterRunner2.map((r) => r.handle)).toEqual(["h-cluster"]);
  });
});
