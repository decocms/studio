import { describe, expect, it } from "bun:test";
import {
  NONCE_HEADER,
  SIG_HEADER,
  TS_HEADER,
  verifyRequest,
} from "../../../../../apps/mesh/src/links/protocol/hmac";
import { computeHandle } from "../shared";
import type { RunnerStateStoreOps } from "../state-store";
import { DesktopSandboxProvider } from "./runner";

const TUNNEL = "https://link-x.deco.host";
const SECRET = "this-is-the-stored-hash-acting-as-the-signing-key";

interface FakeFetchCall {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

function makeFakeFetch(
  responder: (call: FakeFetchCall) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? {});
    const rawBody = init?.body;
    let body = "";
    if (typeof rawBody === "string") body = rawBody;
    else if (rawBody instanceof ArrayBuffer)
      body = Buffer.from(rawBody).toString("utf8");
    else if (rawBody && ArrayBuffer.isView(rawBody)) {
      body = Buffer.from(
        rawBody.buffer,
        rawBody.byteOffset,
        rawBody.byteLength,
      ).toString("utf8");
    } else if (rawBody != null) {
      body = await new Response(rawBody as BodyInit).text();
    }
    const call: FakeFetchCall = { url, method, headers, body };
    calls.push(call);
    return responder(call);
  };
  return { fetch: fakeFetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function verifyCallSignature(call: FakeFetchCall): void {
  const url = new URL(call.url);
  const result = verifyRequest({
    secret: SECRET,
    method: call.method,
    path: url.pathname,
    body: call.body,
    headers: {
      [SIG_HEADER]: call.headers.get(SIG_HEADER) ?? undefined,
      [TS_HEADER]: call.headers.get(TS_HEADER) ?? undefined,
      [NONCE_HEADER]: call.headers.get(NONCE_HEADER) ?? undefined,
    },
    seenNonce: () => false,
  });
  expect(result.valid).toBe(true);
}

function makeFakeStateStore(): RunnerStateStoreOps & {
  rows: Map<
    string,
    {
      id: { userId: string; projectRef: string };
      state: Record<string, unknown>;
    }
  >;
} {
  const rows = new Map<
    string,
    {
      id: { userId: string; projectRef: string };
      state: Record<string, unknown>;
    }
  >();
  return {
    rows,
    async get(id, _kind) {
      const k = `${id.userId}/${id.projectRef}`;
      const row = rows.get(k);
      return row
        ? {
            handle: (row.state.handle as string) ?? "",
            state: row.state,
            updatedAt: new Date(),
          }
        : null;
    },
    async getByHandle(_kind, handle) {
      for (const [, row] of rows) {
        if ((row.state.handle as string) === handle) {
          return {
            id: row.id,
            handle,
            state: row.state,
            updatedAt: new Date(),
          };
        }
      }
      return null;
    },
    async put(id, _kind, entry) {
      const k = `${id.userId}/${id.projectRef}`;
      rows.set(k, { id, state: entry.state });
    },
    async delete(id, _kind) {
      const k = `${id.userId}/${id.projectRef}`;
      rows.delete(k);
    },
    async deleteByHandle(_kind, handle) {
      for (const [k, row] of rows) {
        if ((row.state.handle as string) === handle) rows.delete(k);
      }
    },
  };
}

describe("DesktopSandboxProvider.ensure", () => {
  it("POSTs /api/sandboxes with HMAC headers and returns a Sandbox", async () => {
    const { fetch, calls } = makeFakeFetch(() =>
      jsonResponse({ sandboxUrl: `${TUNNEL}/_sandbox/handle-abc` }),
    );
    const provider = new DesktopSandboxProvider({
      link: { tunnelUrl: TUNNEL, linkSecret: SECRET },
      fetchImpl: fetch,
    });

    const sandbox = await provider.ensure(
      { userId: "user-1", projectRef: "proj-1" },
      {
        repo: {
          cloneUrl: "https://github.com/a/b.git",
          userName: "n",
          userEmail: "e@example.com",
          branch: "main",
        },
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${TUNNEL}/api/sandboxes`);
    expect(calls[0].method).toBe("POST");
    const reqBody = JSON.parse(calls[0].body);
    expect(reqBody.repo.branch).toBe("main");
    verifyCallSignature(calls[0]);

    expect(sandbox.handle).toBeTruthy();
    // Handle should be the deterministic computeHandle output, NOT the
    // server-returned `handle-abc` — that string is just the
    // sandboxUrl's path tail, not necessarily the same as the cluster's handle.
    expect(sandbox.workdir).toBe(`${TUNNEL}/_sandbox/handle-abc`);
    // previewUrl is now the same daemon URL — there's no separate
    // /preview/<handle>/ rewrite in the per-daemon-tunnel world.
    expect(sandbox.previewUrl).toBe(`${TUNNEL}/_sandbox/handle-abc`);
  });

  it("returns the same Sandbox on re-ensure when /health passes (no second POST)", async () => {
    // Re-ensure with a live daemon: cache hit → /health probe → trust.
    // The second call probes but does NOT re-POST.
    const { fetch, calls } = makeFakeFetch((call) => {
      if (call.url.endsWith("/health"))
        return new Response("", { status: 200 });
      return jsonResponse({ sandboxUrl: `${TUNNEL}/_sandbox/handle-abc` });
    });
    const provider = new DesktopSandboxProvider({
      link: { tunnelUrl: TUNNEL, linkSecret: SECRET },
      fetchImpl: fetch,
    });

    const id = { userId: "u", projectRef: "p" };
    const first = await provider.ensure(id);
    const second = await provider.ensure(id);

    const posts = calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/api/sandboxes"),
    );
    expect(posts).toHaveLength(1);
    expect(second.handle).toBe(first.handle);
    expect(second.workdir).toBe(first.workdir);
  });

  it("throws when the link responds non-2xx", async () => {
    const { fetch } = makeFakeFetch(
      () => new Response("nope", { status: 500 }),
    );
    const provider = new DesktopSandboxProvider({
      link: { tunnelUrl: TUNNEL, linkSecret: SECRET },
      fetchImpl: fetch,
    });
    expect(provider.ensure({ userId: "u", projectRef: "p" })).rejects.toThrow(
      /desktop ensure failed: 500/,
    );
  });
});

describe("DesktopSandboxProvider.exec", () => {
  it("proxies to <sandboxUrl>/_decopilot_vm/exec with HMAC headers", async () => {
    const { fetch, calls } = makeFakeFetch((call) => {
      if (call.url.endsWith("/api/sandboxes")) {
        return jsonResponse({ sandboxUrl: `${TUNNEL}/_sandbox/h-1` });
      }
      return jsonResponse({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });
    });
    const provider = new DesktopSandboxProvider({
      link: { tunnelUrl: TUNNEL, linkSecret: SECRET },
      fetchImpl: fetch,
    });

    const sandbox = await provider.ensure({ userId: "u", projectRef: "p" });
    const out = await provider.exec(sandbox.handle, { command: "echo hi" });

    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("ok");
    const execCall = calls[1];
    expect(execCall.url).toBe(`${TUNNEL}/_sandbox/h-1/_decopilot_vm/exec`);
    expect(execCall.method).toBe("POST");
    verifyCallSignature(execCall);
  });

  it("throws on unknown handle", async () => {
    const { fetch } = makeFakeFetch(() => jsonResponse({}));
    const provider = new DesktopSandboxProvider({
      link: { tunnelUrl: TUNNEL, linkSecret: SECRET },
      fetchImpl: fetch,
    });
    expect(provider.exec("nope", { command: "x" })).rejects.toThrow(
      /unknown handle/,
    );
  });
});

describe("DesktopSandboxProvider.delete", () => {
  it("calls DELETE /api/sandboxes/<handle>", async () => {
    const { fetch, calls } = makeFakeFetch((call) => {
      if (call.method === "POST")
        return jsonResponse({ sandboxUrl: `${TUNNEL}/_sandbox/h-1` });
      return new Response(null, { status: 204 });
    });
    const provider = new DesktopSandboxProvider({
      link: { tunnelUrl: TUNNEL, linkSecret: SECRET },
      fetchImpl: fetch,
    });
    const sandbox = await provider.ensure({ userId: "u", projectRef: "p" });
    await provider.delete(sandbox.handle);

    const delCall = calls[1];
    expect(delCall.method).toBe("DELETE");
    expect(delCall.url).toBe(
      `${TUNNEL}/api/sandboxes/${encodeURIComponent(sandbox.handle)}`,
    );
    verifyCallSignature(delCall);

    // alive() with no record + no state store → false.
    const { fetch: deadFetch } = makeFakeFetch(
      () => new Response(null, { status: 404 }),
    );
    const probeOnly = new DesktopSandboxProvider({
      link: { tunnelUrl: TUNNEL, linkSecret: SECRET },
      fetchImpl: deadFetch,
    });
    expect(await probeOnly.alive(sandbox.handle)).toBe(false);
  });

  it("tolerates 404 from the link (already gone)", async () => {
    const { fetch } = makeFakeFetch((call) => {
      if (call.method === "POST")
        return jsonResponse({ sandboxUrl: `${TUNNEL}/_sandbox/h-1` });
      return new Response("not found", { status: 404 });
    });
    const provider = new DesktopSandboxProvider({
      link: { tunnelUrl: TUNNEL, linkSecret: SECRET },
      fetchImpl: fetch,
    });
    const sandbox = await provider.ensure({ userId: "u", projectRef: "p" });
    // Must not throw.
    await provider.delete(sandbox.handle);
  });
});

describe("DesktopSandboxProvider.alive", () => {
  it("returns true after ensure() populated the in-process records cache", async () => {
    // ensure() populates `records`, so alive() reuses it without hitting
    // the state store. Probe URL is `<sandboxUrl>/health`, unsigned.
    const { fetch, calls } = makeFakeFetch((call) => {
      if (call.url.endsWith("/api/sandboxes"))
        return jsonResponse({ sandboxUrl: `${TUNNEL}/_sandbox/alive-1` });
      return new Response("", { status: 200 });
    });
    const provider = new DesktopSandboxProvider({
      link: { tunnelUrl: TUNNEL, linkSecret: SECRET },
      fetchImpl: fetch,
    });
    const sandbox = await provider.ensure({ userId: "u", projectRef: "p" });
    const ok = await provider.alive(sandbox.handle);
    expect(ok).toBe(true);
    expect(calls[1].url).toBe(`${TUNNEL}/_sandbox/alive-1/health`);
    expect(calls[1].method).toBe("GET");
  });

  it("returns false when there is no cached record and no state store", async () => {
    const { fetch } = makeFakeFetch(() => new Response(null, { status: 404 }));
    const provider = new DesktopSandboxProvider({
      link: { tunnelUrl: TUNNEL, linkSecret: SECRET },
      fetchImpl: fetch,
    });
    expect(await provider.alive("nope")).toBe(false);
  });
});

describe("DesktopSandboxProvider.proxyDaemonRequest", () => {
  it("forwards to <sandboxUrl><path> with HMAC", async () => {
    const { fetch, calls } = makeFakeFetch((call) => {
      if (call.url.endsWith("/api/sandboxes"))
        return jsonResponse({ sandboxUrl: `${TUNNEL}/_sandbox/h-1` });
      return new Response('{"ok":1}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const provider = new DesktopSandboxProvider({
      link: { tunnelUrl: TUNNEL, linkSecret: SECRET },
      fetchImpl: fetch,
    });
    const sandbox = await provider.ensure({ userId: "u", projectRef: "p" });
    const res = await provider.proxyDaemonRequest(
      sandbox.handle,
      "/_decopilot_vm/status",
      {
        method: "POST",
        headers: new Headers({ "content-type": "application/json" }),
        body: JSON.stringify({ ping: true }),
      },
    );
    expect(res.status).toBe(200);
    const proxyCall = calls[1];
    expect(proxyCall.url).toBe(`${TUNNEL}/_sandbox/h-1/_decopilot_vm/status`);
    expect(JSON.parse(proxyCall.body)).toEqual({ ping: true });
    verifyCallSignature(proxyCall);
  });

  it("returns 404 when no record is known and no state store is configured", async () => {
    // With no in-memory record and no state store hydration, the provider
    // can't know where to forward — surface 404 to the caller instead of
    // guessing a URL.
    const { fetch, calls } = makeFakeFetch(
      () => new Response("", { status: 200 }),
    );
    const provider = new DesktopSandboxProvider({
      link: { tunnelUrl: TUNNEL, linkSecret: SECRET },
      fetchImpl: fetch,
    });
    const res = await provider.proxyDaemonRequest(
      "any-handle",
      "/_decopilot_vm/status",
      {
        method: "GET",
        headers: new Headers(),
        body: null,
      },
    );
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe("DesktopSandboxProvider misc surface", () => {
  it("localWorkdir + getPreviewUrl return null when no record is known", async () => {
    const { fetch } = makeFakeFetch(() => jsonResponse({}));
    const provider = new DesktopSandboxProvider({
      link: { tunnelUrl: TUNNEL, linkSecret: SECRET },
      fetchImpl: fetch,
    });
    expect(await provider.localWorkdir("anything")).toBeNull();
    expect(await provider.getPreviewUrl("anything")).toBeNull();
  });

  it("watchClaimLifecycle yields a single ready phase", async () => {
    const { fetch } = makeFakeFetch(() => jsonResponse({}));
    const provider = new DesktopSandboxProvider({
      link: { tunnelUrl: TUNNEL, linkSecret: SECRET },
      fetchImpl: fetch,
    });
    const phases: unknown[] = [];
    for await (const phase of provider.watchClaimLifecycle("h")) {
      phases.push(phase);
    }
    expect(phases).toEqual([{ kind: "ready" }]);
  });

  it("rejects construction without tunnelUrl or linkSecret", () => {
    expect(
      () =>
        new DesktopSandboxProvider({
          // @ts-expect-error - intentional
          link: { tunnelUrl: "", linkSecret: "x" },
        }),
    ).toThrow();
    expect(
      () =>
        new DesktopSandboxProvider({
          // @ts-expect-error - intentional
          link: { tunnelUrl: TUNNEL, linkSecret: "" },
        }),
    ).toThrow();
  });
});

describe("DesktopSandboxProvider + state store", () => {
  it("persists {handle, sandboxUrl} on ensure", async () => {
    const { fetch } = makeFakeFetch(() =>
      jsonResponse({ sandboxUrl: `${TUNNEL}/_sandbox/persisted` }),
    );
    const stateStore = makeFakeStateStore();
    const provider = new DesktopSandboxProvider({
      link: { tunnelUrl: TUNNEL, linkSecret: SECRET },
      fetchImpl: fetch,
      stateStore,
    });

    const sandbox = await provider.ensure({ userId: "u", projectRef: "p" });
    const row = await stateStore.getByHandle("desktop", sandbox.handle);
    expect(row).not.toBeNull();
    expect(row?.state.sandboxUrl).toBe(`${TUNNEL}/_sandbox/persisted`);
  });

  it("alive() probes sandboxUrl from state store on cache miss", async () => {
    const stateStore = makeFakeStateStore();
    await stateStore.put({ userId: "u", projectRef: "p" }, "desktop", {
      handle: "fresh-handle",
      state: {
        handle: "fresh-handle",
        sandboxUrl: `${TUNNEL}/_sandbox/fresh`,
      },
    });
    const { fetch, calls } = makeFakeFetch(
      () => new Response("", { status: 200 }),
    );
    const provider = new DesktopSandboxProvider({
      link: { tunnelUrl: TUNNEL, linkSecret: SECRET },
      fetchImpl: fetch,
      stateStore,
    });
    const ok = await provider.alive("fresh-handle");
    expect(ok).toBe(true);
    expect(calls[0].url).toBe(`${TUNNEL}/_sandbox/fresh/health`);
  });

  it("proxyDaemonRequest forwards to sandboxUrl from state store on cache miss", async () => {
    const stateStore = makeFakeStateStore();
    await stateStore.put({ userId: "u", projectRef: "p" }, "desktop", {
      handle: "proxy-handle",
      state: {
        handle: "proxy-handle",
        sandboxUrl: `${TUNNEL}/_sandbox/proxy`,
      },
    });
    const { fetch, calls } = makeFakeFetch(
      () => new Response("{}", { status: 200 }),
    );
    const provider = new DesktopSandboxProvider({
      link: { tunnelUrl: TUNNEL, linkSecret: SECRET },
      fetchImpl: fetch,
      stateStore,
    });
    const res = await provider.proxyDaemonRequest(
      "proxy-handle",
      "/_decopilot_vm/exec",
      {
        method: "POST",
        headers: new Headers(),
        body: JSON.stringify({ cmd: "x" }),
      },
    );
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe(`${TUNNEL}/_sandbox/proxy/_decopilot_vm/exec`);
  });

  it("alive() returns false when state store has no row", async () => {
    const stateStore = makeFakeStateStore();
    const { fetch } = makeFakeFetch(() => new Response("", { status: 200 }));
    const provider = new DesktopSandboxProvider({
      link: { tunnelUrl: TUNNEL, linkSecret: SECRET },
      fetchImpl: fetch,
      stateStore,
    });
    expect(await provider.alive("never-seen")).toBe(false);
  });

  it("re-POSTs to the link when state-store URL is dead (/health fails)", async () => {
    // The daemon died but `sandbox_runner_state` still holds its URL.
    // ensure() must probe, find it dead, drop the stale row, and re-POST
    // the link to respawn. This is the auto-restart path that was broken
    // before — without the probe, every retry replayed the corpse URL.
    const stateStore = makeFakeStateStore();
    const STALE_URL = `${TUNNEL}/_sandbox/dead`;
    const FRESH_URL = `${TUNNEL}/_sandbox/fresh`;
    // Seed under the *real* handle ensure() will compute, so the state-store
    // hydration path actually finds the stale row.
    const handle = computeHandle({ userId: "u", projectRef: "p" }, undefined, {
      hashLen: 16,
    });
    await stateStore.put({ userId: "u", projectRef: "p" }, "desktop", {
      handle,
      state: { handle, sandboxUrl: STALE_URL },
    });

    const { fetch, calls } = makeFakeFetch((call) => {
      if (call.url === `${STALE_URL}/health`)
        return new Response("", { status: 503 });
      if (call.url.endsWith("/api/sandboxes"))
        return jsonResponse({ sandboxUrl: FRESH_URL });
      return jsonResponse({});
    });
    const provider = new DesktopSandboxProvider({
      link: { tunnelUrl: TUNNEL, linkSecret: SECRET },
      fetchImpl: fetch,
      stateStore,
    });

    // Seed the state-store row under the handle ensure() will compute, so
    // the hydration path actually hits the stale URL. computeHandle is
    // deterministic from (id, branch); easier to just discover the handle.
    const sandbox = await provider.ensure({ userId: "u", projectRef: "p" });

    expect(sandbox.previewUrl).toBe(FRESH_URL);
    const probes = calls.filter((c) => c.url.endsWith("/health"));
    const posts = calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/api/sandboxes"),
    );
    expect(probes.length).toBeGreaterThanOrEqual(1);
    expect(posts).toHaveLength(1);

    // Stale row must be replaced, not left behind.
    const stillStale = Array.from(stateStore.rows.values()).some(
      (r) => r.state.sandboxUrl === STALE_URL,
    );
    expect(stillStale).toBe(false);
  });

  it("clears in-process cache and state-store row when cache hit fails /health", async () => {
    // Mirrors the within-request retry path: first ensure() succeeds and
    // populates the cache. The daemon dies during the tool call; harness
    // re-invokes ensure(). Probe must catch the cached corpse and respawn.
    const stateStore = makeFakeStateStore();
    let healthAlive = true;
    let postCount = 0;
    const { fetch } = makeFakeFetch((call) => {
      if (call.url.endsWith("/health")) {
        return new Response("", { status: healthAlive ? 200 : 503 });
      }
      if (call.url.endsWith("/api/sandboxes")) {
        postCount++;
        return jsonResponse({
          sandboxUrl: `${TUNNEL}/_sandbox/v${postCount}`,
        });
      }
      return jsonResponse({});
    });
    const provider = new DesktopSandboxProvider({
      link: { tunnelUrl: TUNNEL, linkSecret: SECRET },
      fetchImpl: fetch,
      stateStore,
    });

    const id = { userId: "u", projectRef: "p" };
    const first = await provider.ensure(id);
    expect(first.previewUrl).toBe(`${TUNNEL}/_sandbox/v1`);

    // Simulate the daemon dying between ensures.
    healthAlive = false;
    const second = await provider.ensure(id);
    expect(second.previewUrl).toBe(`${TUNNEL}/_sandbox/v2`);
    expect(postCount).toBe(2);
  });

  it("delete() clears the state store row", async () => {
    const stateStore = makeFakeStateStore();
    const { fetch } = makeFakeFetch((call) => {
      if (call.method === "POST")
        return jsonResponse({ sandboxUrl: `${TUNNEL}/_sandbox/del` });
      return new Response(null, { status: 204 });
    });
    const provider = new DesktopSandboxProvider({
      link: { tunnelUrl: TUNNEL, linkSecret: SECRET },
      fetchImpl: fetch,
      stateStore,
    });
    const sandbox = await provider.ensure({ userId: "u", projectRef: "p" });
    expect(stateStore.rows.size).toBe(1);
    await provider.delete(sandbox.handle);
    expect(stateStore.rows.size).toBe(0);
  });
});
