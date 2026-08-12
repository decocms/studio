/**
 * A stalled Gemini Interactions connection must never hang the harness run
 * forever — `opts.abortSignal` only covers user/run cancellation, not a dead
 * connection to Google, so each call needs its own timeout.
 */
import { describe, expect, it } from "bun:test";
import { pollInteraction, submitInteraction } from "./gemini-interactions";

function stubTimeoutFetch() {
  return (async () => {
    const err = new Error("The operation was aborted");
    err.name = "TimeoutError";
    throw err;
  }) as unknown as typeof fetch;
}

describe("submitInteraction", () => {
  it("times out instead of hanging forever on an unresponsive endpoint", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubTimeoutFetch();
    try {
      await expect(
        submitInteraction({ apiKey: "key", agent: "agent", query: "q" }),
      ).rejects.toThrow(/timed out/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("pollInteraction", () => {
  it("times out instead of hanging forever on an unresponsive endpoint", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubTimeoutFetch();
    try {
      await expect(
        pollInteraction({ apiKey: "key", interactionId: "id-1" }),
      ).rejects.toThrow(/timed out/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
