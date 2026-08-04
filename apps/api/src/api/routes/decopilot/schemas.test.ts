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
        memory: { windowSize },
      });
      expect(result.success).toBe(false);
    }
  });

  it("accepts a valid memory.windowSize", () => {
    const result = StreamRequestSchema.safeParse({
      ...baseRequest,
      memory: { windowSize: 100 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects every retired top-level routing alias", () => {
    for (const legacyField of [
      { agent: { id: "legacy-agent" } },
      { harnessId: "decopilot" },
      { sandboxProviderKind: "agent-sandbox" },
      { thread_id: "thread-1" },
      { stream: true },
    ]) {
      expect(
        StreamRequestSchema.safeParse({ ...baseRequest, ...legacyField })
          .success,
      ).toBe(false);
    }
  });

  it("rejects memory.thread_id instead of accepting a second thread authority", () => {
    const result = StreamRequestSchema.safeParse({
      ...baseRequest,
      memory: { windowSize: 100, thread_id: "thread-1" },
    });

    expect(result.success).toBe(false);
  });

  it("rejects unknown fields on the request and memory objects", () => {
    expect(
      StreamRequestSchema.safeParse({
        ...baseRequest,
        unknownSelector: "future-runtime",
      }).success,
    ).toBe(false);

    expect(
      StreamRequestSchema.safeParse({
        ...baseRequest,
        memory: { windowSize: 100, unknownOption: true },
      }).success,
    ).toBe(false);
  });

  it("keeps AI SDK message objects extensible", () => {
    expect(
      StreamRequestSchema.safeParse({
        messages: [{ ...baseRequest.messages[0], providerMetadata: {} }],
      }).success,
    ).toBe(true);
  });
});
