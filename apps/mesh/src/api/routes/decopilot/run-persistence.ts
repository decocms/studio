/**
 * Canonical run-message persistence factory.
 *
 * Every path that writes an assistant message to `thread_message_parts` — the
 * hosted live path (`dispatch-run`), the relay live path (`link-ingest`), the
 * durable projector's terminal pass, and the projector's incremental checkpoint
 * pass — MUST agree on two things or the same logical message lands twice (or
 * sorts wrong):
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
 *      message.
 *
 * Before this helper each site re-derived the base inline and they had already
 * drifted (the checkpoint pass omitted it entirely, defaulting to `Date.now()`
 * and re-opening the ordering bug for late checkpoints). Routing everyone
 * through here makes that drift unrepresentable.
 */

import type { SqlThreadMessagePartStorage } from "@/storage/thread-message-parts";
import type { HarnessStreamPersistence } from "./consume-harness-stream";
import { PartEmitter } from "./part-emitter";

export interface AssistantEmitterArgs {
  messageParts: SqlThreadMessagePartStorage;
  orgId: string;
  /** runId === threadId by convention (a thread hosts one run id per turn). */
  runId: string;
}

/**
 * Build the canonical assistant {@link PartEmitter} for a run: fresh per-message
 * seqs from 0 and `baseTimeMs = max(existing created_at) + 1`. This is the one
 * place that computes the assistant base; every writer derives it identically.
 */
export async function createAssistantEmitter(
  args: AssistantEmitterArgs,
): Promise<PartEmitter> {
  const maxExistingMs = await args.messageParts.maxCreatedAtMsForRun(
    args.runId,
  );
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
   * `true` (default) → terminal pass: writes step parts AND closes the message
   * with a finish/error anchor. `false` → checkpoint pass: writes step parts
   * only, leaving the finish anchor to the terminal pass so checkpoint writes
   * are strictly additive.
   */
  terminal?: boolean;
}

/**
 * {@link HarnessStreamPersistence} over the canonical assistant emitter. Use
 * `terminal: false` for non-terminal (checkpoint) projection passes.
 */
export async function createRunPersistence(
  args: RunPersistenceArgs,
): Promise<HarnessStreamPersistence> {
  const emitter = await createAssistantEmitter(args);
  const terminal = args.terminal ?? true;
  return {
    emitStepParts: (message) => emitter.emitStepParts(message),
    emitFinal: terminal
      ? (message) => emitter.emitFinal(message)
      : async () => {},
    emitError: terminal
      ? (messageId, errorText) => emitter.emitError(messageId, errorText)
      : async () => {},
  };
}
