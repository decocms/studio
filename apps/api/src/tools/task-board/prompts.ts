import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/studio-context";
import { TASK_SYSTEM_PROMPT_MAX_LENGTH } from "@decocms/shared/task-board";
import { CANONICAL_COLUMN_KEYS } from "@decocms/shared/task-board";

const TaskBoardPromptSchema = z.object({
  columnKey: z
    .string()
    .nullable()
    .describe("null for the org-wide prompt; a column key to scope it."),
  prompt: z.string(),
});

/** The org this call is for, or a clear error. Same guard every board tool uses. */
function orgIdOf(ctx: { organization?: { id: string } }): string {
  const organizationId = ctx.organization?.id;
  if (!organizationId) {
    throw new Error(
      "Organization ID required (no active organization in context)",
    );
  }
  return organizationId;
}

export const TASK_BOARD_PROMPT_LIST = defineTool({
  name: "TASK_BOARD_PROMPT_LIST",
  description:
    "List the instructions appended to the system prompt of every agent run " +
    "started from a card on this board. The org-wide prompt comes first; a " +
    "prompt with a columnKey applies only to cards in that column.",
  inputSchema: z.object({}),
  outputSchema: z.object({ prompts: z.array(TaskBoardPromptSchema) }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    return {
      prompts: await ctx.storage.taskBoardPrompts.listByOrg(orgIdOf(ctx)),
    };
  },
});

export const TASK_BOARD_PROMPT_UPSERT = defineTool({
  name: "TASK_BOARD_PROMPT_UPSERT",
  description:
    "Set the instructions appended to the system prompt of agent runs started " +
    "from this board's cards — house rules for the work (conventions, tools " +
    "to prefer, what never to touch), not what to do with one card. Replaces " +
    "whatever was on that scope. Omit columnKey for the whole board.",
  annotations: { readOnlyHint: false, idempotentHint: true },
  inputSchema: z.object({
    columnKey: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        "A column of this board (see TASK_BOARD_ITEM_LIST) to scope the " +
          "prompt to. Omit or null for every card on the board.",
      ),
    prompt: z.string().min(1).max(TASK_SYSTEM_PROMPT_MAX_LENGTH),
  }),
  outputSchema: z.object({ prompt: TaskBoardPromptSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = orgIdOf(ctx);
    const columnKey = input.columnKey ?? null;

    // Rejected rather than stored and ignored: a prompt on a column this board
    // does not have never applies, and looks configured to whoever set it.
    if (columnKey !== null) {
      if (!CANONICAL_COLUMN_KEYS.some((key) => key === columnKey)) {
        throw new Error(
          `This board has no column "${columnKey}" — it has ${CANONICAL_COLUMN_KEYS.join(", ")}`,
        );
      }
    }

    return {
      prompt: await ctx.storage.taskBoardPrompts.upsert(
        organizationId,
        columnKey,
        input.prompt.trim(),
      ),
    };
  },
});

export const TASK_BOARD_PROMPT_DELETE = defineTool({
  name: "TASK_BOARD_PROMPT_DELETE",
  description:
    "Clear a board prompt. Deleting IS the off switch, so a prompt cannot be " +
    "set-but-inactive. Omit columnKey to clear the org-wide one.",
  annotations: { readOnlyHint: false, idempotentHint: true },
  inputSchema: z.object({
    columnKey: z.string().min(1).nullable().optional(),
  }),
  outputSchema: z.object({ removed: z.boolean() }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    return {
      removed: await ctx.storage.taskBoardPrompts.remove(
        orgIdOf(ctx),
        input.columnKey ?? null,
      ),
    };
  },
});
