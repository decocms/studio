/**
 * Canonical run-message persistence factory.
 *
 * Every path that writes an assistant message to `thread_message_parts` — the
 * hosted live path (`dispatch-run`), the relay live path (`link-ingest`), and
 * the durable projector's terminal pass — MUST agree on two things or the same
 * logical message lands twice (or sorts wrong):
 *
 *   1. **Row ids / dedup.** Row id is `${runId}:${messageId}:${seq}` with `seq`
 *      a per-message counter that restarts at 0. A fresh {@link PartEmitter}
 *      (assistant-only) always assigns the same seqs, so independent writers
 *      produce byte-identical ids and `appendParts`' `ON CONFLICT DO NOTHING`
 *      dedupes them. This invariant lives in `PartRowBuilder` and is unit-tested
 *      in `part-row-builder.test.ts`.
 *
 *   2. **`created_at` base.** Each part's `created_at = base + seq`. Whoever
 *      inserts a given row first wins its `created_at` (ON CONFLICT keeps it).
 *      Seeding `base = max(existing created_at for run) + 1` keeps the assistant
 *      strictly after its own user message and prior turns no matter how late
 *      the writer runs — without it a backlogged/redelivered write would stamp
 *      a wall-clock `Date.now()` that can sort after a *later* turn's user
 *      message. When the request `messageId` is known, the base is instead
 *      seeded from THAT message's own max — anchoring the reply right after its
 *      own user message even when a queued turn's projection runs after later
 *      turns have already been persisted under the same run (== thread).
 *
 * Before this helper each site re-derived the base inline and they had already
 * drifted (one omitted it entirely, defaulting to `Date.now()` and re-opening
 * the ordering bug for late writes). Routing everyone through here makes that
 * drift unrepresentable.
 */

import type { SqlThreadMessagePartStorage } from "@/storage/thread-message-parts";
import type { HarnessStreamPersistence } from "./consume-harness-stream";
import { PartEmitter } from "./part-emitter";

export interface AssistantEmitterArgs {
  messageParts: SqlThreadMessagePartStorage;
  orgId: string;
  /** runId === threadId by convention (a thread hosts one run id per turn). */
  runId: string;
  /**
   * The turn's user message id; when set, the assistant base is that
   * message's own max created_at so the reply anchors right after it instead
   * of after later-queued turns.
   */
  requestMessageId?: string;
}

/**
 * Build the canonical assistant {@link PartEmitter} for a run: fresh per-message
 * seqs from 0 and `baseTimeMs = max(existing created_at) + 1`. This is the one
 * place that computes the assistant base; every writer derives it identically.
 */
async function createAssistantEmitter(
  args: AssistantEmitterArgs,
): Promise<PartEmitter> {
  // Prefer the request message's OWN max: anchors the reply right after its user
  // message, excluding later-queued turns that share run_id (== threadId). Fall
  // back to the run-wide max when no messageId is threaded (legacy callers) or
  // the message has no parts yet.
  const maxForMessage = args.requestMessageId
    ? await args.messageParts.maxCreatedAtMsForMessage(
        args.runId,
        args.requestMessageId,
      )
    : null;
  const maxExistingMs =
    maxForMessage ?? (await args.messageParts.maxCreatedAtMsForRun(args.runId));
  return new PartEmitter({
    storage: args.messageParts,
    orgId: args.orgId,
    threadId: args.runId,
    runId: args.runId,
    baseTimeMs: (maxExistingMs ?? Date.now()) + 1,
  });
}

export interface RunPersistenceArgs extends AssistantEmitterArgs {
  /**
   * Terminal projection may need to overwrite an already-persisted assistant
   * snapshot for the same message id (approval response → final tool output).
   */
  replaceFinal?: boolean;
}

/**
 * {@link HarnessStreamPersistence} over the canonical assistant emitter. The
 * durable projector folds a run once, at the terminal `{done}`: each pass writes
 * the step parts and closes the message with a finish/error anchor.
 */
export async function createRunPersistence(
  args: RunPersistenceArgs,
): Promise<HarnessStreamPersistence> {
  const emitter = await createAssistantEmitter(args);
  const emitFinal = args.replaceFinal
    ? (message: Parameters<HarnessStreamPersistence["emitFinal"]>[0]) =>
        emitter.replaceFinal(message)
    : (message: Parameters<HarnessStreamPersistence["emitFinal"]>[0]) =>
        emitter.emitFinal(message);
  return {
    emitStepParts: (message) => emitter.emitStepParts(message),
    emitFinal,
    emitError: (messageId, errorText) =>
      emitter.emitError(messageId, errorText),
  };
}
