import { describe, expect, mock, test } from "bun:test";
import { createCliMessageMetadata } from "../cli-stream-metadata";
import type { HarnessContext, HarnessStreamInput } from "../types";

const claudeCodeModelCalls: Array<{
  modelId: string;
  options: unknown;
}> = [];
let streamTextConfig: unknown;

mock.module("ai", () => ({
  convertToModelMessages: async (
    messages: Array<{ role: string; parts: unknown[] }>,
  ) =>
    messages.map((message) => ({
      role: message.role,
      content: message.parts,
    })),
  generateObject: async () => ({ object: { title: null } }),
  streamText: (config: unknown) => {
    streamTextConfig = config;
    return {
      toUIMessageStream: () =>
        (async function* () {
          // Empty stream; tests only inspect the options passed to streamText.
        })(),
    };
  },
}));

mock.module("./model", () => ({
  createClaudeCodeModel: (modelId: string, options: unknown) => {
    claudeCodeModelCalls.push({ modelId, options });
    return { provider: "claude-code-test-model" };
  },
  resolveClaudeCodeModelId: (modelId: string) =>
    modelId === "claude-code:sonnet" ? "sonnet" : modelId,
}));

function makeInput(
  overrides: Partial<HarnessStreamInput> = {},
): HarnessStreamInput {
  return {
    threadId: "thread-1",
    userMessage: {
      id: "msg-default",
      role: "user",
      parts: [{ type: "text", text: "default message" }],
    },
    harness: {},
    workspace: { cwd: null },
    models: {
      thinking: {
        id: "claude-code:sonnet",
        title: "Claude Sonnet",
        provider: null,
        credentialId: "cred-1",
      },
    },
    mcp: {
      url: "https://mcp.example.com",
      headers: { authorization: "Bearer token" },
      expiresAt: Date.now() + 60_000,
    },
    mode: "default",
    temperature: 0,
    toolApprovalLevel: "readonly",
    user: { id: "user-1", email: "user@example.com" },
    organizationId: "org-1",
    agent: { id: "agent-1", instructions: "Prefer small focused patches." },
    currentThreadTitle: "Renamed thread",
    signal: new AbortController().signal,
    ...overrides,
  };
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
  test("has id 'claude-code'", async () => {
    const { claudeCodeHarnessFactory } = await import("./index");
    expect(claudeCodeHarnessFactory.id).toBe("claude-code");
  });

  test("create() returns a Harness with id 'claude-code' and a stream() method", async () => {
    const { claudeCodeHarnessFactory } = await import("./index");
    const harness = claudeCodeHarnessFactory.create({} as HarnessContext);
    expect(harness.id).toBe("claude-code");
    expect(typeof harness.stream).toBe("function");
  });

  test("uses single userMessage and harness session id", async () => {
    claudeCodeModelCalls.length = 0;
    streamTextConfig = undefined;
    const { claudeCodeHarnessFactory } = await import("./index");
    const input = makeInput({
      userMessage: {
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      },
      harness: { sessionId: "session-1" },
      workspace: { cwd: null },
    });

    expect(input.harness.sessionId).toBe("session-1");
    expect(input.userMessage.parts[0]).toEqual({ type: "text", text: "hello" });

    const harness = claudeCodeHarnessFactory.create({} as HarnessContext);
    for await (const _chunk of harness.stream(input)) {
      // Exhaust the stream so the harness reaches streamText.
    }

    expect(claudeCodeModelCalls[0]?.options).toMatchObject({
      resume: "session-1",
      cwd: undefined,
    });
    expect(streamTextConfig).toMatchObject({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    });
  });
});

test("buildClaudeCodeSystemPrompt appends coding workspace and agent instructions to Claude Code preset", async () => {
  const { buildClaudeCodeSystemPrompt } = await import("./index");
  const prompt = buildClaudeCodeSystemPrompt({
    workspace: {
      repo: {
        owner: "deco",
        name: "site",
        connectedGithub: true,
      },
      branch: "main",
      cwd: "/repo",
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
