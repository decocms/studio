/**
 * The project home's first control: say what you want done.
 *
 * It sits where the org home puts its search, because the two pages answer
 * different questions — the org home is where you LOOK for something, a project
 * is where you ASK for one.
 * Linear's composer, inline. Pills stay unset until touched; only title is required. */

import { useRef, useState } from "react";
import { Check, ChevronDown } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { AgentAvatar } from "@/components/agent-icon";
import {
  useBoardColumns,
  useTaskBoardItemActions,
} from "@/hooks/use-task-board-items";
import { useProjectScope } from "@/hooks/use-project-scope";
import {
  PRIORITIES,
  PRIORITY_CONFIG,
  TASK_TYPES,
  TASK_TYPE_CONFIG,
  laneHeader,
  type TaskBoardItemPriority,
  type TaskBoardItemType,
} from "@/layouts/task-board/config";
import { track } from "@/lib/posthog-client";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";
import type { ComponentType, ReactNode } from "react";

/** One attribute pill: a glyph, the value or its unset name, a menu. */
function AttributePill({
  icon,
  label,
  isSet,
  children,
}: {
  icon: ReactNode;
  label: string;
  isSet: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-border px-2.5 text-xs transition-colors",
            /* Solid either way. Dashed reads as a placeholder, and these are
               real controls whether or not you have picked a value yet — the
               difference between set and unset is the label and the glyph. */
            isSet
              ? "bg-accent/60 text-foreground"
              : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
          )}
        >
          {icon}
          {label}
          <ChevronDown size={12} className="text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A menu row that shows its own glyph and ticks when chosen. */
function OptionRow({
  icon: Icon,
  iconClassName,
  label,
  selected,
  onSelect,
}: {
  icon: ComponentType<{ size?: number; className?: string }>;
  iconClassName: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem onSelect={onSelect} className="gap-2">
      <Icon size={14} className={cn("shrink-0", iconClassName)} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected && <Check size={14} />}
    </DropdownMenuItem>
  );
}

