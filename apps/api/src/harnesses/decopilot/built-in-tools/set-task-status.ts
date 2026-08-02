/**
 * `set_task_status` — move the card of the task this run is talking about.
 *
 * Registered alongside `reply_comment`, on comment runs only, and bound to that
 * run's task so the model passes a status and nothing else.
 *
 * It exists because a run being alive is NOT evidence the task is being worked:
 * someone asking "what do you think?" spins up a run, and auto-advancing on
 * that would drag every discussed card into In Progress. So the automatic
 * transition withholds `in_progress` for comment runs (`runMayAdvance`, decided
 * from in-memory metadata — fast, no classifier) and the agent declares the move
 * itself when a comment actually asks it to start. Saying "on it" and moving the
 * card are then one intent instead of a guess.
 *
 * The other direction still happens by itself: a PR opened from this run, or the
 * run finishing work it started, advances the card through the normal reactions.
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItemStatus } from "@/storage/types";
import { emitTaskBoardUpdated } from "@/tools/task-board/run-reactions";

const SetTaskStatusInputSchema = z.object({
  status: z
    .enum(["triage", "todo", "in_progress", "in_review", "done"])
    .describe(
      "Where the card should be. Use in_progress when you're starting the work, in_review when it's ready for a human to look, done when it's finished.",
    ),
});

export function createSetTaskStatusTool(
  ctx: StudioContext,
  binding: { taskBoardItemId: string },
) {
  return tool({
    description:
      "Move this task's card on the board. Call it when you actually start the work someone asked you for (in_progress), or when the work is ready for review or finished. Don't move the card just to answer a question — talking about a task isn't working on it.",
    inputSchema: zodSchema(SetTaskStatusInputSchema),
    execute: async ({ status }) => {
      const organizationId = ctx.organization?.id;
      if (!organizationId) return { moved: false, reason: "no organization" };

      const current = await ctx.storage.taskBoard.getById(
        binding.taskBoardItemId,
        organizationId,
      );
      if (!current) return { moved: false, reason: "task not found" };
      if (current.status === status) return { moved: false, from: status };

      const item = await ctx.storage.taskBoard.update(
        binding.taskBoardItemId,
        organizationId,
        { status: status as TaskBoardItemStatus },
        // The agent moved it, so the card's `updated_by` stays whoever last
        // touched it as a person.
        current.updatedBy,
      );
      // Timeline entry with a null actor — same convention as every other
      // agent-driven move.
      await ctx.storage.taskBoard
        .recordActivity({
          taskBoardItemId: binding.taskBoardItemId,
          action: "status_changed",
          actorId: null,
          data: { from: current.status, to: status },
        })
        .catch((err) =>
          console.error("[task-board] activity log write failed", err),
        );
      emitTaskBoardUpdated(organizationId, item);

      return { moved: true, from: current.status, to: status };
    },
  });
}
