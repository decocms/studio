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
import { createApp } from "../app";

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
    }
    const byTitle = new Map(rows.map((r) => [r.title, r]));
    expect(byTitle.get("Adicionar H1 na home")?.priority).toBe("high");
    expect(byTitle.get("Liberar o GPTBot no WAF")?.priority).toBe("medium");
    expect(byTitle.get("Liberar o GPTBot no WAF")?.description).toBe(
      "403 no WAF.",
    );
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

  it("an externalKey matching an open item refreshes it instead of duplicating", async () => {
    const key = "diag:shop.com:GEO-001";
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
});
