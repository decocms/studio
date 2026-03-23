import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  createTestDatabase,
  closeTestDatabase,
  type TestDatabase,
} from "../database/test-db";
import { createTestSchema } from "./test-helpers";
import { SqlThreadStorage } from "./threads";
import type { ThreadMessage } from "./types";

describe("SqlThreadStorage", () => {
  let database: TestDatabase;
  let storage: SqlThreadStorage;

  beforeAll(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);
    // Insert org and user for thread FK constraints
    await database.db
      .insertInto("organization")
      .values({
        id: "org_1",
        name: "Test Org",
        slug: "test-org",
        createdAt: new Date().toISOString(),
      })
      .execute();
    await database.db
      .insertInto("user")
      .values({
        id: "user_1",
        email: "test@test.com",
        emailVerified: 0,
        name: "Test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .execute();
    storage = new SqlThreadStorage(database.db);
  });

  afterAll(async () => {
    await closeTestDatabase(database);
  });

  describe("saveMessages (upsert)", () => {
    it("inserts new messages", async () => {
      const thread = await storage.create({
        organization_id: "org_1",
        created_by: "user_1",
      });

      const messages: ThreadMessage[] = [
        {
          id: "msg_1",
          role: "user",
          parts: [{ type: "text", text: "Hello" }],
          thread_id: thread.id,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          id: "msg_2",
          role: "assistant",
          parts: [{ type: "text", text: "Hi there" }],
          thread_id: thread.id,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];

      await storage.saveMessages(messages, "org_1");

      const { messages: loaded } = await storage.listMessages(
        thread.id,
        "org_1",
      );
      expect(loaded).toHaveLength(2);
      expect(loaded[0]!.id).toBe("msg_1");
      expect(loaded[1]!.id).toBe("msg_2");
    });

    it("updates existing message when id conflicts", async () => {
      const thread = await storage.create({
        organization_id: "org_1",
        created_by: "user_1",
      });

      const initial: ThreadMessage[] = [
        {
          id: "msg_upsert",
          role: "assistant",
          parts: [{ type: "text", text: "Original" }],
          thread_id: thread.id,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];

      await storage.saveMessages(initial, "org_1");

      const updated: ThreadMessage[] = [
        {
          id: "msg_upsert",
          role: "assistant",
          parts: [
            { type: "text", text: "Original" },
            {
              type: "tool-user_ask",
              toolCallId: "tc-1",
              state: "output-available",
              input: { prompt: "?", type: "text" },
              output: { response: "Answered" },
            },
          ],
          thread_id: thread.id,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];

      await storage.saveMessages(updated, "org_1");

      const { messages: loaded } = await storage.listMessages(
        thread.id,
        "org_1",
      );
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.id).toBe("msg_upsert");
      expect(loaded[0]!.parts).toHaveLength(2);
      const toolPart = loaded[0]!.parts?.find(
        (p) => p.type === "tool-user_ask" && "output" in p,
      );
      expect(toolPart).toBeDefined();
      expect(
        (toolPart as { output?: { response: string } }).output?.response,
      ).toBe("Answered");
    });
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
    describe("claimOrphanedRun", () => {
      it("claims when run_owner_pod is NULL", async () => {
        const thread = await storage.create({
          organization_id: "org_1",
          created_by: "user_1",
          status: "in_progress",
        });
        await storage.claimOrphanedRun(thread.id, "org_1", "pod-1");
        const loaded = await storage.get(thread.id, "org_1");
        expect(loaded?.run_owner_pod).toBe("pod-1");
      });

      it("claims from a different (stale) pod", async () => {
        const thread = await storage.create({
          organization_id: "org_1",
          created_by: "user_1",
          status: "in_progress",
        });
        // Simulate a crashed pod owning this thread
        await storage.update(thread.id, "org_1", {
          run_owner_pod: "dead-pod",
        });
        // New pod should be able to claim it (verify via side effect —
        // PGlite doesn't report numUpdatedRows correctly)
        await storage.claimOrphanedRun(thread.id, "org_1", "new-pod");
        const loaded = await storage.get(thread.id, "org_1");
        expect(loaded?.run_owner_pod).toBe("new-pod");
      });

      it("does not claim when status is not in_progress", async () => {
        const thread = await storage.create({
          organization_id: "org_1",
          created_by: "user_1",
          status: "completed",
        });
        await storage.claimOrphanedRun(thread.id, "org_1", "pod-1");
        const loaded = await storage.get(thread.id, "org_1");
        // Should not have been claimed
        expect(loaded?.run_owner_pod).toBeNull();
      });
    });

    describe("listOrphanedRuns", () => {
      it("returns threads with NULL owner", async () => {
        const thread = await storage.create({
          organization_id: "org_1",
          created_by: "user_1",
          status: "in_progress",
        });
        // Set run_config so it qualifies as an orphan
        await storage.update(thread.id, "org_1", {
          run_config: { agent: { id: "a" } },
        });
        const orphans = await storage.listOrphanedRuns("current-pod");
        const found = orphans.find((t) => t.id === thread.id);
        expect(found).toBeDefined();
      });

      it("does NOT return threads without run_config", async () => {
        const thread = await storage.create({
          organization_id: "org_1",
          created_by: "user_1",
          status: "in_progress",
        });
        // No run_config set
        const orphans = await storage.listOrphanedRuns("current-pod");
        const found = orphans.find((t) => t.id === thread.id);
        expect(found).toBeUndefined();
      });

      it("does NOT return threads with non-in_progress status", async () => {
        const thread = await storage.create({
          organization_id: "org_1",
          created_by: "user_1",
          status: "completed",
        });
        await storage.update(thread.id, "org_1", {
          run_config: { agent: { id: "a" } },
        });
        const orphans = await storage.listOrphanedRuns("current-pod");
        const found = orphans.find((t) => t.id === thread.id);
        expect(found).toBeUndefined();
      });
    });

    describe("orphanRunsByPod", () => {
      it("clears ownership for all runs owned by pod", async () => {
        const thread = await storage.create({
          organization_id: "org_1",
          created_by: "user_1",
          status: "in_progress",
        });
        await storage.update(thread.id, "org_1", {
          run_owner_pod: "pod-orphan-test",
          run_config: { agent: { id: "a" } },
        });

        await storage.orphanRunsByPod("pod-orphan-test");

        const loaded = await storage.get(thread.id, "org_1");
        expect(loaded?.run_owner_pod).toBeNull();
        // status should remain in_progress
        expect(loaded?.status).toBe("in_progress");
        // run_config should be preserved
        expect(loaded?.run_config).not.toBeNull();
      });

      it("does not affect runs owned by other pods", async () => {
        const thread = await storage.create({
          organization_id: "org_1",
          created_by: "user_1",
          status: "in_progress",
        });
        await storage.update(thread.id, "org_1", {
          run_owner_pod: "pod-other",
        });

        await storage.orphanRunsByPod("pod-orphan-different");

        const loaded = await storage.get(thread.id, "org_1");
        expect(loaded?.run_owner_pod).toBe("pod-other");
      });
    });

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
});
