import { describe, expect, it } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AgentLoopPendingImage } from "./agent-loop-state";
import { attachToolResultImages, toolsFromMCP } from "./mcp-tools";

const png = (bytes: number) => "A".repeat(Math.ceil((bytes * 4) / 3));

describe("attachToolResultImages", () => {
  it("queues images and leaves a text placeholder", () => {
    const queue: AgentLoopPendingImage[] = [];
    const out = attachToolResultImages(
      [
        { type: "image", data: png(2048), mimeType: "image/png" },
        { type: "text", text: "outline" },
      ],
      "get_design_context",
      queue,
    );
    expect(out).toEqual([
      { type: "text", text: "[image/png image, 2 KB, attached below]" },
      { type: "text", text: "outline" },
    ]);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.url.startsWith("data:image/png;base64,AAAA")).toBe(true);
    expect(queue[0]?.label).toBe("[Image returned by get_design_context]");
  });

  it("describes images when there is no queue or they are too large", () => {
    const queue: AgentLoopPendingImage[] = [];
    const big = attachToolResultImages(
      [{ type: "image", data: png(4_000_000), mimeType: "image/png" }],
      "t",
      queue,
    );
    const noQueue = attachToolResultImages(
      [{ type: "image", data: png(1024), mimeType: "image/jpeg" }],
      "t",
    );
    expect(queue).toHaveLength(0);
    expect(big[0]).toEqual({
      type: "text",
      text: "[image/png image, 3906 KB, not shown to the model]",
    });
    expect(noQueue[0]).toEqual({
      type: "text",
      text: "[image/jpeg image, 1 KB, not shown to the model]",
    });
  });
});

describe("toolsFromMCP image results", () => {
  const client = {
    listTools: async () => ({
      tools: [
        { name: "shot", inputSchema: { type: "object", properties: {} } },
      ],
    }),
  } as unknown as Client;

  // ~400 KB of base64: well above the 32k-token truncation cap as text.
  const result: CallToolResult = {
    content: [
      { type: "image", data: png(300_000), mimeType: "image/png" },
      { type: "text", text: "FRAME Card 320x200" },
    ],
  };

  it("sends the text to the model, queues the image once, and does not truncate on base64", async () => {
    const pendingImages: AgentLoopPendingImage[] = [];
    const { tools } = await toolsFromMCP(client, new Map(), undefined, "auto", {
      pendingImages,
    });
    // biome-ignore lint/suspicious/noExplicitAny: exercising the AI SDK hook directly
    const toModelOutput = (tools.shot as any).toModelOutput;
    const first = await toModelOutput({
      output: result,
      toolCallId: "c1",
      input: {},
    });
    const again = await toModelOutput({
      output: result,
      toolCallId: "c1",
      input: {},
    });

    expect(first).toEqual({
      type: "text",
      value: "[image/png image, 293 KB, attached below]\nFRAME Card 320x200",
    });
    expect(again).toEqual(first);
    expect(pendingImages).toHaveLength(1);
    // The original result (what the UI renders) is untouched.
    expect(result.content[0]?.type).toBe("image");
  });
});
