/**
 * Cross-pod running-thread set for the home "X agents working on N tasks" badge.
 *
 * The authoritative count is spread across pods (each pod's run registry only
 * knows its own in-flight runs), so this store materializes it in a shared
 * place. Two backends sit behind one interface:
 *
 *   - JetStreamKVRunningThreadsStore (prod): a NATS JetStream KV key per org
 *     holding the org's running threads. Cheap reads, cross-pod, and a per-entry
 *     `lastProgressAt` lets a crashed/orphaned run be pruned on the same idle
 *     timeline the reaper uses — without depending on the reaper (which only
 *     sweeps the owning pod's memory).
 *   - DbRunningThreadsStore (dev / no-NATS): reads the threads table directly via
 *     `summarizeRunning`. The reactor updates the row BEFORE calling the store,
 *     so a fresh read reflects the transition. Single-pod, so a per-transition
 *     query is fine.
 *
 * The run reactor calls markRunning/markStopped on each transition and emits the
 * returned list as a `decopilot.running.summary` event through the SSE hub. The
 * `/watch` connect snapshot is served separately from the DB (authoritative and
 * infrequent, so it sidesteps KV cold-start undercounts after a deploy).
 * Best-effort throughout: a counter for a homepage badge must never block or
 * fail a run.
 */

import {
  JSONCodec,
  nanos,
  StorageType,
  type JetStreamClient,
  type KV,
} from "nats";
import type { RunningThread } from "@decocms/mesh-sdk";
import {
  RUNNING_THREAD_IDLE_MS,
  RUNNING_THREADS_KV_TTL_MS,
} from "@/core/constants";
import type { ThreadStoragePort } from "@/storage/ports";

export interface RunningThreadsStore {
  /** Record a thread as running; returns the org's current running set. */
  markRunning(orgId: string, thread: RunningThread): Promise<RunningThread[]>;
  /** Record a thread as no longer running; returns the org's running set. */
  markStopped(orgId: string, threadId: string): Promise<RunningThread[]>;
  /** Refresh a running thread's liveness (no emit). No-op if absent. */
  touch(orgId: string, threadId: string): Promise<void>;
  /** Current running set for an org (stale entries excluded). */
  summarize(orgId: string): Promise<RunningThread[]>;
  teardown(): void;
}

// ============================================================================
// JetStream KV backend
// ============================================================================

interface StoredEntry {
  /** virtual_mcp_id; "" when agentless. */
  v: string;
  /** agent title; null when unknown. */
  t: string | null;
  /** lastProgressAt, epoch ms. */
  p: number;
}

type StoredOrg = Record<string, StoredEntry>;

const KV_BUCKET = "DECOCMS_RUNNING_THREADS";
const MAX_CAS_ATTEMPTS = 5;

/** Drop entries idle past the timeout (orphaned/crashed runs self-heal here). */
function prune(org: StoredOrg, now: number): StoredOrg {
  const cutoff = now - RUNNING_THREAD_IDLE_MS;
  const out: StoredOrg = {};
  for (const [id, e] of Object.entries(org)) {
    if (e.p >= cutoff) out[id] = e;
  }
  return out;
}

function toRunningThreads(org: StoredOrg): RunningThread[] {
  return Object.entries(org).map(([id, e]) => ({
    id,
    virtual_mcp_id: e.v,
    title: e.t,
  }));
}

export class JetStreamKVRunningThreadsStore implements RunningThreadsStore {
  private kv: KV | null = null;
  private readonly codec = JSONCodec<StoredOrg>();

  constructor(
    private readonly options: { getJetStream: () => JetStreamClient | null },
  ) {}

  async init(): Promise<void> {
    const js = this.options.getJetStream();
    if (!js) return; // NATS not ready — paused until re-init
    this.kv = await js.views.kv(KV_BUCKET, {
      storage: StorageType.Memory,
      ttl: nanos(RUNNING_THREADS_KV_TTL_MS),
    });
  }

