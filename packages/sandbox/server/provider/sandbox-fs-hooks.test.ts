import { describe, expect, test } from "bun:test";
import type { SandboxProvider } from "./types";
import { createSandboxFsHooks } from "./sandbox-fs-hooks";

/**
 * A minimal fake `SandboxProvider` that only implements `proxyDaemonRequest`
 * (the sole surface the fs hooks build on). `captured` records the last
 * `(path, body)` so tests can assert the wire translation, and `response`
 * lets each test choose the daemon's JSON reply.
 */
function fakeProvider(
  captured: { path?: string; body?: unknown },
  response: unknown,
  init?: { status?: number },
): SandboxProvider {
  return {
    kind: "agent-sandbox",
    proxyDaemonRequest: async (
      _handle: string,
      path: string,
      reqInit: { body: BodyInit | null },
    ) => {
      captured.path = path;
      captured.body = reqInit.body ? JSON.parse(reqInit.body as string) : null;
      return new Response(JSON.stringify(response), {
        status: init?.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  } as unknown as SandboxProvider;
}

const lifecycle = {
  ensureHandle: async () => "handle-1",
  invalidateHandle: async () => {},
  canAutoRestart: false,
};

describe("createSandboxFsHooks", () => {
  test("onRead proxies /_sandbox/read and returns content", async () => {
    const captured: { path?: string; body?: unknown } = {};
    const hooks = createSandboxFsHooks(
      fakeProvider(captured, {
        kind: "text",
        content: "file body",
        lineCount: 1,
      }),
      lifecycle,
    );
    const out = await hooks.onRead("/app/x.ts");
    expect(captured.path).toBe("/_sandbox/read");
    expect(captured.body).toEqual({ path: "/app/x.ts" });
    expect(out).toBe("file body");
  });

  test("onWrite proxies /_sandbox/write with path + content", async () => {
    const captured: { path?: string; body?: unknown } = {};
    const hooks = createSandboxFsHooks(
      fakeProvider(captured, { ok: true, bytesWritten: 2 }),
      lifecycle,
    );
    await hooks.onWrite("/app/y.ts", "hi");
    expect(captured.path).toBe("/_sandbox/write");
    expect(captured.body).toEqual({ path: "/app/y.ts", content: "hi" });
  });

  test("onEdit maps edits to the daemon's snake_case edit surface", async () => {
    const captured: { path?: string; body?: unknown } = {};
    const hooks = createSandboxFsHooks(
      fakeProvider(captured, { ok: true, replacements: 1, content: "new" }),
      lifecycle,
    );
    await hooks.onEdit("/app/z.ts", [
      { oldText: "a", newText: "b", replaceAll: true },
    ]);
    expect(captured.path).toBe("/_sandbox/edit");
    expect(captured.body).toEqual({
      path: "/app/z.ts",
      old_string: "a",
      new_string: "b",
      replace_all: true,
    });
  });

  test("onBash proxies /_sandbox/bash and returns the result triple", async () => {
    const captured: { path?: string; body?: unknown } = {};
    const hooks = createSandboxFsHooks(
      fakeProvider(captured, { stdout: "ok", stderr: "", exitCode: 0 }),
      lifecycle,
    );
    const r = await hooks.onBash("echo ok", { cwd: "/app", timeoutMs: 1000 });
    expect(captured.path).toBe("/_sandbox/bash");
    expect(captured.body).toEqual({
      command: "echo ok",
      cwd: "/app",
      timeout: 1000,
    });
    expect(r).toEqual({ stdout: "ok", stderr: "", exitCode: 0 });
  });

  test("onGlob proxies /_sandbox/glob and returns the files list", async () => {
    const captured: { path?: string; body?: unknown } = {};
    const hooks = createSandboxFsHooks(
      fakeProvider(captured, { files: ["a.ts", "b.ts"] }),
      lifecycle,
    );
    const files = await hooks.onGlob("**/*.ts");
    expect(captured.path).toBe("/_sandbox/glob");
    expect(captured.body).toEqual({ pattern: "**/*.ts" });
    expect(files).toEqual(["a.ts", "b.ts"]);
  });

  test("onGrep proxies /_sandbox/grep and parses results into hits", async () => {
    const captured: { path?: string; body?: unknown } = {};
    const hooks = createSandboxFsHooks(
      fakeProvider(captured, {
        results: "a.ts:3:hello\nb.ts:7:hello",
        matchCount: 2,
      }),
      lifecycle,
    );
    const hits = await hooks.onGrep("hello", { glob: "*.ts" });
    expect(captured.path).toBe("/_sandbox/grep");
    expect(captured.body).toEqual({
      pattern: "hello",
      glob: "*.ts",
      output_mode: "content",
    });
    expect(hits).toEqual([
      { file: "a.ts", line: 3, text: "hello" },
      { file: "b.ts", line: 7, text: "hello" },
    ]);
  });

  test("retries once on daemon-unreachable when canAutoRestart is true", async () => {
    let attempts = 0;
    let invalidated = 0;
    const provider = {
      kind: "agent-sandbox",
      proxyDaemonRequest: async () => {
        attempts++;
        if (attempts === 1) throw new Error("connection refused");
        return new Response(
          JSON.stringify({ kind: "text", content: "ok", lineCount: 1 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    } as unknown as SandboxProvider;
    const hooks = createSandboxFsHooks(provider, {
      ensureHandle: async () => "h",
      invalidateHandle: async () => {
        invalidated++;
      },
      canAutoRestart: true,
    });
    const out = await hooks.onRead("/app/x.ts");
    expect(out).toBe("ok");
    expect(attempts).toBe(2);
    expect(invalidated).toBe(1);
  });
});
