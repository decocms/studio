import { describe, expect, it } from "bun:test";
import { StreamRequestSchema } from "./schemas";

const baseRequest = {
  messages: [
    {
      id: "msg-1",
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    },
  ],
  agent: { id: "agent-1" },
};

describe("StreamRequestSchema", () => {
  it("rejects retired runLocally requests", () => {
    const result = StreamRequestSchema.safeParse({
      ...baseRequest,
      runLocally: true,
    });

    expect(result.success).toBe(false);
  });

  it("rejects sandbox provider selectors", () => {
    for (const sandboxProviderKind of [
      "agent-sandbox",
      "cluster",
      "local-api",
      "future-sandbox",
      null,
    ]) {
      expect(
        StreamRequestSchema.safeParse({
          ...baseRequest,
          sandboxProviderKind,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects harness selectors, including Decopilot", () => {
    for (const harnessId of ["decopilot", "claude-code", "future"]) {
      expect(
        StreamRequestSchema.safeParse({
          ...baseRequest,
          harnessId,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects an out-of-range memory.windowSize", () => {
    // windowSize flows straight into a DB query LIMIT (Memory.loadHistory) —
    // an unbounded or negative value must be rejected at the boundary rather
    // than reaching the query.
    for (const windowSize of [0, -1, 1.5, 100_000]) {
      const result = StreamRequestSchema.safeParse({
        ...baseRequest,
        memory: { windowSize, thread_id: "thread-1" },
      });
      expect(result.success).toBe(false);
    }
  });

  it("accepts a valid memory.windowSize", () => {
    const result = StreamRequestSchema.safeParse({
      ...baseRequest,
      memory: { windowSize: 100, thread_id: "thread-1" },
    });
    expect(result.success).toBe(true);
  });
});
