/**
 * suggest_task built-in
 *
 * Client-side (no `execute`): the call streams to the UI, which renders a card
 * above the chat input. The user clicks, the client submits the tool output,
 * and the model continues in the same thread — filing the card with
 * `TASK_BOARD_ITEM_CREATE` when it already has enough to write a good one, or
 * asking (`user_ask`) until it does.
 *
 * Why a tool and not plain text: an offer the user can accept in one click is
 * the whole point, and only a tool call gets a rendered card. It is deliberately
 * NOT `TASK_BOARD_ITEM_CREATE` behind a confirmation — the user agreeing is a
 * signal to *start writing the task*, not to file whatever the model guessed.
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";
import {
  MAX_TASK_DESCRIPTION_LENGTH,
  MAX_TASK_TITLE_LENGTH,
} from "@/tools/task-board/schema";

const SuggestTaskInputSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(MAX_TASK_TITLE_LENGTH)
    .describe(
      "The task as one imperative line (≤10 words), e.g. 'Add dark mode to the settings page'.",
    ),
  summary: z
    .string()
    .min(1)
    .max(MAX_TASK_DESCRIPTION_LENGTH)
    .describe(
      "Two or three sentences the user can check at a glance: what would be built and why. " +
        "Written for the user, not for the board — the real description is written later.",
    ),
});

const SuggestTaskOutputSchema = z.object({
  accepted: z
    .boolean()
    .describe("True when the user agreed to turn this into a task."),
});

const description =
  "Offer to turn what the user just said into a task on the board. Call this as soon as a " +
  "message reads like a new piece of work — a feature they want, a bug they hit, something " +
  "they wish the product did — rather than answering it as a question.\n\n" +
  "Guidelines:\n" +
  "- One call per distinct piece of work. Don't offer for work already on the board, and don't " +
  "re-offer something the user just declined.\n" +
  "- `accepted: false` — drop it and keep helping in chat. Do not ask again.\n" +
  "- `accepted: true` — the user agreed to a task, NOT to this exact wording. If you can already " +
  "write a task someone could pick up without asking you anything, call `TASK_BOARD_ITEM_CREATE`. " +
  "If you can't — the scope, the affected area or the expected behavior is still guesswork — keep " +
  "asking with `user_ask` until you can, then create it.";

export const suggestTaskTool = tool({
  description,
  inputSchema: zodSchema(SuggestTaskInputSchema),
  outputSchema: zodSchema(SuggestTaskOutputSchema),
});
