import type { UIMessage, UIMessageChunk } from "ai";
import { exponentialBackoffWithJitter, sleep } from "@decocms/std";
import type { HarnessStreamPersistence } from "./consume-harness-stream";
import { synthesizedErrorMessageId } from "./message-ids";
import {
  projectChunks,
  type ProjectChunksResult,
  type ProjectTitleOptions,
} from "./project-chunks";

/** Attempts before a run's projection is declared poison and DLQ'd (spec §5.4
 *  poison-event policy). Bounded so one bad run never stalls the consumer. */
export const PROJECT_RUN_MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 100;
const BACKOFF_CAP_MS = 5000;

export interface ProjectRunOptions {
  runId: string;
  /** Per-turn run fence token. Namespaces the assistant/error message ids so
   *  distinct turns of the same thread (runId == threadId is stable) never
   *  collide while the same turn's re-folds stay idempotent. See message-ids.ts. */
  fenceToken: string;
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
  /**
   * Prior completed messages to seed createUIMessageStream. Forwarded to
   * projectChunks → consumeHarnessStream. Omitted → fresh fold (default).
   */
  originalMessages?: UIMessage[];
}

export interface ProjectRunResult {
  ok: boolean;
  attempts: number;
  /**
   * Populated on the `ok:true` branch with the harness verdict from
   * `projectChunks`. `outcome.failed=true` means the run ended with an in-band
   * error chunk (not a persistence/infra error — those cause `ok:false`).
   * The workflow's markRunFailed step reads this to mark the run `failed`
   * in the DB (Task 6).
   */
  outcome?: ProjectChunksResult;
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
      const outcome = await projectChunks({
        chunks: (async function* () {
          yield* options.chunks;
        })(),
        persistence: options.persistence,
        sanitizeErrorText: options.sanitizeErrorText,
        // Deterministic per turn so an error message dedupes across this loop's
        // attempts, DBOS step retries, and the live-path write (same id) while
        // distinct turns never collide.
        errorMessageId: synthesizedErrorMessageId(
          options.runId,
          options.fenceToken,
        ),
        title: options.title,
        originalMessages: options.originalMessages,
      });
      return { ok: true, attempts: attempt + 1, outcome };
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
