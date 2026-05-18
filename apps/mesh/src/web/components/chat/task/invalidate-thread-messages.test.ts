import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { invalidateThreadMessages } from "./invalidate-thread-messages";

describe("invalidateThreadMessages", () => {
  test("invalidates THREAD_MESSAGES queries whose serialized args contain the given taskId", () => {
    const qc = new QueryClient();
    const keyA = [
      "",
      "org-1",
      "self-mcp",
      "collection",
      "THREAD_MESSAGES",
      "list",
      JSON.stringify({
        where: { field: ["thread_id"], operator: "eq", value: "task-A" },
        limit: 100,
        offset: 0,
      }),
    ];
    const keyB = [
      "",
      "org-1",
      "self-mcp",
      "collection",
      "THREAD_MESSAGES",
      "list",
      JSON.stringify({
        where: { field: ["thread_id"], operator: "eq", value: "task-B" },
        limit: 100,
        offset: 0,
      }),
    ];
    qc.setQueryData(keyA, { items: [] });
    qc.setQueryData(keyB, { items: [] });

    invalidateThreadMessages(qc, "task-A");

    expect(qc.getQueryState(keyA)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(keyB)?.isInvalidated).toBe(false);
  });

  test("ignores non-THREAD_MESSAGES collections", () => {
    const qc = new QueryClient();
    const threadsKey = [
      "",
      "org-1",
      "self-mcp",
      "collection",
      "THREADS",
      "list",
      JSON.stringify({}),
    ];
    qc.setQueryData(threadsKey, { items: [] });

    invalidateThreadMessages(qc, "task-A");

    expect(qc.getQueryState(threadsKey)?.isInvalidated).toBe(false);
  });

  test("ignores non-collection query keys", () => {
    const qc = new QueryClient();
    const otherKey = ["other-namespace", "task-A"];
    qc.setQueryData(otherKey, "anything");

    invalidateThreadMessages(qc, "task-A");

    expect(qc.getQueryState(otherKey)?.isInvalidated).toBe(false);
  });
});
