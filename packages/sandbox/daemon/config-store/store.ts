import type { EnrichedTenantConfig, TenantConfig } from "../types";
import { validateTenantConfig } from "../validate";
import { classify } from "./classify";
import { enrich } from "./derive";
import { deepMerge } from "./merge";
import { REJECTION_REASONS, type ApplyEvent, type ApplyResult } from "./types";

type Compute = (current: TenantConfig | null) => Partial<TenantConfig> | null;

interface QueueEntry {
  patch?: Partial<TenantConfig>;
  compute?: Compute;
  /** When true, skip subscriber notification (e.g. orchestrator-internal fills). */
  silent?: boolean;
  resolve: (r: ApplyResult) => void;
}

/**
 * Single-writer, in-memory store for tenant config.
 *
 * - All mutations go through `apply()` / `applyInternal()`. An internal FIFO
 *   worker drains pending applies one at a time, so two concurrent PUT
 *   /config requests compose deterministically (last write wins on the same
 *   field).
 * - `subscribe()` listeners run synchronously inside the worker after each
 *   applied change. Subscribers must return immediately — slow handlers
 *   stall the queue.
 * - Nothing is persisted: `.decocms/daemon.json` is read-only at boot and
 *   any further state lives only in memory until the next daemon restart.
 */
export class TenantConfigStore {
  private current: EnrichedTenantConfig | null = null;
  private readonly subscribers = new Set<(e: ApplyEvent) => void>();
  private readonly queue: QueueEntry[] = [];
  private draining = false;

  read(): EnrichedTenantConfig | null {
    return this.current;
  }

  /**
   * Bootstrap the in-memory state from a value already on disk (or seeded
   * from env). Does NOT classify, persist, or notify subscribers — purely
   * loads memory. Used once during daemon boot, before the HTTP server
   * accepts requests, so it can safely skip the apply queue.
   */
  hydrate(config: TenantConfig): void {
    this.current = enrich(config);
  }

  /**
   * Drop in-memory state. Used on orchestrator failure to reset to
   * "awaiting fresh bootstrap."
   */
  clear(): void {
    this.current = null;
  }

  apply(patch: Partial<TenantConfig>): Promise<ApplyResult> {
    return new Promise((resolve) => {
      this.queue.push({ patch, resolve });
      void this.drain();
    });
  }

  /**
   * Apply a patch computed from the post-queue state without notifying
   * subscribers. The orchestrator uses this during bootstrap to fill missing
   * fields (lockfile-detected pm/runtime, disk fallback) without re-emitting
   * pm-change/runtime-change — it already runs install+start in the same
   * pass, so a fresh transition would re-trigger them.
   *
   * `compute` runs inside the queue worker, AFTER any earlier queued applies
   * have settled. This eliminates the race where reading state out-of-band
   * and then writing it back would clobber a concurrent PUT.
   *
   * Return `null` from `compute` to skip the apply (no-op).
   */
  applyInternal(compute: Compute): Promise<ApplyResult> {
    return new Promise((resolve) => {
      this.queue.push({ compute, silent: true, resolve });
      void this.drain();
    });
  }

  subscribe(fn: (e: ApplyEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const entry = this.queue.shift();
        if (!entry) break;
        try {
          entry.resolve(await this.runOne(entry));
        } catch {
          entry.resolve({
            kind: "rejected",
            reason: REJECTION_REASONS.APPLY_FAILED,
          });
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async runOne(entry: QueueEntry): Promise<ApplyResult> {
    const before = this.current ? plainConfig(this.current) : null;
    const patch = entry.compute ? entry.compute(before) : entry.patch;
    if (!patch) {
      return {
        kind: "applied",
        before,
        after: before ?? {},
        transition: { kind: "no-op" },
      };
    }
    const merged = deepMerge(before, patch);

    const validation = validateTenantConfig(merged);
    if (validation.kind === "invalid") {
      return { kind: "rejected", reason: REJECTION_REASONS.INVALID };
    }

    const transition = classify(before, merged);
    if (transition.kind === "identity-conflict") {
      return {
        kind: "rejected",
        reason: REJECTION_REASONS.IMMUTABLE,
        detail: transition.field,
      };
    }

    if (transition.kind === "no-op") {
      return {
        kind: "applied",
        before,
        after: merged,
        transition,
      };
    }

    this.current = enrich(merged);

    if (!entry.silent) {
      const event: ApplyEvent = { before, after: merged, transition };
      for (const sub of this.subscribers) {
        try {
          sub(event);
        } catch {
          /* one bad subscriber does not stall the queue */
        }
      }
    }

    return {
      kind: "applied",
      before,
      after: merged,
      transition,
    };
  }
}

/** Strip in-memory derived fields when reading "before" out of state. */
function plainConfig(enriched: EnrichedTenantConfig): TenantConfig {
  return {
    git: enriched.git,
    application: enriched.application,
  };
}
