import type { Task } from "../task/types";

type ResponsePart = {
  type?: string;
  state?: string;
};

// Client-side mirror of the server's `resolveThreadStatus`
// (apps/api/src/api/routes/decopilot/status.ts). `apps/web` can't import from
// `apps/api/src` (ban-web-server-imports), so the two are kept in lockstep by
// hand — change both together.
export function deriveTerminalThreadStatus(
  finishReason: string | undefined,
  responseParts: ResponsePart[] = [],
): Exclude<Task["status"], "in_progress"> {
  if (finishReason === "stop") {
    // A clean stop is a finished turn. An agent that needs input signals it
    // structurally — a pending `user_ask` or `approval-requested` part, both
    // handled by the `tool-calls` branch below — never by ending prose with a
    // question. (We used to infer `requires_action` from a `?` in the text,
    // which false-positived on any URL query string or rhetorical question.)
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
