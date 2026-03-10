import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createDatabase, closeDatabase, type MeshDatabase } from "../database";
import { createTestSchema } from "./test-helpers";
import { SqlThreadStorage } from "./threads";
import type { ThreadMessage } from "./types";

describe("SqlThreadStorage", () => {
  let database: MeshDatabase;
  let storage: SqlThreadStorage;

  beforeAll(async () => {
    database = createDatabase(":memory:");
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
    await closeDatabase(database);
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
});
