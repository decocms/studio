/**
 * suggest_task — offer the user a task card for the board.
 *
 * Returns at once: the card renders from the call's input, and the user's
 * answer arrives as their next message. Claude Code cannot take a tool result
 * injected into a resumed session, so unlike the Decopilot built-in there is
 * no `accepted` output to wait for.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth, requireOrganization } from "@/core/studio-context";
import {
  MAX_TASK_DESCRIPTION_LENGTH,
  MAX_TASK_TITLE_LENGTH,
} from "../task-board/schema";

export const SuggestTaskInputSchema = z.object({
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

/** When to offer; each surface appends how the user's answer comes back. */
export const SUGGEST_TASK_GUIDANCE =
  "Offer to turn what the user just said into a task on the board. Call this as soon as a " +
  "message reads like a new piece of work — a feature they want, a bug they hit, something " +
  "they wish the product did — rather than answering it as a question.\n\n" +
  "Guidelines:\n" +
  "- One call per distinct piece of work. Don't offer for work already on the board, and don't " +
  "re-offer something the user just declined.\n";

export const SUGGEST_TASK = defineTool({
  name: "suggest_task",
  description:
    SUGGEST_TASK_GUIDANCE +
    "- The card is shown to the user and this call returns at once; end your turn. Their answer " +
    "is their next message.\n" +
    "- Declined — drop it and keep helping in chat. Do not ask again.\n" +
    "- Accepted — the user agreed to a task, NOT to this exact wording. If you can already write " +
    "a task someone could pick up without asking you anything, call `TASK_BOARD_ITEM_CREATE`. " +
    "If you can't, ask until you can, then create it.",
  annotations: {
    title: "Suggest Task",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: SuggestTaskInputSchema,
  outputSchema: z.object({ shown: z.literal(true) }),
  modelSummary: () =>
    "Shown to the user. Their answer arrives as their next message.",
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();
    return { shown: true as const };
  },
});
