/**
 * Linear-like task detail dialog for the demo board: meta row, title,
 * description, mock pull request card and agent session timelines.
 */

import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useThreadActions } from "@/web/components/chat/store/hooks";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@deco/ui/components/command.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { getInitials } from "@/web/lib/get-initials";
import { useMembers } from "@/web/hooks/use-members";
import type { Member } from "../config";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Check,
  ChevronRight,
  Clock,
  DotsHorizontal,
  Flag01,
  Send01,
  User01,
} from "@untitledui/icons";
import { GitHubIcon } from "@/web/components/icons/github-icon";
import {
  PRIORITIES,
  PRIORITY_CONFIG,
  STATUS_CONFIG,
  STATUSES,
} from "../config";
import type { DemoAssignee, DemoSession, DemoTask } from "./data";
import { DecoAvatar } from "./icons";
import { moveTask, setAssignee, setPriority } from "./store";

export function TaskDetailDialog({
  task,
  open,
  onClose,
  onOpenChat,
}: {
  task: DemoTask;
  open: boolean;
  onClose: () => void;
  onOpenChat: (session: DemoSession) => void;
}) {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const { create } = useThreadActions();

  // Edit opens the real preview panel: a fresh thread on the org's super
  // agent with the sandbox preview tab active.
  const openPreview = async () => {
    const decopilot = getWellKnownDecopilotVirtualMCP(org.id);
    const taskId = crypto.randomUUID();
    try {
      await create({ id: taskId, virtual_mcp_id: decopilot.id });
    } catch {
      // Toast already fired; navigate anyway.
    }
    navigate({
      to: "/$org/$taskId",
      params: { org: org.slug, taskId },
      search: { virtualmcpid: decopilot.id, main: "preview" },
    });
  };

  const statusConfig = STATUS_CONFIG[task.status];
  const StatusIcon = statusConfig.icon;
  const priorityConfig = PRIORITY_CONFIG[task.priority];
  const takenByAgent =
    task.status === "in_progress" ||
    task.status === "in_review" ||
    task.status === "done";

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
        <DialogContent className="flex h-[min(44rem,85vh)] flex-row gap-0 overflow-hidden p-0 sm:max-w-4xl">
          <DialogTitle className="sr-only">{task.title}</DialogTitle>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-6">
            <span className="text-xs font-medium text-muted-foreground">
              {task.key}
            </span>

            <h2 className="text-xl font-semibold text-foreground">
              {task.title}
            </h2>

            <p className="text-sm leading-relaxed text-muted-foreground">
              {task.description}
            </p>

            {((task.pr && task.prStatus) ||
              (takenByAgent && task.sessions && task.sessions.length > 0)) && (
              <div className="flex flex-col gap-3 border-t border-border pt-5">
                <h3 className="text-sm font-semibold text-foreground">
                  Activity
                </h3>
                {takenByAgent &&
                  task.sessions?.map((s, i) => (
                    <SessionCard
                      key={s.startedAgo + i}
                      session={s}
                      task={task}
                      onOpenChat={(session) => {
                        onClose();
                        onOpenChat(session);
                      }}
                    />
                  ))}
                {task.pr && task.prStatus && (
                  <PrCard task={task} onEdit={() => void openPreview()} />
                )}
              </div>
            )}
          </div>

          <aside className="flex w-56 shrink-0 flex-col gap-1 overflow-y-auto border-l border-border px-4 py-6">
            <h3 className="mb-2 px-2 text-xs font-medium text-muted-foreground">
              Properties
            </h3>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <PropertyButton
                  icon={
                    <StatusIcon
                      size={15}
                      className={statusConfig.iconClassName}
                    />
                  }
                >
                  {statusConfig.label}
                </PropertyButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {STATUSES.map((status) => {
                  const config = STATUS_CONFIG[status];
                  const Icon = config.icon;
                  return (
                    <DropdownMenuItem
                      key={status}
                      onSelect={() => moveTask(task.id, status)}
                    >
                      <Icon size={14} className={config.iconClassName} />
                      {config.label}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <PropertyButton
                  icon={
                    <Flag01
                      size={15}
                      className={priorityConfig.flagClassName}
                    />
                  }
                >
                  {priorityConfig.label}
                </PropertyButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {PRIORITIES.map((priority) => {
                  const config = PRIORITY_CONFIG[priority];
                  return (
                    <DropdownMenuItem
                      key={priority}
                      onSelect={() => setPriority(task.id, priority)}
                    >
                      <Flag01 size={14} className={config.flagClassName} />
                      {config.label}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
            <AssigneePicker task={task} takenByAgent={takenByAgent} />
            <PropertyButton
              icon={<Clock size={15} className="text-muted-foreground" />}
            >
              Est. {task.effort}
            </PropertyButton>
          </aside>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Effective assignee: explicit override wins, else derived from status. */
function effectiveAssignee(
  task: DemoTask,
  takenByAgent: boolean,
): DemoAssignee | null {
  if (task.assignee !== undefined) return task.assignee;
  return takenByAgent ? { type: "agent" } : null;
}

function AssigneePicker({
  task,
  takenByAgent,
}: {
  task: DemoTask;
  takenByAgent: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { data: membersData } = useMembers();
  const members = (membersData?.data?.members ?? []) as Member[];
  const assignee = effectiveAssignee(task, takenByAgent);

  const pick = (next: DemoAssignee | null) => {
    setAssignee(task.id, next);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <PropertyButton
          aria-label="Assignee"
          icon={
            assignee?.type === "agent" ? (
              <DecoAvatar />
            ) : assignee?.type === "user" ? (
              <Avatar
                url={assignee.image ?? undefined}
                fallback={getInitials(assignee.name)}
                shape="circle"
                size="2xs"
              />
            ) : (
              <User01 size={15} className="text-muted-foreground" />
            )
          }
        >
          {assignee?.type === "agent"
            ? "Deco"
            : assignee?.type === "user"
              ? assignee.name
              : "Unassigned"}
        </PropertyButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Assign to..." />
          <CommandList>
            <CommandEmpty>No one found.</CommandEmpty>
            <CommandGroup>
              <CommandItem value="no assignee" onSelect={() => pick(null)}>
                <User01 size={15} className="text-muted-foreground" />
                No assignee
                {assignee === null && <Check size={14} className="ml-auto" />}
              </CommandItem>
              <CommandItem
                value="deco agent"
                onSelect={() => pick({ type: "agent" })}
              >
                <DecoAvatar />
                Deco
                <Badge className="bg-muted text-[10px] text-muted-foreground">
                  Agent
                </Badge>
                {assignee?.type === "agent" && (
                  <Check size={14} className="ml-auto" />
                )}
              </CommandItem>
            </CommandGroup>
            {members.length > 0 && (
              <CommandGroup heading="Team members">
                {members.map((m) => {
                  const name = m.user?.name ?? m.userId;
                  return (
                    <CommandItem
                      key={m.userId}
                      value={name}
                      onSelect={() =>
                        pick({
                          type: "user",
                          userId: m.userId,
                          name,
                          image: m.user?.image ?? null,
                        })
                      }
                    >
                      <Avatar
                        url={m.user?.image ?? undefined}
                        fallback={getInitials(name)}
                        shape="circle"
                        size="2xs"
                      />
                      <span className="min-w-0 truncate">{name}</span>
                      {assignee?.type === "user" &&
                        assignee.userId === m.userId && (
                          <Check size={14} className="ml-auto" />
                        )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
            <CommandGroup>
              <CommandItem
                value="invite user"
                onSelect={() => setOpen(false)}
                className="text-muted-foreground"
              >
                <Send01 size={15} className="text-muted-foreground" />
                Invite user
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function PropertyButton({
  icon,
  children,
  ...props
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
} & React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted"
    >
      <span className="flex size-5 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}

function PrCard({ task, onEdit }: { task: DemoTask; onEdit: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const pr = task.pr;
  if (!pr) return null;
  const merged = task.prStatus === "merged";

  return (
    <div className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full flex-col gap-2 px-4 py-3 text-left"
      >
        <div className="flex w-full items-center gap-2">
          <GitHubIcon size={16} className="shrink-0 text-foreground" />
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {pr.title}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            #{pr.number}
          </span>
          <span className="flex-1" />
          <Badge
            className={cn(
              "shrink-0 text-[10px]",
              merged
                ? "bg-purple-500/10 text-purple-600"
                : "bg-green-500/10 text-green-600",
            )}
          >
            {merged ? "Merged" : "Open"}
          </Badge>
        </div>

        <div
          className={cn(
            "relative overflow-hidden",
            !expanded && "max-h-[2.5rem]",
          )}
        >
          <p className="text-xs leading-relaxed text-muted-foreground">
            {pr.summary.join(". ")}.
          </p>
          {!expanded && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-card to-transparent" />
          )}
        </div>
      </button>

      <div className="flex items-center gap-2 px-4 pb-3">
        <Button variant="outline" size="sm" asChild>
          <a href="#" onClick={(e) => e.preventDefault()}>
            <GitHubIcon size={14} />
            View on GitHub
          </a>
        </Button>
        <Button size="sm" onClick={onEdit}>
          Edit
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={(e) => e.preventDefault()}
        >
          Publish
        </Button>
      </div>
    </div>
  );
}

function sessionStatus(
  task: DemoTask,
  session: DemoSession,
): { text: string; tone: "working" | "done" } | null {
  const prNumber = task.pr?.number;
  switch (task.status) {
    case "in_progress":
      return { text: `Working: ${session.workingStatus}`, tone: "working" };
    case "in_review":
      return {
        text: `Opened PR #${prNumber}, waiting for review`,
        tone: "done",
      };
    case "done":
      return { text: `PR #${prNumber} merged`, tone: "done" };
    case "triage":
    case "todo":
      return null;
    default: {
      const exhaustive: never = task.status;
      return exhaustive;
    }
  }
}

function SessionCard({
  session,
  task,
  onOpenChat,
}: {
  session: DemoSession;
  task: DemoTask;
  onOpenChat: (session: DemoSession) => void;
}) {
  const status = sessionStatus(task, session);
  const hasChat = !!session.chat?.length;

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 px-4 py-3">
        <DecoAvatar className="size-5" />
        <span className="text-sm font-medium text-foreground">Deco</span>
        <span className="text-xs text-muted-foreground/70">
          {session.startedAgo}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Session options"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <DotsHorizontal size={14} />
        </button>
      </div>

      <div className="border-t border-border" />

      <button
        type="button"
        onClick={() => hasChat && onOpenChat(session)}
        className={cn(
          "flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors",
          hasChat && "hover:bg-muted/40",
          !hasChat && "cursor-default",
        )}
      >
        {status && (
          <>
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                status.tone === "working"
                  ? "animate-pulse bg-blue-500"
                  : "bg-green-500",
              )}
            />
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
              {status.text}
            </span>
          </>
        )}
        <span className="flex-1" />
        {hasChat && (
          <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
        )}
      </button>
    </div>
  );
}