export function NewTaskComposer() {
  const t = useT();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [priority, setPriority] = useState<TaskBoardItemPriority | null>(null);
  const [type, setType] = useState<TaskBoardItemType | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const { repo, project } = useProjectScope();
  const columns = useBoardColumns();
  const actions = useTaskBoardItemActions();

  const trimmed = title.trim();
  const canSubmit = trimmed.length > 0 && !actions.create.isPending;
  const reset = () => {
    setTitle("");
    setDescription("");
    setStatus(null);
    setPriority(null);
    setType(null);
  };

  const submit = () => {
    if (!canSubmit) return;
    track("task_created", {
      source: "project_home_composer",
      withDescription: !!description.trim(),
    });
    /** Clear on success only. `mutate` is fire-and-forget, so resetting on the
     *  next line threw away a title and a typed-out repro whenever the create
     *  failed — no card, no message, nothing to paste back. */
    actions.create.mutate(
      {
        title: trimmed,
        description: description.trim() || undefined,
        status: status ?? undefined,
        priority: priority ?? undefined,
        type: type ?? undefined,
        repo: repo ?? undefined,
      },
      {
        onSuccess: () => {
          reset();
          titleRef.current?.focus();
        },
        onError: (error) => {
          toast.error(
            error instanceof Error
              ? error.message
              : t("home.newTask.createFailed"),
          );
        },
      },
    );
  };

  const lane = status ? laneHeader(status, t, columns) : null;
  const LaneIcon = lane?.visual.icon;
  const priorityConfig = priority ? PRIORITY_CONFIG[priority] : null;
  const PriorityIcon = priorityConfig?.icon;
  const typeConfig = type ? TASK_TYPE_CONFIG[type] : null;
  const TypeIcon = typeConfig?.icon;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="card-shadow flex flex-col rounded-xl bg-card px-4 pt-4 pb-3"
    >
      {/* Three groups, spaced by what they are rather than evenly: the
          breadcrumb labels the form, the two fields are ONE thing you are
          writing so they sit tight together, and the attributes are a footer,
          set off by a rule. A uniform gap made four unrelated rows. */}
      {project && (
        <p className="mb-4 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-foreground">
            <AgentAvatar
              icon={project.icon}
              name={project.title}
              size="2xs"
              className="size-3.5 shrink-0"
            />
            {project.title}
          </span>
          <span aria-hidden="true">›</span>
          {t("home.newTask.heading")}
        </p>
      )}

      <input
        ref={titleRef}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder={t("home.newTask.placeholder")}
        aria-label={t("home.newTask.placeholder")}
        /* The placeholder keeps the title's weight — dropping to normal made
           the empty form two identical grey lines with no hierarchy at all. */
        className="w-full bg-transparent text-lg leading-snug font-semibold text-foreground outline-none placeholder:text-muted-foreground/70"
      />

      <textarea
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        placeholder={t("home.newTask.descriptionPlaceholder")}
        aria-label={t("home.newTask.descriptionPlaceholder")}
        rows={2}
        className="mt-1.5 w-full resize-none bg-transparent text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
      />

      <div className="-mx-4 mt-4 flex flex-wrap items-center gap-1.5 border-t border-border px-4 pt-3">
        <AttributePill
          isSet={!!lane}
          label={lane?.label ?? t("home.newTask.status")}
          icon={
            LaneIcon ? (
              <LaneIcon
                size={14}
                className={cn("shrink-0", lane?.visual.iconClassName)}
              />
            ) : null
          }
        >
          {columns.map((column) => {
            const header = laneHeader(column.key, t, columns);
            return (
              <OptionRow
                key={column.key}
                icon={header.visual.icon}
                iconClassName={header.visual.iconClassName}
                label={header.label}
                selected={status === column.key}
                onSelect={() =>
                  setStatus(status === column.key ? null : column.key)
                }
              />
            );
          })}
        </AttributePill>

        <AttributePill
          isSet={!!priorityConfig}
          label={
            priorityConfig
              ? t(priorityConfig.labelKey)
              : t("home.newTask.priority")
          }
          icon={
            PriorityIcon ? (
              <PriorityIcon
                size={14}
                className={cn("shrink-0", priorityConfig?.iconClassName)}
              />
            ) : null
          }
        >
          {PRIORITIES.map((value) => (
            <OptionRow
              key={value}
              icon={PRIORITY_CONFIG[value].icon}
              iconClassName={PRIORITY_CONFIG[value].iconClassName}
              label={t(PRIORITY_CONFIG[value].labelKey)}
              selected={priority === value}
              onSelect={() => setPriority(priority === value ? null : value)}
            />
          ))}
        </AttributePill>

        <AttributePill
          isSet={!!typeConfig}
          label={typeConfig ? t(typeConfig.labelKey) : t("home.newTask.type")}
          icon={
            TypeIcon ? (
              <TypeIcon
                size={14}
                className={cn("shrink-0", typeConfig?.iconClassName)}
              />
            ) : null
          }
        >
          {TASK_TYPES.map((value) => (
            <OptionRow
              key={value}
              icon={TASK_TYPE_CONFIG[value].icon}
              iconClassName={TASK_TYPE_CONFIG[value].iconClassName}
              label={t(TASK_TYPE_CONFIG[value].labelKey)}
              selected={type === value}
              onSelect={() => setType(type === value ? null : value)}
            />
          ))}
        </AttributePill>

        {/* No Cancel beside it: this form is always open rather than a dialog,
            so there is nothing to back out of — and on an empty one the button
            did nothing at all. */}
        <Button
          type="submit"
          size="sm"
          disabled={!canSubmit}
          className="ml-auto h-7"
        >
          {t("home.newTask.submit")}
        </Button>
      </div>
    </form>
  );
}
