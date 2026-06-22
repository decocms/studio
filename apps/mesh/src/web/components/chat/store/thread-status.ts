import type { Task } from "../task/types";

type ResponsePart = {
  type?: string;
  text?: string;
  state?: string;
};

export function deriveTerminalThreadStatus(
  finishReason: string | undefined,
  responseParts: ResponsePart[] = [],
): Exclude<Task["status"], "in_progress"> {
  if (finishReason === "stop") {
    const text = responseParts
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text!)
      .join("\n");
    const textWithoutUrls = text.replace(/https?:\/\/[^\s)>\]]+/g, "");
    return textWithoutUrls.includes("?") ? "requires_action" : "completed";
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
