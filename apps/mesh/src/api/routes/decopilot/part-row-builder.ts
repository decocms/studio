import type { PartKind, ThreadMessagePart } from "@/storage/fold-parts";

export type AnyPart = { type?: string; state?: string } & Record<
  string,
  unknown
>;

export type AnyMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  parts?: unknown[];
};

export interface PartRowBuilderCtx {
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

export class PartRowBuilder {
  private readonly base: number;
  /** `${messageId}#${index}` → assigned seq (stable per logical part). */
  private readonly seqByPart = new Map<string, number>();
  /** Logical part keys that have been successfully handed off by this builder. */
  private readonly emitted = new Set<string>();
  /** Message ids for which the `finish` anchor has been successfully handed off. */
  private readonly finished = new Set<string>();
  /** Row id → logical part key, used to commit pending rows after persistence. */
  private readonly partKeyByRowId = new Map<string, string>();
  /** Row id → message id, used to commit pending finish anchors after persistence. */
  private readonly finishMessageIdByRowId = new Map<string, string>();
  private nextSeq = 0;

  constructor(private readonly ctx: PartRowBuilderCtx) {
    this.base = ctx.baseTimeMs ?? Date.now();
  }

  /** Allocate (or reuse) the stable seq for a logical part. */
  private seqFor(key: string): number {
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
    metadata: unknown | null = null,
  ): ThreadMessagePart {
    return {
      // Per-MESSAGE-scoped id: seq restarts at 0 per builder (per message), so
      // the runId+seq pair alone is NOT unique across messages of one run (e.g.
      // the user message and the assistant message of a pull turn each start at
      // seq 0). The messageId segment keeps them disjoint while same-message
      // re-emits (same messageId + same seq) stay idempotent for ON CONFLICT.
      id: `${this.ctx.runId}:${messageId}:${seq}`,
      seq,
      org_id: this.ctx.orgId,
      thread_id: this.ctx.threadId,
      run_id: this.ctx.runId,
      message_id: messageId,
      role,
      kind,
      payload,
      payload_ref: null,
      metadata,
      // Monotonic per run, derived from seq (NOT Date.now() per part).
      created_at: new Date(this.base + seq).toISOString(),
    };
  }

  /**
   * Emit the FINAL parts of a message that have not been acknowledged. Walks the
   * cumulative `parts` array; pending rows repeat until `acknowledge` is called.
   */
  private emitMessageParts(message: AnyMessage): ThreadMessagePart[] {
    const parts = (message.parts ?? []) as AnyPart[];
    const rows: ThreadMessagePart[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (!isFinalPart(part)) continue;

      const key = `${message.id}#${i}`;
      if (this.emitted.has(key)) continue;

      const seq = this.seqFor(key);
      const row = this.row(
        message.id,
        message.role,
        seq,
        kindForPart(part),
        part,
      );
      this.partKeyByRowId.set(row.id, key);
      rows.push(row);
    }
    return rows;
  }

  /** Return the single `finish` anchor for a message until it is acknowledged. */
  private markFinished(
    messageId: string,
    role: AnyMessage["role"],
    metadata: unknown | null = null,
  ): ThreadMessagePart[] {
    if (this.finished.has(messageId)) return [];
    const seq = this.seqFor(`${messageId}#finish`);
    const row = this.row(messageId, role, seq, "finish", {}, metadata);
    this.finishMessageIdByRowId.set(row.id, messageId);
    return [row];
  }

  /**
   * Commit rows that have been successfully handed off to durable storage or a
   * desktop batcher. Rows are intentionally not committed during `emit*` so a
   * failed handoff can retry and receive the same deterministic rows again.
   */
  acknowledge(rows: ThreadMessagePart[]): void {
    for (const row of rows) {
      const partKey = this.partKeyByRowId.get(row.id);
      if (partKey !== undefined) this.emitted.add(partKey);

      const finishMessageId = this.finishMessageIdByRowId.get(row.id);
      if (finishMessageId !== undefined) this.finished.add(finishMessageId);
    }
  }

  /**
   * Initial user-message save: persist the user's parts + a `finish` anchor so
   * the message is immediately complete in the v2 read path.
   */
  emitUserMessage(message: AnyMessage): ThreadMessagePart[] {
    return [
      ...this.emitMessageParts(message),
      ...this.markFinished(
        message.id,
        message.role,
        (message as { metadata?: unknown }).metadata ?? null,
      ),
    ];
  }

  /**
   * `onStepFinish`: persist any newly-final parts of the assistant message.
   * No `finish` marker yet — the message may continue in later steps.
   */
  emitStepParts(message: AnyMessage): ThreadMessagePart[] {
    return this.emitMessageParts(message);
  }

  /**
   * `onFinish`: persist remaining final parts, then close the assistant
   * message with a single `finish` anchor. The message metadata (usage,
   * codingAgentSessionId, etc.) is carried on the finish anchor row so the
   * v2 fold path can surface it on `FoldedMessage.metadata`.
   */
  emitFinal(message: AnyMessage): ThreadMessagePart[] {
    return [
      ...this.emitMessageParts(message),
      ...this.markFinished(
        message.id,
        message.role,
        (message as { metadata?: unknown }).metadata ?? null,
      ),
    ];
  }

  /**
   * `onError`: persist an `error` part for the assistant message and close it
   * with a `finish` anchor so the thread renders the failure rather than a
   * dangling in-progress message.
   */
  emitError(messageId: string, errorText: string): ThreadMessagePart[] {
    const key = `${messageId}#error`;
    const rows: ThreadMessagePart[] = [];
    if (!this.emitted.has(key)) {
      const seq = this.seqFor(key);
      const row = this.row(messageId, "assistant", seq, "error", {
        type: "text",
        text: `Error: ${errorText}`,
      });
      this.partKeyByRowId.set(row.id, key);
      rows.push(row);
    }
    return [...rows, ...this.markFinished(messageId, "assistant")];
  }
}
