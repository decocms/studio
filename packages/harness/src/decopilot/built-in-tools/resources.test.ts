import { describe, expect, test } from "bun:test";
import { createReadResourceTool } from "./resources";

const passthroughClient = {
  readResource: async () => ({ contents: [] }),
} as never;

describe("createReadResourceTool", () => {
  test("resolves mesh-storage URIs via objectStorage hook (no ctx)", async () => {
    const tool = createReadResourceTool({
      passthroughClient,
      toolOutputMap: new Map(),
      objectStorage: {
        getBytesOrPresign: async () => ({
          content: "hello",
          contentType: "text/markdown",
          encoding: "utf-8",
          size: 5,
        }),
      } as never,
    });
    const result = (await tool.execute!(
      { uri: "mesh-storage://web-search/x.md" },
      { toolCallId: "tc1" } as never,
    )) as { contents?: Array<{ text: string }> };
    expect(result.contents?.[0]?.text).toBe("hello");
  });
});
