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
import { useHomeTiles } from "@/web/components/home/tiles/use-home-tiles";
import { startPresetTask } from "@/web/components/home/tiles/start-preset-task";
import type { TileId } from "@/web/components/home/tiles/types";
import { ImportFromDecoDialog } from "@/web/components/import-from-deco-dialog.tsx";

type FilterOption = "all" | "manual" | "automation";
type MemberFilter = "all" | "mine";
type SectionMode = "list" | "new";

interface PresetCard {
  id: string;
  title: string;
  description: string;
  /** Renders the colored badge on the left of the card. */
  badge: React.ReactNode;
  /** Onclick behavior. "new-chat" opens an empty chat; preset starts a
   *  prefilled chat and activates the matching home tile; "import-deco"
   *  opens the import dialog. */
  action: "new-chat" | "import-deco" | { tileId?: TileId; prompt: string };
}

function Badge({
  className,
  children,
}: {
  className: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "relative flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/40 shadow-sm",
        className,
      )}
      aria-hidden
    >
      {children}
    </span>
  );
}

function NewChatBadge() {
  return (
    <Badge className="bg-[#E8E5FF]">
      <span className="absolute inset-1.5 rounded-md bg-white shadow-sm" />
      <span className="absolute left-2.5 right-3 top-3 h-[3px] rounded-full bg-[#C9C2FF]" />
      <span className="absolute left-2.5 right-5 top-[18px] h-[3px] rounded-full bg-[#C9C2FF]" />
      <span className="absolute left-2.5 right-4 top-[24px] h-[3px] rounded-full bg-[#C9C2FF]" />
    </Badge>
  );
}

function BrandBadge() {
  return (
    <Badge className="bg-[#E2F66B]">
      <span className="absolute left-2 top-3.5 size-1.5 rounded-full bg-[#FF7676]" />
      <span className="absolute left-[14px] top-3.5 size-1.5 rounded-full bg-[#7D7D7D]" />
      <span className="absolute left-[20px] top-3.5 size-1.5 rounded-full bg-[#FFFFFF] border border-[#C4D75E]" />
      <span className="absolute right-2 bottom-2 text-[11px] font-semibold leading-none text-[#1F2937]">
        Aa
      </span>
    </Badge>
  );
}

function LandingBadge() {
  return (
    <Badge className="bg-[#CDEEFA]">
      <span className="absolute left-1.5 top-1.5 bottom-1.5 right-1.5 rounded-md bg-white" />
      <span className="absolute left-3 right-3 top-3 h-1 rounded-full bg-[#9FD2E4]" />
      <span className="absolute left-3 right-5 top-[18px] h-1 rounded-full bg-[#D2E8F0]" />
      <span className="absolute left-3 right-6 top-[24px] h-1 rounded-full bg-[#D2E8F0]" />
    </Badge>
  );
}

function MonitoringBadge() {
  return (
    <Badge className="bg-[#FAD2A2]">
      <svg viewBox="0 0 28 16" className="h-3.5 w-7 text-[#C2473F]" aria-hidden>
        <polyline
          points="0,12 5,8 10,11 14,4 18,9 23,6 28,10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="absolute right-1 top-1 flex size-3 items-center justify-center rounded-full bg-white text-[8px] font-bold leading-none text-[#C2473F]">
        !
      </span>
    </Badge>
  );
}

function DecoBadge() {
  return (
    <Badge className="bg-[#D6F26B]">
      <img
        src="/logos/deco%20logo.svg"
        alt=""
        className="size-6 object-contain"
      />
    </Badge>
  );
}

const PRESET_CARDS: PresetCard[] = [
  {
    id: "new-chat",
    title: "New chat",
    description: "Start a fresh conversation.",
    badge: <NewChatBadge />,
    action: "new-chat",
  },
  {
    id: "brand-context",
    title: "Extract brand context",
    description: "Pull colors, fonts, and tone from your site.",
    badge: <BrandBadge />,
    action: {
      tileId: "brand-context",
      prompt:
        "Extract my brand context — pull the colors, typography, and tone of voice from my site so we can reuse them across new work.",
    },
  },
  {
    id: "landing-page",
    title: "Create landing page",
    description: "Generate a page from your brand and a prompt.",
    badge: <LandingBadge />,
    action: {
      tileId: "landing-page",
      prompt:
        "Draft a landing page for my product using my existing brand. Start with a hero, three feature sections, social proof, and a CTA.",
    },
  },
  {
    id: "error-monitoring",
    title: "Set up error monitoring",
    description: "Connect your stack and start capturing errors.",
    badge: <MonitoringBadge />,
    action: {
      tileId: "error-monitoring",
      prompt:
        "Help me set up error monitoring for my app. Walk me through connecting the stack and start capturing errors.",
    },
  },
  {
    id: "import-deco",
    title: "Import Deco site",
    description: "Bring a deco.cx site into Studio.",
    badge: <DecoBadge />,
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
  const { activate } = useHomeTiles(org.slug);
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
      activate,
      tileId: card.action.tileId,
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
          <div className="flex flex-col gap-2 pt-1 px-1">
            {PRESET_CARDS.map((card) => (
              <button
                key={card.id}
                type="button"
                onClick={() => handleCardClick(card)}
                className={cn(
                  "group/row flex w-full items-center gap-3.5 rounded-2xl border border-border/60 bg-background px-3 py-3 text-left transition-all",
                  "hover:border-border hover:bg-accent/40 hover:shadow-sm cursor-pointer",
                )}
              >
                {card.badge}
                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <div className="text-[14px] font-medium text-foreground leading-tight">
                    {card.title}
                  </div>
                  <div className="text-[12px] text-muted-foreground leading-snug truncate">
                    {card.description}
                  </div>
                </div>
                <ArrowRight
                  size={16}
                  className="shrink-0 text-muted-foreground opacity-0 transition-all group-hover/row:opacity-100 group-hover/row:translate-x-0.5 group-hover/row:text-foreground"
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
