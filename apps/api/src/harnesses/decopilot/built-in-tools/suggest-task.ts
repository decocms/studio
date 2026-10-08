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
  SUGGEST_TASK_GUIDANCE,
  SuggestTaskInputSchema,
} from "@/tools/chat/suggest-task";

const SuggestTaskOutputSchema = z.object({
  accepted: z
    .boolean()
    .describe("True when the user agreed to turn this into a task."),
});

const description =
  SUGGEST_TASK_GUIDANCE +
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
