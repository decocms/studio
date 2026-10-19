/**
 * Messages a person sends while a turn is running.
 *
 * The daemon writes one `{"liveMessage":{"id","text"}}` line to this process's
 * stdin per message (`POST /_sandbox/runs/{runId}/messages`) and answers its
 * caller only after reading the `{"liveMessageAck":{"id","accepted"}}` line
 * printed back. The ack is what makes the daemon's answer true: a message
 * accepted here is one the turn will not finish without, and one refused (the
 * turn already decided to finish) is queued by Studio as the next turn.
 *
 * Accepted messages go into the SDK's streaming input as `priority: "next"`
 * user messages. Claude Code folds those into the running turn between tool
 * rounds; with `--replay-user-messages` it echoes each one back (`isReplay`,
 * same uuid) at the point the model read it, and that echo is where the run's
 * `data-live-message` part goes. A message the turn ends without reading
 * starts the CLI's next turn instead, which this run keeps reading.
 */

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SdkResultMessage } from "./to-ui-chunks";

export interface LiveMessage {
  /** Studio's message id: the user row that already holds the text. */
  id: string;
  text: string;
}

/** The stdin line the daemon writes, or null when `value` is anything else. */
export function parseLiveMessageLine(value: unknown): LiveMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const message = (value as { liveMessage?: unknown }).liveMessage;
  if (typeof message !== "object" || message === null) return null;
  const { id, text } = message as { id?: unknown; text?: unknown };
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof text !== "string" || text.trim().length === 0) return null;
  return { id, text };
}

/** The stdout line the daemon waits for before it answers. */
export function liveMessageAckLine(id: string, accepted: boolean): string {
  return JSON.stringify({ liveMessageAck: { id, accepted } });
}

/**
 * The part a run's assistant message carries where the model read a message.
 * Only the id: the text lives on the user row Studio wrote when the message
 * arrived, so it is stored once.
 */
export function liveMessageChunk(messageId: string): Record<string, unknown> {
  return {
    type: "data-live-message",
    id: `live-message-${messageId}`,
    data: { messageId },
  };
}

/**
 * One run's result when a live message made the CLI run more than one turn.
 * `usage` is per CLI turn, so it is summed; the cost and `modelUsage` are
 * running totals of the session, so the latest wins.
 */
export function mergeTurnResults(
  previous: SdkResultMessage | null,
  next: SdkResultMessage,
): SdkResultMessage {
  if (!previous?.usage) return next;
  const sum = (key: keyof NonNullable<SdkResultMessage["usage"]>) =>
    (previous.usage?.[key] ?? 0) + (next.usage?.[key] ?? 0);
  return {
    ...next,
    usage: {
      input_tokens: sum("input_tokens"),
      output_tokens: sum("output_tokens"),
      cache_read_input_tokens: sum("cache_read_input_tokens"),
      cache_creation_input_tokens: sum("cache_creation_input_tokens"),
    },
  };
}

/**
 * Routes stdin's live messages to the turn running now. Lives as long as the
 * process; a turn opens it on start and closes it once it decides to finish.
 */
export class LiveMessageInbox {
  private handler:
    | ((message: LiveMessage) => boolean | Promise<boolean>)
    | null = null;

  open(handler: (message: LiveMessage) => boolean | Promise<boolean>): void {
    this.handler = handler;
  }

  close(): void {
    this.handler = null;
  }

  /** Whether a turn took the message. No turn running means no. */
  deliver(message: LiveMessage): boolean | Promise<boolean> {
    return this.handler ? this.handler(message) : false;
  }
}

/** One turn's live messages, from accepted to read by the model. */
export class LiveMessageTurn {
  private closed = false;
  private sink: ((message: SDKUserMessage) => void) | null = null;
  /** SDK uuid → Studio id and the message as sent, until the model reads it. */
  private readonly unread = new Map<
    string,
    { id: string; sdk: SDKUserMessage }
  >();
  /** Studio ids this turn accepted, so a redelivered one is not sent twice. */
  private readonly accepted = new Set<string>();

  /** False once the turn is finishing: the caller queues the message instead. */
  accept(message: LiveMessage): boolean {
    if (this.closed) return false;
    if (this.accepted.has(message.id)) return true;
    this.accepted.add(message.id);
    const uuid = crypto.randomUUID();
    const sdk = {
      type: "user",
      message: { role: "user", content: message.text },
      parent_tool_use_id: null,
      uuid,
      priority: "next",
    } satisfies SDKUserMessage;
    this.unread.set(uuid, { id: message.id, sdk });
    this.sink?.(sdk);
    return true;
  }

  /**
   * Point the turn at an SDK input. Unread messages are sent again: a new input
   * means the previous attempt's session ended before its model call, so it
   * showed the model nothing.
   */
  attach(sink: (message: SDKUserMessage) => void): void {
    this.sink = sink;
    for (const { sdk } of this.unread.values()) sink(sdk);
  }

  /** The model read the message sent as `uuid`; its Studio id, or null if it is not one of ours. */
  markRead(uuid: string | undefined): string | null {
    if (!uuid) return null;
    const entry = this.unread.get(uuid);
    if (!entry) return null;
    this.unread.delete(uuid);
    return entry.id;
  }

  /**
   * Every unread message, now marked read. For a CLI turn that started after
   * the previous one ended: only queued messages start one, so it is theirs.
   */
  readAll(): string[] {
    const ids = [...this.unread.values()].map((entry) => entry.id);
    this.unread.clear();
    return ids;
  }

  hasUnread(): boolean {
    return this.unread.size > 0;
  }

  /** The turn is finishing. Returns the ids the model never read. */
  close(): string[] {
    this.closed = true;
    return [...this.unread.values()].map((entry) => entry.id);
  }
}
