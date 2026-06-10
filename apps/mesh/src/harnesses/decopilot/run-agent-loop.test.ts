/**
 * runAgentLoop tests — shared core for parent + subagent.
 */

import { describe, expect, test } from "bun:test";
import { runAgentLoop, type RunAgentLoopOptions } from "./run-agent-loop";
import { buildAgentSystemPrompt } from "./build-agent-system-prompt";

// ── Stub fixtures ────────────────────────────────────────────────────
// ctx needs enough storage stubs for buildAgentSystemPrompt (listAgentsBlock
// calls ctx.storage.virtualMcps.list, listConnectionsBlock is no-op when
// connectionsData is absent).
const mockCtx = {
  storage: {
    virtualMcps: {
      list: async () => [],
    },
  },
} as never;
const mockOrg = { id: "org_test" } as never;
const mockProvider = {} as never;
const mockModels = {
  thinking: { id: "m1", limits: {} },
  credentialId: "cred_1",
} as never;
const mockWriter = { write: () => {}, merge: () => {} } as never;
const mockSubtaskParams = {
  provider: mockProvider,
  organization: mockOrg,
  models: mockModels,
};

describe("runAgentLoop", () => {
  test("exports the expected types", () => {
    // Type-check at compile time. If this compiles, types are exported.
    const opts: Partial<RunAgentLoopOptions> = { kind: "agent" };
    expect(opts.kind).toBe("agent");
  });
});

describe("runAgentLoop with kind: 'agent'", () => {
  test("captures errors via onError and resolves the error promise", async () => {
    let capturedOnError:
      | ((event: { error: unknown }) => void | Promise<void>)
      | undefined;

    const fakeResult = {
      text: Promise.resolve(""),
      finishReason: Promise.resolve("error"),
      usage: Promise.resolve({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }),
      toUIMessageStream: () => ({
        async *[Symbol.asyncIterator]() {},
      }),
      response: Promise.resolve({ messages: [] }),
    } as never;

    // Inject a fake streamText via __streamText to avoid
    // ES-module read-only binding limitations.
    const fakeStreamText = (cfg: {
      onError: (event: { error: unknown }) => void | Promise<void>;
    }) => {
      capturedOnError = cfg.onError;
      Promise.resolve().then(() =>
        capturedOnError?.({ error: new Error("provider rejected: 400") }),
      );
      return fakeResult;
    };

    const mockMcpClientWithListTools = {
      listTools: async () => ({ tools: [] }),
      getInstructions: () => "",
    } as never;

    const handle = await runAgentLoop({
      kind: "agent",
      ctx: mockCtx,
      organization: mockOrg,
      virtualMcp: { id: "vir_test" },
      mcpClient: mockMcpClientWithListTools,
      provider: mockProvider,
      models: mockModels,
      messages: [],
      abortSignal: new AbortController().signal,
      writer: mockWriter,
      subtaskParams: mockSubtaskParams,
      __streamText: fakeStreamText,
    } as never);

    const error = await handle.error;
    expect(error).toContain("provider rejected: 400");
  });
});

describe("runAgentLoop with kind: 'subagent'", () => {
  test("subagent kind no longer throws and assembles tools", async () => {
    const fakeResult = {
      text: Promise.resolve(""),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }),
      toUIMessageStream: () => ({
        async *[Symbol.asyncIterator]() {},
      }),
      response: Promise.resolve({ messages: [] }),
    } as never;

    // Build a fake streamText that returns a minimal result
    const fakeStreamText = () => {
      return fakeResult;
    };

    const mockMcpClientWithListTools = {
      listTools: async () => ({ tools: [] }),
      getInstructions: () => "",
    } as never;

    const handle = await runAgentLoop({
      kind: "subagent",
      ctx: mockCtx,
      organization: mockOrg,
      virtualMcp: { id: "vir_test" },
      mcpClient: mockMcpClientWithListTools,
      provider: mockProvider,
      models: mockModels,
      messages: [{ role: "user", content: "hi" }],
      abortSignal: new AbortController().signal,
      writer: mockWriter,
      subtaskParams: mockSubtaskParams,
      __streamText: fakeStreamText as never,
    } as never);

    expect(handle).toBeDefined();
    expect(handle.result).toBeDefined();
    expect(handle.error).toBeDefined();
    expect(handle.span).toBeDefined();
  });
});

describe("runAgentLoop assembledSystemMessages (single surviving assembler)", () => {
  test("exposes exactly buildAgentSystemPrompt's output — the prompt feeding the model is the same one the _request.systemSections debug metadata is derived from", async () => {
    const fakeResult = {
      text: Promise.resolve(""),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }),
      toUIMessageStream: () => ({
        async *[Symbol.asyncIterator]() {},
      }),
      response: Promise.resolve({ messages: [] }),
    } as never;
    const fakeStreamText = () => fakeResult;
    const mockMcpClient = {
      listTools: async () => ({ tools: [] }),
      getInstructions: () => "",
    } as never;

    const opts = {
      kind: "agent" as const,
      ctx: mockCtx,
      organization: mockOrg,
      virtualMcp: { id: "vir_test" },
      mcpClient: mockMcpClient,
      provider: mockProvider,
      models: mockModels,
      messages: [{ role: "user" as const, content: "hi" }],
      abortSignal: new AbortController().signal,
      writer: mockWriter,
      subtaskParams: mockSubtaskParams,
      isDecopilot: true,
      __streamText: fakeStreamText,
    } as never;

    const handle = await runAgentLoop(opts);

    // The loop returns the SAME assembled system messages buildAgentSystemPrompt
    // produces (no per-request extras passed here), proving the duplicate
    // assembler removal didn't change the prompt the model sees.
    const expected = await buildAgentSystemPrompt({
      ctx: mockCtx,
      organization: mockOrg,
      virtualMcp: { id: "vir_test" },
      kind: "agent",
      planMode: false,
      isDecopilot: true,
    });

    const contents = handle.assembledSystemMessages.map((m) => m.content);
    const expectedContents = expected.map((m) => m.content);
    // The non-cached <current-context> tail carries the date/time, so compare
    // every part except that last tail (which differs by wall-clock seconds).
    expect(contents.slice(0, -1)).toEqual(expectedContents.slice(0, -1));
    expect(contents.length).toBe(expectedContents.length);
  });
});
