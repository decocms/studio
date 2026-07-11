/**
 * ThreadCard — one moving piece of MY work, rendered on the cross-org home.
 *
 * Shows which org it lives in, the agent, the title, a status pill, and last
 * activity. The AI-analysis line (see `thread-analysis.tsx`) slots in below the
 * title. Clicking the card opens the thread in its org.
 */
import { Link } from "@tanstack/react-router";
import { cn } from "@deco/ui/lib/utils.ts";
import { AgentAvatar } from "@/web/components/agent-icon";
import { OrgIcon } from "@/web/components/header/org-switcher";
import { getStatusConfig } from "@/web/lib/task-status";
import { formatTimeAgo } from "@/web/lib/format-time";
import type { MyThread, MyThreadAgent } from "@/web/hooks/use-my-threads";
import { ThreadAnalysis } from "./thread-analysis";

function relativeTime(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : formatTimeAgo(date);
}

function StatusPill({ status }: { status: string | undefined }) {
  const config = getStatusConfig(status);
  const Icon = config.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium",
        config.labelColor,
      )}
    >
      <Icon
        className={cn(
          "size-3.5 shrink-0",
          config.iconClassName,
          status === "in_progress" && "animate-spin",
        )}
      />
      {config.label}
    </span>
  );
}

/** Agent name + avatar, resolved in the fan-out hook (the home is org-less, so
 * we can't use the org-scoped `useVirtualMCP` here). */
function AgentLabel({ agent }: { agent: MyThreadAgent | null }) {
  const title = agent?.title ?? "Decopilot";
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0 text-xs text-muted-foreground">
      <AgentAvatar icon={agent?.icon ?? null} name={title} size="2xs" />
      <span className="truncate">{title}</span>
    </span>
  );
}

export function ThreadCard({ item }: { item: MyThread }) {
  const { thread, org, agent } = item;
  const virtualmcpid = thread.virtual_mcp_id;

  return (
    <Link
      to="/$org/$taskId"
      params={{ org: org.slug, taskId: thread.id }}
      search={virtualmcpid ? { virtualmcpid } : {}}
      className={cn(
        "group flex flex-col gap-2.5 rounded-xl border border-border bg-background p-4 text-left",
        "transition-colors hover:border-border/80 hover:bg-accent/30",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
      )}
    >
      {/* org + activity */}
      <div className="flex items-center justify-between gap-2 min-w-0">
        <span className="inline-flex items-center gap-1.5 min-w-0 text-xs text-muted-foreground">
          <OrgIcon org={org} size="xs" />
          <span className="truncate font-medium text-foreground/70">
            {org.name}
          </span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {relativeTime(thread.updated_at)}
        </span>
      </div>

      {/* title */}
      <h3 className="text-sm font-semibold leading-snug line-clamp-2 text-foreground">
        {thread.title || "Untitled thread"}
      </h3>

      {/* AI analysis — heuristic instant, LLM summary progressively */}
      <ThreadAnalysis item={item} />

      {/* footer: agent + status */}
      <div className="mt-auto flex items-center justify-between gap-2 pt-1 min-w-0">
        <AgentLabel agent={agent} />
        <StatusPill status={thread.status} />
      </div>
    </Link>
  );
}
