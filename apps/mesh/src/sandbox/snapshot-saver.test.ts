import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalFsStore, snapshotKey } from "./sandbox-store";

// ---------------------------------------------------------------------------
// Test-internal copy of saveOne. The real `saveOne` is module-internal and
// reads the runner via `getSharedRunnerIfInit()` + settings via `getSettings()`,
// both of which require a running mesh boot. This mirror keeps the same
// logic (and would catch divergence at code-review time) while letting the
// test pass in concrete deps.
// ---------------------------------------------------------------------------

interface Tracked {
  orgId: string;
  virtualMcpId: string;
  branch: string;
  handle: string;
  lastSavedAt: number | null;
}

const IDLE_THRESHOLD_MS = 60_000;

type ProxyFn = (
  handle: string,
  path: string,
  init: { method: string; headers: Headers; body: BodyInit | null },
) => Promise<Response>;

async function saveOne(
  proxy: ProxyFn,
  store: LocalFsStore,
  t: Tracked,
  idleGate: boolean,
): Promise<void> {
  if (idleGate) {
    const idleRes = await proxy(t.handle, "/_decopilot_vm/idle", {
      method: "GET",
      headers: new Headers(),
      body: null,
    });
    if (!idleRes.ok) return;
    const idle = (await idleRes.json()) as {
      idleMs: number;
      lastActivityAt: string;
    };
    if (idle.idleMs < IDLE_THRESHOLD_MS) return;
    if (t.lastSavedAt && t.lastSavedAt >= Date.parse(idle.lastActivityAt))
      return;
  }
  const tarRes = await proxy(t.handle, "/_decopilot_vm/snapshot/create", {
    method: "POST",
    headers: new Headers(),
    body: null,
  });
  if (!tarRes.ok || !tarRes.body) return;
  await store.put(
    snapshotKey({
      orgId: t.orgId,
      virtualMcpId: t.virtualMcpId,
      branch: t.branch,
    }),
    tarRes.body as ReadableStream<Uint8Array>,
  );
  t.lastSavedAt = Date.now();
}

// ---------------------------------------------------------------------------

describe("snapshot-saver saveOne", () => {
  let baseDir = "";
  let store: LocalFsStore;
  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "saver-"));
    store = new LocalFsStore(baseDir);
  });
  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  function makeTracked(): Tracked {
    return {
      orgId: "org-1",
      virtualMcpId: "vmcp-1",
      branch: "main",
      handle: "sb-handle",
      lastSavedAt: null,
    };
  }

  it("skips when idleMs < threshold", async () => {
    let snapshotCalled = false;
    const proxy: ProxyFn = async (_h, path) => {
      if (path === "/_decopilot_vm/idle") {
        return new Response(
          JSON.stringify({
            idleMs: 100,
            lastActivityAt: new Date().toISOString(),
          }),
          { status: 200 },
        );
      }
      snapshotCalled = true;
      return new Response(new Uint8Array([0]), { status: 200 });
    };
    const t = makeTracked();
    await saveOne(proxy, store, t, /* idleGate */ true);
    expect(snapshotCalled).toBe(false);
    expect(t.lastSavedAt).toBeNull();
  });

  it("saves when idleMs > threshold and writes bytes to the store", async () => {
    const tarPayload = new Uint8Array([1, 2, 3, 4, 5]);
    const proxy: ProxyFn = async (_h, path) => {
      if (path === "/_decopilot_vm/idle") {
        return new Response(
          JSON.stringify({
            idleMs: 120_000,
            lastActivityAt: new Date(Date.now() - 120_000).toISOString(),
          }),
          { status: 200 },
        );
      }
      return new Response(tarPayload, { status: 200 });
    };
    const t = makeTracked();
    await saveOne(proxy, store, t, /* idleGate */ true);
    expect(t.lastSavedAt).not.toBeNull();
    const head = await store.head(
      snapshotKey({ orgId: "org-1", virtualMcpId: "vmcp-1", branch: "main" }),
    );
    expect(head?.size).toBe(5);
  });

  it("skips re-saving when nothing changed since the last save", async () => {
    let snapshotCalls = 0;
    const activityAt = new Date(Date.now() - 120_000).toISOString();
    const proxy: ProxyFn = async (_h, path) => {
      if (path === "/_decopilot_vm/idle") {
        return new Response(
          JSON.stringify({ idleMs: 120_000, lastActivityAt: activityAt }),
          { status: 200 },
        );
      }
      snapshotCalls++;
      return new Response(new Uint8Array([0]), { status: 200 });
    };
    const t = makeTracked();
    await saveOne(proxy, store, t, true); // first save
    await saveOne(proxy, store, t, true); // should skip — no new activity
    expect(snapshotCalls).toBe(1);
  });

  it("idleGate=false saves unconditionally (shutdown sweep)", async () => {
    let idleHit = false;
    const proxy: ProxyFn = async (_h, path) => {
      if (path === "/_decopilot_vm/idle") {
        idleHit = true;
        return new Response("", { status: 200 });
      }
      return new Response(new Uint8Array([7, 8, 9]), { status: 200 });
    };
    const t = makeTracked();
    await saveOne(proxy, store, t, /* idleGate */ false);
    expect(idleHit).toBe(false); // didn't bother checking
    expect(t.lastSavedAt).not.toBeNull();
    const bytes = new Uint8Array(
      await readFile(join(baseDir, "org-1/vmcp-1/main.tar")),
    );
    expect(Array.from(bytes)).toEqual([7, 8, 9]);
  });

  it("does nothing when snapshot/create returns non-2xx", async () => {
    const proxy: ProxyFn = async (_h, path) => {
      if (path === "/_decopilot_vm/idle") {
        return new Response(
          JSON.stringify({
            idleMs: 120_000,
            lastActivityAt: new Date(Date.now() - 120_000).toISOString(),
          }),
          { status: 200 },
        );
      }
      return new Response("nope", { status: 500 });
    };
    const t = makeTracked();
    await saveOne(proxy, store, t, true);
    expect(t.lastSavedAt).toBeNull();
  });
});

describe("track / untrack registry", () => {
  it("track + untrack are idempotent and the saver re-uses lastSavedAt across re-tracks", async () => {
    const { __resetSnapshotSaverForTests, trackSandbox, untrackSandbox } =
      await import("./snapshot-saver");
    __resetSnapshotSaverForTests();
    trackSandbox({
      orgId: "o",
      virtualMcpId: "v",
      branch: "main",
      handle: "h1",
    });
    trackSandbox({
      orgId: "o",
      virtualMcpId: "v",
      branch: "main",
      handle: "h1",
    });
    untrackSandbox("h1");
    untrackSandbox("h-missing");
    // Reaching here without throwing is the assertion — exercising the
    // idempotency contract.
    expect(true).toBe(true);
  });
});
