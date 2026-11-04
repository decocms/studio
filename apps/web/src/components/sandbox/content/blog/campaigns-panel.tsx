/**
 * Campaigns: the board and the list, behind one view toggle.
 *
 * Mirrors the Posts area, which already settled this pair — a board to move
 * work through its states, a list to search and edit one thing at a time. The
 * lane mechanics (drag payload key, drop target, collapse-when-empty) are
 * copied from `posts-workspace.tsx` on purpose, so the two boards behave the
 * same way under the hand.
 *
 * Moving a card is far simpler here than in Posts. A post changing status can
 * cross the planning/live boundary, which renames its block key — hence
 * `use-post-status-move.ts`. A campaign is always planning: one write of the
 * new status. All that survives of that hook is the in-flight set, which keeps
 * a card that is mid-write from accepting a second drop.
 */

import { Fragment, type ReactNode, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Stars02,
  Trash01,
  SearchLg,
  Columns03,
  List,
} from "@untitledui/icons";
import { toast } from "sonner";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import type { BlogState } from "./use-blog-state";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import { useOpenBlogChat } from "@/hooks/use-open-blog-chat";
import { useStudioTools } from "@/lib/studio-tools";
import { useClockTick } from "@/lib/use-clock-tick";
import { campaignProgress, type CampaignProgress } from "./campaign-model";
import { useCampaignActions } from "./use-campaign-actions";
import { SaveStatus } from "./save-status";
import { GoalLine } from "./campaign-goal";
import {
  CAMPAIGN_STATUSES,
  type CampaignEntry,
  type CampaignStatus,
} from "./blog-data";
import {
  CAMPAIGN_PROGRESS_LABEL,
  CAMPAIGN_STATUS_LABEL,
  CAMPAIGN_STATUS_VARIANT,
  CAMPAIGN_TRIGGER_LABEL,
} from "./campaign-labels";

/** Drag payload — the dragged campaign's block key. */
const DRAG_KEY = "application/x-campaign-key";

type CampaignView = "board" | "list";

/** The period as one line, or null when neither end is pinned. */
function periodLabel(campaign: CampaignEntry): string | null {
  const { start, end } = campaign.period;
  if (!start && !end) return null;
  return `${start ?? "—"} / ${end ?? "—"}`;
}

