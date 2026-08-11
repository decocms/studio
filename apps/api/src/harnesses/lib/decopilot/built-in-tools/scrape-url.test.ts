import { describe, expect, test } from "bun:test";
import { createScrapeUrlTool } from "./scrape-url";

const writer = { write: () => {} } as never;

describe("createScrapeUrlTool", () => {
  test("uses injected browserless token (not process.env)", async () => {
    const originalFetch = globalThis.fetch;
    let calledUrl = "";
    globalThis.fetch = (async (url: string) => {
      calledUrl = url;
      return new Response("<html>ok</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as never;
    const prevEnv = process.env.BROWSERLESS_TOKEN;
    delete process.env.BROWSERLESS_TOKEN; // prove we don't read it
    try {
      const tool = createScrapeUrlTool(writer, {
        browserless: { baseUrl: "https://bl.example", token: "INJECTED" },
        objectStorage: { put: async () => ({ key: "k" }) } as never,
        toolOutputMap: new Map(),
      });
      const result = (await tool.execute!({ url: "https://example.com" }, {
        toolCallId: "tc1",
      } as never)) as { success: boolean };
      expect(result.success).toBe(true);
      expect(calledUrl).toContain("https://bl.example/content");
      expect(calledUrl).toContain("token=INJECTED");
    } finally {
      globalThis.fetch = originalFetch;
      if (prevEnv === undefined) delete process.env.BROWSERLESS_TOKEN;
      else process.env.BROWSERLESS_TOKEN = prevEnv;
    }
  });

  test("bounds the browserless fetch with a timeout signal", async () => {
    const originalFetch = globalThis.fetch;
    let sawSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sawSignal = init?.signal ?? undefined;
      return new Response("<html>ok</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as never;
    try {
      const tool = createScrapeUrlTool(writer, {
        browserless: { baseUrl: "https://bl.example", token: "t" },
        objectStorage: { put: async () => ({ key: "k" }) } as never,
        toolOutputMap: new Map(),
      });
      await tool.execute!({ url: "https://example.com" }, {
        toolCallId: "tc2",
      } as never);
      expect(sawSignal).toBeInstanceOf(AbortSignal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reports a timeout instead of hanging when browserless never responds", async () => {
    // Simulates what fetch throws once AbortSignal.timeout fires, without
    // waiting for the real 45s — the fix is the try/catch mapping this to a
    // clear error, not the exact timer duration.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new DOMException("timed out", "TimeoutError");
    }) as never;
    try {
      const tool = createScrapeUrlTool(writer, {
        browserless: { baseUrl: "https://bl.example", token: "t" },
        objectStorage: { put: async () => ({ key: "k" }) } as never,
        toolOutputMap: new Map(),
      });
      const result = (await tool.execute!({ url: "https://example.com" }, {
        toolCallId: "tc3",
      } as never)) as { success: boolean; error: string };
      expect(result.success).toBe(false);
      expect(result.error).toContain("timed out");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("caps an oversized browserless error body instead of embedding it whole", async () => {
    const originalFetch = globalThis.fetch;
    const hugeBody = "x".repeat(50_000);
    globalThis.fetch = (async () =>
      new Response(hugeBody, { status: 502 })) as never;
    try {
      const tool = createScrapeUrlTool(writer, {
        browserless: { baseUrl: "https://bl.example", token: "t" },
        objectStorage: { put: async () => ({ key: "k" }) } as never,
        toolOutputMap: new Map(),
      });
      const result = (await tool.execute!({ url: "https://example.com" }, {
        toolCallId: "tc4",
      } as never)) as { success: boolean; error: string };
      expect(result.success).toBe(false);
      expect(result.error.length).toBeLessThan(600);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
