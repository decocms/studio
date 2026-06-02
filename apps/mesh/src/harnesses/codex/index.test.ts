import { describe, expect, test } from "bun:test";
import type { HarnessContext } from "../types";
import { codexHarnessFactory } from "./index";

/**
 * Contract tests for the Codex harness factory.
 *
 * Exercising the actual streamText loop requires a working `codex`
 * app-server subprocess (the harness spawns it via
 * `ai-sdk-provider-codex-cli`), so that path is left to end-to-end /
 * resilience tests. The unit tests here verify only the factory shape —
 * id, create() return type, and stream() being a function. Task 12 will
 * own the integration coverage via the shared dispatcher.
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
});

import type { UIMessageChunk } from "ai";

describe("codexHarnessFactory.stream", () => {
  test("yields a data-title-input chunk as the first emission", async () => {
    const harness = codexHarnessFactory.create({} as HarnessContext);
    const abortController = new AbortController();
    abortController.abort();

    const input = {
      threadId: "t",
      runId: "r",
      messages: [
        {
          id: "m1",
          role: "user",
          parts: [{ type: "text", text: "Add OAuth support" }],
        } as never,
      ],
      models: {
        credentialId: "c",
        thinking: { id: "codex:gpt-5.4", provider: "openai" },
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
      // before the call.
    }

    expect(chunks[0]?.type).toBe("data-title-input");
    expect(
      (chunks[0] as { data?: { userMessage?: string } }).data?.userMessage,
    ).toBe("Add OAuth support");
  });
});
