import { describe, expect, test } from "bun:test";
import { createInspectPageTool } from "./inspect-page";

const writer = { write: () => {} } as never;

describe("createInspectPageTool", () => {
  test("caps an oversized browserless error body instead of embedding it whole", async () => {
    const originalFetch = globalThis.fetch;
    const hugeBody = "x".repeat(50_000);
    globalThis.fetch = (async () =>
      new Response(hugeBody, { status: 502 })) as never;
    try {
      const tool = createInspectPageTool(writer, {
        browserless: { baseUrl: "https://bl.example", token: "t" },
        objectStorage: { put: async () => ({ key: "k" }) } as never,
        toolOutputMap: new Map(),
      });
      const result = (await tool.execute!({ url: "https://example.com" }, {
        toolCallId: "tc1",
      } as never)) as { success: boolean; error: string };
      expect(result.success).toBe(false);
      expect(result.error.length).toBeLessThan(600);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
