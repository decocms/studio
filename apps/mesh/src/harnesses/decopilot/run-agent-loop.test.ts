/**
 * runAgentLoop tests — shared core for parent + subagent.
 */

import { describe, expect, test } from "bun:test";
import { runAgentLoop, type RunAgentLoopOptions } from "./run-agent-loop";

// ── Stub fixtures ────────────────────────────────────────────────────
const mockCtx = {} as never;
const mockOrg = { id: "org_test" } as never;
const mockMcpClient = {} as never;
const mockProvider = {} as never;
const mockModels = {
  thinking: { id: "m1", limits: {} },
  credentialId: "cred_1",
} as never;

describe("runAgentLoop", () => {
  test("rejects when kind is 'subagent' (Stage 1 stub)", async () => {
    const fakeOpts = {
      kind: "subagent",
    } as RunAgentLoopOptions;

    // runAgentLoop is async from the start so the Stage 1 → Stage 2
    // transition doesn't change call-site shape (no sync→async break).
    await expect(runAgentLoop(fakeOpts)).rejects.toThrow(
      /not yet implemented in Stage 1/,
    );
  });

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

    // Stage 1 shim: inject a fake streamText via __streamText to avoid
    // ES-module read-only binding limitations. Deleted in Stage 2.
    const fakeStreamText = (cfg: {
      onError: (event: { error: unknown }) => void | Promise<void>;
    }) => {
      capturedOnError = cfg.onError;
      Promise.resolve().then(() =>
        capturedOnError?.({ error: new Error("provider rejected: 400") }),
      );
      return fakeResult;
    };

    const handle = await runAgentLoop({
      kind: "agent",
      ctx: mockCtx,
      organization: mockOrg,
      virtualMcp: { id: "vir_test" },
      mcpClient: mockMcpClient,
      provider: mockProvider,
      models: mockModels,
      messages: [],
      abortSignal: new AbortController().signal,
      __streamText: fakeStreamText,
    } as never);

    const error = await handle.error;
    expect(error).toContain("provider rejected: 400");
  });
});
