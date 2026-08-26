import { describe, expect, test } from "bun:test";
import { createSandboxFsHooks, opDeadlineMs } from "./sandbox-fs-hooks";

type SandboxFsProvider = Parameters<typeof createSandboxFsHooks>[0];

/**
 * A minimal fake of the two AgentSandboxProvider capabilities used by the fs
 * hooks. `captured` records the last `(path, body)` so tests can assert the
 * wire translation, and `response` lets each test choose the daemon's reply.
 */
function fakeProvider(
  captured: { path?: string; body?: unknown },
  response: unknown,
  init?: { status?: number },
): SandboxFsProvider {
  return {
    proxyDaemonRequest: async (_handle, path, reqInit) => {
      captured.path = path;
      captured.body = reqInit.body ? JSON.parse(reqInit.body as string) : null;
      return new Response(JSON.stringify(response), {
        status: init?.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
    renewTtl: async () => {},
  };
}

const lifecycle = {
  ensureHandle: async () => "handle-1",
  invalidateHandle: async () => {},
  canAutoRestart: false,
};

describe("claim TTL renewal", () => {
  test("renews on the first op, then throttles", async () => {
    const renewed: string[] = [];
    const provider: SandboxFsProvider = {
      proxyDaemonRequest: async () =>
        new Response(JSON.stringify({ ok: true, bytesWritten: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      renewTtl: async (handle) => {
        renewed.push(handle);
      },
    };

    const hooks = createSandboxFsHooks(provider, lifecycle);
    // Without this a hosted-harness run holds no claim at all and the operator
    // reaps the pod 15 minutes in, mid-run (prod thread 38147122, 2026-08-16).
    await hooks.onProxy("/_sandbox/write", {
      path: "/app/a.ts",
      content: "a",
    });
    await hooks.onProxy("/_sandbox/write", {
      path: "/app/b.ts",
      content: "b",
    });
    await hooks.onProxy("/_sandbox/write", {
      path: "/app/c.ts",
      content: "c",
    });
    expect(renewed).toEqual(["handle-1"]);
  });
});

describe("createSandboxFsHooks", () => {
  test("onProxy forwards the daemon path and body", async () => {
    const captured: { path?: string; body?: unknown } = {};
    const hooks = createSandboxFsHooks(
      fakeProvider(captured, {
        kind: "text",
        content: "file body",
        lineCount: 1,
      }),
      lifecycle,
    );
    const out = await hooks.onProxy("/_sandbox/read", { path: "/app/x.ts" });
    expect(captured.path).toBe("/_sandbox/read");
    expect(captured.body).toEqual({ path: "/app/x.ts" });
    expect(out).toEqual({
      kind: "text",
      content: "file body",
      lineCount: 1,
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

  test("stamps x-thread-id on every daemon call when the lifecycle carries a threadId", async () => {
    // The daemon's `linked()` middleware repoints `org/output` at the thread's
    // org-fs subtree keyed on this header. Without it, the fs write's MkdirAll
    // materializes `org/output` as a real dir on ephemeral disk and every
    // deliverable written there dies with the pod (silently: the write reports
    // success, the Library shows "no longer available").
    let sawThreadHeader: string | null = null;
    const provider: SandboxFsProvider = {
      proxyDaemonRequest: async (_handle, _path, init) => {
        sawThreadHeader = init.headers.get("x-thread-id");
        return new Response(JSON.stringify({ ok: true, bytesWritten: 2 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      renewTtl: async () => {},
    };
    const hooks = createSandboxFsHooks(provider, {
      ...lifecycle,
      threadId: "thread-42",
    });
    await hooks.onProxy("/_sandbox/write", {
      path: "org/output/plan.md",
      content: "hi",
    });
    expect(sawThreadHeader).toBe("thread-42" as never);

    // Without a threadId (e.g. a threadless probe) the header is absent.
    const bare = createSandboxFsHooks(provider, lifecycle);
    await bare.onProxy("/_sandbox/write", {
      path: "org/output/plan.md",
      content: "hi",
    });
    expect(sawThreadHeader).toBe(null);
  });

  test("a daemon op that never responds fails at the op deadline — without reaping the sandbox", async () => {
    // The silent-hang regression: a wedged daemon (stalled org-fs mount) left
    // the harness awaiting forever with no chunks, so the 10-min liveness
    // reaper killed an otherwise healthy run. The op deadline converts the
    // wedge into a tool error the model can react to. It must NOT be treated
    // as daemon-unreachable — that path reaps + re-provisions the sandbox.
    let invalidated = 0;
    const provider: SandboxFsProvider = {
      proxyDaemonRequest: () => new Promise<Response>(() => {}), // never settles
      renewTtl: async () => {},
    };
    const hooks = createSandboxFsHooks(provider, {
      ensureHandle: async () => "h",
      invalidateHandle: async () => {
        invalidated++;
      },
      canAutoRestart: true,
      opTimeoutMs: 30,
    });
    await expect(
      hooks.onProxy("/_sandbox/read", { path: "/app/x.ts" }),
    ).rejects.toThrow(/timed out after/);
    expect(invalidated).toBe(0);
  });

  test("op deadline follows the op's own budget: 45s default, budget+grace, clamped at the daemon cap", () => {
    // No budget: daemon default 30s + 15s grace.
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
    const provider: SandboxFsProvider = {
      proxyDaemonRequest: (_handle, _path, init) => {
        sawSignal = init.signal;
        return new Promise<Response>(() => {}); // never settles on its own
      },
      renewTtl: async () => {},
    };
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
    const provider: SandboxFsProvider = {
      proxyDaemonRequest: async () => {
        attempts++;
        if (attempts === 1) throw new Error("connection refused");
        return new Response(
          JSON.stringify({ kind: "text", content: "ok", lineCount: 1 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
      renewTtl: async () => {},
    };
    const hooks = createSandboxFsHooks(provider, {
      ensureHandle: async () => "h",
      invalidateHandle: async () => {
        invalidated++;
      },
      canAutoRestart: true,
    });
    const out = await hooks.onProxy("/_sandbox/read", { path: "/app/x.ts" });
    expect(out).toEqual({ kind: "text", content: "ok", lineCount: 1 });
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
    const provider: SandboxFsProvider = {
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
      renewTtl: async () => {},
    };
    const hooks = createSandboxFsHooks(provider, {
      ensureHandle: async () => "h",
      invalidateHandle: async (opts) => {
        forced = opts?.force;
      },
      canAutoRestart: false,
    });
    const out = await hooks.onProxy("/_sandbox/read", { path: "/app/x.ts" });
    expect(out).toEqual({
      kind: "text",
      content: "recovered",
      lineCount: 1,
    });
    expect(attempts).toBe(2);
    expect(forced).toBe(true);
  });

  test("does NOT respawn on an ambiguous connect failure when canAutoRestart is false", async () => {
    // A transport throw (not a 404) could be a transient blip on a still-live
    // persistent sandbox — reaping would abandon its working tree — so the
    // conservative branch surfaces the sticky failure without a retry.
    let attempts = 0;
    let invalidated = 0;
    const provider: SandboxFsProvider = {
      proxyDaemonRequest: async () => {
        attempts++;
        throw new Error("connection refused");
      },
      renewTtl: async () => {},
    };
    const hooks = createSandboxFsHooks(provider, {
      ensureHandle: async () => "h",
      invalidateHandle: async () => {
        invalidated++;
      },
      canAutoRestart: false,
    });
    await expect(
      hooks.onProxy("/_sandbox/read", { path: "/app/x.ts" }),
    ).rejects.toThrow(/not running/);
    expect(attempts).toBe(1);
    expect(invalidated).toBe(0);
  });
});
