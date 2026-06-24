import { describe, expect, test } from "bun:test";
import type { DecopilotHttpMcpSource } from "../../sources";
import { createMcpBackgroundDispatcher } from "./mcp-background-dispatcher";

const source: DecopilotHttpMcpSource = {
  kind: "http",
  url: "https://x/api/acme/mcp/self",
  headers: { Authorization: "Bearer t", "x-org-id": "org_1" },
  expiresAt: Date.now() + 60_000,
};

const snapshot = {
  agentId: "agent_1",
  temperature: 0.5,
  toolApprovalLevel: "auto",
  branch: null,
};

function dispatcherWith(
  callTool: (args: unknown) => Promise<unknown>,
  closed: { value: boolean },
) {
  return createMcpBackgroundDispatcher({
    source,
    threadId: "thread_1",
    fenceToken: "fence_1",
    snapshot,
    openHttp: async () => ({
      client: { callTool } as never,
      close: async () => {
        closed.value = true;
      },
    }),
  });
}

describe("createMcpBackgroundDispatcher", () => {
  test("calls THREAD_BACKGROUND_TOOL_START with fence + snapshot and returns jobId", async () => {
    let received: { name: string; arguments: Record<string, unknown> } | null =
      null;
    const closed = { value: false };
    const d = dispatcherWith(async (args) => {
      received = args as never;
      return { structuredContent: { jobId: "job-1" } };
    }, closed);

    const out = await d.start({
      toolName: "generate_image",
      input: { prompt: "a cat" },
      toolCallId: "call-1",
    });

    expect(out).toEqual({ jobId: "job-1" });
    expect(received!.name).toBe("THREAD_BACKGROUND_TOOL_START");
    expect(received!.arguments).toEqual({
      threadId: "thread_1",
      fenceToken: "fence_1",
      toolName: "generate_image",
      input: { prompt: "a cat" },
      toolCallId: "call-1",
      ...snapshot,
    });
    expect(closed.value).toBe(true);
  });

  test("throws on tool error and still closes the client", async () => {
    const closed = { value: false };
    const d = dispatcherWith(
      async () => ({
        isError: true,
        content: [{ type: "text", text: "fenced" }],
      }),
      closed,
    );
    await expect(
      d.start({ toolName: "generate_image", input: {}, toolCallId: "c" }),
    ).rejects.toThrow("fenced");
    expect(closed.value).toBe(true);
  });

  test("throws when no jobId is returned", async () => {
    const closed = { value: false };
    const d = dispatcherWith(async () => ({ structuredContent: {} }), closed);
    await expect(
      d.start({ toolName: "generate_image", input: {}, toolCallId: "c" }),
    ).rejects.toThrow("no jobId");
    expect(closed.value).toBe(true);
  });
});
