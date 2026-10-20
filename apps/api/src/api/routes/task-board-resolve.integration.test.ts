// CredentialVault requires a valid 32-byte base64 ENCRYPTION_KEY.
// Must be set before any import triggers getSettings(), which freezes
// the settings singleton on first access.
process.env.ENCRYPTION_KEY ??= Buffer.from("0".repeat(32)).toString("base64");

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { TASK_BOARD_ITEM_UPDATED_EVENT } from "@decocms/shared/task-board";
import { sql } from "kysely";
import { auth } from "../../auth";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../../database/test-db-pg";
import { sseHub } from "../../event-bus";
import { getSettings, setGlobalSettings } from "../../settings";
import { TaskBoardStorage } from "../../storage/task-board";
import { createApp } from "../app";

if (!getSettings().encryptionKey) {
  setGlobalSettings({
    ...getSettings(),
    encryptionKey: process.env.ENCRYPTION_KEY!,
  });
}

/**
 * The wire contract of `POST /api/:org/internal/task-board/resolve`: service
 * token, org by id, validation, reply order and realtime pushes.
 * `task-board-resolve-finding.integration.test.ts` pins which card gets which
 * outcome, against the storage method.
 */
const RESOLVE_URL = (org: string) =>
  `http://test/api/${org}/internal/task-board/resolve`;

const post = (org: string, token: string | null, body: unknown) =>
  new Request(RESOLVE_URL(org), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const SOURCE = { url: "https://shop.example/", run_id: "run_1" };
const LISTENER = "task-board-resolve-test";

describe("Task Board Resolve Route", () => {
  let database: StudioDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;
  let storage: TaskBoardStorage;
  /** Card ids the route pushed to open boards of org_board. */
  const pushed: string[] = [];
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

    // Orgs whose id ≠ slug, so the tests prove the engine can address an org
    // by the id it holds.
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "organization" (id, name, slug, "createdAt")
      VALUES ('org_board', 'Board Org', 'board-org', ${now}),
             ('org_other', 'Other Org', 'other-org', ${now})
    `.execute(database.db);
    storage = new TaskBoardStorage(database.db);

    pushed.length = 0;
    sseHub.add({
      id: LISTENER,
      organizationId: "org_board",
      typePatterns: [TASK_BOARD_ITEM_UPDATED_EVENT],
      push: (event) => pushed.push(String(event.subject)),
    });

    app = await createApp({ database, disableNats: true });
  });

  afterEach(async () => {
    sseHub.remove("org_board", LISTENER);
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

  const reportsCard = (status?: string, organizationId = "org_board") =>
    storage.create({
      organizationId,
      title: "Add an H1 to the home page",
      status,
      by: "system",
    });

  const statusOf = async (id: string) =>
    (
      await database.db
        .selectFrom("task_board_items")
        .select(["status"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow()
    ).status;

  const activityOf = (id: string) =>
    database.db
      .selectFrom("task_board_activity")
      .select(["action"])
      .where("task_board_item_id", "=", id)
      .execute();

  it("rejects requests without the service token, writing nothing", async () => {
    const card = await reportsCard();
    const body = { items: [{ id: card.id }], source: SOURCE };

    const noToken = await app.fetch(post("org_board", null, body));
    expect(noToken.status).toBe(401);
    const wrongToken = await app.fetch(post("org_board", "not-it", body));
    expect(wrongToken.status).toBe(401);

    expect(await statusOf(card.id)).toBe("triage");
    expect(await activityOf(card.id)).toHaveLength(0);
  });

  it("answers every item in request order and resolves a repeated id once", async () => {
    const triage = await reportsCard();
    const started = await reportsCard("in_progress");
    const dismissed = await reportsCard();
    await storage.delete(dismissed.id, "org_board", "user_1");
    const foreign = await reportsCard(undefined, "org_other");

    const res = await app.fetch(
      post("org_board", "svc-secret", {
        items: [triage, foreign, started, dismissed, triage].map(({ id }) => ({
          id,
        })),
        source: SOURCE,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [
        { id: triage.id, outcome: "closed" },
        { id: foreign.id, outcome: "not_found" },
        { id: started.id, outcome: "noted" },
        { id: dismissed.id, outcome: "skipped" },
        { id: triage.id, outcome: "closed" },
      ],
    });

    expect(await statusOf(triage.id)).toBe("done");
    expect(
      (await activityOf(triage.id)).filter(
        (e) => e.action === "finding_resolved",
      ),
    ).toHaveLength(1);
    expect(await statusOf(started.id)).toBe("in_progress");
    // The route leaves another org's card alone and does not say it exists.
    expect(await statusOf(foreign.id)).toBe("triage");
    expect(await activityOf(foreign.id)).toHaveLength(0);
    expect(await activityOf(dismissed.id)).toHaveLength(0);
    // Open boards hear about the two cards that changed, once each.
    expect(pushed.sort()).toEqual([triage.id, started.id].sort());
  });

  it("a replay of the run_id gets the same reply, writes nothing, pushes nothing", async () => {
    const triage = await reportsCard();
    const started = await reportsCard("in_review");
    const body = {
      items: [{ id: triage.id }, { id: started.id }],
      source: SOURCE,
    };

    const first = await app.fetch(post("org_board", "svc-secret", body));
    const firstReply = await first.json();
    pushed.length = 0;

    const replay = await app.fetch(post("org_board", "svc-secret", body));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstReply);
    expect(await activityOf(triage.id)).toHaveLength(2);
    expect(await activityOf(started.id)).toHaveLength(1);
    expect(pushed).toEqual([]);
  });

  it("an empty batch is a no-op", async () => {
    const res = await app.fetch(
      post("org_board", "svc-secret", { items: [], source: SOURCE }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });

  it("rejects more than 100 items, writing nothing", async () => {
    const card = await reportsCard();
    const items = Array.from({ length: 101 }, () => ({ id: card.id }));

    const res = await app.fetch(
      post("org_board", "svc-secret", { items, source: SOURCE }),
    );
    expect(res.status).toBe(400);
    expect(await statusOf(card.id)).toBe("triage");
    expect(await activityOf(card.id)).toHaveLength(0);
  });
});
