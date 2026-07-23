import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@/api/routes/decopilot/types";
import { assembleDecopilotContextForTest } from "./context-loader";

describe("assembleDecopilotContextForTest", () => {
  test("includes system messages, historical messages, and current user message in order", async () => {
    const history = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "old" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "reply" }],
      },
    ] as ChatMessage[];
    const userMessage = {
      id: "u2",
      role: "user",
      parts: [{ type: "text", text: "new" }],
    } as ChatMessage;

    const result = await assembleDecopilotContextForTest({
      history,
      userMessage,
      systemMessages: [
        {
          id: "s1",
          role: "system",
          parts: [{ type: "text", text: "sys" }],
        },
      ] as ChatMessage[],
    });

    expect(result.map((m) => m.id)).toEqual(["s1", "u1", "a1", "u2"]);
  });
});
