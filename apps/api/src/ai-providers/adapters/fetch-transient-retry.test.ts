import { describe, expect, it, mock } from "bun:test";
import { fetchWithTransientRetry } from "./fetch-transient-retry";

describe("fetchWithTransientRetry", () => {
  it("retries a thrown fetch error (network blip) and returns the eventual success", async () => {
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() => {
      calls++;
      if (calls < 2) throw new TypeError("fetch failed");
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as unknown as typeof fetch;

    try {
      const res = await fetchWithTransientRetry(
        "test",
        "https://example.com",
        {},
      );
      expect(res.status).toBe(200);
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("gives up after maxAttempts and surfaces the original error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    try {
      await expect(
        fetchWithTransientRetry("test", "https://example.com", {}),
      ).rejects.toThrow("fetch failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
