/**
 * postMessage protocol between the deck preview iframe (the standalone
 * `<deck-viewer>` runtime served from /deck-runtime/v1/deck-viewer.js) and
 * the DeckTab host. Keep in sync with the protocol block documented at the
 * top of `apps/web/public/deck-runtime/v1/deck-viewer.js`.
 *
 * The iframe is sandboxed (`allow-scripts`, opaque origin), so:
 *  - `event.origin` is the string "null" — identity is checked via
 *    `event.source === iframe.contentWindow`, never via origin.
 *  - both directions post with targetOrigin "*" and must carry no secrets.
 */

export const DECK_PROTOCOL_V = 1;

/** Structural / text ops emitted by the runtime after optimistic
 *  self-apply. Indices are positions in the slide list BEFORE the op. */
export type DeckOp =
  | { kind: "move"; from: number; to: number }
  | { kind: "remove"; at: number }
  | { kind: "duplicate"; at: number }
  | { kind: "set-attr"; at: number; name: string; value: string }
  | { kind: "remove-attr"; at: number; name: string }
  | { kind: "replace"; at: number; html: string };

export interface DeckOpMessage {
  v: typeof DECK_PROTOCOL_V;
  source: "deck-viewer";
  type: "op";
  opId: string;
  witness: { childCount: number };
  op: DeckOp;
}

export interface DeckReadyMessage {
  v: typeof DECK_PROTOCOL_V;
  source: "deck-viewer";
  type: "ready";
  total: number;
  design: { width: number; height: number };
}

export interface DeckStateMessage {
  v: typeof DECK_PROTOCOL_V;
  source: "deck-viewer";
  type: "state";
  index: number;
  total: number;
  skipped: number[];
}

export type DeckRuntimeMessage =
  | DeckOpMessage
  | DeckReadyMessage
  | DeckStateMessage;

export type DeckHostMessage =
  | {
      v: typeof DECK_PROTOCOL_V;
      type: "ack";
      opId: string;
      ok: boolean;
      error?: string;
    }
  | { v: typeof DECK_PROTOCOL_V; type: "set-edit-mode"; enabled: boolean }
  | { v: typeof DECK_PROTOCOL_V; type: "set-rail"; open: boolean }
  | { v: typeof DECK_PROTOCOL_V; type: "goto"; index: number }
  | { v: typeof DECK_PROTOCOL_V; type: "print" };

export function parseDeckRuntimeMessage(
  data: unknown,
): DeckRuntimeMessage | null {
  if (
    typeof data !== "object" ||
    data === null ||
    (data as { v?: unknown }).v !== DECK_PROTOCOL_V ||
    (data as { source?: unknown }).source !== "deck-viewer"
  ) {
    return null;
  }
  const msg = data as DeckRuntimeMessage;
  if (msg.type === "ready" || msg.type === "state") return msg;
  if (msg.type === "op" && typeof msg.opId === "string" && msg.op) return msg;
  return null;
}
