/**
 * Room transcript — make a shared thread readable by whichever agent is
 * answering this turn.
 *
 * A thread is a room: several agents and several humans speak in it. The model
 * context, though, only has `role` — so without this, an agent reading the
 * history sees ANOTHER agent's replies as `assistant` and takes them for its
 * own past words. It then contradicts itself, apologises for things it never
 * said, or "continues" work it never started.
 *
 * So before the history reaches the model we rewrite it from the point of view
 * of the agent that is about to speak:
 *  - its OWN prior turns stay `assistant` (untouched — same shape as today);
 *  - another agent's turns become `user` messages labelled `[Name]: …`, i.e.
 *    what they actually are to this agent: something a participant said;
 *  - human turns are labelled the same way, but ONLY when more than one human
 *    has spoken — a 1:1 thread reads exactly as it does today.
 *
 * Who authored an assistant turn is not stored on a column: it's the agent the
 * preceding user turn was addressed to (`metadata.agent`, set at send time).
 * Threads written before multi-agent rooms carry no `metadata.agent`, so every
 * turn resolves to the answering agent and nothing is rewritten.
 */

import type { ChatMessage } from "@/api/routes/decopilot/types";

/** Tool calls/results can't ride on a `user` message, and a tool-result part
 *  orphaned from its call breaks strict providers. A foreign turn is flattened
 *  to what the room actually needs from it: what was said. */
function flattenToText(message: ChatMessage): string {
  return message.parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        (part as { type?: string }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function labelled(name: string, body: string): string {
  return `[${name}]: ${body}`;
}

/**
 * Rewrite a thread's history for `selfAgentId`, the agent answering this turn.
 *
 * `messages` is chronological and includes the current user message. System
 * messages pass through untouched.
 */
export function buildRoomTranscript(
  messages: ChatMessage[],
  selfAgentId: string,
): ChatMessage[] {
  // Who is this turn addressed to? Tracks forward through the thread: an
  // assistant message belongs to the agent the last user message named — the
  // name rides along, since only the user message carries it.
  let addressee = selfAgentId;
  let addresseeTitle: string | undefined;

  // Only label humans once the room actually has more than one of them —
  // otherwise every existing 1:1 thread would gain noise.
  const humanNames = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    const name = message.metadata?.user?.name;
    if (name) humanNames.add(name);
  }
  const multiHuman = humanNames.size > 1;

  return messages.map((message) => {
    if (message.role === "system") return message;

    if (message.role === "user") {
      addressee = message.metadata?.agent?.id ?? selfAgentId;
      addresseeTitle = message.metadata?.agent?.title;

      const name = message.metadata?.user?.name;
      if (!multiHuman || !name) return message;

      const body = flattenToText(message);
      if (!body) return message;
      return {
        ...message,
        parts: [{ type: "text", text: labelled(name, body) }],
      } as ChatMessage;
    }

    // Assistant: mine stays mine.
    if (addressee === selfAgentId) return message;

    const body = flattenToText(message);
    const name = addresseeTitle ?? "Another agent";
    return {
      ...message,
      role: "user",
      parts: [
        {
          type: "text",
          // Empty is possible: a turn that only ran tools. Say so rather than
          // emitting an empty message, which some providers reject.
          text: labelled(name, body || "(worked on this without replying)"),
        },
      ],
    } as ChatMessage;
  });
}
