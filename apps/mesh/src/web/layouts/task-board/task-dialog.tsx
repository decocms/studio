import { useState } from "react";
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
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { ChevronDown, Trash01, User01 } from "@untitledui/icons";
import { useMembers } from "@/web/hooks/use-members";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  PRIORITIES,
  PRIORITY_CONFIG,
  type TaskBoardItem,
  type TaskBoardItemPriority,
  type Member,
} from "./config";

function getInitials(name?: string | null) {
  if (!name) return "?";
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function TaskBoardItemDialog({
  open,
  onClose,
  item,
  onSubmit,
  onDelete,
  isSaving,
}: {
  open: boolean;
  onClose: () => void;
  /** Present in edit mode, prefills the form. */
  item?: TaskBoardItem;
  onSubmit: (input: {
    title: string;
    description: string | null;
    priority: TaskBoardItemPriority;
    assigneeId: string | null;
  }) => void;
  onDelete?: () => void;
  isSaving?: boolean;
}) {
  const { data } = useMembers();
  const members = (data?.data?.members ?? []) as Member[];

  const [title, setTitle] = useState(item?.title ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [priority, setPriority] = useState<TaskBoardItemPriority>(
    item?.priority ?? "medium",
  );
  const [assigneeId, setAssigneeId] = useState<string | null>(
    item?.assigneeId ?? null,
  );

  const reset = () => {
    setTitle(item?.title ?? "");
    setDescription(item?.description ?? "");
    setPriority(item?.priority ?? "medium");
    setAssigneeId(item?.assigneeId ?? null);
  };

  const close = () => {
    onClose();
    reset();
  };

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    onSubmit({
      title: trimmed,
      description: description.trim() || null,
      priority,
      assigneeId,
    });
  };

  const assignee = members.find((m) => m.userId === assigneeId);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        className="gap-0 overflow-hidden p-0 sm:max-w-[560px]"
        closeButtonClassName="hidden"
      >
        <DialogTitle className="sr-only">
          {item ? "Edit task" : "New task"}
        </DialogTitle>

        <div className="flex flex-col gap-3 px-4 pt-4">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title"
            autoFocus
            className="border-0 px-0 text-base font-medium shadow-none focus-visible:ring-0"
          />
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Add a description…"
            className="min-h-[96px] resize-none border-0 px-0 text-sm shadow-none focus-visible:ring-0"
          />
        </div>

        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-muted"
              >
                <span
                  className={cn(
                    "size-2 rounded-full",
                    PRIORITY_CONFIG[priority].badgeClassName,
                  )}
                />
                {PRIORITY_CONFIG[priority].label}
                <ChevronDown size={12} className="text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-40">
              {PRIORITIES.map((p) => (
                <DropdownMenuItem key={p} onSelect={() => setPriority(p)}>
                  {PRIORITY_CONFIG[p].label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-muted"
              >
                {assignee ? (
                  <Avatar
                    url={assignee.user?.image ?? undefined}
                    fallback={getInitials(assignee.user?.name)}
                    shape="circle"
                    size="2xs"
                  />
                ) : (
                  <User01 size={13} className="text-muted-foreground" />
                )}
                {assignee?.user?.name ?? "Unassigned"}
                <ChevronDown size={12} className="text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuItem onSelect={() => setAssigneeId(null)}>
                Unassigned
              </DropdownMenuItem>
              {members.map((m) => (
                <DropdownMenuItem
                  key={m.userId}
                  onSelect={() => setAssigneeId(m.userId)}
                  className="gap-2"
                >
                  <Avatar
                    url={m.user?.image ?? undefined}
                    fallback={getInitials(m.user?.name)}
                    shape="circle"
                    size="2xs"
                  />
                  <span className="truncate">{m.user?.name ?? m.userId}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {item && onDelete && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Delete task"
              className="ml-0 text-muted-foreground hover:text-destructive"
              onClick={onDelete}
            >
              <Trash01 size={14} />
            </Button>
          )}

          <Button
            size="sm"
            className="ml-auto"
            disabled={!title.trim() || isSaving}
            onClick={submit}
          >
            {item ? "Save" : "Create task"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
