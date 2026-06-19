import { describe, expect, test } from "bun:test";
import { buildClaudeCodeSystemPrompt, claudeCodeHarnessFactory } from "./index";
import { createCliMessageMetadata } from "../cli-stream-metadata";
import type { HarnessContext, HarnessStreamInput } from "../types";

function makeInput(): HarnessStreamInput {
  return {
    agent: { id: "agent-1" },
    workspace: { cwd: "default" },
    models: {
      thinking: {
        id: "claude-code:sonnet",
        title: "Claude Sonnet",
        provider: null,
        credentialId: "cred-1",
      },
    },
    threadId: "thread-1",
  } as unknown as HarnessStreamInput;
}

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

test("buildClaudeCodeSystemPrompt appends coding workspace and agent instructions to Claude Code preset", () => {
  const prompt = buildClaudeCodeSystemPrompt({
    codingWorkspace: {
      repo: {
        owner: "deco",
        name: "site",
        connectedGithub: true,
      },
      branch: "main",
      cwd: "/repo",
      workspaceKind: "github",
    },
    agentInstructions: "Prefer small focused patches.",
    now: new Date("2026-06-18T12:34:00.000Z"),
  });

  expect(prompt).toEqual({
    type: "preset",
    preset: "claude_code",
    append: expect.stringContaining("<coding-workspace>"),
  });
  if (!prompt) throw new Error("Expected Claude Code system prompt");
  expect(prompt.append).toContain("Repository: deco/site");
  expect(prompt.append).toContain("Prefer small focused patches.");
  expect(prompt.append).toContain("Current date: 2026-06-18");
  expect(prompt.append).not.toContain("<available-agents>");
  expect(prompt.append).not.toContain("enable_tool");
  expect(prompt.append).not.toContain("todo_write");
});

describe("createCliMessageMetadata for Claude Code", () => {
  test("emits start metadata and final Claude Code session metadata", () => {
    const messageMetadata = createCliMessageMetadata({
      input: makeInput(),
      providerName: "claude-code",
      providerMetadataKey: "claude-code",
      extractSessionId: (metadata) =>
        typeof (metadata as { sessionId?: unknown })?.sessionId === "string"
          ? (metadata as { sessionId: string }).sessionId
          : undefined,
    });

    const start = messageMetadata({
      part: { type: "start" } as never,
    });
    expect(start).toMatchObject({
      agent: { id: "agent-1" },
      models: {
        credentialId: "cred-1",
        thinking: {
          id: "claude-code:sonnet",
          title: "Claude Sonnet",
          provider: undefined,
        },
      },
      thread_id: "thread-1",
    });
    expect(start?.created_at).toBeInstanceOf(Date);

    const step = messageMetadata({
      part: {
        type: "finish-step",
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        providerMetadata: {
          "claude-code": { sessionId: "claude-session-1" },
        },
      } as never,
    });
    expect(step).toEqual({
      usage: {
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
        contextTokens: 2,
        cachedInputTokens: 0,
        inputTokenDetails: {
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          noCacheTokens: 2,
        },
      },
    });

    expect(
      messageMetadata({
        part: {
          type: "finish",
          totalUsage: {
            inputTokens: 2,
            outputTokens: 3,
            totalTokens: 5,
          },
        } as never,
      }),
    ).toMatchObject({
      codingAgentSessionId: "claude-session-1",
      codingAgentProvider: "claude-code",
      usage: {
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
      },
    });
  });
});
