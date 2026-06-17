import type { UIMessageChunk } from "ai";
import { exponentialBackoffWithJitter, sleep } from "@decocms/std";
import type { HarnessStreamPersistence } from "./consume-harness-stream";
import { projectChunks, type ProjectTitleOptions } from "./project-chunks";

/** Attempts before a run's projection is declared poison and DLQ'd (spec §5.4
 *  poison-event policy). Bounded so one bad run never stalls the consumer. */
export const PROJECT_RUN_MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 100;
const BACKOFF_CAP_MS = 5000;

export interface ProjectRunOptions {
  runId: string;
  /** Materialized chunks for this run (replayed identically on each attempt;
   *  PartEmitter deterministic ids make re-projection idempotent). */
  chunks: UIMessageChunk[];
  persistence: HarnessStreamPersistence;
  /** Surface the poison run: DLQ + mark the run errored. Must not throw. */
  onDlq: (runId: string, error: unknown) => Promise<void>;
  sanitizeErrorText?: (error: unknown) => string;
  /** Delay calculator override (tests pass `() => 0`). */
  backoffMs?: (attempt: number) => number;
  /** When set, the projector persists the run's title chunk (sole writer). */
  title?: ProjectTitleOptions;
}

export interface ProjectRunResult {
  ok: boolean;
  attempts: number;
}

/**
 * Drive one run's projection with attempt-bounded retry + DLQ surface. On
 * exhaustion the run is sent to `onDlq` and `ok:false` is returned so the
 * consumer can ACK-to-unblock (the poison must not stall the durable consumer
 * or block later runs — spec §5.4 / §13-risks).
 */
export async function projectRun(
  options: ProjectRunOptions,
): Promise<ProjectRunResult> {
  const backoff =
    options.backoffMs ??
    ((attempt: number) =>
      exponentialBackoffWithJitter(
        BACKOFF_CAP_MS,
        BACKOFF_BASE_MS,
        attempt,
        2,
        0.5,
      ));
  let lastError: unknown = null;
  for (let attempt = 0; attempt < PROJECT_RUN_MAX_ATTEMPTS; attempt++) {
    try {
      await projectChunks({
        chunks: (async function* () {
          yield* options.chunks;
        })(),
        persistence: options.persistence,
        sanitizeErrorText: options.sanitizeErrorText,
        title: options.title,
      });
      return { ok: true, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      if (attempt < PROJECT_RUN_MAX_ATTEMPTS - 1) {
        await sleep(backoff(attempt));
      }
    }
  }
  await options
    .onDlq(options.runId, lastError)
    .catch((e) => console.error("[project-run] onDlq failed", e));
  return { ok: false, attempts: PROJECT_RUN_MAX_ATTEMPTS };
}
