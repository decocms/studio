import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useProjectContext } from "@decocms/mesh-sdk";
import {
  ArrowRight,
  Edit05,
  FilterLines,
  User02,
  Users03,
} from "@untitledui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import type { Task } from "@/web/components/chat/task/types";
import { TaskRow } from "./task-row";
import { track } from "@/web/lib/posthog-client";
import { useHomeBoard } from "@/web/components/home/tiles/use-home-board";
import { startPresetTask } from "@/web/components/home/tiles/start-preset-task";
import type { PresetTileType } from "@/web/components/home/tiles/registry";
import { ImportFromDecoDialog } from "@/web/components/import-from-deco-dialog.tsx";

type FilterOption = "all" | "manual" | "automation";
type MemberFilter = "all" | "mine";
type SectionMode = "list" | "new";

interface PresetCard {
  id: string;
  title: string;
  /** Path to the Figma-exported PNG used as the colored thumbnail. */
  thumb: string;
  /** Onclick behavior. "new-chat" opens an empty chat; preset starts a
   *  prefilled chat and pins the matching home tile; "import-deco"
   *  opens the import dialog. */
  action:
    | "new-chat"
    | "import-deco"
    | { tileType: PresetTileType; prompt: string };
}

const PRESET_CARDS: PresetCard[] = [
  {
    id: "new-chat",
    title: "New chat",
    thumb: "/home/task-new-chat.png",
    action: "new-chat",
  },
  {
    id: "brand-context",
    title: "Extract brand context",
    thumb: "/home/task-brand.png",
    action: {
      tileType: "studio.brand-context",
      prompt:
        "Extract my brand context — pull the colors, typography, and tone of voice from my site so we can reuse them across new work.",
    },
  },
  {
    id: "landing-page",
    title: "Create landing page",
    thumb: "/home/task-landing.png",
    action: {
      tileType: "studio.landing-page",
      prompt:
        "Draft a landing page for my product using my existing brand. Start with a hero, three feature sections, social proof, and a CTA.",
    },
  },
  {
    id: "error-monitoring",
    title: "Set up error monitoring",
    thumb: "/home/task-monitoring.png",
    action: {
      tileType: "studio.error-monitoring",
      prompt:
        "Help me set up error monitoring for my app. Walk me through connecting the stack and start capturing errors.",
    },
  },
  {
    id: "import-deco",
    title: "Import Deco site",
    thumb: "/home/task-import-deco.png",
    action: "import-deco",
  },
];

const FILTER_LABELS: Record<FilterOption, string> = {
  all: "All tasks",
  manual: "Chats",
  automation: "Automation",
};

const MEMBER_FILTER_LABELS: Record<MemberFilter, string> = {
  all: "All members",
  mine: "Mine only",
};

