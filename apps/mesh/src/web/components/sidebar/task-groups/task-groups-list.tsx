import { type ReactNode, useState } from "react";
import { FilterLines, SearchSm } from "@untitledui/icons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { useSidebar } from "@deco/ui/components/sidebar.tsx";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useNavigate, useParams } from "@tanstack/react-router";
import { authClient } from "@/web/lib/auth-client";
import {
  useThreadActions,
  useThreads,
} from "@/web/components/chat/store/hooks";
import { filterThreads } from "@/web/components/chat/task";
import { usePanelActions } from "@/web/layouts/shell-layout";
import { GlobalSearchDialog } from "@/web/layouts/tasks-panel/global-search-dialog";
import { track } from "@/web/lib/posthog-client";
import type { Task } from "@/web/components/chat/task/types";
import { ToolbarIconButton } from "@/web/components/toolbar-icon-button";
import { TaskRow } from "@/web/layouts/tasks-panel/task-row";

// Single-agent model: the sidebar is a flat list of TASKS — no agent grouping.
type TypeFilter = "all" | "manual" | "automation";
type MemberFilter = "all" | "mine";

const TYPE_LABELS: Record<TypeFilter, string> = {
  all: "All tasks",
  manual: "Chats",
  automation: "Automation",
};

const MEMBER_LABELS: Record<MemberFilter, string> = {
  all: "All members",
  mine: "Mine only",
};

export function TaskGroupsList() {
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id;
  const { org } = useProjectContext();

  const { threads: allThreads } = useThreads();
  const visibleThreads = filterThreads(allThreads, { hidden: false });
  const { hide } = useThreadActions();

  const navigate = useNavigate();
  const { setTaskId } = usePanelActions();
  const params = useParams({ strict: false }) as { taskId?: string };
  const activeTaskId = params.taskId ?? null;

  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [memberFilter, setMemberFilter] = useState<MemberFilter>("all");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchEverOpened, setSearchEverOpened] = useState(false);

  const tasks = visibleThreads
    .filter((t) =>
      memberFilter === "mine" && currentUserId
        ? t.created_by === currentUserId
        : true,
    )
    .filter((t) =>
      typeFilter === "automation"
        ? Boolean(t.trigger_id)
        : typeFilter === "manual"
          ? !t.trigger_id
          : true,
    )
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));

  const handleArchive = (task: Task) => {
    const wasActive = task.id === activeTaskId;
    hide(task.id);
    if (!wasActive) return;
    const next = tasks.find((t) => t.id !== task.id);
    if (next) {
      setTaskId(next.id, next.virtual_mcp_id);
    } else {
      navigate({ to: "/$org", params: { org: org.slug } });
    }
  };

  const filtersActive = typeFilter !== "all" || memberFilter !== "all";
  const { state: sidebarState, isMobile } = useSidebar();
  const isCollapsed = sidebarState === "collapsed" && !isMobile;

  // Collapsed rail shows only nav icons — no task list.
  if (isCollapsed) return null;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 px-1 h-10 md:h-7 mb-2 flex items-center gap-0.5">
        <ToolbarIconButton
          aria-label="Search threads"
          onClick={() => {
            track("tasks_panel_search_opened");
            setSearchEverOpened(true);
            setSearchOpen(true);
          }}
        >
          <SearchSm size={16} />
        </ToolbarIconButton>
        <Popover>
          <PopoverTrigger asChild>
            <ToolbarIconButton aria-label="Filter tasks">
              <FilterLines size={16} />
              {filtersActive && (
                <span className="absolute top-0.5 right-0.5 size-2 rounded-full bg-destructive ring-1 ring-sidebar pointer-events-none" />
              )}
            </ToolbarIconButton>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            sideOffset={8}
            collisionPadding={16}
            className="w-72 p-3"
          >
            <div className="flex flex-col gap-2">
              <FilterRow label="Members">
                <Select
                  value={memberFilter}
                  onValueChange={(v) => setMemberFilter(v as MemberFilter)}
                >
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(MEMBER_LABELS) as MemberFilter[]).map(
                      (opt) => (
                        <SelectItem key={opt} value={opt}>
                          {MEMBER_LABELS[opt]}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              </FilterRow>
              <FilterRow label="Type">
                <Select
                  value={typeFilter}
                  onValueChange={(v) => setTypeFilter(v as TypeFilter)}
                >
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(TYPE_LABELS) as TypeFilter[]).map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {TYPE_LABELS[opt]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FilterRow>
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain flex flex-col gap-0.5 -mr-2 pr-2">
        {tasks.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">
            No tasks yet
          </div>
        ) : (
          tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              isActive={activeTaskId === task.id}
              onClick={() => setTaskId(task.id, task.virtual_mcp_id)}
              onArchive={() => handleArchive(task)}
              showAutomationBadge={Boolean(task.trigger_id)}
            />
          ))
        )}
      </div>
      {searchEverOpened && (
        <GlobalSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      )}
    </div>
  );
}

function FilterRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="w-36 shrink-0">{children}</div>
    </div>
  );
}
