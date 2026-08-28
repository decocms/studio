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

  it("registers the portable image tool when its dependencies exist", () => {
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
      imageTool: {
        provider: { aiSdk: { imageModel: () => ({}) as never } },
        imageModelInfo: { id: "image-model-1" },
      },
    });

    expect("generate_image" in tools).toBe(true);
  });

  // Inverts the assertions this file used to make: BROWSERLESS_TOKEN registered
  // take_screenshot / scrape_url / inspect_page here. The browser now lives in
  // the sandbox image (`qa-screenshot`), reached over `bash`, so no env var
  // conjures a browser tool into the hosted vocabulary any more.
  it("registers no browser tools, with or without BROWSERLESS_TOKEN", () => {
    const original = process.env.BROWSERLESS_TOKEN;
    process.env.BROWSERLESS_TOKEN = "browserless-test-token";
    try {
      const tools = buildPortableBuiltInTools({
        writer,
        toolOutputMap: new Map(),
        passthroughClient,
        toolApprovalLevel: "auto",
        isPlanMode: false,
        objectStorage: { put: async (key: string) => ({ key }) },
      });

      expect("take_screenshot" in tools).toBe(false);
      expect("scrape_url" in tools).toBe(false);
      expect("inspect_page" in tools).toBe(false);
    } finally {
      if (original === undefined) delete process.env.BROWSERLESS_TOKEN;
      else process.env.BROWSERLESS_TOKEN = original;
    }
  });
});
