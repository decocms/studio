/**
 * RunRegistry — in-memory registry of active Decopilot runs
 *
 * Tracks running streamText loops by threadId so they survive client disconnect.
 * Cancel is propagated via NATS to the pod that owns the run.
 */

import type { ThreadStoragePort } from "@/storage/ports";

export interface ActiveRun {
  threadId: string;
  orgId: string;
  userId: string;
  abortController: AbortController;
  status: "running" | "completed" | "failed";
  startedAt: Date;
}

const REAP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RUN_AGE_MS = 30 * 60 * 1000; // 30 minutes

export class RunRegistry {
  private readonly runs = new Map<string, ActiveRun>();
  private reaperTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.reaperTimer = setInterval(
      () => this.reapStaleRuns(),
      REAP_INTERVAL_MS,
    );
  }

  private reapStaleRuns(): void {
    const now = Date.now();
    for (const [threadId, run] of this.runs) {
      if (
        run.status === "running" &&
        now - run.startedAt.getTime() > MAX_RUN_AGE_MS
      ) {
        console.warn(
          `[RunRegistry] Reaping stale run for thread ${threadId} (age: ${Math.round((now - run.startedAt.getTime()) / 60_000)}min)`,
        );
        run.status = "failed";
        run.abortController.abort();
        this.runs.delete(threadId);
      }
    }
  }

  startRun(threadId: string, orgId: string, userId: string): ActiveRun {
    const existing = this.runs.get(threadId);
    if (existing) {
      if (existing.status === "running") {
        existing.abortController.abort();
      }
      existing.status = "failed";
      this.runs.delete(threadId);
    }
    const run: ActiveRun = {
      threadId,
      orgId,
      userId,
      abortController: new AbortController(),
      status: "running",
      startedAt: new Date(),
    };
    this.runs.set(threadId, run);
    return run;
  }

  getRun(threadId: string): ActiveRun | undefined {
    return this.runs.get(threadId);
  }

  cancelLocal(threadId: string): boolean {
    const run = this.runs.get(threadId);
    if (!run || run.status !== "running") return false;
    run.status = "failed";
    this.runs.delete(threadId);
    run.abortController.abort();
    return true;
  }

  completeRun(threadId: string, status: "completed" | "failed"): void {
    const run = this.runs.get(threadId);
    if (run) {
      run.status = status;
      this.runs.delete(threadId);
    }
  }

  /**
   * Finish a run: update status, remove from registry, and purge stream buffer.
   * Unifies completeRun + purge into a single call to avoid split call sites.
   */
  finishRun(
    threadId: string,
    status: "completed" | "failed",
    onPurge?: (threadId: string) => void,
  ): void {
    this.completeRun(threadId, status);
    onPurge?.(threadId);
  }

  stopAll(storage: ThreadStoragePort): void {
    for (const [threadId, run] of this.runs) {
      if (run.status === "running") {
        run.abortController.abort();
        storage.update(threadId, { status: "failed" }).catch(() => {});
      }
    }
    this.runs.clear();
  }

  dispose(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }
}
