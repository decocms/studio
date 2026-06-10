/**
 * Faithful canned harness-output chunk sequences for the chunk-relay return
 * path (protocol v2). A real desktop daemon relays its sandbox harness's raw
 * `UIMessageChunk`s wrapped as seq-numbered `RelayLine`s
 * ({seq, event: DispatchSSEEvent}) to
 *   POST /api/:org/links/runs/:runId/chunks
 * (see `links/protocol/relay.ts` + `link-daemon/chunk-relay.ts`). The
 * cluster-side `consumeRelayedRun` feeds them into the SAME harness kernel
 * (`consumeHarnessStream`) hosted runs use, so these fixtures double as the
 * conformance corpus: title/usage/parts/status/session all flow through one
 * code path regardless of whether the chunk source is in-process (hosted) or
 * daemon-relayed (pull).
 *
 * The chunk ORDER mirrors what a real harness emits per assistant turn:
 *   start → start-step → text-start → text-delta(s) → text-end
 *         → finish-step → finish
 * The `finish` chunk carries `messageMetadata` (usage + optional
 * codingAgentSessionId/codingAgentProvider), exactly as
 * `harnesses/cli-stream-metadata.ts` builds it. A transient
 * `data-title-result` chunk (if requested) is injected after `start` — the
 * cluster title interceptor swallows it, persists the title (gated on the
 * thread's current title being the default), and rebroadcasts a UI-facing
 * `data-thread-title` chunk.
 *
 * Wire shape per line: `{ seq, event: { type: "ui-message-chunk", chunk } }`,
 * terminated by `{ seq, event: { type: "done" } }` (or an `error` event for
 * the failure case). NDJSON, one JSON object per line, trailing newline.
 */

export interface HarnessTurnUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface BuildTurnOptions {
  /** Assistant message id; the text part id is derived from it. */
  messageId: string;
  /** Visible assistant text (single text part). */
  text: string;
  /** When set, a transient `data-title-result` chunk is injected after start. */
  title?: string;
  /** When set, the final `finish` chunk carries `messageMetadata.usage`. */
  usage?: HarnessTurnUsage;
  /**
   * When set, the final `finish` chunk carries `codingAgentSessionId` +
   * `codingAgentProvider: "claude-code"` — the shape `lookupResumeSessionRef`
   * reads back on the NEXT turn to populate `harnessInput.resumeSessionRef`.
   */
  codingAgentSessionId?: string;
}

/** A single UIMessageChunk wrapped as the daemon's relay event. */
function uiChunkEvent(chunk: unknown): unknown {
  return { type: "ui-message-chunk", chunk };
}

/**
 * Build the ordered list of relay EVENTS (pre-seq) for one assistant turn.
 * Factored out from the body builders so a turn's events can be composed
 * (e.g. with a terminal `done`/`error` line) before seq-numbering.
 */
function buildTurnEvents(opts: BuildTurnOptions): unknown[] {
  const textId = `${opts.messageId}-text-0`;
  const events: unknown[] = [];

  events.push(uiChunkEvent({ type: "start" }));

  // Transient title result lands right after start, like a real harness's
  // fast-model title side-channel.
  if (opts.title !== undefined) {
    events.push(
      uiChunkEvent({
        type: "data-title-result",
        data: { title: opts.title },
        transient: true,
      }),
    );
  }

  events.push(uiChunkEvent({ type: "start-step" }));
  events.push(uiChunkEvent({ type: "text-start", id: textId }));
  events.push(
    uiChunkEvent({ type: "text-delta", id: textId, delta: opts.text }),
  );
  events.push(uiChunkEvent({ type: "text-end", id: textId }));
  events.push(uiChunkEvent({ type: "finish-step" }));

  // The final `finish` chunk carries the message-level metadata the kernel
  // folds onto the assistant message (usage → PostHog + persisted metadata;
  // codingAgentSessionId → resume ref on the next turn).
  const messageMetadata: Record<string, unknown> = {};
  if (opts.usage) messageMetadata.usage = opts.usage;
  if (opts.codingAgentSessionId) {
    messageMetadata.codingAgentSessionId = opts.codingAgentSessionId;
    messageMetadata.codingAgentProvider = "claude-code";
  }
  const finishChunk: Record<string, unknown> = { type: "finish" };
  if (Object.keys(messageMetadata).length > 0) {
    finishChunk.messageMetadata = messageMetadata;
  }
  events.push(uiChunkEvent(finishChunk));

  return events;
}

/** Seq-number a list of events (1-based) and serialize as NDJSON with a
 *  trailing newline. The cluster dedupes by seq, so a caller may re-serialize
 *  the same prefix to simulate a reconnect replay. */
function serializeRelayLines(events: unknown[]): string {
  return `${events
    .map((event, i) => JSON.stringify({ seq: i + 1, event }))
    .join("\n")}\n`;
}

/**
 * Build a complete single-turn relay body: ordered turn events + a terminal
 * `done` line, seq-numbered NDJSON. This is the canned "successful assistant
 * turn" the relay driver POSTs. Returns the body plus the line count (== the
 * `lastSeq` the cluster acks).
 */
export function buildTurnRelayBody(opts: BuildTurnOptions): {
  body: string;
  lineCount: number;
} {
  const events = [...buildTurnEvents(opts), { type: "done" }];
  return { body: serializeRelayLines(events), lineCount: events.length };
}

/**
 * Build a relay body whose terminal line is an `error` event (a failed harness
 * run). The kernel's onError path persists an error part + transitions the run
 * to `failed`. No `done` line — the error IS the terminator.
 */
export function buildErrorRelayBody(opts: {
  messageId: string;
  /** Partial text streamed before the failure (optional). */
  text?: string;
  code: string;
  message: string;
}): { body: string; lineCount: number } {
  const events: unknown[] = [];
  events.push(uiChunkEvent({ type: "start" }));
  events.push(uiChunkEvent({ type: "start-step" }));
  if (opts.text) {
    const textId = `${opts.messageId}-text-0`;
    events.push(uiChunkEvent({ type: "text-start", id: textId }));
    events.push(
      uiChunkEvent({ type: "text-delta", id: textId, delta: opts.text }),
    );
    events.push(uiChunkEvent({ type: "text-end", id: textId }));
  }
  events.push({ type: "error", code: opts.code, message: opts.message });
  return { body: serializeRelayLines(events), lineCount: events.length };
}
