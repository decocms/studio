/**
 * Short card link (`/$org/t/DECO-01`).
 *
 * The board's own deep link carries a thread id, a virtual MCP id and a uuid,
 * which is not a thing anyone pastes into Slack. This route is the shareable
 * shape: it resolves the key to the card and forwards to the board's deep
 * link, so there is still exactly one place that renders a task.
 *
 * An unknown key lands on the board rather than an error page — the card was
 * probably deleted, and the board is where you'd look next.
 */
import { Navigate, useParams } from "@tanstack/react-router";
import { findTaskByKeyOrId } from "./resolve";
import { useTaskBoardItems } from "@/hooks/use-task-board-items";
import { useProjectContext } from "@/sdk";
import { ShellRouteLoading } from "@/layouts/shell-route-loading";

export default function TaskKeyRedirect() {
  const { org } = useProjectContext();
  const { taskKey } = useParams({ strict: false }) as { taskKey?: string };
  const { items, isLoading } = useTaskBoardItems();

  if (isLoading) return <ShellRouteLoading />;

  const item = findTaskByKeyOrId(items, taskKey);

  return (
    <Navigate
      to="/$org"
      params={{ org: org.slug }}
      search={{ main: "board", task: item?.id }}
      replace
    />
  );
}
