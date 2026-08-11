import { useState } from "react";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@decocms/ui/components/command.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { Check, CheckDone01, ChevronDown, Plus } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";
import { useThreadActions } from "@/components/chat/store/hooks";
import {
  useTaskBoardItemActions,
  useTaskBoardItems,
} from "@/hooks/use-task-board-items";
import {
  STATUS_CONFIG,
  STATUSES,
  statusIconClassName,
  type TaskBoardItem,
  type TaskBoardItemStatus,
  type TaskBoardItemThread,
} from "@/layouts/task-board/config";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useNavigate } from "@tanstack/react-router";
import { useOptionalChatTask } from "../context";
import { usePanelActions } from "@/layouts/shell-layout";
import { useProjectContext, useVirtualMCP } from "@/sdk";
import { getActiveGithubRepo } from "@/lib/github-repo";
import {
  branchUserLabel,
  generateBranchName,
} from "@decocms/shared/branch-name";
import { writeStoredAutosend } from "@/lib/autosend";
import { authClient } from "@/lib/auth-client";
import { NewTaskDialog } from "./new-task-dialog";

/**
 * Task-based flow replacement for the branch picker. The TASK BOARD is the
 * source of truth: this names the board task you're editing and switches
 * between your board tasks for this site. Each task's work lives on a linked
 * thread (its branch/CMS); "New task" creates a board item + a thread on this
 * repo-bound agent, so the work shows up on the board.
 *
 * Rendered only when the `taskBasedFlow` org flag is on (see the branch selector
 * in workspace-panel-group).
 */
