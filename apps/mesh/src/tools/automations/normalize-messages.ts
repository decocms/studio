/**
 * Shared message normalization for automation create/update tools.
 *
 * Handles two concerns:
 * 1. LLMs sometimes pass the messages array as a JSON-stringified string —
 *    detect and parse it to avoid double-serialization.
 * 2. Messages may lack `metadata.tiptapDoc` — generate it from the first
 *    text part so the UI editor can render the content.
 */

type MessagePart = Record<string, unknown>;

type Message = {
  id?: string;
  role: "user" | "assistant" | "system";
  parts: MessagePart[];
  metadata?: unknown;
  [key: string]: unknown;
};

function buildTiptapDoc(text: string) {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text,
          },
        ],
      },
    ],
  };
}

function ensureTiptapDoc(messages: Message[]): Message[] {
  return messages.map((msg) => {
    const meta = msg.metadata as Record<string, unknown> | undefined;
    if (meta?.tiptapDoc) {
      return msg;
    }

    const firstTextPart = msg.parts.find(
      (p) => p.type === "text" && typeof p.text === "string",
    );
    if (!firstTextPart?.text || typeof firstTextPart.text !== "string") {
      return msg;
    }

    return {
      ...msg,
      metadata: {
        ...meta,
        tiptapDoc: buildTiptapDoc(firstTextPart.text),
      },
    };
  });
}

/**
 * Normalize messages input from LLM tool calls:
 * - If string is a JSON-serialized message array, parse it
 * - If string is plain text, wrap in a user message
 * - Ensure all messages have `metadata.tiptapDoc`
 */
export function normalizeMessages(messages: string | Message[]): Message[] {
  let normalized: Message[];

  if (typeof messages === "string") {
    try {
      const parsed = JSON.parse(messages);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed[0]?.role &&
        Array.isArray(parsed[0]?.parts)
      ) {
        normalized = parsed;
      } else {
        normalized = [
          {
            role: "user" as const,
            parts: [{ type: "text", text: messages }],
          },
        ];
      }
    } catch {
      normalized = [
        {
          role: "user" as const,
          parts: [{ type: "text", text: messages }],
        },
      ];
    }
  } else {
    normalized = messages;
  }

  return ensureTiptapDoc(normalized);
}
