/**
 * The JSON-serializable subset of a Tiptap node that crosses Studio's wire
 * boundary. Keeping this structural avoids making shared contracts depend on
 * the Tiptap editor runtime.
 */
export interface TiptapNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  marks?: Array<{
    type: string;
    attrs?: Record<string, unknown>;
    [key: string]: unknown;
  }>;
  text?: string;
  [key: string]: unknown;
}

export interface TiptapDoc {
  type: "doc";
  content: TiptapNode[];
}
