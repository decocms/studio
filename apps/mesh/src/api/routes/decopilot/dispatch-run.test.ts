import { describe, expect, test } from "bun:test";
import {
  assertSinglePersistedRequestMessage,
  buildDurableDispatchInput,
} from "./dispatch-run";
import type { ChatMessage } from "./types";

describe("assertSinglePersistedRequestMessage", () => {
  test("returns the persisted user message matching the durable message id", () => {
    const message = {
      id: "msg-user",
      role: "user",
      parts: [{ type: "text", text: "already materialized" }],
    } as ChatMessage;

    expect(assertSinglePersistedRequestMessage([message], "msg-user")).toBe(
      message,
    );
  });

  test("returns a persisted assistant continuation matching the durable message id", () => {
    const message = {
      id: "msg-assistant",
      role: "assistant",
      parts: [
        {
          type: "tool-bash",
          state: "approval-responded",
          approval: { id: "ap_1", approved: true },
        },
      ],
    } as unknown as ChatMessage;

    expect(
      assertSinglePersistedRequestMessage([message], "msg-assistant"),
    ).toBe(message);
  });

  test("throws when the durable message id is missing from folded history", () => {
    expect(() => assertSinglePersistedRequestMessage([], "missing")).toThrow(
      "Persisted request message missing for messageId=missing",
    );
  });

  test("throws when the durable message id points at a system message", () => {
    expect(() =>
      assertSinglePersistedRequestMessage(
        [
          {
            id: "system-msg",
            role: "system",
            parts: [{ type: "text", text: "hello" }],
          } as ChatMessage,
        ],
        "system-msg",
      ),
    ).toThrow("Persisted message system-msg has role=system");
  });
});

describe("buildDurableDispatchInput", () => {
  test("drops raw messages and carries only submit-time ids, fence, and frozen config", () => {
    const durable = buildDurableDispatchInput(
      {
        messages: [
          {
            id: "msg-user",
            role: "user",
            parts: [{ type: "text", text: "secret prompt" }],
          } as ChatMessage,
        ],
        models: {
          credentialId: "cred-1",
          thinking: { id: "model-1" },
        },
        agent: { id: "agent-1" },
        temperature: 0.2,
        toolApprovalLevel: "auto",
        mode: "default",
        organizationId: "org-1",
        userId: "user-1",
        taskId: "thread-1",
        windowSize: 50,
        branch: "main",
      },
      {
        messageId: "msg-user",
        runFenceToken: "fence-1",
        branch: "main",
        harnessId: "decopilot",
        target: { sandboxProviderKind: "agent-sandbox" },
      },
    );

    expect("messages" in durable).toBe(false);
    expect(JSON.stringify(durable)).not.toContain("secret prompt");
    expect(durable).toMatchObject({
      organizationId: "org-1",
      userId: "user-1",
      taskId: "thread-1",
      messageId: "msg-user",
      runFenceToken: "fence-1",
      harnessId: "decopilot",
      branch: "main",
      target: { sandboxProviderKind: "agent-sandbox" },
    });
  });
});
