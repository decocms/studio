import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import { cn } from "@decocms/ui/lib/utils.ts";

/** A mention's tint, in the composer and in a posted body: the Super Agent in
 *  its lime, a person in blue. */
export function mentionChipClassName(id: string | null | undefined): string {
  return cn(
    "rounded px-1 py-px font-medium",
    id === SUPER_AGENT_ASSIGNEE_ID
      ? "bg-brand-lime-tint text-brand-green-dark dark:bg-brand/20 dark:text-brand"
      : "bg-brand-blue-tint text-brand-blue-dark dark:bg-brand-blue/20 dark:text-brand-blue",
  );
}
