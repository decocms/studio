import { describe, expect, it } from "bun:test";
import type { SandboxProvider } from "../server/provider";
import { buildLocalTools } from "@decocms/harness/decopilot/desktop-local-tools";
import {
  buildDesktopSandboxFs,
  createDesktopLocalSandboxProvider,
} from "./desktop-sandbox-fs";

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

function fakeRunner(
  calls: Array<{
    kind: "ensure" | "proxy";
    handle?: string;
    path?: string;
    body?: string | null;
  }>,
) {
  return {
    kind: "user-desktop",
    ensure: async () => {
      calls.push({ kind: "ensure" });
      return { handle: "ensured-local", workdir: "/", previewUrl: null };
    },
    delete: async () => {},
    alive: async () => true,
    getPreviewUrl: async () => null,
    watchClaimLifecycle: async function* () {
      yield { kind: "ready" as const };
    },
    proxyDaemonRequest: async (handle, path, init) => {
      calls.push({
        kind: "proxy",
        handle,
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
    const calls: Array<{
      kind: "ensure" | "proxy";
      handle?: string;
      path?: string;
      body?: string | null;
    }> = [];
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
      // fs is now injected (built by the desktop glue) — drive it through the
      // fake runner so the ensure→proxy sequence assertions below still hold.
      fs: buildDesktopSandboxFs({
        runner: fakeRunner(calls),
        virtualMcpId: "agent-1",
        userId: "user-1",
      }),
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
        kind: "ensure",
      },
      {
        kind: "proxy",
        handle: "ensured-local",
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

describe("createDesktopLocalSandboxProvider", () => {
  it("provisions through the local control URL when configured", async () => {
    const originalControlUrl = process.env.DESKTOP_SANDBOX_CONTROL_URL;
    const originalHandle = process.env.SANDBOX_HANDLE;
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method: string; body?: string | null }> =
      [];

    process.env.DESKTOP_SANDBOX_CONTROL_URL = "http://127.0.0.1:7777";
    process.env.SANDBOX_HANDLE = "handle-1";
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : null,
      });
      if (String(input).endsWith("/api/sandboxes")) {
        return Response.json({
          sandboxApiUrl: "http://127.0.0.1:9999",
          previewUrl: "http://handle-1.localhost:7070",
        });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    try {
      const provider = createDesktopLocalSandboxProvider();
      const sandbox = await provider.ensure({
        userId: "user-1",
        projectRef: "agent-1",
      });
      await provider.proxyDaemonRequest("handle-1", "/_sandbox/read", {
        method: "POST",
        headers: new Headers({ "content-type": "application/json" }),
        body: JSON.stringify({ path: "README.md" }),
      });

      expect(sandbox.handle).toBe("handle-1");
      expect(sandbox.workdir).toBe("http://127.0.0.1:9999");
      expect(calls).toEqual([
        {
          url: "http://127.0.0.1:7777/api/sandboxes",
          method: "POST",
          body: JSON.stringify({ handle: "handle-1" }),
        },
        {
          url: "http://127.0.0.1:7777/_sandbox/handle-1/read",
          method: "POST",
          body: JSON.stringify({ path: "README.md" }),
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalControlUrl === undefined) {
        delete process.env.DESKTOP_SANDBOX_CONTROL_URL;
      } else {
        process.env.DESKTOP_SANDBOX_CONTROL_URL = originalControlUrl;
      }
      if (originalHandle === undefined) {
        delete process.env.SANDBOX_HANDLE;
      } else {
        process.env.SANDBOX_HANDLE = originalHandle;
      }
    }
  });
});
