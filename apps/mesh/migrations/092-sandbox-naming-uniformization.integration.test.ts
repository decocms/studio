/**
 * Integration test for migration 092: sandbox-naming uniformization sweep.
 *
 * Covers four rewrites in one migration:
 *  1. `sandbox_runner_state.sandbox_provider_kind` value rewrites
 *     (docker → local-docker, agent-sandbox → cluster, desktop →
 *     user-desktop, plus legacy remote-user → user-desktop).
 *  2. `connections.metadata.vmMap` top-level key rename → `sandboxMap`.
 *  3. Inside each `sandboxMap[user][branch]` cell: kind key rewrites
 *     (docker → local-docker, agent-sandbox → cluster, desktop →
 *     user-desktop, remote-user → user-desktop) AND the inner
 *     `sandboxProviderKind` field value; drop legacy `host` / `freestyle`
 *     cells entirely.
 *  4. Tool-name strings `"VM_START"` / `"VM_DELETE"` anywhere in
 *     `connections.metadata` → `"SANDBOX_START"` / `"SANDBOX_DELETE"`.
 *
 * Mirrors the 089 test harness pattern.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../src/database/test-db-pg";
import type { MeshDatabase } from "../src/database";
import { up as up092 } from "./092-sandbox-naming-uniformization";

const USER = "user_test";
const ORG = "org_test";

interface ConnectionRow {
  metadata: string | null;
}

interface RunnerStateRow {
  user_id: string;
  project_ref: string;
  sandbox_provider_kind: string;
  handle: string;
}

async function getMetadata(
  database: MeshDatabase,
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
  database: MeshDatabase,
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
  database: MeshDatabase,
): Promise<RunnerStateRow[]> {
  const res = (await sql<RunnerStateRow>`
    SELECT user_id, project_ref, sandbox_provider_kind, handle
    FROM sandbox_runner_state
    ORDER BY handle
  `.execute(database.db)) as unknown as { rows: RunnerStateRow[] };
  return res.rows;
}

async function insertRunnerState(
  database: MeshDatabase,
  handle: string,
  sandboxProviderKind: string,
): Promise<void> {
  // PK is (user_id, project_ref, sandbox_provider_kind) so vary project_ref
  // by handle to keep the test rows distinct.
  await sql`
    INSERT INTO sandbox_runner_state (
      user_id, project_ref, sandbox_provider_kind, handle, state
    ) VALUES (
      ${USER}, ${"proj_" + handle}, ${sandboxProviderKind}, ${handle}, '{}'::jsonb
    )
  `.execute(database.db);
}

describe("migration 092 — sandbox naming uniformization", () => {
  let database: MeshDatabase;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
  });

  it("rewrites sandbox_runner_state.sandbox_provider_kind values", async () => {
    await insertRunnerState(database, "h-docker", "docker");
    await insertRunnerState(database, "h-agent-sandbox", "agent-sandbox");
    await insertRunnerState(database, "h-desktop", "desktop");
    await insertRunnerState(database, "h-remote-user", "remote-user");
    // Already-canonical row, must not change.
    await insertRunnerState(database, "h-cluster", "cluster");

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up092(database.db as any);

    const rows = await listRunnerState(database);
    const byHandle = Object.fromEntries(
      rows.map((r) => [r.handle, r.sandbox_provider_kind] as const),
    );
    expect(byHandle["h-docker"]).toBe("local-docker");
    expect(byHandle["h-agent-sandbox"]).toBe("cluster");
    expect(byHandle["h-desktop"]).toBe("user-desktop");
    expect(byHandle["h-remote-user"]).toBe("user-desktop");
    expect(byHandle["h-cluster"]).toBe("cluster");
  });

  it("renames vmMap → sandboxMap on connections.metadata", async () => {
    const inner = {
      "local-docker": {
        sandboxHandle: "vm-a",
        previewUrl: "http://x/preview",
        sandboxProviderKind: "local-docker",
        createdAt: 1779000000000,
      },
    };
    await insertVirtualConnection(database, "vir_rename_map", {
      vmMap: {
        [USER]: {
          "deco/branch-a": inner,
        },
      },
      otherField: "kept",
    });

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up092(database.db as any);

    const meta = await getMetadata(database, "vir_rename_map");
    expect(meta.vmMap).toBeUndefined();
    expect(meta.sandboxMap).toEqual({
      [USER]: {
        "deco/branch-a": inner,
      },
    });
    expect(meta.otherField).toBe("kept");
  });

  it("rewrites inner kind keys and sandboxProviderKind field values", async () => {
    await insertVirtualConnection(database, "vir_inner_keys", {
      vmMap: {
        [USER]: {
          "deco/branch-a": {
            docker: {
              vmId: "vm-d",
              previewUrl: null,
              sandboxProviderKind: "docker",
              createdAt: 1779000000001,
            },
            desktop: {
              vmId: "vm-dt",
              previewUrl: null,
              sandboxProviderKind: "desktop",
              createdAt: 1779000000002,
            },
            "agent-sandbox": {
              vmId: "vm-as",
              previewUrl: null,
              sandboxProviderKind: "agent-sandbox",
              createdAt: 1779000000003,
            },
            "remote-user": {
              vmId: "vm-ru",
              previewUrl: null,
              sandboxProviderKind: "remote-user",
              createdAt: 1779000000004,
            },
          },
        },
      },
    });

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up092(database.db as any);

    const meta = (await getMetadata(database, "vir_inner_keys")) as {
      sandboxMap: Record<string, Record<string, Record<string, unknown>>>;
    };
    const branch = meta.sandboxMap[USER]!["deco/branch-a"]!;
    // Keys are remapped.
    expect(Object.keys(branch).sort()).toEqual(
      ["cluster", "local-docker", "user-desktop"].sort(),
    );
    // remote-user collapsed onto user-desktop (last writer wins); either entry
    // body is acceptable, but the field must match the canonical key.
    expect(branch["local-docker"]).toMatchObject({
      sandboxProviderKind: "local-docker",
    });
    expect(branch["cluster"]).toMatchObject({
      sandboxProviderKind: "cluster",
    });
    expect(branch["user-desktop"]).toMatchObject({
      sandboxProviderKind: "user-desktop",
    });
  });

  it("drops legacy host/freestyle cells while preserving valid ones", async () => {
    await insertVirtualConnection(database, "vir_drop_legacy", {
      vmMap: {
        [USER]: {
          "deco/branch-x": {
            host: {
              vmId: "vm-host",
              sandboxProviderKind: "host",
              createdAt: 1,
            },
            freestyle: {
              vmId: "vm-fs",
              sandboxProviderKind: "freestyle",
              createdAt: 2,
            },
            docker: {
              vmId: "vm-d",
              previewUrl: null,
              sandboxProviderKind: "docker",
              createdAt: 3,
            },
          },
        },
      },
    });

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up092(database.db as any);

    const meta = (await getMetadata(database, "vir_drop_legacy")) as {
      sandboxMap: Record<string, Record<string, Record<string, unknown>>>;
    };
    const branch = meta.sandboxMap[USER]!["deco/branch-x"]!;
    expect(Object.keys(branch).sort()).toEqual(["local-docker"]);
    expect(branch["local-docker"]).toMatchObject({
      sandboxProviderKind: "local-docker",
    });
  });

  it("rewrites stored VM_START / VM_DELETE tool-name strings", async () => {
    await insertVirtualConnection(database, "vir_tool_names", {
      toolAllowList: ["VM_START", "VM_DELETE", "OTHER_TOOL"],
      systemPrompt:
        "When asked, call VM_START with the user id; later VM_DELETE.",
      nested: { allowed: ["VM_START"] },
    });

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up092(database.db as any);

    const meta = (await getMetadata(database, "vir_tool_names")) as {
      toolAllowList: string[];
      systemPrompt: string;
      nested: { allowed: string[] };
    };
    expect(meta.toolAllowList).toEqual([
      "SANDBOX_START",
      "SANDBOX_DELETE",
      "OTHER_TOOL",
    ]);
    expect(meta.nested.allowed).toEqual(["SANDBOX_START"]);
    // Bare-word substrings inside free-form strings (no surrounding quotes
    // in the JSON encoding) are intentionally left alone — the rewrite only
    // targets the quoted form '"VM_START"' / '"VM_DELETE"' to avoid
    // mangling natural-language text. The systemPrompt above will retain
    // its `VM_START` and `VM_DELETE` substrings.
    expect(meta.systemPrompt).toBe(
      "When asked, call VM_START with the user id; later VM_DELETE.",
    );
  });

  it("is idempotent — re-running on already-migrated rows is a no-op", async () => {
    await insertRunnerState(database, "h-already", "user-desktop");
    await insertVirtualConnection(database, "vir_idem", {
      sandboxMap: {
        [USER]: {
          "deco/branch-i": {
            "user-desktop": {
              sandboxHandle: "vm-i",
              previewUrl: null,
              sandboxProviderKind: "user-desktop",
              createdAt: 1779000000005,
            },
          },
        },
      },
      toolAllowList: ["SANDBOX_START"],
    });

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up092(database.db as any);
    const after1Meta = await getMetadata(database, "vir_idem");
    const after1Runner = await listRunnerState(database);

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up092(database.db as any);
    const after2Meta = await getMetadata(database, "vir_idem");
    const after2Runner = await listRunnerState(database);

    expect(after2Meta).toEqual(after1Meta);
    expect(after2Runner).toEqual(after1Runner);
  });

  it("leaves rows without a vmMap or sandboxMap untouched", async () => {
    await insertVirtualConnection(database, "vir_no_map", {
      instructions: "hello",
    });

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up092(database.db as any);

    const meta = await getMetadata(database, "vir_no_map");
    expect(meta).toEqual({ instructions: "hello" });
  });
});
