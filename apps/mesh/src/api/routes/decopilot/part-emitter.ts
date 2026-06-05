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
 *   - `emitUserMessage(message)` at the initial user-message save.
 *   - `emitError(messageId, role, parts)` at `onError`: an `error` part + finish.
 *
 * **Deterministic, idempotent ids.** Row id = `${runId}:${seq}`. `seq` is a
 * per-run counter, but it is NOT a naive "next int per call": the SAME logical
 * part (identified by `${message_id}#${indexInMessage}`) is always assigned the
 * SAME `seq`, memoized in `seqByPart`. So a part that is `input-available`
 * (skipped) at step N and `output-available` (emitted) at step N+1 lands at one
 * stable id, and re-emits across retries/resumes hit `ON CONFLICT (id) DO
 * NOTHING`. This also satisfies the UNIQUE `(run_id, seq)` index: each logical
 * part owns exactly one seq for the life of the run.
 *
 * **Monotonic created_at from seq.** `created_at = base + seq` (ms), NOT
 * `Date.now()` per part. The fold orders messages by their first part's
 * `created_at`; deriving it from the monotonic seq keeps user-before-assistant
 * ordering stable and avoids the C5 reordering hazard of wall-clock-per-part.
 *
 * `payload_ref` stays null — payloads are inline (claim-check is a later phase).
 */

import type { SqlThreadMessagePartStorage } from "@/storage/thread-message-parts";
import type { PartKind, ThreadMessagePart } from "@/storage/fold-parts";

type AnyPart = { type?: string; state?: string } & Record<string, unknown>;
type AnyMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  parts?: unknown[];
};

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

/**
 * True when a part has reached a terminal/renderable state and is safe to
 * freeze. Streaming text/reasoning and in-flight tool calls return false.
 */
export function isFinalPart(part: AnyPart): boolean {
  const type = part.type;
  if (typeof type !== "string") return false;

  if (type === "text" || type === "reasoning") {
    // `state` is 'streaming' | 'done' (may be absent on a step-final snapshot).
    return part.state !== "streaming";
  }

  if (type === "step-start") {
    // Never persisted (folded away as a boundary marker), but treat as final.
    return false;
  }

  if (type.startsWith("tool-") || type === "dynamic-tool") {
    // Final only at a terminal output state. Anything earlier
    // (input-streaming/input-available/approval-*) is still in flight.
    return (
      part.state === "output-available" ||
      part.state === "output-error" ||
      part.state === "output-denied"
    );
  }

  // file / source-url / source-document / data-* — terminal by nature.
  return true;
}

/** Map an AI-SDK part `type` to the storage `PartKind` taxonomy. */
function kindForPart(part: AnyPart): PartKind {
  const type = part.type ?? "";
  if (type === "reasoning") return "reasoning";
  if (type === "file") return "file";
  if (type.startsWith("tool-") || type === "dynamic-tool") {
    return part.state === "output-available" ||
      part.state === "output-error" ||
      part.state === "output-denied"
      ? "tool_result"
      : "tool_call";
  }
  // text, source-*, data-* and anything else render as text-equivalent payloads.
  return "text";
}

export class PartEmitter {
  private readonly base: number;
  /** `${messageId}#${index}` → assigned seq (stable per logical part). */
  private readonly seqByPart = new Map<string, number>();
  /** Message ids for which the `finish` anchor has already been emitted. */
  private readonly finished = new Set<string>();
  private nextSeq = 0;

  constructor(private readonly ctx: PartEmitterCtx) {
    this.base = ctx.baseTimeMs ?? Date.now();
  }

  /** Allocate (or reuse) the stable seq for a logical part. */
  private seqFor(messageId: string, index: number): number {
    const key = `${messageId}#${index}`;
    const existing = this.seqByPart.get(key);
    if (existing !== undefined) return existing;
    const seq = this.nextSeq++;
    this.seqByPart.set(key, seq);
    return seq;
  }

  private row(
    messageId: string,
    role: AnyMessage["role"],
    seq: number,
    kind: PartKind,
    payload: unknown,
  ): ThreadMessagePart {
    return {
      id: `${this.ctx.runId}:${seq}`,
      seq,
      org_id: this.ctx.orgId,
      thread_id: this.ctx.threadId,
      run_id: this.ctx.runId,
      message_id: messageId,
      role,
      kind,
      payload,
      payload_ref: null,
      metadata: null,
      // Monotonic per run, derived from seq (NOT Date.now() per part).
      created_at: new Date(this.base + seq).toISOString(),
    };
  }

  /**
   * Emit the FINAL parts of a message that are not yet persisted. Walks the
   * (cumulative) `parts` array; idempotent via stable seq + ON CONFLICT.
   * Does NOT emit a `finish` marker — call `markFinished` for that.
   */
  private async emitMessageParts(message: AnyMessage): Promise<void> {
    const parts = (message.parts ?? []) as AnyPart[];
    const rows: ThreadMessagePart[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (!isFinalPart(part)) continue;
      const seq = this.seqFor(message.id, i);
      rows.push(
        this.row(message.id, message.role, seq, kindForPart(part), part),
      );
    }
    if (rows.length > 0) await this.ctx.storage.appendParts(rows);
  }

  /** Append the single `finish` anchor for a message (idempotent). */
  private async markFinished(
    messageId: string,
    role: AnyMessage["role"],
  ): Promise<void> {
    if (this.finished.has(messageId)) return;
    this.finished.add(messageId);
    const seq = this.seqFor(`${messageId}#finish`, 0);
    await this.ctx.storage.appendParts([
      this.row(messageId, role, seq, "finish", {}),
    ]);
  }

  /**
   * Initial user-message save: persist the user's parts + a `finish` anchor so
   * the message is immediately complete in the v2 read path.
   */
  async emitUserMessage(message: AnyMessage): Promise<void> {
    await this.emitMessageParts(message);
    await this.markFinished(message.id, message.role);
  }

  /**
   * `onStepFinish`: persist any newly-final parts of the assistant message.
   * No `finish` marker yet — the message may continue in later steps.
   */
  async emitStepParts(message: AnyMessage): Promise<void> {
    await this.emitMessageParts(message);
  }

  /**
   * `onFinish`: persist remaining final parts, then close the assistant
   * message with a single `finish` anchor.
   */
  async emitFinal(message: AnyMessage): Promise<void> {
    await this.emitMessageParts(message);
    await this.markFinished(message.id, message.role);
  }

  /**
   * `onError`: persist an `error` part for the assistant message and close it
   * with a `finish` anchor so the thread renders the failure rather than a
   * dangling in-progress message.
   */
  async emitError(messageId: string, errorText: string): Promise<void> {
    const seq = this.seqFor(`${messageId}#error`, 0);
    await this.ctx.storage.appendParts([
      this.row(messageId, "assistant", seq, "error", {
        type: "text",
        text: `Error: ${errorText}`,
      }),
    ]);
    await this.markFinished(messageId, "assistant");
  }
}
