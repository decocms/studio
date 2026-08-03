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
};

describe("StreamRequestSchema", () => {
  it("rejects retired runLocally requests", () => {
    const result = StreamRequestSchema.safeParse({
      ...baseRequest,
      runLocally: true,
    });

    expect(result.success).toBe(false);
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

  it("keeps strict unknown-field rejection after stripping legacy selectors", () => {
    const result = StreamRequestSchema.safeParse({
      ...baseRequest,
      agent: { id: "legacy-agent" },
      harnessId: "decopilot",
      sandboxProviderKind: "agent-sandbox",
      unknownSelector: "future-runtime",
    });

    expect(result.success).toBe(false);
  });
});
