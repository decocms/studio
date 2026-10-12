/**
 * The user message a sandbox-hosted harness receives. The dispatch wire carries
 * one user message and no per-turn system prompt (the harness's system prompt is
 * the agent's, cached across turns), so what Decopilot gets as system messages
 * rides on the message instead: the prior conversation before it, the client's
 * per-turn context after it, such as the Library file open beside the chat.
 */

import type { UIMessage } from "ai";

interface SystemMessage {
  parts: readonly unknown[];
}

function textsOf(messages: readonly SystemMessage[]): string[] {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      const typed = part as { type?: unknown; text?: unknown } | null;
      return typed?.type === "text" &&
        typeof typed.text === "string" &&
        typed.text.trim()
        ? [typed.text]
        : [];
    }),
  );
}

export function sandboxWireUserMessage<T extends UIMessage>(
  message: T,
  opts: {
    historyPrefix?: string | null;
    turnContext: readonly SystemMessage[];
  },
): T {
  const context = textsOf(opts.turnContext);
  if (!opts.historyPrefix && context.length === 0) return message;
  return {
    ...message,
    parts: [
      ...(opts.historyPrefix
        ? [{ type: "text" as const, text: opts.historyPrefix }]
        : []),
      ...message.parts,
      ...context.map((text) => ({ type: "text" as const, text })),
    ],
  };
}