export function CampaignsPanel({
  blog,
  onOpen,
}: {
  /** The organization's blog state: its brand and its campaigns. */
  blog: BlogState;
  /** Open a campaign's page. */
  onOpen: (campaignId: string) => void;
}) {
  const t = useT();
  /** Campaigns are the organization's records, written through its blog state. */
  const { campaigns, remove: deleteCampaign } = blog;
  const { update } = useCampaignActions();
  const now = useClockTick();

  const openChat = useOpenBlogChat();
  const studio = useStudioTools();
  const [suggesting, setSuggesting] = useState(false);
  /** A new draft whose agent suggests briefings, in a chat opened beside the page. */
  const suggest = async () => {
    setSuggesting(true);
    try {
      const { threadId } = await studio.call("BLOG_CAMPAIGN_RUN", {});
      openChat(threadId, { view: "campaigns" });
    } catch (err) {
      toast.error(
        t("sandbox.campaigns.suggestFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setSuggesting(false);
    }
  };
  const [view, setView] = useState<CampaignView>("board");
  const [query, setQuery] = useState("");
  const [dragOverLane, setDragOverLane] = useState<CampaignStatus | null>(null);
  const [laneOverrides, setLaneOverrides] = useState<Record<string, boolean>>(
    {},
  );
  /** Campaigns with a status write in flight — they refuse a second drop. */
  const [movingKeys, setMovingKeys] = useState<ReadonlySet<string>>(new Set());

  const isLaneCollapsed = (lane: string, empty: boolean) =>
    laneOverrides[lane] ?? empty;
  const setLaneCollapsed = (lane: string, collapsed: boolean) =>
    setLaneOverrides((prev) => ({ ...prev, [lane]: collapsed }));

  const moveTo = async (key: string, next: CampaignStatus) => {
    const campaign = campaigns.find((entry) => entry.key === key);
    if (!campaign || campaign.status === next || movingKeys.has(key)) return;
    setMovingKeys((keys) => new Set(keys).add(key));
    try {
      await update.mutateAsync({ id: campaign.id, patch: { status: next } });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("sandbox.campaigns.moveFailed"),
      );
    } finally {
      setMovingKeys((keys) => {
        const rest = new Set(keys);
        rest.delete(key);
        return rest;
      });
    }
  };

  /**
   * Deleting a campaign is final — there is no archived lane to land in, the
   * way a post has. So it asks first, and asks from wherever it was triggered.
   */
  const [pendingDelete, setPendingDelete] = useState<CampaignEntry | null>(
    null,
  );

  const term = query.trim().toLowerCase();
  const listed = term
    ? campaigns.filter((entry) =>
        `${entry.name} ${entry.trigger.note}`.toLowerCase().includes(term),
      )
    : campaigns;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 px-8 pb-3 pt-4">
        <div className="flex items-center gap-0.5 rounded-lg border p-0.5">
          <ToggleButton
            active={view === "board"}
            onClick={() => setView("board")}
            icon={<Columns03 size={14} />}
            label={t("sandbox.campaigns.viewBoard")}
          />
          <ToggleButton
            active={view === "list"}
            onClick={() => setView("list")}
            icon={<List size={14} />}
            label={t("sandbox.campaigns.viewList")}
          />
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={suggesting}
            onClick={() => void suggest()}
          >
            <Stars02 size={14} />
            {t("sandbox.campaigns.suggest")}
          </Button>
          <SaveStatus
            isPending={update.isPending || deleteCampaign.isPending}
            isError={update.isError || deleteCampaign.isError}
          />
        </div>
      </div>

      {view === "board" ? (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-8 pb-6">
          {CAMPAIGN_STATUSES.map((status) => {
            const laneLabel = t(CAMPAIGN_STATUS_LABEL[status]);
            const lane = campaigns.filter((entry) => entry.status === status);
            const collapsed = isLaneCollapsed(status, lane.length === 0);
            return (
              <Fragment key={status}>
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOverLane(status);
                  }}
                  onDragLeave={() =>
                    setDragOverLane((l) => (l === status ? null : l))
                  }
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOverLane(null);
                    void moveTo(e.dataTransfer.getData(DRAG_KEY), status);
                  }}
                  className={cn(
                    "flex shrink-0 flex-col rounded-xl border bg-muted/30 transition-colors",
                    collapsed ? "w-11" : "w-72",
                    dragOverLane === status && "border-primary bg-primary/5",
                  )}
                >
                  {collapsed ? (
                    // Still a drop target, so a card can land on a closed lane.
                    <button
                      type="button"
                      onClick={() => setLaneCollapsed(status, false)}
                      aria-label={t("sandbox.campaigns.expandLane", {
                        lane: laneLabel,
                      })}
                      aria-expanded={false}
                      className="flex min-h-0 flex-1 cursor-pointer flex-col items-center gap-2 py-2.5 text-muted-foreground hover:text-foreground"
                    >
                      <ChevronRight size={14} className="shrink-0" />
                      <span className="text-xs tabular-nums">
                        {lane.length}
                      </span>
                      <span className="[writing-mode:vertical-rl] text-sm font-medium">
                        {laneLabel}
                      </span>
                    </button>
                  ) : (
                    <>
                      <div className="flex items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium">
                        <button
                          type="button"
                          onClick={() => setLaneCollapsed(status, true)}
                          aria-label={t("sandbox.campaigns.collapseLane", {
                            lane: laneLabel,
                          })}
                          aria-expanded
                          className="flex min-w-0 cursor-pointer items-center gap-1.5 text-left hover:text-muted-foreground"
                        >
                          <ChevronDown size={14} className="shrink-0" />
                          <span className="truncate">{laneLabel}</span>
                        </button>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {lane.length}
                        </span>
                      </div>
                      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                        {lane.length === 0 ? (
                          <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                            {t("sandbox.campaigns.laneEmpty")}
                          </p>
                        ) : (
                          lane.map((campaign) => (
                            <CampaignCard
                              key={campaign.key}
                              campaign={campaign}
                              moving={movingKeys.has(campaign.key)}
                              progress={campaignProgress(campaign, now)}
                              onOpen={() => onOpen(campaign.id)}
                              onDelete={() => setPendingDelete(campaign)}
                            />
                          ))
                        )}
                      </div>
                    </>
                  )}
                </div>
              </Fragment>
            );
          })}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 border-t">
          <div className="flex w-full max-w-xl flex-col">
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <SearchLg size={14} className="shrink-0 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("sandbox.campaigns.searchPlaceholder")}
                className="h-8 border-0 shadow-none focus-visible:ring-0"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {listed.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                  {campaigns.length === 0
                    ? t("sandbox.campaigns.empty")
                    : t("sandbox.campaigns.noMatches")}
                </p>
              ) : (
                <ul className="divide-y">
                  {listed.map((campaign) => (
                    <li key={campaign.key} className="group/row relative">
                      <DeleteButton
                        label={t("sandbox.campaigns.remove")}
                        onDelete={() => setPendingDelete(campaign)}
                      />
                      <button
                        type="button"
                        onClick={() => onOpen(campaign.id)}
                        className="w-full cursor-pointer px-4 py-3 text-left transition-colors hover:bg-accent"
                      >
                        <p className="truncate pr-6 text-sm font-medium">
                          {campaign.name || t("sandbox.campaigns.untitled")}
                        </p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <Badge
                            variant={CAMPAIGN_STATUS_VARIANT[campaign.status]}
                          >
                            {t(CAMPAIGN_STATUS_LABEL[campaign.status])}
                          </Badge>
                          <span className="truncate text-xs text-muted-foreground">
                            {t(CAMPAIGN_TRIGGER_LABEL[campaign.trigger.type])}
                          </span>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("sandbox.campaigns.deleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("sandbox.campaigns.deleteDescription", {
                name: pendingDelete?.name || t("sandbox.campaigns.untitled"),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("sandbox.campaigns.deleteCancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (pendingDelete) deleteCampaign.mutate(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              {t("sandbox.campaigns.deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CampaignCard({
  campaign,
  moving,
  progress,
  onOpen,
  onDelete,
}: {
  campaign: CampaignEntry;
  /** A status write is in flight — freeze it so a second drop cannot race. */
  moving: boolean;
  progress: CampaignProgress;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const period = periodLabel(campaign);

  return (
    <div
      className={cn(
        "group/card relative rounded-lg bg-card shadow-edge transition-shadow hover:shadow-lift",
        moving && "opacity-80",
      )}
    >
      <DeleteButton
        label={t("sandbox.campaigns.remove")}
        disabled={moving}
        onDelete={onDelete}
      />
      <button
        type="button"
        draggable={!moving}
        onDragStart={(e) => e.dataTransfer.setData(DRAG_KEY, campaign.key)}
        onClick={onOpen}
        className={cn(
          "block w-full p-3 text-left",
          moving ? "cursor-wait" : "cursor-grab active:cursor-grabbing",
        )}
      >
        <p className="line-clamp-2 pr-6 text-sm font-medium">
          {campaign.name || t("sandbox.campaigns.untitled")}
        </p>
        {progress !== "approved" && (
          <p className="mt-1 text-xs text-muted-foreground">
            {t(CAMPAIGN_PROGRESS_LABEL[progress])}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary" className="max-w-full truncate">
            {t(CAMPAIGN_TRIGGER_LABEL[campaign.trigger.type])}
          </Badge>
          {period && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {period}
            </span>
          )}
        </div>
        <GoalLine goals={campaign.goals} className="mt-2" />
      </button>
    </div>
  );
}

/** Reveals on hover, like the post board's. Stops the click reaching the card. */
function DeleteButton({
  label,
  onDelete,
  disabled,
}: {
  label: string;
  onDelete: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="ghost-destructive"
      size="icon-xs"
      type="button"
      disabled={disabled}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onDelete();
      }}
      // Swallow the click while disabled, or it opens the card underneath.
      className="absolute right-2 top-2 z-10 opacity-0 transition-opacity disabled:pointer-events-auto focus-visible:opacity-100 group-hover/card:opacity-100 group-hover/row:opacity-100"
    >
      <Trash01 className="size-3.25" />
    </Button>
  );
}

function ToggleButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
