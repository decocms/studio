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

describe("genTitle fallback", () => {
  test("when the LLM throws, falls back to userMessage.slice(0, 10).trim()", async () => {
    const abortController = new AbortController();
    const handle = genTitle({
      abortSignal: abortController.signal,
      model: makeFailingModel(new Error("provider boom")),
      userMessage: "Fix the login button on mobile devices please",
    });
    handle.finish();
    const result = await handle.promise;
    // First 10 chars of "Fix the login button on mobile devices please"
    // are "Fix the lo"; trimmed.
    expect(result).toBe("Fix the lo");
  });

  test("user message under 10 chars is returned verbatim (trimmed)", async () => {
    const abortController = new AbortController();
    const handle = genTitle({
      abortSignal: abortController.signal,
      model: makeFailingModel(new Error("boom")),
      userMessage: "  hi  ",
    });
    handle.finish();
    const result = await handle.promise;
    expect(result).toBe("hi");
  });

  test("user message exactly 10 chars is returned verbatim", async () => {
    const abortController = new AbortController();
    const handle = genTitle({
      abortSignal: abortController.signal,
      model: makeFailingModel(new Error("boom")),
      userMessage: "0123456789",
    });
    handle.finish();
    const result = await handle.promise;
    expect(result).toBe("0123456789");
  });

  test("empty user message falls back to 'New chat'", async () => {
    const abortController = new AbortController();
    const handle = genTitle({
      abortSignal: abortController.signal,
      model: makeFailingModel(new Error("boom")),
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
      model: makeFailingModel(new Error("boom")),
      userMessage: "!?!?.....",
    });
    handle.finish();
    const result = await handle.promise;
    expect(result).toBe("New chat");
  });

  test("parent abort resolves to null (no fallback emitted)", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const handle = genTitle({
      abortSignal: abortController.signal,
      model: makeFailingModel(
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      ),
      userMessage: "anything at all",
    });
    handle.finish();
    const result = await handle.promise;
    expect(result).toBeNull();
  });
});
