import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import type { StudioDatabase } from "../database";
import { SqlThreadStorage } from "./threads";

describe("SqlThreadStorage", () => {
  let database: StudioDatabase;
  let storage: SqlThreadStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    // Insert org and user for thread FK constraints
    await database.db
      .insertInto("organization")
      .values([
        {
          id: "org_1",
          name: "Test Org",
          slug: "test-org",
          createdAt: new Date().toISOString(),
        },
        {
          id: "org_2",
          name: "Other Org",
          slug: "other-org",
          createdAt: new Date().toISOString(),
        },
      ])
      .execute();
    // Use raw SQL: the Database schema type still has emailVerified as
    // `number` (matching the old PGlite hand-rolled schema). Real Postgres
    // has it as BOOLEAN per Better Auth's migration. Bypassing the typed
    // builder until storage/types.ts gets regenerated against real PG.
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES ('user_1', 'test@test.com', false, 'Test', ${now}, ${now})
    `.execute(database.db);
    storage = new SqlThreadStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  describe("status", () => {
    it("create() without status defaults to completed", async () => {
      const thread = await storage.create({
        organization_id: "org_1",
        created_by: "user_1",
      });
      expect(thread.status).toBe("completed");
    });

    it("create() with explicit status stores it", async () => {
      const thread = await storage.create({
        organization_id: "org_1",
        created_by: "user_1",
        status: "in_progress",
      });
      expect(thread.status).toBe("in_progress");
    });

    it("update() with status persists it", async () => {
      const thread = await storage.create({
        organization_id: "org_1",
        created_by: "user_1",
      });
      const updated = await storage.update(thread.id, "org_1", {
        status: "failed",
      });
      expect(updated.status).toBe("failed");
      const loaded = await storage.get(thread.id, "org_1");
      expect(loaded?.status).toBe("failed");
    });
  });

  // ==========================================================================
  // Durable Run Operations
  // ==========================================================================

  describe("durable run operations", () => {
    describe("update() with new columns", () => {
      it("persists run_owner_pod", async () => {
        const thread = await storage.create({
          organization_id: "org_1",
          created_by: "user_1",
        });
        const updated = await storage.update(thread.id, "org_1", {
          run_owner_pod: "pod-abc",
        });
        expect(updated.run_owner_pod).toBe("pod-abc");
      });

      it("persists run_config as JSONB", async () => {
        const thread = await storage.create({
          organization_id: "org_1",
          created_by: "user_1",
        });
        const config = { agent: { id: "a1" }, temperature: 0.5 };
        const updated = await storage.update(thread.id, "org_1", {
          run_config: config,
        });
        expect(updated.run_config).toEqual(config);
      });

      it("persists run_started_at", async () => {
        const thread = await storage.create({
          organization_id: "org_1",
          created_by: "user_1",
        });
        const ts = new Date("2024-06-01T00:00:00.000Z").toISOString();
        const updated = await storage.update(thread.id, "org_1", {
          run_started_at: ts,
        });
        expect(updated.run_started_at).toBe(ts);
      });

      it("clears columns when set to null", async () => {
        const thread = await storage.create({
          organization_id: "org_1",
          created_by: "user_1",
        });
        await storage.update(thread.id, "org_1", {
          run_owner_pod: "pod-1",
          run_config: { x: 1 },
          run_started_at: new Date().toISOString(),
        });
        const cleared = await storage.update(thread.id, "org_1", {
          run_owner_pod: null,
          run_config: null,
          run_started_at: null,
        });
        expect(cleared.run_owner_pod).toBeNull();
        expect(cleared.run_config).toBeNull();
        expect(cleared.run_started_at).toBeNull();
      });
    });
  });

  describe("metadata", () => {
    it("create() defaults metadata to empty object", async () => {
      const thread = await storage.create({
        organization_id: "org_1",
        created_by: "user_1",
      });
      expect(thread.metadata).toEqual({});
    });

    it("update() can patch metadata.expanded_tools", async () => {
      const thread = await storage.create({
        organization_id: "org_1",
        created_by: "user_1",
      });
      const updated = await storage.update(thread.id, "org_1", {
        metadata: {
          expanded_tools: [
            {
              toolName: "my_tool",
              appId: "app_1",
              args: { foo: "bar" },
              expandedAt: "2026-04-17T00:00:00Z",
            },
          ],
        },
      });
      expect(updated.metadata.expanded_tools).toHaveLength(1);
      expect(updated.metadata.expanded_tools?.[0]!.toolName).toBe("my_tool");
      const loaded = await storage.get(thread.id, "org_1");
      expect(loaded?.metadata.expanded_tools).toHaveLength(1);
      expect(loaded?.metadata.expanded_tools?.[0]!.args).toEqual({
        foo: "bar",
      });
    });
  });

  describe("hosted routing claim", () => {
    it("derives canonical rollout selectors for a locked create", async () => {
      const lockedAt = "2026-08-04T12:00:00.000Z";
      const thread = await storage.create({
        organization_id: "org_1",
        created_by: "user_1",
        branch: "main",
        routing_locked_at: lockedAt,
      });

      expect(thread.harness_id).toBe("decopilot");
      expect(thread.sandbox_provider_kind).toBe("agent-sandbox");
      expect(thread.branch).toBe("main");
      expect(thread.routing_locked_at).toBe(lockedAt);
      expect(thread.hosted_execution_disabled_at).toBeNull();
    });

    it("keeps new API rows selector-free until routing is explicitly locked", async () => {
      const draft = await storage.create({
        organization_id: "org_1",
        created_by: "user_1",
        status: "in_progress",
      });
      expect(draft.harness_id).toBeNull();
      expect(draft.sandbox_provider_kind).toBeNull();
      expect(draft.routing_locked_at).toBeNull();
      expect(draft.hosted_execution_disabled_at).toBeNull();
    });

    it("does not overwrite a concurrent native runtime claim", async () => {
      const thread = await storage.create({
        organization_id: "org_1",
        created_by: "user_1",
      });

      const [hostedClaim, nativeClaim] = await Promise.all([
        storage.claimHostedRoutingIfUnlocked(thread.id, "org_1", {
          branch: "hosted",
        }),
        database.db
          .updateTable("threads")
          .set({
            harness_id: "codex",
            sandbox_provider_kind: "user-desktop",
            branch: "native",
            routing_locked_at: sql`coalesce(routing_locked_at, now())`,
            hosted_execution_disabled_at: sql`coalesce(hosted_execution_disabled_at, now())`,
            updated_at: new Date().toISOString(),
          })
          .where("id", "=", thread.id)
          .where("organization_id", "=", "org_1")
          .where("harness_id", "is", null)
          .where("sandbox_provider_kind", "is", null)
          .returningAll()
          .executeTakeFirst(),
      ]);

      expect(
        Number(hostedClaim.claimed) + Number(nativeClaim !== undefined),
      ).toBe(1);
      const persisted = await storage.get(thread.id, "org_1");
      if (hostedClaim.claimed) {
        expect(persisted).toMatchObject({
          harness_id: "decopilot",
          sandbox_provider_kind: "agent-sandbox",
          branch: "hosted",
          routing_locked_at: expect.any(String),
        });
      } else {
        expect(persisted).toMatchObject({
          harness_id: "codex",
          sandbox_provider_kind: "user-desktop",
          branch: "native",
          routing_locked_at: expect.any(String),
          hosted_execution_disabled_at: expect.any(String),
        });
      }
      expect(hostedClaim.thread).toEqual(persisted);
    });

    it("claims the routing lock exactly once with the hosted runtime", async () => {
      const thread = await storage.create({
        organization_id: "org_1",
        created_by: "user_1",
      });
      expect(thread.routing_locked_at).toBeNull();

      const first = await storage.claimHostedRoutingIfUnlocked(
        thread.id,
        "org_1",
        {
          branch: "main",
        },
      );
      expect(first.claimed).toBe(true);
      expect(first.thread?.routing_locked_at).not.toBeNull();
      const lockedAt = first.thread?.routing_locked_at;

      const second = await storage.claimHostedRoutingIfUnlocked(
        thread.id,
        "org_1",
        {
          branch: "other",
        },
      );
      expect(second.claimed).toBe(false);
      expect(second.thread?.routing_locked_at).toBe(lockedAt);
      expect(second.thread?.hosted_execution_disabled_at).toBeNull();
    });

    it("does not reclaim a locked row when a legacy writer clears its selectors", async () => {
      const lockedAt = "2026-08-04T12:00:00.000Z";
      const thread = await storage.create({
        organization_id: "org_1",
        created_by: "user_1",
        branch: "locked-branch",
        routing_locked_at: lockedAt,
      });
      await database.db
        .updateTable("threads")
        .set({ harness_id: null, sandbox_provider_kind: null })
        .where("id", "=", thread.id)
        .execute();

      const result = await storage.claimHostedRoutingIfUnlocked(
        thread.id,
        "org_1",
        { branch: "replacement-branch" },
      );

      expect(result.claimed).toBe(false);
      expect(result.thread).toMatchObject({
        harness_id: "decopilot",
        sandbox_provider_kind: "agent-sandbox",
        routing_locked_at: lockedAt,
        hosted_execution_disabled_at: null,
        branch: "locked-branch",
      });
    });

    it("preserves branch state written before the routing claim", async () => {
      const thread = await storage.create({
        organization_id: "org_1",
        created_by: "user_1",
        branch: "already-selected",
      });
      const result = await storage.claimHostedRoutingIfUnlocked(
        thread.id,
        "org_1",
        {
          branch: "stale-branch",
          messageStorageVersion: 2,
        },
      );

      expect(result.claimed).toBe(true);
      expect(result.thread).toMatchObject({
        harness_id: "decopilot",
        sandbox_provider_kind: "agent-sandbox",
        branch: "already-selected",
        message_storage_version: 2,
      });
    });

    it("updates routing only while the routing lock remains unset", async () => {
      const unlocked = await storage.create({
        organization_id: "org_1",
        created_by: "user_1",
        virtual_mcp_id: "agent-before",
        branch: "main",
      });
      expect(
        await storage.updateRoutingIfUnlocked(unlocked.id, "org_2", {
          virtual_mcp_id: "cross-tenant",
        }),
      ).toBeNull();
      expect(
        await storage.updateRoutingIfUnlocked("missing", "org_1", {
          virtual_mcp_id: "missing",
        }),
      ).toBeNull();

      const updated = await storage.updateRoutingIfUnlocked(
        unlocked.id,
        "org_1",
        { virtual_mcp_id: "agent-after", branch: "feature" },
      );
      expect(updated).toMatchObject({
        virtual_mcp_id: "agent-after",
        branch: "feature",
        harness_id: null,
      });

      const selectorFreeLocked = await storage.create({
        organization_id: "org_1",
        created_by: "user_1",
        virtual_mcp_id: "locked-agent",
        branch: "locked-branch",
        routing_locked_at: "2026-08-01T00:00:00.000Z",
      });
      await database.db
        .updateTable("threads")
        .set({ harness_id: null, sandbox_provider_kind: null })
        .where("id", "=", selectorFreeLocked.id)
        .execute();
      expect(
        (await storage.get(selectorFreeLocked.id, "org_1"))?.harness_id,
      ).toBe("decopilot");
      expect(
        await storage.updateRoutingIfUnlocked(selectorFreeLocked.id, "org_1", {
          virtual_mcp_id: "too-late",
          branch: "too-late",
        }),
      ).toBeNull();
      expect(await storage.get(selectorFreeLocked.id, "org_1")).toMatchObject({
        virtual_mcp_id: "locked-agent",
        branch: "locked-branch",
        harness_id: "decopilot",
        sandbox_provider_kind: "agent-sandbox",
        routing_locked_at: "2026-08-01T00:00:00.000Z",
      });

      await storage.claimHostedRoutingIfUnlocked(unlocked.id, "org_1", {
        branch: "feature",
      });
      const lostRace = await storage.updateRoutingIfUnlocked(
        unlocked.id,
        "org_1",
        { virtual_mcp_id: "agent-too-late", branch: "other" },
      );

      expect(lostRace).toBeNull();
      expect(await storage.get(unlocked.id, "org_1")).toMatchObject({
        virtual_mcp_id: "agent-after",
        branch: "feature",
        harness_id: "decopilot",
      });
    });

    it("does not overwrite a conflicting partial runtime", async () => {
      const thread = await storage.create({
        organization_id: "org_1",
        created_by: "user_1",
        branch: "native-branch",
      });
      await database.db
        .updateTable("threads")
        .set({ sandbox_provider_kind: "user-desktop" })
        .where("id", "=", thread.id)
        .execute();
      const result = await storage.claimHostedRoutingIfUnlocked(
        thread.id,
        "org_1",
        {
          branch: "hosted-branch",
        },
      );

      expect(result.claimed).toBe(false);
      expect(result.thread?.harness_id).toBeNull();
      expect(result.thread?.sandbox_provider_kind).toBe("user-desktop");
      expect(result.thread?.branch).toBe("native-branch");
    });

    it("does not claim a selector-free hosted tombstone", async () => {
      const disabledAt = "2026-08-04T12:00:00.000Z";
      const thread = await storage.create({
        organization_id: "org_1",
        created_by: "user_1",
      });
      await database.db
        .updateTable("threads")
        .set({ hosted_execution_disabled_at: disabledAt })
        .where("id", "=", thread.id)
        .execute();
      expect(await storage.get(thread.id, "org_1")).toMatchObject({
        harness_id: null,
        sandbox_provider_kind: null,
        routing_locked_at: null,
        hosted_execution_disabled_at: disabledAt,
      });

      const result = await storage.claimHostedRoutingIfUnlocked(
        thread.id,
        "org_1",
        { branch: "hosted-branch" },
      );

      expect(result.claimed).toBe(false);
      expect(result.thread).toMatchObject({
        harness_id: null,
        sandbox_provider_kind: null,
        routing_locked_at: null,
        hosted_execution_disabled_at: disabledAt,
        branch: null,
      });
    });

    it("returns no row for missing and cross-tenant targets", async () => {
      const thread = await storage.create({
        organization_id: "org_1",
        created_by: "user_1",
      });
      const pin = {
        branch: "hosted",
      };

      expect(
        await storage.claimHostedRoutingIfUnlocked("missing", "org_1", pin),
      ).toEqual({ thread: null, claimed: false });
      expect(
        await storage.claimHostedRoutingIfUnlocked(thread.id, "org_2", pin),
      ).toEqual({ thread: null, claimed: false });
      expect((await storage.get(thread.id, "org_1"))?.harness_id).toBeNull();
    });
  });
});
