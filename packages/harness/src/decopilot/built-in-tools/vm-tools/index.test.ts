import { describe, expect, test } from "bun:test";
import type { SandboxFsHooks } from "./sandbox-fs-hooks-types";
import { createVmTools } from "./index";

/**
 * Build a `SandboxFsHooks` stub whose `onProxy` records the last daemon path
 * and returns a canned response keyed by path. The richer fs ops delegate to
 * the same recorder so a single fixture covers every vm tool.
 */
function fakeFs(
  respond: (path: string, body: Record<string, unknown>) => unknown,
): { fs: SandboxFsHooks; calls: Array<{ path: string; body: unknown }> } {
  const calls: Array<{ path: string; body: unknown }> = [];
  const onProxy = async (
    path: string,
    body: Record<string, unknown>,
  ): Promise<unknown> => {
    calls.push({ path, body });
    return respond(path, body);
  };
  const fs: SandboxFsHooks = {
    onProxy,
    onRead: async (path) =>
      ((await onProxy("/_sandbox/read", { path })) as { content: string })
        .content,
    onWrite: async (path, content) => {
      await onProxy("/_sandbox/write", { path, content });
    },
    onEdit: async () => {},
    onBash: async (command) =>
      (await onProxy("/_sandbox/bash", { command })) as {
        stdout: string;
        stderr: string;
        exitCode: number;
      },
    onGlob: async (pattern) =>
      ((await onProxy("/_sandbox/glob", { pattern })) as { files: string[] })
        .files,
    onGrep: async () => [],
  };
  return { fs, calls };
}

describe("createVmTools", () => {
  test("read tool delegates to fs (no SandboxProvider)", async () => {
    const { fs, calls } = fakeFs(() => ({
      kind: "text",
      content: "hello world",
      lineCount: 1,
    }));
    const tools = createVmTools({
      fs,
      toolOutputMap: new Map(),
      needsApproval: false,
      pendingImages: [],
      ctx: { baseUrl: "https://x", objectStorage: null, organization: null },
      threadId: "t1",
      virtualMcpId: "agent-1",
    });
    const out = (await tools.read.execute!({ path: "/app/x.ts" }, {
      toolCallId: "tc1",
    } as never)) as { content?: string };
    expect(calls[0]?.path).toBe("/_sandbox/read");
    expect(out.content).toBe("hello world");
  });

  test("read tool queues images via pendingImages", async () => {
    const { fs } = fakeFs(() => ({
      kind: "image",
      mediaType: "image/png",
      base64: "AAAA",
      size: 3,
    }));
    const pendingImages: Array<{ url: string; mediaType: string }> = [];
    const tools = createVmTools({
      fs,
      toolOutputMap: new Map(),
      needsApproval: false,
      pendingImages: pendingImages as never,
      ctx: { baseUrl: "https://x", objectStorage: null, organization: null },
      threadId: "t1",
      virtualMcpId: "agent-1",
    });
    const out = (await tools.read.execute!({ path: "/app/pic.png" }, {
      toolCallId: "tc2",
    } as never)) as { kind?: string };
    expect(out.kind).toBe("image");
    expect(pendingImages).toHaveLength(1);
    expect(pendingImages[0]?.mediaType).toBe("image/png");
  });
});
