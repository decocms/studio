/** Rows of one thread's parts relevant to queue-tray hydration. */
export interface QueuePartRow {
  message_id: string;
  kind: string;
  seq: number;
  payload: unknown;
}

/**
 * Fold part rows into per-message tray hydration: concatenated text (text
 * parts, seq order) + attachment presence. Pure + total — unknown payload
 * shapes contribute empty strings, never throw.
 */
export function foldQueueHydration(
  rows: QueuePartRow[],
): Map<string, { text: string; hasAttachments: boolean }> {
  const byMessage = new Map<
    string,
    { text: string; hasAttachments: boolean }
  >();
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  for (const row of sorted) {
    const entry = byMessage.get(row.message_id) ?? {
      text: "",
      hasAttachments: false,
    };
    if (row.kind === "text") {
      const payload = row.payload as { text?: unknown } | null;
      if (typeof payload?.text === "string") entry.text += payload.text;
    } else if (row.kind === "file") {
      entry.hasAttachments = true;
    }
    byMessage.set(row.message_id, entry);
  }
  return byMessage;
}
