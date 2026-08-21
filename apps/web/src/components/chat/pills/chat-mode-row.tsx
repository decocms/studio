import type { ReactNode } from "react";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { TaskPill } from "./task-pill";
import { getActiveGithubRepo } from "@/lib/github-repo";

interface PureProps {
  branchPill: ReactNode;
}

/** Pure layout, used by tests. */
export function ChatModeRowPure({ branchPill }: PureProps) {
  if (!branchPill) return null;
  return <>{branchPill}</>;
}

interface SmartProps {
  virtualMcp: VirtualMCPEntity | null | undefined;
}

/** The header context control is the task, not the branch, so `TaskPill` renders here. */
export function ChatModeRow({ virtualMcp }: SmartProps) {
  const githubRepo = getActiveGithubRepo(virtualMcp);
  const taskPill = githubRepo?.connectionId ? (
    <TaskPill placement="header" />
  ) : null;
  return <ChatModeRowPure branchPill={taskPill} />;
}
