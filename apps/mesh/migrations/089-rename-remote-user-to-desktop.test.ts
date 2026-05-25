/**
 * Integration test for migration 089: vmMap kind-key + sandboxProviderKind
 * rename from `remote-user` to `desktop`.
 *
 * Mirrors the 087 pattern: writes to `connections` rows (where virtual
 * MCPs live as `connection_type='VIRTUAL'`), runs the migration directly,
 * asserts the resulting `metadata` JSON shape, and confirms re-running is a
 * no-op. Runner-state and thread updates are exercised by the integration
 * suite where those tables are seeded — the migration test focuses on the
 * JSONB rewrites because that's where the logic is non-trivial.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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
import { up as up089 } from "./089-rename-remote-user-to-desktop";

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

describe("migration 089 — rename remote-user → desktop", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);
    await seedCommonTestFixtures(database.db);
  });

  afterEach(async () => {
    await closeTestDatabase(database);
  });

  it("renames the inner 'remote-user' kind key to 'desktop'", async () => {
    await insertVirtualConnection(database, "vir_kind_key", {
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

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up089(database.db as any);

    const meta = await getMetadata(database, "vir_kind_key");
    expect(meta).toEqual({
      vmMap: {
        [USER]: {
          "deco/branch-a": {
            desktop: {
              vmId: "vm-a",
              previewUrl: "http://x/preview",
              sandboxProviderKind: "desktop",
              createdAt: 1779000000000,
            },
          },
        },
      },
    });
  });

  it("rewrites sandboxProviderKind field value even when key already migrated", async () => {
    // Edge case: the outer key matches the new name but the inner
    // sandboxProviderKind field still carries the old value (would happen
    // if writer was upgraded mid-flight and the row was written halfway).
    await insertVirtualConnection(database, "vir_field_only", {
      vmMap: {
        [USER]: {
          "deco/branch-b": {
            desktop: {
              vmId: "vm-b",
              previewUrl: null,
              sandboxProviderKind: "remote-user",
              createdAt: 1779000000001,
            },
          },
        },
      },
    });

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up089(database.db as any);

    const meta = (await getMetadata(database, "vir_field_only")) as {
      vmMap: Record<string, Record<string, Record<string, unknown>>>;
    };
    const branch = meta.vmMap[USER]!["deco/branch-b"]!;
    expect(branch.desktop).toEqual({
      vmId: "vm-b",
      previewUrl: null,
      sandboxProviderKind: "desktop",
      createdAt: 1779000000001,
    });
  });

  it("leaves other kinds (docker, agent-sandbox) untouched", async () => {
    await insertVirtualConnection(database, "vir_other_kinds", {
      vmMap: {
        [USER]: {
          "deco/branch-c": {
            docker: {
              vmId: "vm-d",
              previewUrl: null,
              sandboxProviderKind: "docker",
              createdAt: 1779000000002,
            },
            "agent-sandbox": {
              vmId: "vm-as",
              previewUrl: null,
              sandboxProviderKind: "agent-sandbox",
              createdAt: 1779000000003,
            },
          },
        },
      },
    });

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up089(database.db as any);

    const meta = await getMetadata(database, "vir_other_kinds");
    expect(meta).toEqual({
      vmMap: {
        [USER]: {
          "deco/branch-c": {
            docker: {
              vmId: "vm-d",
              previewUrl: null,
              sandboxProviderKind: "docker",
              createdAt: 1779000000002,
            },
            "agent-sandbox": {
              vmId: "vm-as",
              previewUrl: null,
              sandboxProviderKind: "agent-sandbox",
              createdAt: 1779000000003,
            },
          },
        },
      },
    });
  });

  it("is idempotent — re-running on already-migrated row makes no change", async () => {
    await insertVirtualConnection(database, "vir_idem", {
      vmMap: {
        [USER]: {
          "deco/branch-i": {
            desktop: {
              vmId: "vm-i",
              previewUrl: null,
              sandboxProviderKind: "desktop",
              createdAt: 1779000000004,
            },
          },
        },
      },
    });

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up089(database.db as any);
    const after1 = await getMetadata(database, "vir_idem");
    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up089(database.db as any);
    const after2 = await getMetadata(database, "vir_idem");

    expect(after2).toEqual(after1);
  });

  it("leaves rows without a vmMap untouched", async () => {
    await insertVirtualConnection(database, "vir_no_map", {
      instructions: "hello",
    });

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up089(database.db as any);

    const meta = await getMetadata(database, "vir_no_map");
    expect(meta).toEqual({ instructions: "hello" });
  });
});
