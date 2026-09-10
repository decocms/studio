/**
 * What a task's assignee LOOKS like — the one definition, for every surface
 * that shows one.
 *
 * The rule that matters is the agent branch: a task handed to the Super Agent
 * carries a sentinel id rather than a member, so resolving it against the org's
 * members yields nothing and the row rendered an empty slot or, worse, a "?"
 * monogram for the one assignee that is never a person. It gets the capybara.
 *
 * Read-only by design. The board wraps this with its assign popover and its
 * delegation stack; anywhere else an assignee is a fact you are being told, not
 * a control, so there is nothing to click.
 */

import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import { getInitials } from "@/lib/get-initials";
import {
  SUPER_AGENT_ASSIGNEE_ID,
  type Member,
} from "@/layouts/task-board/config";

export function TaskAssigneeAvatar({
  assigneeId,
  assignee,
  size = 20,
  title,
  className,
}: {
  assigneeId: string | null | undefined;
  /** The member `assigneeId` resolves to; absent for the agent, or while the
   *  member list is still loading. */
  assignee?: Member;
  size?: number;
  title?: string;
  className?: string;
}) {
  if (!assigneeId) return null;

  /** The tooltip lives on a wrapper rather than on either glyph: `Avatar` and
   *  `SuperAgentIcon` take different props, and one span means both branches
   *  say the same thing the same way. */
  const glyph =
    assigneeId === SUPER_AGENT_ASSIGNEE_ID ? (
      <SuperAgentIcon size={size} />
    ) : assignee ? (
      <Avatar
        url={assignee.user?.image ?? undefined}
        fallback={getInitials(assignee.user?.name)}
        shape="circle"
        size="xs"
      />
    ) : null;

  if (!glyph) return null;

  return (
    <span className={cn("inline-flex shrink-0", className)} title={title}>
      {glyph}
    </span>
  );
}
