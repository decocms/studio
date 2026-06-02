import { describe, expect, test } from "bun:test";
import { claudeCodeHarnessFactory } from "./index";
import type { HarnessContext } from "../types";

/**
 * Contract tests for the Claude Code harness factory.
 *
 * Exercising the actual streamText loop requires a working `claude` CLI
 * subprocess (the harness spawns it via `ai-sdk-provider-claude-code`),
 * so that path is left to end-to-end / resilience tests. The unit tests
 * here verify only the factory shape — id, create() return type, and
 * stream() being a function. Task 12 will own the integration coverage
 * via the shared dispatcher.
 */
describe("claudeCodeHarnessFactory", () => {
  test("has id 'claude-code'", () => {
    expect(claudeCodeHarnessFactory.id).toBe("claude-code");
  });

  test("create() returns a Harness with id 'claude-code' and a stream() method", () => {
    const harness = claudeCodeHarnessFactory.create({} as HarnessContext);
    expect(harness.id).toBe("claude-code");
    expect(typeof harness.stream).toBe("function");
  });
});

import type { UIMessageChunk } from "ai";

describe("claudeCodeHarnessFactory.stream", () => {
  test("yields a data-title-input chunk as the first emission", async () => {
    const harness = claudeCodeHarnessFactory.create({} as HarnessContext);

    // Build a minimal HarnessStreamInput that drives prepCliMessages
    // (sync, deterministic) and then trips the real streamText
    // invocation. We abort the signal before iterating so streamText
    // never actually spawns the claude CLI subprocess; the iterator
    // still emits the data-title-input chunk (it lives BEFORE the
    // streamText call).
    const abortController = new AbortController();
    abortController.abort();

    const input = {
      threadId: "t",
      runId: "r",
      messages: [
        {
          id: "m1",
          role: "user",
          parts: [{ type: "text", text: "What does this do?" }],
        } as never,
      ],
      models: {
        credentialId: "c",
        thinking: { id: "claude-code:sonnet", provider: "anthropic" },
      },
      mcp: { url: "https://example", headers: {}, expiresAt: 0 },
      mode: "default",
      temperature: 0.2,
      toolApprovalLevel: "readonly",
      user: { id: "u", email: "u@example.com" },
      organizationId: "o",
      virtualMcp: { id: "vm" },
      agent: { id: "a" },
      signal: abortController.signal,
    } as never;

    const chunks: UIMessageChunk[] = [];
    try {
      for await (const c of harness.stream(input)) {
        chunks.push(c);
        if (chunks.length >= 1) break;
      }
    } catch {
      // streamText errors out post-abort; the first yield happens
      // before the call, so the first chunk is captured.
    }

    expect(chunks[0]?.type).toBe("data-title-input");
    expect(
      (chunks[0] as { data?: { userMessage?: string } }).data?.userMessage,
    ).toBe("What does this do?");
  });
});