  /**
   * Optimistic read-modify-write across replicas, mirroring the connection
   * circuit store: create() rejects if the key exists, update() rejects on a
   * stale revision — both mean another replica raced us, so we retry. After a
   * few attempts we give up; a lost update only briefly skews a cosmetic count.
   */
  private async mutate(
    orgId: string,
    fn: (org: StoredOrg, now: number) => StoredOrg,
  ): Promise<RunningThread[]> {
    if (!this.kv) return [];
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      try {
        const now = Date.now();
        const entry = await this.kv.get(orgId);
        const live =
          entry &&
          entry.operation !== "DEL" &&
          entry.operation !== "PURGE" &&
          entry.value?.length;

        const prev: StoredOrg = live ? this.codec.decode(entry.value) : {};
        const next = fn(prune(prev, now), now);

        if (Object.keys(next).length === 0) {
          // Nothing running — drop the key so an idle org leaves no footprint.
          if (live) await this.kv.delete(orgId);
          return [];
        }
        const encoded = this.codec.encode(next);
        if (live) {
          await this.kv.update(orgId, encoded, entry.revision);
        } else {
          await this.kv.create(orgId, encoded);
        }
        return toRunningThreads(next);
      } catch {
        // create race / revision conflict — retry the read-modify-write
      }
    }
    return [];
  }

  markRunning(orgId: string, thread: RunningThread): Promise<RunningThread[]> {
    return this.mutate(orgId, (org, now) => ({
      ...org,
      [thread.id]: { v: thread.virtual_mcp_id, t: thread.title, p: now },
    }));
  }

  markStopped(orgId: string, threadId: string): Promise<RunningThread[]> {
    return this.mutate(orgId, (org) => {
      if (!(threadId in org)) return org;
      const { [threadId]: _removed, ...rest } = org;
      return rest;
    });
  }

  async touch(orgId: string, threadId: string): Promise<void> {
    await this.mutate(orgId, (org, now) => {
      const e = org[threadId];
      if (!e) return org;
      return { ...org, [threadId]: { ...e, p: now } };
    });
  }

  async summarize(orgId: string): Promise<RunningThread[]> {
    if (!this.kv) return [];
    try {
      const entry = await this.kv.get(orgId);
      if (
        !entry ||
        entry.operation === "DEL" ||
        entry.operation === "PURGE" ||
        !entry.value?.length
      ) {
        return [];
      }
      return toRunningThreads(
        prune(this.codec.decode(entry.value), Date.now()),
      );
    } catch {
      return [];
    }
  }

  teardown(): void {
    this.kv = null;
  }
}

// ============================================================================
// DB backend (dev / no-NATS)
// ============================================================================

/**
 * Reads the threads table. The reactor updates the row's status BEFORE calling
 * markRunning/markStopped, so re-reading reflects the transition. Single-pod,
 * so a query per transition is acceptable.
 */
export class DbRunningThreadsStore implements RunningThreadsStore {
  constructor(private readonly storage: ThreadStoragePort) {}

  markRunning(orgId: string): Promise<RunningThread[]> {
    return this.storage.summarizeRunning(orgId);
  }
  markStopped(orgId: string): Promise<RunningThread[]> {
    return this.storage.summarizeRunning(orgId);
  }
  async touch(): Promise<void> {}
  summarize(orgId: string): Promise<RunningThread[]> {
    return this.storage.summarizeRunning(orgId);
  }
  teardown(): void {}
}

// ============================================================================
// Noop (tests)
// ============================================================================

export class NoopRunningThreadsStore implements RunningThreadsStore {
  async markRunning(): Promise<RunningThread[]> {
    return [];
  }
  async markStopped(): Promise<RunningThread[]> {
    return [];
  }
  async touch(): Promise<void> {}
  async summarize(): Promise<RunningThread[]> {
    return [];
  }
  teardown(): void {}
}

// Exposed for unit tests.
export const __test = { prune, toRunningThreads };
