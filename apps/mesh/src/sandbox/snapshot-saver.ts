/**
 * Polls tracked sandboxes for idle activity and uploads a tar snapshot via
 * `SandboxStore.put`. Also flushes all on SIGTERM so work survives pod recycles.
 */

import type { SandboxRunner } from "@decocms/sandbox/runner";

import { getSettings } from "../settings";
import { getSharedRunnerIfInit } from "./lifecycle";
import {
  pickStoreFromEnv,
  type SandboxStore,
  snapshotKey,
} from "./sandbox-store";

interface Tracked {
  orgId: string;
  virtualMcpId: string;
  branch: string;
  handle: string;
  /** ms since epoch when the last successful save completed. */
  lastSavedAt: number | null;
}

const IDLE_THRESHOLD_MS = 60_000;
const POLL_INTERVAL_MS = 30_000;

const tracked = new Map<string, Tracked>();
let timer: ReturnType<typeof setInterval> | null = null;
let tickRunning = false;

export function trackSandbox(s: {
  orgId: string;
  virtualMcpId: string;
  branch: string;
  handle: string;
}): void {
  // Idempotent — VM_START runs multiple times per session; we keep the
  // existing lastSavedAt so a re-track doesn't force an unnecessary save
  // on the next tick.
  const prior = tracked.get(s.handle);
  tracked.set(s.handle, { ...s, lastSavedAt: prior?.lastSavedAt ?? null });
}

export function untrackSandbox(handle: string): void {
  tracked.delete(handle);
}

/** Test seam: drop all tracking + cancel the timer. */
export function __resetSnapshotSaverForTests(): void {
  tracked.clear();
  if (timer) clearInterval(timer);
  timer = null;
  tickRunning = false;
}

function resolveStore(): SandboxStore {
  return pickStoreFromEnv({ dataDir: getSettings().dataDir });
}

async function saveOne(
  runner: SandboxRunner,
  store: SandboxStore,
  t: Tracked,
  idleGate: boolean,
): Promise<void> {
  if (idleGate) {
    const idleRes = await runner.proxyDaemonRequest(
      t.handle,
      "/_decopilot_vm/idle",
      { method: "GET", headers: new Headers(), body: null },
    );
    if (!idleRes.ok) return;
    const idle = (await idleRes.json()) as {
      idleMs: number;
      lastActivityAt: string;
    };
    if (idle.idleMs < IDLE_THRESHOLD_MS) return;
    if (t.lastSavedAt && t.lastSavedAt >= Date.parse(idle.lastActivityAt))
      return;
  }

  const tarRes = await runner.proxyDaemonRequest(
    t.handle,
    "/_decopilot_vm/snapshot/create",
    { method: "POST", headers: new Headers(), body: null },
  );
  if (!tarRes.ok || !tarRes.body) return;

  // Record before upload: activity during the upload window should trigger
  // another save on the next tick, not be silently swallowed.
  const savedAt = Date.now();
  await store.put(
    snapshotKey({
      orgId: t.orgId,
      virtualMcpId: t.virtualMcpId,
      branch: t.branch,
    }),
    tarRes.body as ReadableStream<Uint8Array>,
  );
  t.lastSavedAt = savedAt;
}

async function tick(): Promise<void> {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const runner = getSharedRunnerIfInit();
    if (!runner) return;
    const store = resolveStore();
    for (const t of tracked.values()) {
      await saveOne(runner, store, t, true).catch((err) =>
        console.warn(`[snapshot-saver] tick ${t.handle}: ${err}`),
      );
    }
  } finally {
    tickRunning = false;
  }
}

export function startSnapshotSaver(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  timer.unref?.();
}

export async function saveAllSnapshotsOnShutdown(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  const runner = getSharedRunnerIfInit();
  if (!runner) return;
  const store = resolveStore();
  await Promise.allSettled(
    Array.from(tracked.values()).map((t) =>
      saveOne(runner, store, t, false).catch((err) =>
        console.warn(`[snapshot-saver] shutdown ${t.handle}: ${err}`),
      ),
    ),
  );
}
