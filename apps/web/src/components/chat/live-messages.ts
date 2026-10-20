import { createContext, useContext } from "react";
import type { ChatMessage } from "./types.ts";

/**
 * Messages delivered into a running sandbox turn. The user row carries
 * `metadata.liveRunId`; the run's assistant message carries a
 * `data-live-message` part where the model read it, and that is where the body
 * shows it.
 */
export const LIVE_MESSAGE_PART = "data-live-message";

/** The id of the user message a `data-live-message` part points at. */
export function liveMessagePartId(part: unknown): string | null {
  if (typeof part !== "object" || part === null) return null;
  const { type, data } = part as { type?: unknown; data?: unknown };
  if (type !== LIVE_MESSAGE_PART) return null;
  const id = (data as { messageId?: unknown } | undefined)?.messageId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function isLiveMessage(message: ChatMessage): boolean {
  return message.role === "user" && Boolean(message.metadata?.liveRunId);
}

export function withLiveRunId(
  message: ChatMessage,
  liveRunId: string,
): ChatMessage {
  return { ...message, metadata: { ...message.metadata, liveRunId } };
}

export interface LiveMessagePlacement {
  /** The body's messages, without the live ones shown elsewhere. */
  visible: ChatMessage[];
  /** Live messages the model read, by id, for their inline parts. */
  read: Map<string, ChatMessage>;
  /** Live messages the running turn has not read yet: shown under it. */
  pending: ChatMessage[];
}

/**
 * Where the body shows each live message. A read one renders inline at its
 * `data-live-message` part. An unread one renders under the running turn while
 * it runs, and as an ordinary message once the run is over without reading it.
 * Pure, for the unit test.
 */
export function placeLiveMessages(
  messages: ChatMessage[],
  runActive: boolean,
): LiveMessagePlacement {
  const readIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      const id = liveMessagePartId(part);
      if (id) readIds.add(id);
    }
  }
  const read = new Map<string, ChatMessage>();
  const pending: ChatMessage[] = [];
  const visible: ChatMessage[] = [];
  for (const message of messages) {
    if (isLiveMessage(message) && readIds.has(message.id)) {
      read.set(message.id, message);
    } else if (isLiveMessage(message) && runActive) {
      pending.push(message);
    } else {
      visible.push(message);
    }
  }
  return { visible, read, pending };
}

export const LiveMessagesContext = createContext<
  Pick<LiveMessagePlacement, "read" | "pending">
>({ read: new Map(), pending: [] });

export function useLiveMessages() {
  return useContext(LiveMessagesContext);
}
