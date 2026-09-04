// CredentialVault requires a valid 32-byte base64 ENCRYPTION_KEY.
// Must be set before any import triggers getSettings(), which freezes
// the settings singleton on first access.
process.env.ENCRYPTION_KEY ??= Buffer.from("0".repeat(32)).toString("base64");

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { sql } from "kysely";
import { auth } from "../../auth";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../../database/test-db-pg";
import { getSettings, setGlobalSettings } from "../../settings";
import { TaskBoardStorage } from "../../storage/task-board";
import { createApp } from "../app";
import {
  getCommerceDiscoveryAgentId,
  WellKnownOrgMCPId,
} from "@decocms/shared/sdk";

if (!getSettings().encryptionKey) {
  setGlobalSettings({
    ...getSettings(),
    encryptionKey: process.env.ENCRYPTION_KEY!,
  });
}

const IMPORT_URL = (org: string) =>
  `http://test/api/${org}/internal/task-board/import`;

const post = (org: string, token: string | null, body: unknown) =>
  new Request(IMPORT_URL(org), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const BODY = {
  items: [
    { title: "Adicionar H1 na home", priority: "high" },
    { title: "Liberar o GPTBot no WAF", description: "403 no WAF." },
  ],
  source: { url: "shop.com" },
};

async function insertReportConnection(
  database: StudioDatabase,
  organizationId: string,
  projectId: string,
) {
  const now = new Date().toISOString();
  await database.db
    .insertInto("connections")
    .values({
      id: WellKnownOrgMCPId.COMMERCE_DISCOVERY(organizationId),
      organization_id: organizationId,
      created_by: "user_1",
      title: "Store Report",
      connection_type: "HTTP",
      connection_url: "https://reports.example/mcp",
      metadata: JSON.stringify({ projectId }),
      status: "active",
      pinned: false,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function insertReportRun(
  database: StudioDatabase,
  organizationId: string,
  runId: string,
  projectId: string,
  siteUrl = "https://shop.com",
) {
  await database.db
    .insertInto("commerce_discovery_report_runs")
    .values({
      organization_id: organizationId,
      run_id: runId,
      site_url: siteUrl,
      virtual_mcp_id: projectId,
    })
    .execute();
}

describe("Task Board Import Route", () => {
  let database: StudioDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;
  const prevServiceToken = process.env.VAULT_SERVICE_TOKEN;

  beforeEach(async () => {
    process.env.VAULT_SERVICE_TOKEN = "svc-secret";
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);

    vi.spyOn(auth.api, "getMcpSession").mockResolvedValue(null);
    vi.spyOn(auth.api, "verifyApiKey").mockResolvedValue({
      valid: false,
      error: { message: "invalid api key" },
      key: null,
    } as never);

    // An org whose id ≠ slug, so the tests prove the service caller can
    // resolve by ID (the worker holds the org id, never the slug).
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "organization" (id, name, slug, "createdAt")
      VALUES ('org_board', 'Board Org', 'board-org', ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(database.db);
    // user_1 (seeded) is org_board's owner — the delegation principal.
    await sql`
      INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
      VALUES ('mem_board_owner', 'user_1', 'org_board', 'owner', ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(database.db);

    app = await createApp({ database, disableNats: true });
  });

  afterEach(async () => {
    if (prevServiceToken === undefined) {
      delete process.env.VAULT_SERVICE_TOKEN;
    } else {
      process.env.VAULT_SERVICE_TOKEN = prevServiceToken;
    }
    vi.restoreAllMocks();
    if (app) {
      await app.shutdown();
    }
    if (database) {
      await closeTestPgDatabase(database);
    }
  });

  it("rejects requests without the service token", async () => {
    const noToken = await app.fetch(post("org_board", null, BODY));
    expect(noToken.status).toBe(401);

    const wrongToken = await app.fetch(post("org_board", "not-it", BODY));
    expect(wrongToken.status).toBe(401);
  });

  it("imports tasks without creating organization settings", async () => {
    // org_1 (seeded) has no settings row. The task board is always available,
    // so importing tasks must not create unrelated configuration state.
    const res = await app.fetch(post("org_1", "svc-secret", BODY));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      created: 2,
      updated: 0,
      delegated: 0,
    });

    const settings = await database.db
      .selectFrom("organization_settings")
      .select(["organizationId"])
      .where("organizationId", "=", "org_1")
      .executeTakeFirst();
    expect(settings).toBeUndefined();
  });

  it("rejects an invalid body", async () => {
    const res = await app.fetch(post("org_board", "svc-secret", { items: [] }));
    expect(res.status).toBe(400);
  });

  it("creates triage items as the system principal, resolving the org by id", async () => {
    const res = await app.fetch(post("org_board", "svc-secret", BODY));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      created: 2,
      updated: 0,
      delegated: 0,
    });

    const rows = await database.db
      .selectFrom("task_board_items")
      .selectAll()
      .where("organization_id", "=", "org_board")
      .orderBy("title")
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.title).sort()).toEqual([
      "Adicionar H1 na home",
      "Liberar o GPTBot no WAF",
    ]);
    for (const row of rows) {
      expect(row.status).toBe("triage");
      expect(row.created_by).toBe("system");
      expect(row.updated_by).toBe("system");
      expect(row.virtual_mcp_id).toBe(getCommerceDiscoveryAgentId("org_board"));
    }
    const byTitle = new Map(rows.map((r) => [r.title, r]));
    expect(byTitle.get("Adicionar H1 na home")?.priority).toBe("high");
    expect(byTitle.get("Liberar o GPTBot no WAF")?.priority).toBe("medium");
    expect(byTitle.get("Liberar o GPTBot no WAF")?.description).toBe(
      "403 no WAF.",
    );
  });

  it("uses the originating run snapshot instead of mutable connection metadata", async () => {
    const projectId = "vir_originating_report_owner";
    const newerProjectId = "vir_newer_connection_owner";
    await insertReportConnection(database, "org_board", newerProjectId);
    await insertReportRun(
      database,
      "org_board",
      "run_owned_snapshot",
      projectId,
    );

    const res = await app.fetch(
      post("org_board", "svc-secret", {
        ...BODY,
        source: { url: "shop.com", run_id: "run_owned_snapshot" },
      }),
    );
    expect(res.status).toBe(200);

    const owners = await database.db
      .selectFrom("task_board_items")
      .select("virtual_mcp_id")
      .where("organization_id", "=", "org_board")
      .execute();
    expect(owners).toHaveLength(BODY.items.length);
    expect(owners.every((row) => row.virtual_mcp_id === projectId)).toBe(true);
  });

  it("rejects a run snapshot used with another site before writing tasks", async () => {
    await insertReportRun(
      database,
      "org_board",
      "run_wrong_site",
      "vir_report_owner",
      "https://first.example",
    );

    const res = await app.fetch(
      post("org_board", "svc-secret", {
        items: [{ title: "Must not land" }],
        source: { url: "second.example", run_id: "run_wrong_site" },
      }),
    );
    expect(res.status).toBe(409);
    expect(
      await database.db
        .selectFrom("task_board_items")
        .select("id")
        .where("organization_id", "=", "org_board")
        .execute(),
    ).toEqual([]);
  });

  it("delegates a super-agent item: To Do, owner as the run principal", async () => {
    const res = await app.fetch(
      post("org_board", "svc-secret", {
        items: [
          { title: "Adicionar sinônimos à busca", assigneeId: "super-agent" },
          { title: "Tarefa comum" },
        ],
      }),
    );
    expect(res.status).toBe(200);
    // The enqueue itself is best-effort (no model configured in tests) — the
    // delegation must still land on the row.
    await expect(res.json()).resolves.toEqual({
      created: 2,
      updated: 0,
      delegated: 1,
    });

    const rows = await database.db
      .selectFrom("task_board_items")
      .selectAll()
      .where("organization_id", "=", "org_board")
      .execute();
    const byTitle = new Map(rows.map((r) => [r.title, r]));
    const delegated = byTitle.get("Adicionar sinônimos à busca");
    expect(delegated?.status).toBe("todo");
    expect(delegated?.assignee_id).toBe("super-agent");
    expect(delegated?.assigned_by).toBe("user_1"); // the org owner
    expect(delegated?.created_by).toBe("system");
    const plain = byTitle.get("Tarefa comum");
    expect(plain?.status).toBe("triage");
    expect(plain?.assigned_by).toBeNull();
  });

  it("accepts a real-member assignee and rejects a non-member", async () => {
    const ok = await app.fetch(
      post("org_board", "svc-secret", {
        items: [{ title: "Pra pessoa", assigneeId: "user_1" }],
      }),
    );
    expect(ok.status).toBe(200);
    const row = await database.db
      .selectFrom("task_board_items")
      .selectAll()
      .where("organization_id", "=", "org_board")
      .where("title", "=", "Pra pessoa")
      .executeTakeFirst();
    expect(row?.assignee_id).toBe("user_1");
    expect(row?.assigned_by).toBe("system");
    expect(row?.status).toBe("triage");

    const bad = await app.fetch(
      post("org_board", "svc-secret", {
        items: [{ title: "t", assigneeId: "user_stranger" }],
      }),
    );
    expect(bad.status).toBe(400);
  });

  it("replays of the same run_id no-op (request idempotency)", async () => {
    const body = {
      items: [{ title: "Adicionar H1 na home" }],
      source: { url: "shop.com", run_id: "run_double_fire" },
    };
    const first = await app.fetch(post("org_board", "svc-secret", body));
    await expect(first.json()).resolves.toEqual({
      created: 1,
      updated: 0,
      delegated: 0,
    });

    // The success page and the webhook fire the SAME import seconds apart —
    // the second one must not double the board.
    const replay = await app.fetch(post("org_board", "svc-secret", body));
    await expect(replay.json()).resolves.toEqual({
      created: 0,
      updated: 0,
      delegated: 0,
      deduped: true,
    });

    const rows = await database.db
      .selectFrom("task_board_items")
      .selectAll()
      .where("organization_id", "=", "org_board")
      .execute();
    expect(rows).toHaveLength(1);
  });

  it("serializes different runs creating the same finding for one project", async () => {
    const projectId = "vir_concurrent_report_owner";
    const key = "diag:shop.com:concurrent-finding";
    await insertReportRun(database, "org_board", "run_concurrent_a", projectId);
    await insertReportRun(database, "org_board", "run_concurrent_b", projectId);

    // Hold each candidate insert long enough for a competing request to reach
    // its dedup read. Without the owner-scoped transaction lock both reads see
    // an empty set and both inserts commit.
    await sql`drop trigger if exists task_board_import_test_pause on task_board_items`.execute(
      database.db,
    );
    await sql`
      create or replace function task_board_import_test_pause()
      returns trigger
      language plpgsql
      as $$
      begin
        perform pg_sleep(0.25);
        return new;
      end
      $$
    `.execute(database.db);
    await sql`
      create trigger task_board_import_test_pause
      before insert on task_board_items
      for each row execute function task_board_import_test_pause()
    `.execute(database.db);

    try {
      const responseBodies = await Promise.all(
        ["run_concurrent_a", "run_concurrent_b"].map(async (runId) => {
          const response = await app.fetch(
            post("org_board", "svc-secret", {
              items: [{ title: "Concurrent finding", externalKey: key }],
              source: { url: "shop.com", run_id: runId },
            }),
          );
          expect(response.status).toBe(200);
          return response.json();
        }),
      );

      expect(responseBodies).toEqual(
        expect.arrayContaining([
          { created: 1, updated: 0, delegated: 0 },
          { created: 0, updated: 1, delegated: 0 },
        ]),
      );
      const rows = await database.db
        .selectFrom("task_board_items")
        .select(["id", "virtual_mcp_id"])
        .where("organization_id", "=", "org_board")
        .where("external_key", "=", key)
        .execute();
      expect(rows).toEqual([
        { id: expect.any(String), virtual_mcp_id: projectId },
      ]);
    } finally {
      await sql`drop trigger if exists task_board_import_test_pause on task_board_items`.execute(
        database.db,
      );
      await sql`drop function if exists task_board_import_test_pause()`.execute(
        database.db,
      );
    }
  });

  it("an externalKey matching an open item refreshes it instead of duplicating", async () => {
    const key = "diag:shop.com:GEO-001";
    const projectId = "vir_backfilled_report_owner";
    const run1 = await app.fetch(
      post("org_board", "svc-secret", {
        items: [
          {
            title: "Liberar o GPTBot no WAF",
            description: "403 no WAF (run 1).",
            priority: "medium",
            externalKey: key,
          },
        ],
        source: { url: "shop.com", run_id: "run_1" },
      }),
    );
    await expect(run1.json()).resolves.toEqual({
      created: 1,
      updated: 0,
      delegated: 0,
    });

    // Simulate a report row created before persisted project ownership. A
    // normal refresh must backfill it instead of leaving legacy inference in
    // place forever.
    await database.db
      .updateTable("task_board_items")
      .set({ virtual_mcp_id: null })
      .where("organization_id", "=", "org_board")
      .where("external_key", "=", key)
      .execute();
    // A snapshotted run may claim an owner-null pre-migration row once.
    await insertReportRun(database, "org_board", "run_2", projectId);

    // A month later the diagnostic re-runs, finds the same issue with fresh
    // evidence and a worse severity — the card is refreshed, not duplicated,
    // and the human-facing title is left alone.
    const run2 = await app.fetch(
      post("org_board", "svc-secret", {
        items: [
          {
            title: "GPTBot ainda bloqueado",
            description: "403 no WAF (run 2).",
            priority: "high",
            externalKey: key,
          },
        ],
        source: { url: "shop.com", run_id: "run_2" },
      }),
    );
    await expect(run2.json()).resolves.toEqual({
      created: 0,
      updated: 1,
      delegated: 0,
    });

    const rows = await database.db
      .selectFrom("task_board_items")
      .selectAll()
      .where("organization_id", "=", "org_board")
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Liberar o GPTBot no WAF");
    expect(rows[0]?.description).toBe("403 no WAF (run 2).");
    expect(rows[0]?.priority).toBe("high");
    expect(rows[0]?.external_key).toBe(key);
    expect(rows[0]?.virtual_mcp_id).toBe(projectId);
  });

  it("does not steal a same-title user task from a sibling project", async () => {
    const title = "Adicionar H1 na home";
    const siblingProjectId = "vir_sibling";
    const reportProjectId = "vir_report";
    const storage = new TaskBoardStorage(database.db);
    const userTask = await storage.create({
      organizationId: "org_board",
      title,
      description: "Human-authored context",
      virtualMcpId: siblingProjectId,
      by: "user_1",
    });
    await insertReportRun(
      database,
      "org_board",
      "run_title_collision",
      reportProjectId,
    );

    const res = await app.fetch(
      post("org_board", "svc-secret", {
        items: [{ title, description: "Report evidence" }],
        source: { url: "shop.com", run_id: "run_title_collision" },
      }),
    );
    await expect(res.json()).resolves.toEqual({
      created: 1,
      updated: 0,
      delegated: 0,
    });

    const rows = await database.db
      .selectFrom("task_board_items")
      .select(["id", "description", "created_by", "virtual_mcp_id"])
      .where("organization_id", "=", "org_board")
      .where("title", "=", title)
      .orderBy("created_at")
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === userTask.id)).toMatchObject({
      description: "Human-authored context",
      created_by: "user_1",
      virtual_mcp_id: siblingProjectId,
    });
    expect(rows.find((row) => row.id !== userTask.id)).toMatchObject({
      description: "Report evidence",
      created_by: "system",
      virtual_mcp_id: reportProjectId,
    });
  });

  it("does not transfer an explicitly owned report finding to a sibling project", async () => {
    const key = "diag:shop.com:shared-key";
    const projectA = "vir_report_a";
    const projectB = "vir_report_b";
    const storage = new TaskBoardStorage(database.db);
    const existing = await storage.create({
      organizationId: "org_board",
      title: "Project A finding",
      description: "A evidence",
      externalKey: key,
      virtualMcpId: projectA,
      by: "system",
    });
    await insertReportRun(database, "org_board", "run_project_b", projectB);

    const res = await app.fetch(
      post("org_board", "svc-secret", {
        items: [
          {
            title: "Project B finding",
            description: "B evidence",
            externalKey: key,
          },
        ],
        source: { url: "shop.com", run_id: "run_project_b" },
      }),
    );
    await expect(res.json()).resolves.toEqual({
      created: 1,
      updated: 0,
      delegated: 0,
    });

    const rows = await database.db
      .selectFrom("task_board_items")
      .select(["id", "description", "virtual_mcp_id"])
      .where("organization_id", "=", "org_board")
      .where("external_key", "=", key)
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === existing.id)).toMatchObject({
      description: "A evidence",
      virtual_mcp_id: projectA,
    });
    expect(rows.find((row) => row.id !== existing.id)).toMatchObject({
      description: "B evidence",
      virtual_mcp_id: projectB,
    });
  });

  it("refreshes a development-owned finding into its canonical live owner", async () => {
    const key = "diag:shop.com:dev-live";
    const developmentProject = "vir_report_dev";
    const liveProject = "vir_report_live";
    const now = new Date().toISOString();
    await database.db
      .insertInto("connections")
      .values({
        id: developmentProject,
        organization_id: "org_board",
        created_by: "user_1",
        title: "Development report project",
        connection_type: "VIRTUAL",
        connection_url: `virtual://${developmentProject}`,
        metadata: JSON.stringify({ liveAgentId: liveProject }),
        status: "active",
        pinned: false,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const storage = new TaskBoardStorage(database.db);
    const existing = await storage.create({
      organizationId: "org_board",
      title: "Development finding",
      description: "Old evidence",
      externalKey: key,
      virtualMcpId: developmentProject,
      by: "system",
    });
    await insertReportRun(database, "org_board", "run_live_owner", liveProject);

    const res = await app.fetch(
      post("org_board", "svc-secret", {
        items: [
          {
            title: "Live finding",
            description: "Fresh evidence",
            externalKey: key,
          },
        ],
        source: { url: "shop.com", run_id: "run_live_owner" },
      }),
    );
    await expect(res.json()).resolves.toEqual({
      created: 0,
      updated: 1,
      delegated: 0,
    });

    const refreshed = await storage.getById(existing.id, "org_board");
    expect(refreshed).toMatchObject({
      description: "Fresh evidence",
      virtualMcpId: liveProject,
    });
  });

  it("attaches the sender's tags, reusing an existing name case-insensitively", async () => {
    // The org already labels things "report" — the import must reuse that tag
    // rather than fork a second one that only differs in case.
    await sql`
      INSERT INTO "organization_tags" (id, organization_id, name, color, created_at)
      VALUES ('tag_report', 'org_board', 'report', '#111111', ${new Date().toISOString()})
    `.execute(database.db);

    const res = await app.fetch(
      post("org_board", "svc-secret", {
        items: [
          {
            title: "Adicionar H1 na home",
            externalKey: "diag:shop.com:TSEO-001",
            tags: ["Report", "SEO"],
          },
        ],
        source: { url: "shop.com", run_id: "run_tags_1" },
      }),
    );
    await expect(res.json()).resolves.toEqual({
      created: 1,
      updated: 0,
      delegated: 0,
    });

    const storage = new TaskBoardStorage(database.db);
    const [item] = await storage.list("org_board");
    expect(item?.tags.map((t) => t.name).sort()).toEqual(["SEO", "report"]);
    // The missing one was created with a palette color, not left blank.
    const seo = item?.tags.find((t) => t.name === "SEO");
    expect(seo?.color).toMatch(/^#[0-9a-f]{6}$/i);
    const orgTags = await database.db
      .selectFrom("organization_tags")
      .select(["name"])
      .where("organization_id", "=", "org_board")
      .execute();
    expect(orgTags.map((t) => t.name).sort()).toEqual(["SEO", "report"]);
  });

  it("a refresh re-asserts its own tags without removing a human's", async () => {
    const key = "diag:shop.com:PERF-002";
    await app.fetch(
      post("org_board", "svc-secret", {
        items: [{ title: "Reduzir o LCP da home", externalKey: key }],
        source: { url: "shop.com", run_id: "run_tags_2" },
      }),
    );
    const storage = new TaskBoardStorage(database.db);
    const [created] = await storage.list("org_board");
    // A human triages the card with a tag of their own.
    await sql`
      INSERT INTO "organization_tags" (id, organization_id, name, color, created_at)
      VALUES ('tag_sprint', 'org_board', 'Sprint 12', '#222222', ${new Date().toISOString()})
    `.execute(database.db);
    await storage.setItemTags(created!.id, ["tag_sprint"], "user_1");

    await app.fetch(
      post("org_board", "svc-secret", {
        items: [
          {
            title: "Reduzir o LCP da home",
            description: "LCP 4.2s no p75.",
            externalKey: key,
            tags: ["Report", "Performance"],
          },
        ],
        source: { url: "shop.com", run_id: "run_tags_3" },
      }),
    );

    const [refreshed] = await storage.list("org_board");
    expect(refreshed?.tags.map((t) => t.name).sort()).toEqual([
      "Performance",
      "Report",
      "Sprint 12",
    ]);
  });

  it("a done item does not match — a regression creates a fresh card", async () => {
    const key = "diag:shop.com:SEO-002";
    await app.fetch(
      post("org_board", "svc-secret", {
        items: [{ title: "Adicionar H1 na home", externalKey: key }],
        source: { url: "shop.com", run_id: "run_a" },
      }),
    );
    await database.db
      .updateTable("task_board_items")
      .set({ status: "done" })
      .where("organization_id", "=", "org_board")
      .execute();

    const regression = await app.fetch(
      post("org_board", "svc-secret", {
        items: [{ title: "Adicionar H1 na home", externalKey: key }],
        source: { url: "shop.com", run_id: "run_b" },
      }),
    );
    await expect(regression.json()).resolves.toEqual({
      created: 1,
      updated: 0,
      delegated: 0,
    });

    const rows = await database.db
      .selectFrom("task_board_items")
      .selectAll()
      .where("organization_id", "=", "org_board")
      .orderBy("created_at")
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status).sort()).toEqual(["done", "triage"]);
    // Both carry the key — identity survives the lifecycle.
    expect(rows.every((r) => r.external_key === key)).toBe(true);
  });

  // Without the dismissal the next run would just re-create the card.
  it("a dismissed finding is skipped, and restoring it lets the card come back", async () => {
    const key = "diag:shop.com:SEO-003";
    await app.fetch(
      post("org_board", "svc-secret", {
        items: [{ title: "Adicionar H1 na home", externalKey: key }],
        source: { url: "shop.com", run_id: "run_x" },
      }),
    );
    const created = await database.db
      .selectFrom("task_board_items")
      .select(["id"])
      .where("organization_id", "=", "org_board")
      .where("external_key", "=", key)
      .executeTakeFirstOrThrow();

    await new TaskBoardStorage(database.db).delete(
      created.id,
      "org_board",
      "user_1",
    );

    const afterDismiss = await app.fetch(
      post("org_board", "svc-secret", {
        items: [{ title: "Adicionar H1 na home", externalKey: key }],
        source: { url: "shop.com", run_id: "run_y" },
      }),
    );
    await expect(afterDismiss.json()).resolves.toEqual({
      created: 0,
      updated: 0,
      delegated: 0,
      dismissed: 1,
    });
    // Dismissed, not dropped — same row, so a restore brings back the card.
    expect(
      await database.db
        .selectFrom("task_board_items")
        .select(["id", "dismissed_at"])
        .where("organization_id", "=", "org_board")
        .where("external_key", "=", key)
        .execute(),
    ).toMatchObject([{ id: created.id, dismissed_at: expect.anything() }]);

    // Restored ⇒ the next run refreshes the same card again.
    await new TaskBoardStorage(database.db).restoreDismissedFindings(
      "org_board",
      [key],
    );
    const afterRestore = await app.fetch(
      post("org_board", "svc-secret", {
        items: [{ title: "Adicionar H1 na home", externalKey: key }],
        source: { url: "shop.com", run_id: "run_z" },
      }),
    );
    await expect(afterRestore.json()).resolves.toEqual({
      created: 0,
      updated: 1,
      delegated: 0,
    });
    expect(
      await database.db
        .selectFrom("task_board_items")
        .select(["id"])
        .where("organization_id", "=", "org_board")
        .where("external_key", "=", key)
        .where("dismissed_at", "is", null)
        .execute(),
    ).toMatchObject([{ id: created.id }]);
  });

  it("a dismissal is scoped to its org", async () => {
    const key = "diag:shop.com:SEO-004";
    await app.fetch(
      post("org_board", "svc-secret", {
        items: [{ title: "Adicionar H1 na home", externalKey: key }],
        source: { url: "shop.com", run_id: "run_o1" },
      }),
    );
    const created = await database.db
      .selectFrom("task_board_items")
      .select(["id"])
      .where("organization_id", "=", "org_board")
      .where("external_key", "=", key)
      .executeTakeFirstOrThrow();
    await new TaskBoardStorage(database.db).delete(
      created.id,
      "org_board",
      "user_1",
    );

    // A second org that dismissed nothing still gets the finding.
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "organization" (id, name, slug, "createdAt")
      VALUES ('org_other', 'Other Org', 'other-org', ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(database.db);
    const other = await app.fetch(
      post("org_other", "svc-secret", {
        items: [{ title: "Adicionar H1 na home", externalKey: key }],
        source: { url: "shop.com", run_id: "run_o2" },
      }),
    );
    await expect(other.json()).resolves.toEqual({
      created: 1,
      updated: 0,
      delegated: 0,
    });
  });
});
