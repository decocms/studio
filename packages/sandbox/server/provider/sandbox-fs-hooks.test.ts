import { describe, expect, test } from "bun:test";
import type { SandboxProvider } from "./types";
import { createSandboxFsHooks, opDeadlineMs } from "./sandbox-fs-hooks";

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

  test("a daemon op that never responds fails at the op deadline — without reaping the sandbox", async () => {
    // The silent-hang regression: a wedged daemon (stalled org-fs mount) left
    // the harness awaiting forever with no chunks, so the 10-min liveness
    // reaper killed an otherwise healthy run. The op deadline converts the
    // wedge into a tool error the model can react to. It must NOT be treated
    // as daemon-unreachable — that path reaps + re-provisions the sandbox.
    let invalidated = 0;
    const provider = {
      kind: "agent-sandbox",
      proxyDaemonRequest: () => new Promise<Response>(() => {}), // never settles
    } as unknown as SandboxProvider;
    const hooks = createSandboxFsHooks(provider, {
      ensureHandle: async () => "h",
      invalidateHandle: async () => {
        invalidated++;
      },
      canAutoRestart: true,
      opTimeoutMs: 30,
    });
    await expect(hooks.onRead("/app/x.ts")).rejects.toThrow(/timed out after/);
    expect(invalidated).toBe(0);
  });

  test("op deadline follows the op's own budget: 45s default, budget+grace, clamped at the daemon cap", () => {
    // No budget (read/write/edit/grep/glob): daemon default 30s + 15s grace.
    expect(opDeadlineMs({ path: "/x" })).toBe(45_000);
    // Bash with an explicit budget: budget + grace.
    expect(opDeadlineMs({ command: "x", timeout: 60_000 })).toBe(75_000);
    // Budget above the daemon's 120s clamp doesn't inflate the deadline; the
    // deadline stays ABOVE the cap so a command the daemon kills at 120s still
    // delivers its stdout/stderr instead of losing the race to the client abort.
    expect(opDeadlineMs({ command: "x", timeout: 999_000 })).toBe(135_000);
  });

  test("cancelling the run aborts the in-flight op — no timeout wait, no restart retry", async () => {
    let invalidated = 0;
    let sawSignal: AbortSignal | undefined;
    const provider = {
      kind: "agent-sandbox",
      proxyDaemonRequest: (
        _handle: string,
        _path: string,
        init: { signal?: AbortSignal },
      ) => {
        sawSignal = init.signal;
        return new Promise<Response>(() => {}); // never settles on its own
      },
    } as unknown as SandboxProvider;
    const hooks = createSandboxFsHooks(provider, {
      ensureHandle: async () => "h",
      invalidateHandle: async () => {
        invalidated++;
      },
      canAutoRestart: true,
      opTimeoutMs: 60_000,
    });
    const runAbort = new AbortController();
    const pending = hooks.onProxy(
      "/_sandbox/bash",
      { command: "sleep 999" },
      "POST",
      runAbort.signal,
    );
    runAbort.abort(new Error("run cancelled"));
    await expect(pending).rejects.toThrow("run cancelled");
    expect(invalidated).toBe(0);
    // The composed signal reaches the transport so honoring providers can
    // tear down the underlying request too.
    expect(sawSignal?.aborted).toBe(true);
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

  test("respawns on 404 sandbox-not-found even when canAutoRestart is false", async () => {
    // A reaped sandbox (worker eviction / housekeeper GC dropped it mid-run) is
    // provably gone — never a user pause — so even a persistent branch recovers
    // instead of surfacing a sticky failure. `force` must reach invalidateHandle
    // so the map entry is reaped, not just the memoised handle cleared.
    let attempts = 0;
    let forced: boolean | undefined;
    const provider = {
      kind: "agent-sandbox",
      proxyDaemonRequest: async () => {
        attempts++;
        if (attempts === 1) {
          return new Response(JSON.stringify({ error: "sandbox not found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({ kind: "text", content: "recovered", lineCount: 1 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    } as unknown as SandboxProvider;
    const hooks = createSandboxFsHooks(provider, {
      ensureHandle: async () => "h",
      invalidateHandle: async (opts) => {
        forced = opts?.force;
      },
      canAutoRestart: false,
    });
    const out = await hooks.onRead("/app/x.ts");
    expect(out).toBe("recovered");
    expect(attempts).toBe(2);
    expect(forced).toBe(true);
  });

  test("does NOT respawn on an ambiguous connect failure when canAutoRestart is false", async () => {
    // A transport throw (not a 404) could be a transient blip on a still-live
    // persistent sandbox — reaping would abandon its working tree — so the
    // conservative branch surfaces the sticky failure without a retry.
    let attempts = 0;
    let invalidated = 0;
    const provider = {
      kind: "agent-sandbox",
      proxyDaemonRequest: async () => {
        attempts++;
        throw new Error("connection refused");
      },
    } as unknown as SandboxProvider;
    const hooks = createSandboxFsHooks(provider, {
      ensureHandle: async () => "h",
      invalidateHandle: async () => {
        invalidated++;
      },
      canAutoRestart: false,
    });
    await expect(hooks.onRead("/app/x.ts")).rejects.toThrow(/not running/);
    expect(attempts).toBe(1);
    expect(invalidated).toBe(0);
  });
});
