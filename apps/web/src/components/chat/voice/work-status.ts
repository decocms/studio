import { z } from "zod";
import type { ChatMessage } from "../types";

const BackgroundStartedSchema = z.object({
  background: z.literal(true),
  status: z.literal("started"),
  jobId: z.string().min(1),
});
const CreatedTaskSchema = z.object({
  item: z.object({
    id: z.string().min(1),
    title: z.string(),
    status: z.string(),
  }),
});

export interface TrackedTask {
  id: string;
  title: string;
  status: string;
}

/** The id of the hidden user turn that delivers a background subtask's result. */
export const backgroundReactionId = (jobId: string) => `${jobId}:react-msg`;

/** Assistant messages answering one user turn. Subtask runs nest under their card instead. */
export function turnMessages(
  messages: ChatMessage[],
  userMessageId: string,
): ChatMessage[] | null {
  const index = messages.findIndex(
    (message) => message.id === userMessageId && message.role === "user",
  );
  if (index < 0) return null;
  const turn: ChatMessage[] = [];
  for (const message of messages.slice(index + 1)) {
    if (message.metadata?.subtaskJobId) continue;
    if (message.role === "user") break;
    if (message.role === "assistant") turn.push(message);
  }
  return turn;
}

/** Background subtasks started and board tasks created while answering a turn. */
export function turnActivity(messages: ChatMessage[], userMessageId: string) {
  const backgroundJobs: string[] = [];
  const tasks: TrackedTask[] = [];
  for (const message of turnMessages(messages, userMessageId) ?? []) {
    for (const part of message.parts) {
      if (!("state" in part) || part.state !== "output-available") continue;
      if (!("output" in part)) continue;
      // MCP tool parts are typed only by the built-in tool set.
      const type: string = part.type;
      if (type === "tool-subtask") {
        const started = BackgroundStartedSchema.safeParse(part.output);
        if (started.success) backgroundJobs.push(started.data.jobId);
      } else if (type === "tool-TASK_BOARD_ITEM_CREATE") {
        const created = CreatedTaskSchema.safeParse(part.output);
        if (created.success) tasks.push(created.data.item);
      }
    }
  }
  return { backgroundJobs, tasks };
}
