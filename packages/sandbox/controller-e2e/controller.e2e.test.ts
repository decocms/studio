/**
 * Black-box contract test for the sandbox controller: drive the built binary
 * over HTTP through the same client studio uses, assert only on responses.
 * Nothing here imports the controller's internals, so it holds for a
 * reimplementation in another language.
 *
 * Needs a running controller with a real runtime:
 *
 *   CONTROLLER_E2E_URL=http://127.0.0.1:8787 bun test controller.e2e.test.ts
 *
 * Skipped when unset, so `bun test` stays green without a cluster.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { RemoteSandboxProvider } from "../server/provider/remote";
import type { RuntimesResponse } from "../server/provider/remote/protocol";
import { composeSandboxRef } from "../server/provider/sandbox-ref";
import type { ClaimPhase, SandboxId } from "../server/provider";

const BASE = process.env.CONTROLLER_E2E_URL;
const TOKEN = process.env.SANDBOX_CONTROLLER_TOKEN;
const suite = BASE ? describe : describe.skip;

/** Unique per run so concurrent runs never collide on a handle. */
const nonce = Math.random().toString(36).slice(2, 10);
const id: SandboxId = {
  userId: `e2e-${nonce}`,
  projectRef: composeSandboxRef({ threadId: `controller-e2e-${nonce}` }),
};

suite("sandbox controller", () => {
  const provider = new RemoteSandboxProvider({
    baseUrl: BASE ?? "",
    token: TOKEN,
  });
  const auth = TOKEN ? { authorization: `Bearer ${TOKEN}` } : undefined;
  let handle = "";

  beforeAll(async () => {
    expect((await fetch(`${BASE}/healthz`)).status).toBe(200);
  });

  it("declares at least one available runtime", async () => {
    const res = await fetch(`${BASE}/runtimes`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RuntimesResponse;
    const live = body.runtimes.filter((r) => r.available);
    expect(live.length).toBeGreaterThan(0);
    // Capabilities are the optional SandboxProvider methods, declared as data.
    expect(live[0]?.capabilities).toContain("preview");
  });

  it("rejects an unauthenticated call when a token is configured", async () => {
    if (!TOKEN) return;
    expect((await fetch(`${BASE}/runtimes`)).status).toBe(401);
  });

  it("answers the admission gate", async () => {
    expect(typeof (await provider.hasSchedulableCapacity())).toBe("boolean");
  });

  it("reports an unknown handle as dead rather than erroring", async () => {
    expect(await provider.alive("definitely-not-a-handle")).toBe(false);
  });

  it("503s when a runtime nobody has is pinned", async () => {
    const res = await fetch(`${BASE}/sandboxes?handle=pinned-${nonce}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ id, runtime: "lambda-microvm" }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      reasons: { "lambda-microvm": "unknown runtime" },
    });
  });

  it("provisions a sandbox", async () => {
    const sandbox = await provider.ensure(id, { cloneOnly: true });
    handle = sandbox.handle;
    expect(handle).toBeTruthy();
    expect(sandbox.workdir).toBeTruthy();
  }, 600_000);

  it("is idempotent by handle", async () => {
    expect((await provider.ensure(id, { cloneOnly: true })).handle).toBe(
      handle,
    );
  }, 600_000);

  it("hands back a daemon address and token instead of relaying", async () => {
    const res = await fetch(`${BASE}/sandboxes/${handle}`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      alive: boolean;
      runtime: string;
      daemon: { url: string; token: string } | null;
    };
    expect(body.alive).toBe(true);
    expect(body.runtime).toBeTruthy();
    expect(body.daemon?.url).toMatch(/^http:\/\//);
    expect(body.daemon?.token).toBeTruthy();
  });

  it("reaches the daemon directly at that address", async () => {
    const res = await provider.proxyDaemonRequest(handle, "/health", {
      method: "GET",
      headers: new Headers(),
      body: null,
    });
    expect(res.status).toBe(200);
    // The daemon's own health shape — proof studio talked to the pod itself.
    expect(await res.json()).toMatchObject({
      bootId: expect.any(String),
      ready: expect.any(Boolean),
    });
  }, 60_000);

  it("rejects a daemon call carrying the wrong token", async () => {
    const res = await fetch(`${BASE}/sandboxes/${handle}`, { headers: auth });
    const { daemon } = (await res.json()) as { daemon: { url: string } };
    const denied = await fetch(`${daemon.url}/_sandbox/config`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong",
      },
      body: "{}",
    });
    expect(denied.status).toBe(401);
  }, 60_000);

  it("streams lifecycle phases and terminates", async () => {
    const phases: ClaimPhase[] = [];
    for await (const phase of provider.watchClaimLifecycle(handle)) {
      phases.push(phase);
      if (phases.length > 20) break;
    }
    expect(phases.length).toBeGreaterThan(0);
    expect(phases.at(-1)?.kind).toBe("ready");
  }, 300_000);

  it("extends and shortens the lifetime", async () => {
    await provider.renewTtl(handle);
    await provider.releaseAfter(handle, 600_000);
  }, 60_000);

  it("deletes, and does not answer 204 until the sandbox is gone", async () => {
    const res = await fetch(`${BASE}/sandboxes/${handle}`, {
      method: "DELETE",
      headers: auth,
    });
    expect([204, 202]).toContain(res.status);
    if (res.status === 204) expect(await provider.alive(handle)).toBe(false);
  }, 300_000);
});
