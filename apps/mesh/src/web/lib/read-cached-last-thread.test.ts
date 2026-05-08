import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { KEYS } from "./query-keys";
import { readCachedLastThread } from "./read-cached-last-thread";
import type { Task, TasksQueryData } from "@/web/components/chat/task/types";

const LOCATOR = "org/proj";
const USER_ID = "user-1";
const AGENT_ID = "agent-1";

function task(overrides: Partial<Task>): Task {
  return {
    id: "t-default",
    title: "Test thread",
    created_at: "2026-04-29T00:00:00.000Z",
    updated_at: "2026-04-29T00:00:00.000Z",
    created_by: USER_ID,
    virtual_mcp_id: AGENT_ID,
    ...overrides,
  };
}

function seed(qc: QueryClient, filterTag: string, items: Task[]) {
  const data: TasksQueryData = { items, hasMore: false };
  qc.setQueryData(["tasks", LOCATOR, filterTag], data);
}

describe("readCachedLastThread", () => {
  test("returns null when the cache is empty", () => {
    const qc = new QueryClient();
    expect(readCachedLastThread(qc, LOCATOR, AGENT_ID, USER_ID)).toBeNull();
  });

  test("returns the single matching thread", () => {
    const qc = new QueryClient();
    seed(qc, "list-a", [
      task({ id: "t1", updated_at: "2026-04-29T01:00:00.000Z" }),
    ]);
    const result = readCachedLastThread(qc, LOCATOR, AGENT_ID, USER_ID);
    expect(result?.id).toBe("t1");
  });

  test("picks the freshest match across multiple cached lists", () => {
    const qc = new QueryClient();
    seed(qc, "list-a", [
      task({ id: "older", updated_at: "2026-04-29T01:00:00.000Z" }),
    ]);
    seed(qc, "list-b", [
      task({ id: "newer", updated_at: "2026-04-29T05:00:00.000Z" }),
      task({ id: "oldest", updated_at: "2026-04-28T00:00:00.000Z" }),
    ]);
    const result = readCachedLastThread(qc, LOCATOR, AGENT_ID, USER_ID);
    expect(result?.id).toBe("newer");
  });

  test("rejects threads for a different agent", () => {
    const qc = new QueryClient();
    seed(qc, "list-a", [
      task({ id: "wrong-agent", virtual_mcp_id: "agent-2" }),
    ]);
    expect(readCachedLastThread(qc, LOCATOR, AGENT_ID, USER_ID)).toBeNull();
  });

  test("rejects threads created by a different user", () => {
    const qc = new QueryClient();
    seed(qc, "list-a", [task({ id: "wrong-user", created_by: "user-2" })]);
    expect(readCachedLastThread(qc, LOCATOR, AGENT_ID, USER_ID)).toBeNull();
  });

  test("rejects archived (hidden) threads", () => {
    const qc = new QueryClient();
    seed(qc, "list-a", [
      task({
        id: "archived",
        hidden: true,
        updated_at: "2026-04-29T05:00:00.000Z",
      }),
      task({ id: "live", updated_at: "2026-04-29T01:00:00.000Z" }),
    ]);
    const result = readCachedLastThread(qc, LOCATOR, AGENT_ID, USER_ID);
    expect(result?.id).toBe("live");
  });

  test("does not match cache entries for a different locator", () => {
    const qc = new QueryClient();
    qc.setQueryData(["tasks", "other-locator", "list-a"], {
      items: [task({ id: "elsewhere" })],
      hasMore: false,
    } satisfies TasksQueryData);
    expect(readCachedLastThread(qc, LOCATOR, AGENT_ID, USER_ID)).toBeNull();
  });

  test("ignores entries with empty/missing items", () => {
    const qc = new QueryClient();
    qc.setQueryData(["tasks", LOCATOR, "empty"], {
      items: [],
      hasMore: false,
    } satisfies TasksQueryData);
    qc.setQueryData(["tasks", LOCATOR, "undef"], undefined);
    expect(readCachedLastThread(qc, LOCATOR, AGENT_ID, USER_ID)).toBeNull();
  });

  test("verifies KEYS.tasksPrefix is used as the matching prefix", () => {
    const qc = new QueryClient();
    const exactKey = KEYS.tasks(LOCATOR, {
      owner: "me",
      status: "open",
      virtualMcpId: AGENT_ID,
      userId: USER_ID,
      hasTrigger: null,
    });
    qc.setQueryData(exactKey, {
      items: [task({ id: "from-real-key" })],
      hasMore: false,
    } satisfies TasksQueryData);
    expect(readCachedLastThread(qc, LOCATOR, AGENT_ID, USER_ID)?.id).toBe(
      "from-real-key",
    );
  });
});
