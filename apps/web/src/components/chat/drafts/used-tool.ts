import type { ChatMessage } from "../types";

/** Whether an answer did work (a tool call), not just replied. */
export function usedTool(message: ChatMessage): boolean {
  return message.parts.some(
    (part) => part.type === "dynamic-tool" || part.type.startsWith("tool-"),
  );
}
