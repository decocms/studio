import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/studio-context";
import { boardColumnsOf } from "./board-handler";

/**
 * What a column means to Studio's automation.
 *
 * A column mirrored from a tracker is a name and a position — nothing tells us
 * that "Fazendo" is where work happens, "Code Review" is where review happens,
 * or that "Arquivado" retires a card. These are the meanings Studio acts on, and a column carries at most
 * one; every other column simply means nothing, which is the safe default for
 * a column we did not invent.
 */
const COLUMN_ROLES = ["todo", "in_progress", "in_review", "archived"] as const;

const roleSchema = z.enum(COLUMN_ROLES);

export const TASK_BOARD_COLUMN_ROLE_SET = defineTool({
  name: "TASK_BOARD_COLUMN_ROLE_SET",
  description:
    "Say what one of this board's columns means to Studio, or unsay it. " +
    "`in_review` is where a card sits while it is being reviewed; `archived` " +
    "is where a finished card retires to, and a board with no archived column " +
    "simply never archives. Pass null to clear. Only a board whose columns are " +
    "the org's own can be told this — Studio's own lanes already mean what " +
    "they say.",
  inputSchema: z.object({
    columnKey: z.string().min(1),
    role: roleSchema.nullable(),
  }),
  outputSchema: z.object({
    columnKey: z.string(),
    role: z.string().nullable(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    // Rejected rather than stored: a role on a column this board does not have
    // never fires, and reads as configured to whoever set it.
    const columns = await boardColumnsOf(ctx, organizationId);
    if (!columns.some((column) => column.key === input.columnKey)) {
      throw new Error(
        `This board has no column "${input.columnKey}" — it has ${
          columns.map((c) => c.key).join(", ") || "none yet"
        }`,
      );
    }

    const updated = await ctx.storage.boardColumns.setRole(
      organizationId,
      input.columnKey,
      input.role,
    );
    if (!updated) {
      throw new Error(
        "Only a board whose columns are the org's own can be given roles — " +
          "Studio's own lanes already mean what they say.",
      );
    }
    return { columnKey: input.columnKey, role: input.role };
  },
});
