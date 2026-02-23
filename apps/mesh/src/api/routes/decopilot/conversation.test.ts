import { describe, it, expect } from "bun:test";
import { processConversation } from "./conversation";
import type { ChatMessage } from "./types";

describe("processConversation", () => {
  describe("ID-based merge", () => {
    it("replaces thread assistant with config assistant when ids match", async () => {
      const configMessage: ChatMessage = {
        id: "msg-assistant-1",
        role: "assistant",
        parts: [
          { type: "text", text: "I'll help." },
          {
            type: "tool-user_ask",
            toolCallId: "tc-1",
            state: "output-available" as const,
            input: {
              prompt: "Which option?",
              type: "choice",
              options: ["A", "B"],
            },
            output: { response: "A" },
          },
        ],
      };

      const allMessages: ChatMessage[] = [
        {
          id: "msg-user-1",
          role: "user",
          parts: [{ type: "text", text: "Help me" }],
        },
        configMessage,
      ];

      const { originalMessages } = await processConversation(allMessages, {
        windowSize: 50,
        models: {
          connectionId: "c1",
          thinking: { id: "m1", capabilities: { text: true } },
        },
      });

      const assistantMsg = originalMessages.find((m) => m.role === "assistant");
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.id).toBe("msg-assistant-1");
      const toolPart = assistantMsg!.parts?.find(
        (p) => p.type === "tool-user_ask" && "output" in p,
      );
      expect(toolPart).toBeDefined();
      expect(
        (toolPart as { output?: { response: string } }).output?.response,
      ).toBe("A");
    });

    it("appends config messages when ids are not in thread", async () => {
      const allMessages: ChatMessage[] = [
        { id: "msg-1", role: "user", parts: [{ type: "text", text: "Hi" }] },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Hello!" }],
        },
      ];

      const { originalMessages } = await processConversation(allMessages, {
        windowSize: 50,
        models: {
          connectionId: "c1",
          thinking: { id: "m1", capabilities: { text: true } },
        },
      });

      expect(originalMessages).toHaveLength(2);
      expect(originalMessages[0]!.id).toBe("msg-1");
      expect(originalMessages[1]!.id).toBe("msg-2");
    });

    it("replaces matching message and drops rest of thread", async () => {
      const allMessages: ChatMessage[] = [
        { id: "msg-1", role: "user", parts: [{ type: "text", text: "A" }] },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "B updated" }],
        },
      ];

      const { originalMessages } = await processConversation(allMessages, {
        windowSize: 50,
        models: {
          connectionId: "c1",
          thinking: { id: "m1", capabilities: { text: true } },
        },
      });

      expect(originalMessages).toHaveLength(2);
      expect(originalMessages[0]!.id).toBe("msg-1");
      expect(originalMessages[1]!.id).toBe("msg-2");
      const part0 = originalMessages[1]!.parts?.[0];
      expect(part0).toBeDefined();
      expect((part0 as { text: string }).text).toBe("B updated");
    });
  });
});
