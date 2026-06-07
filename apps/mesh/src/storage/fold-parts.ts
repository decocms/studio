import type { PartKind } from "./types";

export type { PartKind };

export interface ThreadMessagePart {
  id: string;
  seq: number;
  org_id: string;
  thread_id: string;
  run_id: string;
  message_id: string;
  role: "user" | "assistant" | "system";
  kind: PartKind;
  payload: unknown;
  payload_ref: string | null;
  metadata: unknown | null;
  created_at: string;
}

export interface FoldedMessage {
  id: string; // == message_id
  role: "user" | "assistant" | "system";
  parts: unknown[];
  created_at: string;
  status: "complete" | "in_progress";
}

/**
 * Pure fold: group parts by message_id, order within a message by seq,
 * order messages by created_at. A `finish` part marks completion and is
 * not itself rendered. Deterministic and order-independent.
 */
export function foldParts(parts: ThreadMessagePart[]): FoldedMessage[] {
  const byMessage = new Map<string, ThreadMessagePart[]>();
  for (const p of parts) {
    const arr = byMessage.get(p.message_id);
    if (arr) arr.push(p);
    else byMessage.set(p.message_id, [p]);
  }

  const messages: FoldedMessage[] = [];
  for (const [messageId, group] of byMessage) {
    const sorted = [...group].sort((a, b) => a.seq - b.seq);
    const first = sorted[0]!;
    messages.push({
      id: messageId,
      role: first.role,
      parts: sorted.filter((p) => p.kind !== "finish").map((p) => p.payload),
      created_at: first.created_at,
      status: sorted.some((p) => p.kind === "finish")
        ? "complete"
        : "in_progress",
    });
  }

  messages.sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
  );
  return messages;
}
