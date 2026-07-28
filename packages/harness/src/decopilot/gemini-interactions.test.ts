import { describe, expect, test } from "bun:test";
import { pollInteraction } from "./gemini-interactions";

describe("pollInteraction", () => {
  test("rejects with an Error named AbortError when aborted mid-poll", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    globalThis.fetch = (async () => {
      // Abort right after the first poll response comes back, so the loop's
      // next `sleep` is what has to reject.
      controller.abort();
      return new Response(
        JSON.stringify({ status: "in_progress", steps: [] }),
        {
          status: 200,
        },
      );
    }) as never;

    try {
      let caught: unknown;
      try {
        await pollInteraction({
          apiKey: "k",
          interactionId: "i1",
          abortSignal: controller.signal,
          pollIntervalMs: 10,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).name).toBe("AbortError");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
