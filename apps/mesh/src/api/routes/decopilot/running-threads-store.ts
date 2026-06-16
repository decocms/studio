/**
 * Cross-pod running-thread set for the home "X agents working on N tasks" badge.
 * Best-effort throughout: a counter for a homepage badge must never block or
 * fail a run.
 */

import {
  JSONCodec,
  nanos,
  StorageType,
  type JetStreamClient,
  type KV,
  type KvEntry,
} from "nats";
import type { RunningThread } from "@decocms/mesh-sdk";
import {
  RUNNING_THREAD_IDLE_MS,
  RUNNING_THREADS_KV_TTL_MS,
} from "@/core/constants";
import type { ThreadStoragePort } from "@/storage/ports";

export interface RunningThreadsStore {
  markRunning(orgId: string, thread: RunningThread): Promise<RunningThread[]>;
  markStopped(orgId: string, threadId: string): Promise<RunningThread[]>;
  touch(orgId: string, threadId: string): Promise<void>;
  summarize(orgId: string): Promise<RunningThread[]>;
  teardown(): void;
}

// ============================================================================
// JetStream KV backend
// ============================================================================

// Compact stored shape; p = lastProgressAt (epoch ms), drives idle pruning.
interface StoredEntry {
  v: string;
  t: string | null;
  o: string;
  p: number;
}

type StoredOrg = Record<string, StoredEntry>;

const KV_BUCKET = "DECOCMS_RUNNING_THREADS";
const MAX_CAS_ATTEMPTS = 5;

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
    organization_id: e.o,
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
    if (!js) return;
    this.kv = await js.views.kv(KV_BUCKET, {
      storage: StorageType.Memory,
      ttl: nanos(RUNNING_THREADS_KV_TTL_MS),
    });
  }

  private async read(
    orgId: string,
  ): Promise<{ live: KvEntry | null; org: StoredOrg }> {
    const entry = await this.kv!.get(orgId);
    const live =
      entry &&
      entry.operation !== "DEL" &&
      entry.operation !== "PURGE" &&
      entry.value?.length
        ? entry
        : null;
    return { live, org: live ? this.codec.decode(live.value) : {} };
  }

  // Optimistic read-modify-write: create()/update() reject on a concurrent
  // replica write, so we retry. A lost update only briefly skews the count.
  private async mutate(
    orgId: string,
    fn: (org: StoredOrg, now: number) => StoredOrg,
  ): Promise<RunningThread[]> {
    if (!this.kv) return [];
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      try {
        const now = Date.now();
        const { live, org: prev } = await this.read(orgId);
        const next = fn(prune(prev, now), now);

        if (Object.keys(next).length === 0) {
          if (live) await this.kv.delete(orgId);
          return [];
        }
        const encoded = this.codec.encode(next);
        if (live) await this.kv.update(orgId, encoded, live.revision);
        else await this.kv.create(orgId, encoded);
        return toRunningThreads(next);
      } catch {
        // create race / revision conflict — retry
      }
    }
    return [];
  }

  markRunning(orgId: string, thread: RunningThread): Promise<RunningThread[]> {
    return this.mutate(orgId, (org, now) => ({
      ...org,
      [thread.id]: {
        v: thread.virtual_mcp_id,
        t: thread.title,
        o: thread.organization_id,
        p: now,
      },
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
      const { org } = await this.read(orgId);
      return toRunningThreads(prune(org, Date.now()));
    } catch {
      return [];
    }
  }

  teardown(): void {
    this.kv = null;
  }
}

// ============================================================================
// DB backend (dev / no-NATS) — reactor updates the row before asking, so a
// fresh read reflects the transition.
// ============================================================================

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

export const __test = { prune, toRunningThreads };
