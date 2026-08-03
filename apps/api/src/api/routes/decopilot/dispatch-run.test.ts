import { describe, expect, test } from "bun:test";
import {
  assertHostedDispatchHarness,
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
        harnessId: "decopilot",
        sandboxProviderKind: "agent-sandbox",
        taskId: "thread-1",
        windowSize: 50,
        branch: "main",
      },
      {
        messageId: "msg-user",
        runFenceToken: "fence-1",
        branch: "main",
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
    });
  });

  test("carries runMetadata through the frozen snapshot", () => {
    const durable = buildDurableDispatchInput(
      {
        messages: [],
        models: { credentialId: "cred-1", thinking: { id: "model-1" } },
        agent: { id: "agent-1" },
        temperature: 0.2,
        toolApprovalLevel: "auto",
        mode: "default",
        organizationId: "org-1",
        userId: "user-1",
        harnessId: "decopilot",
        sandboxProviderKind: "agent-sandbox",
        taskId: "thread-1",
        runMetadata: { org_id: "org-xyz", url: "shop.com" },
      },
      { messageId: "msg-1", runFenceToken: "fence-1" },
    );
    expect(durable.runMetadata).toEqual({ org_id: "org-xyz", url: "shop.com" });
  });

  test("folds the per-turn system message text into systemContext", () => {
    const durable = buildDurableDispatchInput(
      {
        messages: [
          {
            id: "sys-1",
            role: "system",
            parts: [
              { type: "text", text: "### Currently Open File\nhome/x.md" },
            ],
          } as ChatMessage,
          {
            id: "msg-user",
            role: "user",
            parts: [{ type: "text", text: "change the h1" }],
          } as ChatMessage,
        ],
        models: { credentialId: "cred-1", thinking: { id: "model-1" } },
        agent: { id: "agent-1" },
        temperature: 0.2,
        toolApprovalLevel: "auto",
        mode: "default",
        organizationId: "org-1",
        userId: "user-1",
        harnessId: "decopilot",
        sandboxProviderKind: "agent-sandbox",
        taskId: "thread-1",
      },
      { messageId: "msg-user", runFenceToken: "fence-1" },
    );
    // The raw messages array is still dropped from the durable snapshot…
    expect("messages" in durable).toBe(false);
    // …but the ephemeral system context survives it (it isn't persisted as a
    // thread message, so the durable branch would otherwise lose it).
    expect(durable.systemContext).toBe("### Currently Open File\nhome/x.md");
  });

  test("omits systemContext when the turn carries no system message", () => {
    const durable = buildDurableDispatchInput(
      {
        messages: [
          {
            id: "msg-user",
            role: "user",
            parts: [{ type: "text", text: "hi" }],
          } as ChatMessage,
        ],
        models: { credentialId: "cred-1", thinking: { id: "model-1" } },
        agent: { id: "agent-1" },
        temperature: 0.2,
        toolApprovalLevel: "auto",
        mode: "default",
        organizationId: "org-1",
        userId: "user-1",
        harnessId: "decopilot",
        sandboxProviderKind: "agent-sandbox",
        taskId: "thread-1",
      },
      { messageId: "msg-user", runFenceToken: "fence-1" },
    );
    expect("systemContext" in durable).toBe(false);
  });
});

describe("assertHostedDispatchHarness", () => {
  test("accepts only explicit Decopilot", () => {
    expect(() => assertHostedDispatchHarness("decopilot")).not.toThrow();
    for (const harnessId of [
      null,
      undefined,
      "claude-code",
      "codex",
      "opencode",
      "future",
    ] as const) {
      expect(() => assertHostedDispatchHarness(harnessId)).toThrow(
        /explicit Decopilot/,
      );
    }
  });
});
