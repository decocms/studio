import { describe, expect, it } from "bun:test";
import { buildPortableBuiltInTools } from "./portable-built-ins";

const writer = {
  write: () => {},
  merge: async () => {},
  onError: () => {},
} as never;

const passthroughClient = {
  readResource: async () => ({ contents: [] }),
  getPrompt: async () => ({ messages: [] }),
  listTools: async () => ({ tools: [] }),
  callTool: async () => ({ content: [] }),
  listResources: async () => ({ resources: [] }),
  listPrompts: async () => ({ prompts: [] }),
} as never;

describe("buildPortableBuiltInTools", () => {
  it("builds the common Decopilot tool vocabulary without cluster context", () => {
    const tools = buildPortableBuiltInTools({
      writer,
      toolOutputMap: new Map(),
      passthroughClient,
      toolApprovalLevel: "auto",
      isPlanMode: false,
    });

    expect(Object.keys(tools).sort()).toEqual([
      "propose_plan",
      "read_tool_output",
      "todo_write",
      "user_ask",
    ]);
  });

  it("registers portable image and screenshot tools when their dependencies exist", () => {
    const originalBrowserlessToken = process.env.BROWSERLESS_TOKEN;
    process.env.BROWSERLESS_TOKEN = "browserless-test-token";

    try {
      const tools = buildPortableBuiltInTools({
        writer,
        toolOutputMap: new Map(),
        passthroughClient,
        toolApprovalLevel: "auto",
        isPlanMode: false,
        objectStorage: {
          put: async (key: string) => ({ key }),
          presignedGetUrl: async (key: string) =>
            `https://storage.example.com/${key}`,
        },
        pendingImages: [],
        imageTool: {
          provider: {
            aiSdk: {
              imageModel: () => ({}) as never,
            },
          },
          imageModelInfo: { id: "image-model-1" },
        },
      });

      expect("generate_image" in tools).toBe(true);
      expect("take_screenshot" in tools).toBe(true);
    } finally {
      if (originalBrowserlessToken === undefined) {
        delete process.env.BROWSERLESS_TOKEN;
      } else {
        process.env.BROWSERLESS_TOKEN = originalBrowserlessToken;
      }
    }
  });

  it("offloads large portable scrape results to object storage", async () => {
    const originalBrowserlessToken = process.env.BROWSERLESS_TOKEN;
    const originalFetch = globalThis.fetch;
    process.env.BROWSERLESS_TOKEN = "browserless-test-token";

    const writes: Array<{
      key: string;
      contentType?: string;
      bodyBytes: number;
    }> = [];
    globalThis.fetch = (async () =>
      new Response("word ".repeat(40_000), {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;

    try {
      const tools = buildPortableBuiltInTools({
        writer,
        toolOutputMap: new Map(),
        passthroughClient,
        toolApprovalLevel: "auto",
        isPlanMode: false,
        objectStorage: {
          put: async (
            key: string,
            body: Uint8Array,
            options?: { contentType?: string },
          ) => {
            writes.push({
              key,
              bodyBytes: body.byteLength,
              contentType: options?.contentType,
            });
            return { key };
          },
        },
      });

      const scrape = tools.scrape_url as unknown as {
        execute: (
          input: { url: string },
          options: { toolCallId: string },
        ) => Promise<unknown>;
      };
      const result = (await scrape.execute(
        { url: "https://example.com" },
        { toolCallId: "tool-1" },
      )) as { success: boolean; uri?: string; content?: string };

      expect(result.success).toBe(true);
      expect(result.uri).toStartWith("studio-storage://scraped-pages/");
      expect(result.content).toBeUndefined();
      expect(writes).toHaveLength(1);
      expect(writes[0]?.contentType).toBe("text/html");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalBrowserlessToken === undefined) {
        delete process.env.BROWSERLESS_TOKEN;
      } else {
        process.env.BROWSERLESS_TOKEN = originalBrowserlessToken;
      }
    }
  });

  it("returns a graceful error instead of throwing when the browserless fetch aborts", async () => {
    const originalBrowserlessToken = process.env.BROWSERLESS_TOKEN;
    const originalFetch = globalThis.fetch;
    process.env.BROWSERLESS_TOKEN = "browserless-test-token";

    globalThis.fetch = (async () => {
      const err = new Error("The operation was aborted");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch;

    try {
      const tools = buildPortableBuiltInTools({
        writer,
        toolOutputMap: new Map(),
        passthroughClient,
        toolApprovalLevel: "auto",
        isPlanMode: false,
      });

      const scrape = tools.scrape_url as unknown as {
        execute: (
          input: { url: string },
          options: { toolCallId: string },
        ) => Promise<unknown>;
      };
      const result = (await scrape.execute(
        { url: "https://example.com" },
        { toolCallId: "tool-1" },
      )) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain("timed out");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalBrowserlessToken === undefined) {
        delete process.env.BROWSERLESS_TOKEN;
      } else {
        process.env.BROWSERLESS_TOKEN = originalBrowserlessToken;
      }
    }
  });
});
