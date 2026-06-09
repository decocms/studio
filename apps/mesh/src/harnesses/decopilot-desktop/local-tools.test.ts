import { describe, expect, it } from "bun:test";
import type { SandboxProvider } from "@decocms/sandbox/provider";
import { buildLocalTools } from "./local-tools";

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

function fakeRunner(calls: Array<{ path: string; body: string | null }>) {
  return {
    kind: "user-desktop",
    ensure: async () => ({ handle: "local", workdir: "/", previewUrl: null }),
    delete: async () => {},
    alive: async () => true,
    getPreviewUrl: async () => null,
    watchClaimLifecycle: async function* () {
      yield { kind: "ready" as const };
    },
    proxyDaemonRequest: async (_handle, path, init) => {
      calls.push({
        path,
        body: typeof init.body === "string" ? init.body : null,
      });
      return Response.json({
        kind: "text",
        content: "1  hello\n",
        lineCount: 1,
      });
    },
  } satisfies SandboxProvider;
}

describe("buildLocalTools", () => {
  it("uses shared VM tools for desktop read/write/edit/grep/glob/bash", async () => {
    const calls: Array<{ path: string; body: string | null }> = [];
    const tools = buildLocalTools({
      writer,
      toolOutputMap: new Map(),
      passthroughClient,
      toolApprovalLevel: "auto",
      isPlanMode: false,
      ctx: {
        objectStorage: null,
        organization: { id: "org-1" },
        auth: { user: { id: "user-1" } },
      },
      pendingImages: [],
      threadId: "thread-1",
      virtualMcpId: "agent-1",
      runner: fakeRunner(calls),
    });

    expect(Object.keys(tools)).toContain("read");
    expect(Object.keys(tools)).toContain("write");
    expect(Object.keys(tools)).toContain("edit");
    expect(Object.keys(tools)).toContain("grep");
    expect(Object.keys(tools)).toContain("glob");
    expect(Object.keys(tools)).toContain("bash");

    const read = tools.read as unknown as {
      execute: (input: { path: string }) => Promise<unknown>;
    };
    const result = await read.execute({ path: "README.md" });

    expect(calls).toEqual([
      {
        path: "/_sandbox/read",
        body: JSON.stringify({ path: "README.md" }),
      },
    ]);
    expect(result).toEqual({
      kind: "text",
      content: "1  hello\n",
      lineCount: 1,
    });
  });
});
