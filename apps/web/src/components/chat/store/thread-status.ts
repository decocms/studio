import type { Task } from "../task/types";

type ResponsePart = {
  type?: string;
  state?: string;
};

// Client mirror of the server's `resolveThreadStatus` (status.ts) — keep in sync.
export function deriveTerminalThreadStatus(
  finishReason: string | undefined,
  responseParts: ResponsePart[] = [],
): Exclude<Task["status"], "in_progress"> {
  if (finishReason === "stop") {
    // Finished turn. "Needs input" comes only from the structured `tool-calls`
    // signals below (user_ask / approval), never from a `?` in the prose.
    return "completed";
  }

  if (finishReason === "tool-calls") {
    const hasPendingClientAction = responseParts.some(
      (part) =>
        (part.type === "tool-user_ask" && part.state === "input-available") ||
        part.state === "approval-requested",
    );
    return hasPendingClientAction ? "requires_action" : "completed";
  }

  return "failed";
}