export function TaskPill({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  // Which board column the list is filtered to. Defaults to the current task's
  // column each time the pill opens (see the Popover's onOpenChange).
  const [statusFilter, setStatusFilter] =
    useState<TaskBoardItemStatus>("triage");
  const { items } = useTaskBoardItems();
  const tb = useTaskBoardItemActions();
  const { create: createThread } = useThreadActions();
  const activeTask = useOptionalChatTask()?.activeTask ?? null;
  const { setTaskId } = usePanelActions();
  const navigate = useNavigate();
  const { org, locator } = useProjectContext();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;

  // A brand-new branch name per task, so every task is isolated. Omitting the
  // branch on create makes the server REUSE the most-recently-touched branch
  // from the sandboxMap — which silently lands two tasks on one branch.
  const freshBranch = () => generateBranchName(branchUserLabel(session?.user));

  // This site's repo — the task's `repoOwner`/`repoName` is the source-of-truth
  // scope. Legacy tasks (pre-repo column) fall back to a linked thread on this
  // agent so they don't vanish.
  const repo = getActiveGithubRepo(useVirtualMCP(virtualMcpId));
  const belongsToSite = (item: TaskBoardItem) =>
    (repo != null &&
      item.repoOwner === repo.owner &&
      item.repoName === repo.name) ||
    item.threads.some((th) => th.virtualMcpId === virtualMcpId);

  // The board is org-wide; scope to this site + "yours" (createdBy) client-side.
  // Most-recently-touched first.
  const taskItems = items
    .filter(
      (item) => (!userId || item.createdBy === userId) && belongsToSite(item),
    )
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

  // Which board task owns the thread currently open (match by linked threadId).
  const currentItem = activeTask
    ? items.find((item) =>
        item.threads.some((th) => th.threadId === activeTask.id),
      )
    : undefined;

  // "New chat" is the app's marker for a never-titled thread — surface it as an
  // untitled TASK, never leaking the chat vocabulary. Falls back to the thread
  // title only when the current thread isn't a board task yet.
  const untitled = t("chat.taskPill.untitled");
  const currentTitle =
    currentItem?.title ||
    (activeTask?.title && activeTask.title !== "New chat"
      ? activeTask.title
      : untitled);
  const label = t("chat.taskPill.editing", { task: currentTitle });

  // Open a task's CMS: its first repo-bound (preview-capable) thread, else any
  // thread with an agent. A task with NO environment yet (created straight on
  // the board) gets one spun up on this site's agent and linked, so it becomes
  // editable. Preview shows the thread's branch automatically.
  const openItem = async (item: TaskBoardItem) => {
    const th: TaskBoardItemThread | undefined =
      item.threads.find((x) => x.hasPreview && x.virtualMcpId) ??
      item.threads.find((x) => x.virtualMcpId);
    if (th?.virtualMcpId) {
      setTaskId(th.threadId, th.virtualMcpId, { main: "preview" });
      return;
    }
    if (starting) return;
    setStarting(true);
    try {
      const newId = crypto.randomUUID();
      await createThread({
        id: newId,
        virtual_mcp_id: virtualMcpId,
        branch: freshBranch(),
      });
      await tb.link.mutateAsync({ id: item.id, linkThreadId: newId });
      setTaskId(newId, virtualMcpId, { main: "preview" });
    } finally {
      setStarting(false);
    }
  };

  // Describe → a real board task: a fresh thread on THIS repo-bound agent (never
  // the Super Agent — no assigneeId), a board item, the link between them, and
  // the autosent prompt so the agent starts working on a new branch.
  const startFromPrompt = async (prompt: string) => {
    if (starting) return;
    setStarting(true);
    try {
      const newId = crypto.randomUUID();
      const tiptapDoc = {
        type: "doc" as const,
        content: [
          { type: "paragraph", content: [{ type: "text", text: prompt }] },
        ],
      };
      writeStoredAutosend(sessionStorage, locator, newId, { tiptapDoc });
      await createThread({
        id: newId,
        virtual_mcp_id: virtualMcpId,
        branch: freshBranch(),
      });
      const firstLine = prompt.split("\n")[0]?.trim() ?? "";
      const { item } = await tb.create.mutateAsync({
        title: (firstLine || prompt).slice(0, 120),
        description: prompt,
        repoOwner: repo?.owner ?? null,
        repoName: repo?.name ?? null,
      });
      await tb.link.mutateAsync({ id: item.id, linkThreadId: newId });
      setTaskId(newId, virtualMcpId, { main: "preview", autosend: true });
      setNewTaskOpen(false);
    } finally {
      setStarting(false);
    }
  };

  // Edit manually → a fresh CMS environment only, NOT a board task (it must not
  // clutter the board). ALWAYS a new thread on a NEW branch (never reuse a
  // session — the point is to branch off the current, unpublished work and start
  // clean). The thread is titled "CMS change" so the pill names it instead of
  // showing "Untitled task". `sidepanel: 0` forces the chat closed (the
  // repo-bound agent defaults it open); `cms: 1` opens the CMS editor.
  const startManualEdit = async () => {
    if (starting) return;
    setNewTaskOpen(false);
    setStarting(true);
    try {
      const newId = crypto.randomUUID();
      const branch = freshBranch();
      await createThread({
        id: newId,
        virtual_mcp_id: virtualMcpId,
        branch,
        title: t("chat.newTask.manualEditTitle"),
      });
      navigate({
        to: "/$org/$taskId",
        params: { org: org.slug, taskId: newId },
        search: {
          virtualmcpid: virtualMcpId,
          main: "preview",
          sidepanel: 0,
          cms: 1,
        },
      });
    } finally {
      setStarting(false);
    }
  };

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // Open focused on the column the current task lives in.
          if (next) setStatusFilter(currentItem?.status ?? "triage");
        }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex min-w-0 shrink">
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={label}
                  className="shrink min-w-0 max-w-[220px] gap-1.5 text-xs"
                >
                  <CheckDone01 className="h-3.5 w-3.5 shrink-0" />
                  {/* Collapse to icon-only under 768px of panel header — the task
                    name stays available via the tooltip. */}
                  <span className="min-w-0 truncate @max-3xl/panel-header:hidden">
                    {currentTitle}
                  </span>
                  <ChevronDown size={12} className="opacity-60 shrink-0" />
                </Button>
              </PopoverTrigger>
            </span>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
        <PopoverContent
          className="w-[min(420px,calc(100vw-2rem))] p-0"
          align="start"
        >
          <Command>
            {/* Search + New task beside it. */}
            <div className="*:data-[slot=command-input-wrapper]:flex-1 *:data-[slot=command-input-wrapper]:border-b-0 flex items-center border-b border-border pr-2">
              <CommandInput
                placeholder={t("chat.taskPill.searchPlaceholder")}
              />
              <Button
                variant="outline"
                size="sm"
                className="h-7 shrink-0 gap-1"
                onClick={() => {
                  setOpen(false);
                  setNewTaskOpen(true);
                }}
              >
                <Plus size={14} />
                {t("chat.taskPill.newTask")}
              </Button>
            </div>
            {/* Column filter — defaults to the current task's column on open. */}
            <div className="flex gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
              {STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatusFilter(s)}
                  className={cn(
                    "shrink-0 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                    statusFilter === s
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(STATUS_CONFIG[s].labelKey)}
                </button>
              ))}
            </div>
            <CommandList>
              <CommandEmpty>{t("chat.taskPill.empty")}</CommandEmpty>
              <CommandGroup>
                {taskItems
                  .filter((item) => item.status === statusFilter)
                  .map((item) => {
                    const StatusIcon = STATUS_CONFIG[item.status].icon;
                    return (
                      <CommandItem
                        // Include the id so two same-named tasks stay distinct to cmdk.
                        key={item.id}
                        value={`${item.title} ${item.id}`}
                        className="gap-2"
                        onSelect={() => {
                          setOpen(false);
                          if (item.id !== currentItem?.id) void openItem(item);
                        }}
                      >
                        <StatusIcon
                          size={16}
                          className={cn("shrink-0", statusIconClassName(item))}
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {item.title || untitled}
                        </span>
                        {item.id === currentItem?.id && (
                          <Check size={14} className="shrink-0" />
                        )}
                      </CommandItem>
                    );
                  })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <NewTaskDialog
        // Remount on open so the prompt textarea resets between tasks.
        key={newTaskOpen ? "new-task-open" : "new-task-closed"}
        open={newTaskOpen}
        isSubmitting={starting}
        onClose={() => setNewTaskOpen(false)}
        onSubmitPrompt={(text) => void startFromPrompt(text)}
        onEditManually={startManualEdit}
      />
    </>
  );
}
