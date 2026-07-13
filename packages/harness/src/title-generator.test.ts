/**
 * Unit tests for the genTitle title-generation primitive.
 *
 * The LLM call itself is exercised via integration tests — here we
 * focus on the fallback path, which is pure logic and covers every
 * production failure mode (provider error, abort, unusable text).
 *
 * We trigger the fallback by passing an AbortController whose signal
 * is already aborted at construction time — generateObject rejects
 * immediately with AbortError, and genTitle resolves to null in that
 * branch. To exercise the *non-null* fallback (provider error, empty
 * output), we drive it via a model that throws a non-abort error.
 */
import { describe, expect, test } from "bun:test";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { genTitle } from "./title-generator";

/** Build a fake LanguageModelV3 whose doGenerate rejects with the given
 *  error. genTitle catches this and returns the new fallback. */
function makeFailingModel(err: Error): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "test",
    doGenerate: async () => {
      throw err;
    },
    doStream: async () => {
      throw err;
    },
  } as unknown as LanguageModelV3;
}

/** A model whose doGenerate hangs until the call's abortSignal fires, then
 *  rejects with AbortError — simulates a slow/hung title model (e.g. codex's
 *  separate title app-server) that only resolves when the self-timeout aborts. */
function makeHangingModel(): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "test",
    doGenerate: async (opts: { abortSignal?: AbortSignal }) => {
      await new Promise((_resolve, reject) => {
        opts.abortSignal?.addEventListener(
          "abort",
          () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      });
      throw new Error("unreachable");
    },
    doStream: async () => {
      throw new Error("no stream");
    },
  } as unknown as LanguageModelV3;
}

/** A model whose doGenerate never settles and IGNORES the abort signal —
 *  simulates a hung title app-server that black-holes the request. Without the
 *  settlement latch, `retry` (which only observes the signal between attempts)
 *  awaits this forever and genTitle's promise never resolves, hanging the parent
 *  run's drain loop. The latch must cap settlement at the timeout regardless. */
function makeUnabortableModel(): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "test",
    doGenerate: () => new Promise(() => {}), // never resolves, ignores abort
    doStream: async () => {
      throw new Error("no stream");
    },
  } as unknown as LanguageModelV3;
}

/** A model that returns a fixed title object via doGenerate. */
function makeSucceedingModel(title: string): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "ok",
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify({ title }) }],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
    doStream: async () => {
      throw new Error("no stream");
    },
  } as unknown as LanguageModelV3;
}

describe("genTitle model fallback chain", () => {
  test("rotates to the next model when the first keeps failing", async () => {
    const handle = genTitle({
      models: [
        () => makeFailingModel(new Error("first boom")),
        () => makeSucceedingModel("Second model title"),
      ],
      userMessage: "does not matter",
    });
    const result = await handle.promise;
    expect(result).toBe("Second model title");
  });

  test("a factory that throws at build time fails only its attempt, then rotates", async () => {
    const handle = genTitle({
      models: [
        () => {
          throw new Error("provider has no aiSdk"); // unbuildable slot
        },
        () => makeSucceedingModel("Built by the second slot"),
      ],
      userMessage: "does not matter",
    });
    const result = await handle.promise;
    expect(result).toBe("Built by the second slot");
  });

  test("empty model list falls back to clamped user message (never a broken title)", async () => {
    const handle = genTitle({
      models: [],
      userMessage: "Fix the login button on mobile devices please",
    });
    const result = await handle.promise;
    expect(result).toBe("Fix the login button on mobile d");
  });
});

describe("genTitle fallback", () => {
  test("self-timeout (slow/hung model) falls back to clamped user message, not null", async () => {
    const handle = genTitle({
      models: [() => makeHangingModel()],
      userMessage: "Build a complex dashboard app",
      timeoutMs: 10, // tiny self-timeout; no parent abort, no finish()
    });
    const result = await handle.promise;
    // First 32 chars of "Build a complex dashboard app".
    expect(result).toBe("Build a complex dashboard app");
  });

  test("provider that IGNORES the abort signal still settles to the fallback (does not hang)", async () => {
    // Regression: the self-timeout only *signals* an abort; `retry` awaits the
    // in-flight call and can't observe the signal mid-attempt. A provider that
    // black-holes the request would leave the promise pending forever and hang
    // the parent run's drain loop. The settlement latch must resolve it anyway.
    const handle = genTitle({
      models: [() => makeUnabortableModel()],
      userMessage: "Ship the unabortable fix",
      timeoutMs: 10,
    });
    const result = await handle.promise;
    expect(result).toBe("Ship the unabortable fix");
  });

  test("when the LLM throws, falls back to userMessage.slice(0, 32).trim()", async () => {
    const abortController = new AbortController();
    const handle = genTitle({
      abortSignal: abortController.signal,
      models: [() => makeFailingModel(new Error("provider boom"))],
      userMessage: "Fix the login button on mobile devices please",
    });
    handle.finish();
    const result = await handle.promise;
    // First 32 chars of "Fix the login button on mobile devices please".
    expect(result).toBe("Fix the login button on mobile d");
  });

  test("user message under 32 chars is returned verbatim (trimmed)", async () => {
    const abortController = new AbortController();
    const handle = genTitle({
      abortSignal: abortController.signal,
      models: [() => makeFailingModel(new Error("boom"))],
      userMessage: "  hi  ",
    });
    handle.finish();
    const result = await handle.promise;
    expect(result).toBe("hi");
  });

  test("user message exactly 32 chars is returned verbatim", async () => {
    const abortController = new AbortController();
    const handle = genTitle({
      abortSignal: abortController.signal,
      models: [() => makeFailingModel(new Error("boom"))],
      userMessage: "01234567890123456789012345678901",
    });
    handle.finish();
    const result = await handle.promise;
    expect(result).toBe("01234567890123456789012345678901");
  });

  test("empty user message falls back to 'New chat'", async () => {
    const abortController = new AbortController();
    const handle = genTitle({
      abortSignal: abortController.signal,
      models: [() => makeFailingModel(new Error("boom"))],
      userMessage: "",
    });
    handle.finish();
    const result = await handle.promise;
    expect(result).toBe("New chat");
  });

  test("user message of only punctuation falls back to 'New chat'", async () => {
    const abortController = new AbortController();
    const handle = genTitle({
      abortSignal: abortController.signal,
      models: [() => makeFailingModel(new Error("boom"))],
      userMessage: "!?!?.....",
    });
    handle.finish();
    const result = await handle.promise;
    expect(result).toBe("New chat");
  });

  test("missing abortSignal does not throw and still produces a fallback", async () => {
    // Repro for the desktop/pull crash: the serialized wire input cannot carry
    // a (non-serializable) AbortSignal, so genTitle may be called with
    // `abortSignal: undefined`. It must degrade to "no parent abort wiring"
    // instead of throwing `addEventListener of undefined`.
    const handle = genTitle({
      abortSignal: undefined,
      models: [() => makeFailingModel(new Error("boom"))],
      userMessage: "Fix the login button on mobile devices please",
    });
    handle.finish();
    const result = await handle.promise;
    expect(result).toBe("Fix the login button on mobile d");
  });

  test("parent abort resolves to null (no fallback emitted)", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const handle = genTitle({
      abortSignal: abortController.signal,
      models: [
        () =>
          makeFailingModel(
            Object.assign(new Error("aborted"), { name: "AbortError" }),
          ),
      ],
      userMessage: "anything at all",
    });
    handle.finish();
    const result = await handle.promise;
    expect(result).toBeNull();
  });
});
