import { describe, it, expect } from "bun:test";
import { processConversation, denyPendingApprovals } from "./conversation";
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
          credentialId: "c1",
          thinking: { id: "m1", title: "m1", capabilities: { text: true } },
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
          credentialId: "c1",
          thinking: { id: "m1", title: "m1", capabilities: { text: true } },
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
          credentialId: "c1",
          thinking: { id: "m1", title: "m1", capabilities: { text: true } },
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

describe("denyPendingApprovals", () => {
  it("returns messages unchanged when no assistant messages have pending approvals", () => {
    const messages: ChatMessage[] = [
      {
        id: "m1",
        role: "assistant",
        parts: [{ type: "text", text: "Hello" }],
      },
    ];

    const result = denyPendingApprovals(messages);
    expect(result).toEqual(messages);
  });

  it("returns non-assistant messages unchanged", () => {
    const messages: ChatMessage[] = [
      { id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] },
    ];

    const result = denyPendingApprovals(messages);
    expect(result).toEqual(messages);
    expect(result[0]).toBe(messages[0]);
  });

  it("converts approval-requested state to output-denied with approved: false", () => {
    const messages = [
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "tool-invocation",
            toolCallId: "tc-1",
            toolName: "do_thing",
            state: "approval-requested",
            approval: { type: "tool-call" },
            args: {},
          },
        ],
      },
    ] as unknown as ChatMessage[];

    const result = denyPendingApprovals(messages);
    const part = result[0]!.parts[0] as Record<string, unknown>;

    expect(part.state).toBe("output-denied");
    expect(part.approval).toEqual({
      type: "tool-call",
      approved: false,
      reason: "User sent a new message without approving this tool call.",
    });
  });

  it("leaves parts without approval field unchanged even if state is approval-requested", () => {
    const messages = [
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "tool-invocation",
            toolCallId: "tc-1",
            toolName: "do_thing",
            state: "approval-requested",
            args: {},
          },
        ],
      },
    ] as unknown as ChatMessage[];

    const result = denyPendingApprovals(messages);
    const part = result[0]!.parts[0] as Record<string, unknown>;

    expect(part.state).toBe("approval-requested");
  });

  it("handles mixed parts (some pending, some already resolved)", () => {
    const messages = [
      {
        id: "m1",
        role: "assistant",
        parts: [
          { type: "text", text: "Let me do that" },
          {
            type: "tool-invocation",
            toolCallId: "tc-1",
            toolName: "a",
            state: "approval-requested",
            approval: { type: "tool-call" },
            args: {},
          },
          {
            type: "tool-invocation",
            toolCallId: "tc-2",
            toolName: "b",
            state: "output-available",
            args: {},
            output: { result: "ok" },
          },
        ],
      },
    ] as unknown as ChatMessage[];

    const result = denyPendingApprovals(messages);
    const parts = result[0]!.parts as Record<string, unknown>[];

    expect((parts[0] as { text: string }).text).toBe("Let me do that");
    expect(parts[1]!.state).toBe("output-denied");
    expect((parts[1]!.approval as { approved: boolean }).approved).toBe(false);
    expect(parts[2]!.state).toBe("output-available");
  });

  it("denies pending approvals across multiple assistant messages", () => {
    const messages = [
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "tool-invocation",
            toolCallId: "tc-1",
            toolName: "older_tool",
            state: "approval-requested",
            approval: { type: "tool-call" },
            args: {},
          },
        ],
      },
      { id: "m2", role: "user", parts: [{ type: "text", text: "continue" }] },
      {
        id: "m3",
        role: "assistant",
        parts: [
          {
            type: "tool-invocation",
            toolCallId: "tc-2",
            toolName: "newer_tool",
            state: "approval-requested",
            approval: { type: "tool-call" },
            args: {},
          },
        ],
      },
    ] as unknown as ChatMessage[];

    const result = denyPendingApprovals(messages);

    const olderPart = result[0]!.parts[0] as Record<string, unknown>;
    expect(olderPart.state).toBe("output-denied");
    expect((olderPart.approval as { approved: boolean }).approved).toBe(false);

    expect(result[1]).toBe(messages[1]);

    const newerPart = result[2]!.parts[0] as Record<string, unknown>;
    expect(newerPart.state).toBe("output-denied");
    expect((newerPart.approval as { approved: boolean }).approved).toBe(false);
  });

  it("returns same reference when no assistant messages need patching", () => {
    const messages: ChatMessage[] = [
      { id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] },
      {
        id: "m2",
        role: "assistant",
        parts: [{ type: "text", text: "Hello!" }],
      },
    ];

    const result = denyPendingApprovals(messages);
    expect(result).toBe(messages);
  });
});