export function TasksSection({
  title,
  tasks,
  activeTaskId,
  onSelect,
  onArchive,
  onNew,
  showNewButton,
  showAutomationBadge,
  emptyLabel,
  currentUserId,
}: {
  title: string;
  tasks: Task[];
  activeTaskId: string | null;
  onSelect: (task: Task) => void;
  onArchive: (task: Task) => void;
  onNew?: () => void;
  showNewButton?: boolean;
  showAutomationBadge?: boolean;
  emptyLabel?: string;
  currentUserId?: string;
}) {
  const navigate = useNavigate();
  const { org, locator } = useProjectContext();
  const { addTile } = useHomeBoard(org.slug);
  const [filter, setFilter] = useState<FilterOption>("all");
  const [memberFilter, setMemberFilter] = useState<MemberFilter>("mine");
  const [mode, setMode] = useState<SectionMode>(
    tasks.length === 0 ? "new" : "list",
  );
  const [importOpen, setImportOpen] = useState(false);

  const memberFiltered =
    memberFilter === "mine" && currentUserId
      ? tasks.filter((t) => t.created_by === currentUserId)
      : tasks;

  const visibleTasks =
    filter === "automation"
      ? memberFiltered.filter((t) => t.fromAutomation)
      : filter === "manual"
        ? memberFiltered.filter((t) => !t.fromAutomation)
        : memberFiltered;

  const handleCardClick = (card: PresetCard) => {
    track("tasks_panel_preset_clicked", { preset_id: card.id });
    if (card.action === "new-chat") {
      if (onNew) onNew();
      return;
    }
    if (card.action === "import-deco") {
      setImportOpen(true);
      return;
    }
    startPresetTask({
      prompt: card.action.prompt,
      orgId: org.id,
      orgSlug: org.slug,
      locator,
      navigate,
      tileType: card.action.tileType,
      addTile,
    });
  };

  return (
    <div className="flex flex-col h-full min-h-0 mt-1">
      <div className="shrink-0 pl-2 pr-1.5 h-7 flex items-center justify-between text-xs font-medium text-muted-foreground mb-1">
        <span>{title}</span>
        <div className="flex items-center gap-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Filter by member"
                className="flex size-8 items-center justify-center rounded-md hover:bg-muted hover:text-foreground"
              >
                {memberFilter === "mine" ? (
                  <User02 size={16} />
                ) : (
                  <Users03 size={16} />
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={memberFilter}
                onValueChange={(v) => {
                  const next = v as MemberFilter;
                  if (next !== memberFilter) {
                    track("tasks_panel_member_filter_changed", {
                      to_value: next,
                    });
                  }
                  setMemberFilter(next);
                }}
              >
                {(Object.keys(MEMBER_FILTER_LABELS) as MemberFilter[]).map(
                  (opt) => (
                    <DropdownMenuRadioItem key={opt} value={opt}>
                      {MEMBER_FILTER_LABELS[opt]}
                    </DropdownMenuRadioItem>
                  ),
                )}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Filter tasks"
                className={cn(
                  "flex size-8 items-center justify-center rounded-md hover:bg-muted hover:text-foreground",
                  filter !== "all" && "text-purple-500",
                )}
              >
                <FilterLines size={16} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={filter}
                onValueChange={(v) => {
                  const next = v as FilterOption;
                  if (next !== filter) {
                    track("tasks_panel_filter_changed", { to_value: next });
                  }
                  setFilter(next);
                }}
              >
                {(Object.keys(FILTER_LABELS) as FilterOption[]).map((opt) => (
                  <DropdownMenuRadioItem key={opt} value={opt}>
                    {FILTER_LABELS[opt]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          {showNewButton && (
            <button
              type="button"
              onClick={() => {
                track("tasks_panel_new_clicked");
                setMode((m) => (m === "new" ? "list" : "new"));
              }}
              aria-label={`New ${title.toLowerCase()}`}
              aria-pressed={mode === "new"}
              className={cn(
                "flex size-8 items-center justify-center rounded-md hover:bg-muted hover:text-foreground",
                mode === "new" && "bg-muted text-foreground",
              )}
            >
              <Edit05 size={16} />
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-0.5">
        {mode === "new" ? (
          <div className="flex flex-col gap-1 pt-1 px-1">
            {PRESET_CARDS.map((card) => (
              <button
                key={card.id}
                type="button"
                onClick={() => handleCardClick(card)}
                className={cn(
                  "group/row flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors",
                  "hover:bg-accent/50 cursor-pointer",
                )}
              >
                <img
                  src={card.thumb}
                  alt=""
                  aria-hidden
                  className="size-10 shrink-0 rounded-md object-cover"
                />
                <div className="flex-1 min-w-0 text-sm font-medium text-foreground truncate">
                  {card.title}
                </div>
                <ArrowRight
                  size={14}
                  className="shrink-0 text-muted-foreground opacity-0 transition-all group-hover/row:opacity-100 group-hover/row:translate-x-0.5"
                />
              </button>
            ))}
          </div>
        ) : visibleTasks.length === 0 && emptyLabel ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground/70">
            {emptyLabel}
          </div>
        ) : (
          visibleTasks.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              isActive={activeTaskId === t.id}
              onClick={() => {
                if (activeTaskId !== t.id) {
                  track("tasks_panel_task_clicked", {
                    thread_id: t.id,
                    virtual_mcp_id: t.virtual_mcp_id ?? null,
                    from_automation: Boolean(t.fromAutomation),
                  });
                }
                onSelect(t);
              }}
              onArchive={() => {
                track("tasks_panel_task_archived", {
                  thread_id: t.id,
                  virtual_mcp_id: t.virtual_mcp_id ?? null,
                });
                onArchive(t);
              }}
              showAutomationBadge={showAutomationBadge || t.fromAutomation}
            />
          ))
        )}
      </div>
      <ImportFromDecoDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}
