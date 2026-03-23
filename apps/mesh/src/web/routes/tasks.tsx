/**
 * Tasks Page — Status-grouped issue list
 *
 * 3 display groups: Needs input, In progress, Done.
 * - Two-line rows: [agent avatar] Title / metadata
 * - Agent icon on the left shows which agent worked on the task
 * - Click to open the conversation
 */

import { useChatStable } from "@/web/components/chat/context";
import type { Task } from "@/web/components/chat/task/types";
import { AgentAvatar } from "@/web/components/agent-icon";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { Page } from "@/web/components/page";
import { User } from "@/web/components/user/user.tsx";
import { formatTimeAgo } from "@/web/lib/format-time";
import {
  buildDisplayGroups,
  getTaskVerb,
  isActionable,
  isOpen,
  type DisplayGroup,
} from "@/web/lib/task-status";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@deco/ui/components/breadcrumb.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  getWellKnownDecopilotVirtualMCP,
  useConnections,
  useIsOrgAdmin,
  useProjectContext,
  type ConnectionEntity,
} from "@decocms/mesh-sdk";
import {
  CheckDone02,
  ChevronRight,
  Loading01,
  SearchMd,
} from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import { Suspense, useRef, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { useChatStore } from "@/web/components/chat/store/selectors";

// ────────────────────────────────────────

function TruncatedText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <Tooltip
      open={open}
      onOpenChange={(val) => {
        if (val && ref.current) {
          setOpen(ref.current.scrollWidth > ref.current.clientWidth);
        } else {
          setOpen(false);
        }
      }}
    >
      <TooltipTrigger asChild>
        <span ref={ref} className={cn("truncate block", className)}>
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="start">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

// ────────────────────────────────────────
// Group header
// ────────────────────────────────────────

function StatusGroupHeader({
  group,
  isOpen,
  onToggle,
}: {
  group: DisplayGroup;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const Icon = group.icon;

  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex items-center gap-2 px-6 py-2.5 w-full hover:bg-accent/30 transition-colors cursor-pointer"
    >
      <ChevronRight
        size={14}
        className={cn(
          "text-muted-foreground transition-transform duration-150",
          isOpen && "rotate-90",
        )}
      />
      <Icon size={16} className={group.iconClassName} />
      <span className="text-sm font-medium text-foreground">{group.label}</span>
      <span className="text-sm text-muted-foreground tabular-nums">
        {group.tasks.length}
      </span>
    </button>
  );
}

// ────────────────────────────────────────
// Multi-agent avatar stack
// ────────────────────────────────────────

function AgentAvatarStack({
  agentIds,
  connectionMap,
  defaultAgent,
}: {
  agentIds: string[];
  connectionMap: Map<string, ConnectionEntity>;
  defaultAgent: { icon: string | null | undefined; title: string };
}) {
  const display =
    agentIds.length > 0
      ? agentIds.slice(0, 2).map((id) => {
          const conn = connectionMap.get(id);
          return conn ? { icon: conn.icon, title: conn.title } : defaultAgent;
        })
      : [defaultAgent];

  const extra = Math.max(0, agentIds.length - 2);

  return (
    <div className="flex -space-x-1 shrink-0">
      {display.map((agent, i) => (
        <div key={i} className="ring-1 ring-background rounded-full">
          <AgentAvatar icon={agent.icon} name={agent.title} size="xs" />
        </div>
      ))}
      {extra > 0 && (
        <div className="flex items-center justify-center size-5 rounded-full bg-muted text-[9px] font-medium text-muted-foreground ring-1 ring-background">
          +{extra}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────
// Task row
// ────────────────────────────────────────

function TaskRow({
  task,
  connectionMap,
  defaultAgent,
  onOpen,
}: {
  task: Task;
  connectionMap: Map<string, ConnectionEntity>;
  defaultAgent: { icon: string | null | undefined; title: string };
  onOpen: () => void;
}) {
  const agentIds = task.agent_ids ?? [];
  const firstAgentId = agentIds[0];
  const primaryAgent =
    firstAgentId !== undefined
      ? (() => {
          const conn = connectionMap.get(firstAgentId);
          return conn ? { icon: conn.icon, title: conn.title } : defaultAgent;
        })()
      : defaultAgent;

  const cachedMessages = useChatStore((s) => s.threadMessages[task.id]);
  const { verb, labelColor } = getTaskVerb(task, cachedMessages);

  return (
    <div
      className="flex items-start gap-3 px-6 py-3 hover:bg-accent/40 transition-colors cursor-pointer"
      onClick={onOpen}
    >
      {/* Agent avatar stack */}
      <AgentAvatarStack
        agentIds={agentIds}
        connectionMap={connectionMap}
        defaultAgent={defaultAgent}
      />

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Line 1: Title */}
        <TruncatedText
          text={task.title || "Untitled"}
          className="text-sm font-medium text-foreground"
        />

        {/* Line 2: Metadata */}
        <div className="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground">
          <span>{primaryAgent.title}</span>
          <span>·</span>
          <span className={labelColor}>{verb}</span>
          {task.updated_at && (
            <>
              <span>·</span>
              <span className="tabular-nums">
                {formatTimeAgo(new Date(task.updated_at))}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Right: creator avatar */}
      <div className="hidden md:flex items-center pt-0.5 shrink-0">
        {task.created_by && <User id={task.created_by} size="3xs" avatarOnly />}
      </div>
    </div>
  );
}

// ────────────────────────────────────────
// Page
// ────────────────────────────────────────

function TasksPageContent() {
  const { org, project } = useProjectContext();
  const isOrgAdmin = useIsOrgAdmin();
  const navigate = useNavigate();
  const { switchToTask, tasks } = useChatStable();

  const connections = useConnections();
  const connectionMap = new Map<string, ConnectionEntity>(
    (connections ?? []).map((c): [string, ConnectionEntity] => [c.id, c]),
  );

  const [searchQuery, setSearchQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const visible = tasks.filter((t) => !t.hidden);

  const searched = searchQuery.trim()
    ? visible.filter((t) =>
        t.title.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : visible;

  const groups = buildDisplayGroups(searched);

  const defaultAgent = getWellKnownDecopilotVirtualMCP(org.id);

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleOpen = async (taskId: string) => {
    await switchToTask(taskId);
    if (isOrgAdmin) {
      navigate({
        to: "/$org",
        params: { org: org.slug },
      });
    } else {
      navigate({
        to: "/$org/projects/$virtualMcpId",
        params: { org: org.slug, virtualMcpId: project.id },
      });
    }
  };

  // Summary counts
  const reviewCount = visible.filter((t) => isActionable(t.status)).length;
  const openCount = visible.filter((t) => isOpen(t.status)).length;
  const doneCount = visible.filter(
    (t) => (t.status ?? "completed") === "completed",
  ).length;

  return (
    <Page>
      <Page.Header>
        <Page.Header.Left>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Tasks</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          {/* Inline counts */}
          <div className="flex items-center gap-3 ml-3 text-xs text-muted-foreground">
            {reviewCount > 0 && (
              <span>
                <span className="font-semibold text-orange-500 tabular-nums">
                  {reviewCount}
                </span>{" "}
                to review
              </span>
            )}
            <span>
              <span className="tabular-nums">{openCount}</span> open
            </span>
            <span>
              <span className="tabular-nums">{doneCount}</span> done
            </span>
          </div>
        </Page.Header.Left>
        <Page.Header.Right>
          <div className="relative w-48">
            <SearchMd
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50"
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSearchQuery("");
                  (e.target as HTMLInputElement).blur();
                }
              }}
              placeholder="Search..."
              className="w-full h-8 pl-8 pr-3 rounded-md border border-border/60 bg-transparent text-sm placeholder:text-muted-foreground/50 outline-none focus:border-foreground/30 transition-colors"
            />
          </div>
        </Page.Header.Right>
      </Page.Header>
      <Page.Content>
        {groups.length === 0 ? (
          <EmptyState
            image={
              <CheckDone02 size={40} className="text-muted-foreground/40" />
            }
            title={searchQuery ? "No matches" : "No tasks yet"}
            description={
              searchQuery
                ? `No tasks match "${searchQuery}"`
                : "Tasks will appear here as agents start working."
            }
            className="py-20"
          />
        ) : (
          <div className="flex flex-col">
            {groups.map((group) => {
              const isGroupOpen = !collapsed[group.key];
              return (
                <div key={group.key}>
                  <StatusGroupHeader
                    group={group}
                    isOpen={isGroupOpen}
                    onToggle={() => toggleGroup(group.key)}
                  />
                  {isGroupOpen &&
                    group.tasks.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        connectionMap={connectionMap}
                        defaultAgent={defaultAgent}
                        onOpen={() => handleOpen(task.id)}
                      />
                    ))}
                </div>
              );
            })}
          </div>
        )}
      </Page.Content>
    </Page>
  );
}

export default function TasksPage() {
  return (
    <ErrorBoundary>
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <Loading01
              size={32}
              className="animate-spin text-muted-foreground"
            />
          </div>
        }
      >
        <TasksPageContent />
      </Suspense>
    </ErrorBoundary>
  );
}
