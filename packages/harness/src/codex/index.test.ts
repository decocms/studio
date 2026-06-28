import { describe, expect, test } from "bun:test";
import { createCliMessageMetadata } from "../cli-stream-metadata";
import { prepCliMessages } from "../cli-message-prep";
import type { HarnessContext, HarnessStreamInput } from "../types";
import {
  buildCodexDeveloperInstructions,
  buildCodexModelOptions,
  codexHarnessFactory,
} from "./index";

function makeInput(
  overrides: Partial<HarnessStreamInput> = {},
): HarnessStreamInput {
  return {
    threadId: "thread-2",
    userMessage: {
      id: "msg-default",
      role: "user",
      parts: [{ type: "text", text: "default message" }],
    },
    harness: {},
    workspace: { cwd: null },
    models: {
      thinking: {
        id: "codex:gpt-5.4",
        title: "GPT 5.4",
        provider: "openai",
        credentialId: "cred-2",
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
    user: { id: "user-2", email: "user@example.com" },
    organizationId: "org-2",
    agent: { id: "agent-2", instructions: "Prefer tests first." },
    currentThreadTitle: "Renamed thread",
    signal: new AbortController().signal,
    ...overrides,
  };
}

/**
 * Contract tests for the Codex harness factory.
 *
 * Exercising the actual streamText loop requires a working `codex`
 * app-server subprocess (the harness spawns it via
 * `ai-sdk-provider-codex-cli`), so that path is left to end-to-end /
 * resilience tests. The unit tests here verify factory shape and pure
 * input/model-option preparation.
 *
 * Provider-cleanup correctness (the try/finally around `provider.close()`)
 * is verified by code review of `index.ts` — exercising the close path
 * unit-style would require mocking `ai-sdk-provider-codex-cli`, which
 * defeats the purpose of testing the real subprocess lifecycle.
 */
describe("codexHarnessFactory", () => {
  test("has id 'codex'", () => {
    expect(codexHarnessFactory.id).toBe("codex");
  });

  test("create() returns a Harness with id 'codex' and a stream() method", () => {
    const harness = codexHarnessFactory.create({} as HarnessContext);
    expect(harness.id).toBe("codex");
    expect(typeof harness.stream).toBe("function");
  });

  test("uses single userMessage and harness session id", async () => {
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

    const options = buildCodexModelOptions(input, undefined, undefined);
    expect(options).toMatchObject({
      resume: "session-1",
      cwd: undefined,
    });

    const messages = await prepCliMessages([input.userMessage]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toEqual([{ type: "text", text: "hello" }]);
  });
});

test("buildCodexDeveloperInstructions includes coding workspace and agent instructions only", () => {
  const instructions = buildCodexDeveloperInstructions({
    workspace: {
      repo: {
        owner: "deco",
        name: "site",
        connectedGithub: false,
      },
      branch: "main",
      cwd: "/repo",
    },
    agentInstructions: "Prefer tests before implementation.",
    now: new Date("2026-06-18T12:34:00.000Z"),
  });

  expect(instructions).toContain("<coding-workspace>");
  expect(instructions).toContain("Repository: deco/site");
  expect(instructions).toContain("GitHub linked: no");
  expect(instructions).toContain("Prefer tests before implementation.");
  expect(instructions).toContain("Current date: 2026-06-18");
  expect(instructions).not.toContain("<available-prompts>");
  expect(instructions).not.toContain("read_prompt");
  expect(instructions).not.toContain("todo_write");
});

describe("createCliMessageMetadata for Codex", () => {
  test("extracts the Codex app-server thread id as coding agent session metadata", () => {
    const messageMetadata = createCliMessageMetadata({
      input: {
        agent: { id: "agent-2" },
        models: {
          credentialId: "cred-2",
          thinking: {
            id: "codex:gpt-5.4",
            provider: "openai",
          },
        },
        threadId: "thread-2",
      } as never,
      providerName: "codex",
      providerMetadataKey: "codex-app-server",
      extractSessionId: (metadata) =>
        typeof (metadata as { threadId?: unknown })?.threadId === "string"
          ? (metadata as { threadId: string }).threadId
          : undefined,
    });

    expect(
      messageMetadata({
        part: {
          type: "finish-step",
          usage: { inputTokens: 1, outputTokens: 4, totalTokens: 5 },
          providerMetadata: {
            "codex-app-server": { threadId: "codex-thread-1" },
          },
        } as never,
      }),
    ).toMatchObject({
      usage: {
        inputTokens: 1,
        outputTokens: 4,
        totalTokens: 5,
      },
    });

    expect(
      messageMetadata({
        part: {
          type: "finish",
          totalUsage: {
            inputTokens: 1,
            outputTokens: 4,
            totalTokens: 5,
          },
        } as never,
      }),
    ).toMatchObject({
      codingAgentSessionId: "codex-thread-1",
      codingAgentProvider: "codex",
      usage: {
        inputTokens: 1,
        outputTokens: 4,
        totalTokens: 5,
      },
    });
  });
});
