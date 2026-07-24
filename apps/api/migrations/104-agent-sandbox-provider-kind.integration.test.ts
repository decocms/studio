/**
 * Integration test for migration 104: canonicalize persisted sandbox provider
 * kind values from the legacy `cluster` spelling to `agent-sandbox`.
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
import {
  down as down104,
  up as up104,
} from "./104-agent-sandbox-provider-kind";

const USER = "user_test";
const ORG = "org_test";

interface ConnectionRow {
  metadata: string | null;
}

interface ProviderKindRow {
  id: string;
  sandbox_provider_kind: string | null;
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
  connectionType = "VIRTUAL",
): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO connections (
      id, organization_id, created_by, title, connection_type,
      connection_url, metadata, status, created_at, updated_at
    ) VALUES (
      ${id}, ${ORG}, ${USER}, 'test-sandbox-map', ${connectionType},
      'virtual://test', ${JSON.stringify(metadata)},
      'active', ${now}, ${now}
    )
  `.execute(database.db);
}

async function insertThread(
  database: StudioDatabase,
  id: string,
  sandboxProviderKind: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO threads (
      id, organization_id, created_by, title, status,
      sandbox_provider_kind, created_at, updated_at
    )
    VALUES (
      ${id}, ${ORG}, ${USER}, 'Test', 'idle',
      ${sandboxProviderKind}, ${now}, ${now}
    )
  `.execute(database.db);
}

async function insertRunnerState(
  database: StudioDatabase,
  handle: string,
  sandboxProviderKind: string,
  opts: {
    projectRef?: string;
    state?: Record<string, unknown>;
    updatedAt?: string;
  } = {},
): Promise<void> {
  await sql`
    INSERT INTO sandbox_runner_state (
      user_id, project_ref, sandbox_provider_kind, handle, state, updated_at
    ) VALUES (
      ${USER},
      ${opts.projectRef ?? "proj_" + handle},
      ${sandboxProviderKind},
      ${handle},
      ${JSON.stringify(opts.state ?? {})}::jsonb,
      ${opts.updatedAt ?? new Date().toISOString()}
    )
  `.execute(database.db);
}

async function listThreadKinds(
  database: StudioDatabase,
): Promise<ProviderKindRow[]> {
  const res = (await sql<ProviderKindRow>`
    SELECT id, sandbox_provider_kind
    FROM threads
    WHERE id LIKE 'thr_104_%'
    ORDER BY id
  `.execute(database.db)) as unknown as { rows: ProviderKindRow[] };
  return res.rows;
}

async function listRunnerKinds(
  database: StudioDatabase,
): Promise<ProviderKindRow[]> {
  const res = (await sql<ProviderKindRow>`
    SELECT handle AS id, sandbox_provider_kind
    FROM sandbox_runner_state
    WHERE handle LIKE 'h-104-%'
    ORDER BY handle
  `.execute(database.db)) as unknown as { rows: ProviderKindRow[] };
  return res.rows;
}

interface RunnerStateRow {
  handle: string;
  sandbox_provider_kind: string;
  state: Record<string, unknown>;
  updated_at: Date;
}

async function getRunnerState(
  database: StudioDatabase,
  projectRef: string,
  sandboxProviderKind: string,
): Promise<RunnerStateRow | undefined> {
  const res = (await sql<RunnerStateRow>`
    SELECT handle, sandbox_provider_kind, state, updated_at
    FROM sandbox_runner_state
    WHERE user_id = ${USER}
      AND project_ref = ${projectRef}
      AND sandbox_provider_kind = ${sandboxProviderKind}
  `.execute(database.db)) as unknown as { rows: RunnerStateRow[] };
  return res.rows[0];
}

describe("migration 104 - agent-sandbox provider kind canonicalization", () => {
  let database: StudioDatabase;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
  });

  it("rewrites table provider kinds up and down", async () => {
    await insertThread(database, "thr_104_cluster", "cluster");
    await insertThread(database, "thr_104_agent_sandbox", "agent-sandbox");
    await insertThread(database, "thr_104_user_desktop", "user-desktop");
    await insertThread(database, "thr_104_null", null);
    await insertRunnerState(database, "h-104-cluster", "cluster");
    await insertRunnerState(database, "h-104-agent-sandbox", "agent-sandbox");
    await insertRunnerState(database, "h-104-user-desktop", "user-desktop");

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up104(database.db as any);

    expect(await listThreadKinds(database)).toEqual([
      { id: "thr_104_agent_sandbox", sandbox_provider_kind: "agent-sandbox" },
      { id: "thr_104_cluster", sandbox_provider_kind: "agent-sandbox" },
      { id: "thr_104_null", sandbox_provider_kind: null },
      { id: "thr_104_user_desktop", sandbox_provider_kind: "user-desktop" },
    ]);
    expect(await listRunnerKinds(database)).toEqual([
      { id: "h-104-agent-sandbox", sandbox_provider_kind: "agent-sandbox" },
      { id: "h-104-cluster", sandbox_provider_kind: "agent-sandbox" },
      { id: "h-104-user-desktop", sandbox_provider_kind: "user-desktop" },
    ]);

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await down104(database.db as any);

    expect(await listThreadKinds(database)).toEqual([
      { id: "thr_104_agent_sandbox", sandbox_provider_kind: "cluster" },
      { id: "thr_104_cluster", sandbox_provider_kind: "cluster" },
      { id: "thr_104_null", sandbox_provider_kind: null },
      { id: "thr_104_user_desktop", sandbox_provider_kind: "user-desktop" },
    ]);
    expect(await listRunnerKinds(database)).toEqual([
      { id: "h-104-agent-sandbox", sandbox_provider_kind: "cluster" },
      { id: "h-104-cluster", sandbox_provider_kind: "cluster" },
      { id: "h-104-user-desktop", sandbox_provider_kind: "user-desktop" },
    ]);
  });

  it("keeps the newer runner-state row when up migration collides", async () => {
    const projectLegacyNewer = "proj_104_legacy_newer";
    const projectCanonicalNewer = "proj_104_canonical_newer";

    await insertRunnerState(
      database,
      "h-104-legacy-newer-old-agent",
      "agent-sandbox",
      {
        projectRef: projectLegacyNewer,
        state: { version: "old-agent" },
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    );
    await insertRunnerState(database, "h-104-legacy-newer-cluster", "cluster", {
      projectRef: projectLegacyNewer,
      state: { version: "new-cluster" },
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    await insertRunnerState(
      database,
      "h-104-canonical-newer-agent",
      "agent-sandbox",
      {
        projectRef: projectCanonicalNewer,
        state: { version: "new-agent" },
        updatedAt: "2026-01-04T00:00:00.000Z",
      },
    );
    await insertRunnerState(
      database,
      "h-104-canonical-newer-cluster",
      "cluster",
      {
        projectRef: projectCanonicalNewer,
        state: { version: "old-cluster" },
        updatedAt: "2026-01-03T00:00:00.000Z",
      },
    );

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up104(database.db as any);

    const legacyNewer = await getRunnerState(
      database,
      projectLegacyNewer,
      "agent-sandbox",
    );
    expect(legacyNewer).toMatchObject({
      handle: "h-104-legacy-newer-cluster",
      sandbox_provider_kind: "agent-sandbox",
      state: { version: "new-cluster" },
    });
    expect(
      await getRunnerState(database, projectLegacyNewer, "cluster"),
    ).toBeUndefined();

    const canonicalNewer = await getRunnerState(
      database,
      projectCanonicalNewer,
      "agent-sandbox",
    );
    expect(canonicalNewer).toMatchObject({
      handle: "h-104-canonical-newer-agent",
      sandbox_provider_kind: "agent-sandbox",
      state: { version: "new-agent" },
    });
    expect(
      await getRunnerState(database, projectCanonicalNewer, "cluster"),
    ).toBeUndefined();
  });

  it("keeps the newer runner-state row when down migration collides", async () => {
    const projectCanonicalNewer = "proj_104_down_agent_newer";
    const projectLegacyNewer = "proj_104_down_cluster_newer";

    await insertRunnerState(
      database,
      "h-104-down-agent-newer-agent",
      "agent-sandbox",
      {
        projectRef: projectCanonicalNewer,
        state: { version: "new-agent" },
        updatedAt: "2026-02-02T00:00:00.000Z",
      },
    );
    await insertRunnerState(
      database,
      "h-104-down-agent-newer-cluster",
      "cluster",
      {
        projectRef: projectCanonicalNewer,
        state: { version: "old-cluster" },
        updatedAt: "2026-02-01T00:00:00.000Z",
      },
    );
    await insertRunnerState(
      database,
      "h-104-down-cluster-newer-agent",
      "agent-sandbox",
      {
        projectRef: projectLegacyNewer,
        state: { version: "old-agent" },
        updatedAt: "2026-02-03T00:00:00.000Z",
      },
    );
    await insertRunnerState(
      database,
      "h-104-down-cluster-newer-cluster",
      "cluster",
      {
        projectRef: projectLegacyNewer,
        state: { version: "new-cluster" },
        updatedAt: "2026-02-04T00:00:00.000Z",
      },
    );

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await down104(database.db as any);

    const canonicalNewer = await getRunnerState(
      database,
      projectCanonicalNewer,
      "cluster",
    );
    expect(canonicalNewer).toMatchObject({
      handle: "h-104-down-agent-newer-agent",
      sandbox_provider_kind: "cluster",
      state: { version: "new-agent" },
    });
    expect(
      await getRunnerState(database, projectCanonicalNewer, "agent-sandbox"),
    ).toBeUndefined();

    const legacyNewer = await getRunnerState(
      database,
      projectLegacyNewer,
      "cluster",
    );
    expect(legacyNewer).toMatchObject({
      handle: "h-104-down-cluster-newer-cluster",
      sandbox_provider_kind: "cluster",
      state: { version: "new-cluster" },
    });
    expect(
      await getRunnerState(database, projectLegacyNewer, "agent-sandbox"),
    ).toBeUndefined();
  });

  it("rewrites sandboxMap keys and nested provider kinds while preserving unrelated metadata", async () => {
    await insertVirtualConnection(database, "vir_104_rewrite", {
      sandboxMap: {
        [USER]: {
          "deco/branch-a": {
            cluster: {
              sandboxHandle: "cluster-handle",
              previewUrl: null,
              sandboxProviderKind: "cluster",
              createdAt: 1,
            },
            "user-desktop": {
              sandboxHandle: "desktop-handle",
              previewUrl: null,
              sandboxProviderKind: "user-desktop",
              createdAt: 2,
            },
          },
          "deco/branch-b": {
            "agent-sandbox": {
              sandboxHandle: "already-agent",
              previewUrl: null,
              sandboxProviderKind: "cluster",
              createdAt: 3,
            },
          },
        },
      },
      otherField: { kept: true },
      notes: "cluster is only rewritten inside sandboxMap records",
    });

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up104(database.db as any);

    const meta = (await getMetadata(database, "vir_104_rewrite")) as {
      sandboxMap: Record<string, Record<string, Record<string, unknown>>>;
      otherField: { kept: boolean };
      notes: string;
    };
    expect(meta.otherField).toEqual({ kept: true });
    expect(meta.notes).toBe(
      "cluster is only rewritten inside sandboxMap records",
    );

    const branchA = meta.sandboxMap[USER]!["deco/branch-a"]!;
    expect(Object.keys(branchA).sort()).toEqual(
      ["agent-sandbox", "user-desktop"].sort(),
    );
    expect(branchA["agent-sandbox"]).toMatchObject({
      sandboxHandle: "cluster-handle",
      sandboxProviderKind: "agent-sandbox",
    });
    expect(branchA["user-desktop"]).toMatchObject({
      sandboxProviderKind: "user-desktop",
    });

    const branchB = meta.sandboxMap[USER]!["deco/branch-b"]!;
    expect(branchB["agent-sandbox"]).toMatchObject({
      sandboxHandle: "already-agent",
      sandboxProviderKind: "agent-sandbox",
    });
  });

  it("keeps agent-sandbox branch entries when cluster conflicts and drops the legacy key", async () => {
    await insertVirtualConnection(database, "vir_104_conflict", {
      sandboxMap: {
        [USER]: {
          "deco/conflict": {
            cluster: {
              sandboxHandle: "legacy-cluster",
              previewUrl: null,
              sandboxProviderKind: "cluster",
              createdAt: 1,
            },
            "agent-sandbox": {
              sandboxHandle: "canonical-agent",
              previewUrl: null,
              sandboxProviderKind: "cluster",
              createdAt: 2,
            },
            "user-desktop": {
              sandboxHandle: "desktop",
              previewUrl: null,
              sandboxProviderKind: "user-desktop",
              createdAt: 3,
            },
          },
        },
      },
      retained: ["metadata", "outside", "sandboxMap"],
    });

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up104(database.db as any);

    const meta = (await getMetadata(database, "vir_104_conflict")) as {
      sandboxMap: Record<string, Record<string, Record<string, unknown>>>;
      retained: string[];
    };
    const branch = meta.sandboxMap[USER]!["deco/conflict"]!;
    expect(Object.keys(branch).sort()).toEqual(
      ["agent-sandbox", "user-desktop"].sort(),
    );
    expect(branch["agent-sandbox"]).toMatchObject({
      sandboxHandle: "canonical-agent",
      sandboxProviderKind: "agent-sandbox",
      createdAt: 2,
    });
    expect(branch.cluster).toBeUndefined();
    expect(meta.retained).toEqual(["metadata", "outside", "sandboxMap"]);
  });

  it("uses a valid legacy cluster entry when conflicting agent-sandbox entry is malformed", async () => {
    await insertVirtualConnection(database, "vir_104_malformed_canonical", {
      sandboxMap: {
        [USER]: {
          "deco/malformed": {
            cluster: {
              sandboxHandle: "valid-legacy",
              previewUrl: null,
              sandboxProviderKind: "cluster",
              createdAt: 1,
            },
            "agent-sandbox": {
              sandboxHandle: "invalid-canonical",
              previewUrl: null,
              sandboxProviderKind: "agent-sandbox",
              createdAt: "bad",
            },
          },
        },
      },
    });

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up104(database.db as any);

    const meta = (await getMetadata(
      database,
      "vir_104_malformed_canonical",
    )) as {
      sandboxMap: Record<string, Record<string, Record<string, unknown>>>;
    };
    const branch = meta.sandboxMap[USER]!["deco/malformed"]!;
    expect(Object.keys(branch)).toEqual(["agent-sandbox"]);
    expect(branch["agent-sandbox"]).toMatchObject({
      sandboxHandle: "valid-legacy",
      sandboxProviderKind: "agent-sandbox",
    });
  });

  it("does not rewrite sandboxMap-like metadata on non-virtual connections", async () => {
    const metadata = {
      sandboxMap: {
        [USER]: {
          "deco/http": {
            cluster: {
              sandboxHandle: "http-legacy",
              previewUrl: null,
              sandboxProviderKind: "cluster",
              createdAt: 1,
            },
          },
        },
      },
      otherField: "kept",
    };
    await insertVirtualConnection(
      database,
      "http_104_metadata",
      metadata,
      "HTTP",
    );

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up104(database.db as any);

    expect(await getMetadata(database, "http_104_metadata")).toEqual(metadata);
  });

  it("reverses sandboxMap values in down migrations", async () => {
    await insertVirtualConnection(database, "vir_104_down", {
      sandboxMap: {
        [USER]: {
          "deco/down": {
            "agent-sandbox": {
              sandboxHandle: "agent-handle",
              previewUrl: null,
              sandboxProviderKind: "agent-sandbox",
              createdAt: 1,
            },
            "user-desktop": {
              sandboxHandle: "desktop-handle",
              previewUrl: null,
              sandboxProviderKind: "user-desktop",
              createdAt: 2,
            },
          },
        },
      },
    });

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await down104(database.db as any);

    const meta = (await getMetadata(database, "vir_104_down")) as {
      sandboxMap: Record<string, Record<string, Record<string, unknown>>>;
    };
    const branch = meta.sandboxMap[USER]!["deco/down"]!;
    expect(Object.keys(branch).sort()).toEqual(
      ["cluster", "user-desktop"].sort(),
    );
    expect(branch.cluster).toMatchObject({
      sandboxHandle: "agent-handle",
      sandboxProviderKind: "cluster",
    });
    expect(branch["user-desktop"]).toMatchObject({
      sandboxProviderKind: "user-desktop",
    });
  });
});
