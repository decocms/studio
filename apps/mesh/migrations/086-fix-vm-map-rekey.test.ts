/**
 * Integration test for migration 082.
 *
 * Migrations 080 and 081 silently no-op'd against the wrong table name. This
 * test pins down that 082 actually rewrites the data on a `connections` row
 * (where virtual MCPs live) and that re-running is a no-op — so a fresh
 * install never regresses to the v1 shape, and a partial-prior-run state
 * converges on a single re-run.
 */

import { beforeEach, afterEach, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import {
  closeTestDatabase,
  createTestDatabase,
  type TestDatabase,
} from "../src/database/test-db";
import {
  createTestSchema,
  seedCommonTestFixtures,
} from "../src/storage/test-helpers";
import { up as up086 } from "./086-fix-vm-map-rekey";

const USER = "user_test";
const ORG = "org_test";

interface ConnectionRow {
  metadata: string | null;
}

async function getMetadata(
  database: TestDatabase,
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
  database: TestDatabase,
  id: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const now = new Date().toISOString();
  // `connection_url` is NOT NULL even for VIRTUAL connections; tests use
  // an inert placeholder URL since the migration only touches `metadata`.
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

describe("migration 082 — fix vmMap rekey", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);
    await seedCommonTestFixtures(database.db);
  });

  afterEach(async () => {
    await closeTestDatabase(database);
  });

  it("wraps a v1 bare entry under its sandboxProviderKind", async () => {
    await insertVirtualConnection(database, "vir_v1_kind", {
      vmMap: {
        [USER]: {
          "deco/branch-a": {
            vmId: "vm-a",
            previewUrl: "http://x/preview",
            sandboxProviderKind: "remote-user",
            createdAt: 1779000000000,
          },
        },
      },
    });

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up086(database.db as any);

    const meta = await getMetadata(database, "vir_v1_kind");
    expect(meta).toEqual({
      vmMap: {
        [USER]: {
          "deco/branch-a": {
            "remote-user": {
              vmId: "vm-a",
              previewUrl: "http://x/preview",
              sandboxProviderKind: "remote-user",
              createdAt: 1779000000000,
            },
          },
        },
      },
    });
  });

  it("falls back to runnerKind, then docker, when sandboxProviderKind is absent", async () => {
    await insertVirtualConnection(database, "vir_v1_runner", {
      vmMap: {
        [USER]: {
          "deco/branch-runner": {
            vmId: "vm-r",
            previewUrl: null,
            runnerKind: "agent-sandbox",
            createdAt: 1779000000001,
          },
          "deco/branch-default": {
            vmId: "vm-d",
            previewUrl: null,
          },
        },
      },
    });

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up086(database.db as any);

    const meta = (await getMetadata(database, "vir_v1_runner")) as {
      vmMap: Record<string, Record<string, Record<string, unknown>>>;
    };
    const userBranches = meta.vmMap[USER]!;
    // The runnerKind branch was wrapped under "agent-sandbox" AND its inner
    // entry's `runnerKind` key was renamed to `sandboxProviderKind`.
    const runnerBranch = userBranches["deco/branch-runner"]!;
    expect(Object.keys(runnerBranch)).toEqual(["agent-sandbox"]);
    expect(runnerBranch["agent-sandbox"]).toEqual({
      vmId: "vm-r",
      previewUrl: null,
      sandboxProviderKind: "agent-sandbox",
      createdAt: 1779000000001,
    });
    // The bare-default branch (no kind hint) was wrapped under "docker".
    expect(Object.keys(userBranches["deco/branch-default"]!)).toEqual([
      "docker",
    ]);
  });

  it("renames runnerKind → sandboxProviderKind on already-v2 inner entries", async () => {
    await insertVirtualConnection(database, "vir_v2_runner", {
      vmMap: {
        [USER]: {
          "deco/branch-c": {
            "agent-sandbox": {
              vmId: "vm-c",
              previewUrl: null,
              runnerKind: "agent-sandbox",
              createdAt: 1779000000002,
            },
          },
        },
      },
    });

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up086(database.db as any);

    const meta = await getMetadata(database, "vir_v2_runner");
    expect(meta).toEqual({
      vmMap: {
        [USER]: {
          "deco/branch-c": {
            "agent-sandbox": {
              vmId: "vm-c",
              previewUrl: null,
              sandboxProviderKind: "agent-sandbox",
              createdAt: 1779000000002,
            },
          },
        },
      },
    });
  });

  it("is idempotent — re-running on a clean row makes no change", async () => {
    await insertVirtualConnection(database, "vir_idem", {
      vmMap: {
        [USER]: {
          "deco/branch-i": {
            "remote-user": {
              vmId: "vm-i",
              previewUrl: null,
              sandboxProviderKind: "remote-user",
              createdAt: 1779000000003,
            },
          },
        },
      },
    });

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up086(database.db as any);
    const after1 = await getMetadata(database, "vir_idem");
    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up086(database.db as any);
    const after2 = await getMetadata(database, "vir_idem");

    expect(after2).toEqual(after1);
  });

  it("leaves rows without a vmMap untouched", async () => {
    await insertVirtualConnection(database, "vir_no_map", {
      instructions: "hello",
    });

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up086(database.db as any);

    const meta = await getMetadata(database, "vir_no_map");
    expect(meta).toEqual({ instructions: "hello" });
  });
});
