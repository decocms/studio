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
});
