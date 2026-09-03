import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/studio-context";
import { CANONICAL_COLUMN_KEYS } from "@decocms/shared/task-board";
import { MAX_AUTOMATION_PROMPT_LENGTH } from "./schema";

const AutomationSchema = z.object({
  columnKey: z.string(),
  prompt: z.string().nullable(),
});

export const TASK_BOARD_AUTOMATION_LIST = defineTool({
  name: "TASK_BOARD_AUTOMATION_LIST",
  description:
    "List what the board runs when a card lands in each of its columns. A " +
    "column with no rule is uneventful — nothing runs there.",
  inputSchema: z.object({}),
  outputSchema: z.object({ automations: z.array(AutomationSchema) }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }
    return {
      automations:
        await ctx.storage.columnAutomations.listByOrg(organizationId),
    };
  },
});

export const TASK_BOARD_AUTOMATION_UPSERT = defineTool({
  name: "TASK_BOARD_AUTOMATION_UPSERT",
  description:
    "Run the agent on every card that lands in a column. Replaces the rule " +
    "already on that column, if any. Omit `prompt` to use the agent's own " +
    "instruction; give one to say what it should do there instead. The card's " +
    "title and description are always included, so the prompt is the " +
    "instruction, not the whole message.",
  inputSchema: z.object({
    columnKey: z
      .string()
      .min(1)
      .describe("A column of this board — see TASK_BOARD_ITEM_LIST."),
    prompt: z
      .string()
      .max(MAX_AUTOMATION_PROMPT_LENGTH)
      .nullable()
      .optional()
      .describe("What to do with a card landing here; null for the default."),
  }),
  outputSchema: z.object({ automation: AutomationSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    // Rejected here rather than stored and ignored: a rule on a column this
    // board does not have never fires, and looks configured to whoever set it.
    if (!CANONICAL_COLUMN_KEYS.some((key) => key === input.columnKey)) {
      throw new Error(
        `This board has no column "${input.columnKey}" — it has ${CANONICAL_COLUMN_KEYS.join(", ")}`,
      );
    }

    const prompt = input.prompt?.trim() ? input.prompt.trim() : null;
    return {
      automation: await ctx.storage.columnAutomations.upsert(
        organizationId,
        input.columnKey,
        prompt,
      ),
    };
  },
});

export const TASK_BOARD_AUTOMATION_DELETE = defineTool({
  name: "TASK_BOARD_AUTOMATION_DELETE",
  description:
    "Stop running the agent on cards landing in a column. Removing the rule " +
    "IS the off switch, so a column cannot be configured-but-disabled.",
  inputSchema: z.object({ columnKey: z.string().min(1) }),
  outputSchema: z.object({ removed: z.boolean() }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }
    return {
      removed: await ctx.storage.columnAutomations.remove(
        organizationId,
        input.columnKey,
      ),
    };
  },
});
