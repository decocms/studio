import { describe, expect, test } from "bun:test";
import type { SandboxFsHooks } from "./sandbox-fs-hooks-types";
import { createVmTools } from "./index";

/**
 * Build a `SandboxFsHooks` stub whose `onProxy` records the last daemon path
 * and returns a canned response keyed by path.
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
    onBash: async (command) =>
      (await onProxy("/_sandbox/bash", { command })) as {
        stdout: string;
        stderr: string;
        exitCode: number;
      },
  };
  return { fs, calls };
}

describe("createVmTools", () => {
  test("read tool delegates to the filesystem hooks", async () => {
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
    });
    const out = (await tools.read.execute!({ path: "/app/pic.png" }, {
      toolCallId: "tc2",
    } as never)) as { kind?: string };
    expect(out.kind).toBe("image");
    expect(pendingImages).toHaveLength(1);
    expect(pendingImages[0]?.mediaType).toBe("image/png");
  });
});
