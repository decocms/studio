/**
 * PartEmitter — v2 (stream-of-record) write path.
 *
 * Persists the AI-SDK message `parts` array into the append-only
 * `thread_message_parts` table, one row per part, plus a `finish` anchor per
 * message. The v2 read path (`Memory.loadHistory` / `foldParts`) groups rows
 * by `message_id`, orders within a message by `seq`, and folds each row's
 * `payload` back into `parts: [...]` — so each row's `payload` MUST be exactly
 * one element of the source `parts` array.
 *
 * ## Correctness invariants
 *
 * **Only FINAL parts are persisted.** A still-streaming text/reasoning part
 * (`state: 'streaming'`) or a tool call that hasn't reached a terminal output
 * state is never frozen — `isFinalPart` gates this. The natural emit points:
 *   - `emitStepParts(responseMessage)` at each `onStepFinish`: the just-finished
 *     step's parts are final, so any newly-final parts get persisted. AI-SDK's
 *     `responseMessage.parts` is CUMULATIVE (grows across steps), so we walk the
 *     whole array each time and rely on idempotency + the final-gate to only
 *     write each part once, when it first becomes final.
 *   - `emitFinal(responseMessage)` at `onFinish`: persist any remaining final
 *     parts, then a single `finish` marker for the assistant message.
 *   - `emitRequestMessage(message)` at the `/messages` durable request save.
 *   - `emitError(messageId, role, parts)` at `onError`: an `error` part + finish.
 *
 * **Deterministic, idempotent ids.** Row id = `${runId}:${messageId}:${seq}`.
 * `seq` is a per-MESSAGE counter (each PartRowBuilder/message restarts at 0),
 * but it is NOT a naive "next int per call": the SAME logical part (identified
 * by `${message_id}#${indexInMessage}`) is always assigned the SAME `seq`,
 * memoized in `seqByPart`. So a part that is `input-available` (skipped) at
 * step N and `output-available` (emitted) at step N+1 lands at one stable id,
 * and re-emits across retries/resumes hit `ON CONFLICT (id) DO NOTHING`. The
 * `messageId` segment is what keeps parts of DIFFERENT messages disjoint even
 * when seq collides — e.g. the user message and assistant message of one pull
 * turn both start at seq 0 under the same `runId == threadId`. Because
 * `messageId` is
 * globally unique, the `id` primary key alone guarantees row uniqueness; there
 * is no longer a UNIQUE `(run_id, seq)` index (dropped in migration 106).
 *
 * **Monotonic created_at from seq.** `created_at = base + seq` (ms), NOT
 * `Date.now()` per part. The fold orders messages by their first part's
 * `created_at`; deriving it from the monotonic seq keeps user-before-assistant
 * ordering stable and avoids the C5 reordering hazard of wall-clock-per-part.
 *
 * `payload_ref` stays null — payloads are inline (claim-check is a later phase).
 */

import type { SqlThreadMessagePartStorage } from "@/storage/thread-message-parts";
import type { ThreadMessagePart } from "@/storage/fold-parts";
import {
  type AnyMessage,
  isFinalPart,
  PartRowBuilder,
} from "./part-row-builder";

export { isFinalPart };

export interface PartEmitterCtx {
  storage: SqlThreadMessagePartStorage;
  orgId: string;
  threadId: string;
  runId: string;
  /**
   * Base epoch-ms for this run's `created_at` derivation. Defaults to
   * `Date.now()` at construction. Each emitted part's `created_at` is
   * `base + seq`, so ordering is driven by the monotonic seq, not wall clock.
   */
  baseTimeMs?: number;
}

export class PartEmitter {
  private readonly builder: PartRowBuilder;

  constructor(private readonly ctx: PartEmitterCtx) {
    this.builder = new PartRowBuilder(ctx);
  }

  private async appendBuiltRows(rows: ThreadMessagePart[]): Promise<void> {
    await this.ctx.storage.appendParts(rows);
    this.builder.acknowledge(rows);
  }

  /** @deprecated Use `emitRequestMessage` for the `/messages` request boundary. */
  async emitUserMessage(message: AnyMessage): Promise<void> {
    await this.appendBuiltRows(this.builder.emitUserMessage(message));
  }

  /**
   * Durable request save: replace the submitted message snapshot with every
   * request part plus a `finish` anchor so dispatch can reload exactly what the
   * client posted. Projection paths still use final-only append methods below.
   */
  async emitRequestMessage(message: AnyMessage): Promise<void> {
    const rows = this.builder.emitRequestMessage(message);
    await this.ctx.storage.replaceMessageParts(
      this.ctx.threadId,
      message.id,
      rows,
    );
    this.builder.acknowledge(rows);
  }

  /**
   * `onStepFinish`: persist any newly-final parts of the assistant message.
   * No `finish` marker yet — the message may continue in later steps.
   */
  async emitStepParts(message: AnyMessage): Promise<void> {
    await this.appendBuiltRows(this.builder.emitStepParts(message));
  }

  /**
   * `onFinish`: persist remaining final parts, then close the assistant
   * message with a single `finish` anchor.
   */
  async emitFinal(message: AnyMessage): Promise<void> {
    await this.appendBuiltRows(this.builder.emitFinal(message));
  }

  /**
   * Terminal projector write: replace the folded assistant snapshot. This is
   * needed for approval continuations, where `/messages` has already persisted
   * the same assistant message id with an `approval-responded` tool part and
   * the terminal projection must rewrite it as `output-available` + final text.
   *
   * Uses `emitFinalSnapshot` (the COMPLETE message, dedup-set-ignoring) rather
   * than `emitFinal` (the not-yet-acknowledged delta): `replaceMessageParts`
   * deletes the whole message first, so inserting only the delta would drop any
   * content an earlier `emitStepParts` already persisted in this same pass.
   */
  async replaceFinal(message: AnyMessage): Promise<void> {
    const rows = this.builder.emitFinalSnapshot(message);
    await this.ctx.storage.replaceMessageParts(
      this.ctx.threadId,
      message.id,
      rows,
    );
    this.builder.acknowledge(rows);
  }

  /**
   * `onError`: persist an `error` part for the assistant message and close it
   * with a `finish` anchor so the thread renders the failure rather than a
   * dangling in-progress message.
   */
  async emitError(messageId: string, errorText: string): Promise<void> {
    await this.appendBuiltRows(this.builder.emitError(messageId, errorText));
  }
}
