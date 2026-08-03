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
});
