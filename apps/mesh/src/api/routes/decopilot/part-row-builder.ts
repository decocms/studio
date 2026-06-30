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
    // Persist terminal output states and terminal "requires action" pauses.
    // Generic input-available tools are still in-flight, but user_ask
    // input-available and approval-requested are the durable state the UI needs
    // after reload to let the user continue the run.
    return (
      part.state === "approval-requested" ||
      (type === "tool-user_ask" && part.state === "input-available") ||
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

  /** True once any content/error part of `messageId` has been handed off. */
  private hasEmittedContentFor(messageId: string): boolean {
    const prefix = `${messageId}#`;
    for (const key of this.emitted) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
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

  /**
   * Emit the submitted request snapshot exactly enough for durable reload.
   * Unlike assistant projection, this stores approval/input states because they
   * are user/assistant request data for the next model step, not final output.
   */
  private emitRequestMessageParts(message: AnyMessage): ThreadMessagePart[] {
    const parts = (message.parts ?? []) as AnyPart[];
    const rows: ThreadMessagePart[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const key = `${message.id}#${i}`;

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

  private markRequestFinished(
    messageId: string,
    role: AnyMessage["role"],
    metadata: unknown | null = null,
  ): ThreadMessagePart[] {
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

  emitRequestMessage(message: AnyMessage): ThreadMessagePart[] {
    return [
      ...this.emitRequestMessageParts(message),
      ...this.markRequestFinished(
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
    const contentRows = this.emitMessageParts(message);
    // A finish anchor with no content part folds to an empty message
    // (`parts: []`, status "complete") — a blank assistant bubble. Skip the
    // anchor entirely when the message produced no renderable part (now or in
    // an earlier step), so the empty message is never persisted at all.
    if (contentRows.length === 0 && !this.hasEmittedContentFor(message.id)) {
      return contentRows;
    }
    return [
      ...contentRows,
      ...this.markFinished(
        message.id,
        message.role,
        (message as { metadata?: unknown }).metadata ?? null,
      ),
    ];
  }

  /**
   * Build the COMPLETE final snapshot of a message — every final part (in its
   * current terminal state) plus the `finish` anchor — IGNORING this builder's
   * `emitted`/`finished` dedup sets.
   *
   * `PartEmitter.replaceFinal` deletes the whole message before re-inserting, so
   * it MUST insert the FULL snapshot, not the not-yet-acknowledged delta that
   * {@link emitFinal} returns. If an earlier `emitStepParts` in the same pass
   * already appended (and acknowledged) the content, `emitFinal` would return
   * only the finish anchor and the delete-then-insert would silently WIPE that
   * content — leaving a content-less assistant bubble. Re-deriving the full
   * snapshot here (stable seqs via `seqFor`, so ids stay idempotent) keeps the
   * replace complete, and also upgrades any part whose state advanced since it
   * was first emitted (e.g. a tool `input-available` → `output-available`).
   */
  emitFinalSnapshot(message: AnyMessage): ThreadMessagePart[] {
    const parts = (message.parts ?? []) as AnyPart[];
    const rows: ThreadMessagePart[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (!isFinalPart(part)) continue;
      const key = `${message.id}#${i}`;
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
    // Same blank-bubble guard as emitFinal: a finish anchor with no content
    // folds to an empty assistant bubble. Skip it when there is genuinely no
    // renderable part (in this snapshot or acknowledged earlier in this pass).
    if (rows.length === 0 && !this.hasEmittedContentFor(message.id)) {
      return rows;
    }
    const finishSeq = this.seqFor(`${message.id}#finish`);
    const finishRow = this.row(
      message.id,
      message.role,
      finishSeq,
      "finish",
      {},
      (message as { metadata?: unknown }).metadata ?? null,
    );
    this.finishMessageIdByRowId.set(finishRow.id, message.id);
    return [...rows, finishRow];
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
