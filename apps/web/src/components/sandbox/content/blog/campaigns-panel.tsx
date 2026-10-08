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
  Plus,
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
import type { TranslationKey } from "@/i18n/use-t.ts";
import { useSaveBlock } from "@/components/sections-editor/use-save-block";
import { useDeleteBlock } from "@/components/sections-editor/use-delete-block";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { SaveStatus } from "./save-status";
import { CampaignEditor } from "./campaign-editor";
import {
  buildCampaignBlock,
  CAMPAIGN_STATUSES,
  type CampaignEntry,
  type CampaignStatus,
  type CampaignTrigger,
  emptyCampaign,
  newCampaignKey,
  scanCampaigns,
} from "./blog-data";

/** Drag payload — the dragged campaign's block key. */
const DRAG_KEY = "application/x-campaign-key";

/** One label map and one colour map, so board, list and editor cannot drift. */
export const CAMPAIGN_STATUS_LABEL: Record<CampaignStatus, TranslationKey> = {
  draft: "sandbox.campaigns.statusDraft",
  active: "sandbox.campaigns.statusActive",
  paused: "sandbox.campaigns.statusPaused",
  finished: "sandbox.campaigns.statusFinished",
};

const STATUS_VARIANT: Record<
  CampaignStatus,
  "secondary" | "warning" | "success" | "outline"
> = {
  draft: "outline",
  active: "success",
  paused: "warning",
  finished: "secondary",
};

export const CAMPAIGN_TRIGGER_LABEL: Record<CampaignTrigger, TranslationKey> = {
  launch: "sandbox.campaigns.triggerLaunch",
  seasonal: "sandbox.campaigns.triggerSeasonal",
  trend: "sandbox.campaigns.triggerTrend",
  seo_gap: "sandbox.campaigns.triggerSeoGap",
  inventory: "sandbox.campaigns.triggerInventory",
  partnership: "sandbox.campaigns.triggerPartnership",
  reputation: "sandbox.campaigns.triggerReputation",
};

type CampaignView = "board" | "list";

/** The period as one line, or null when neither end is pinned. */
function periodLabel(campaign: CampaignEntry): string | null {
  const { start, end } = campaign.period;
  if (!start && !end) return null;
  return `${start ?? "—"} / ${end ?? "—"}`;
}

export function CampaignsPanel({
  orgSlug,
  virtualMcpId,
  branch,
  decofile,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  decofile: Record<string, unknown>;
}) {
  const t = useT();
  const save = useSaveBlock({ orgSlug, virtualMcpId, branch });
  const deleteBlock = useDeleteBlock({ orgSlug, virtualMcpId, branch });

  const [view, setView] = useState<CampaignView>("board");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [dragOverLane, setDragOverLane] = useState<CampaignStatus | null>(null);
  const [laneOverrides, setLaneOverrides] = useState<Record<string, boolean>>(
    {},
  );
  /** Campaigns with a status write in flight — they refuse a second drop. */
  const [movingKeys, setMovingKeys] = useState<ReadonlySet<string>>(new Set());

  const campaigns = scanCampaigns(decofile);
  const isLaneCollapsed = (lane: string, empty: boolean) =>
    laneOverrides[lane] ?? empty;
  const setLaneCollapsed = (lane: string, collapsed: boolean) =>
    setLaneOverrides((prev) => ({ ...prev, [lane]: collapsed }));

  const addCampaign = () => {
    const blockKey = newCampaignKey();
    save.mutate({
      blockKey,
      data: buildCampaignBlock(blockKey, emptyCampaign(new Date())),
    });
    setOpenKey(blockKey);
  };

  const moveTo = async (key: string, next: CampaignStatus) => {
    const campaign = campaigns.find((entry) => entry.key === key);
    if (!campaign || campaign.status === next || movingKeys.has(key)) return;
    setMovingKeys((keys) => new Set(keys).add(key));
    try {
      await save.mutateAsync({
        blockKey: key,
        data: buildCampaignBlock(key, {
          ...campaign,
          status: next,
          updatedAt: new Date().toISOString(),
        }),
      });
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

  const removeCampaign = (key: string) => {
    deleteBlock.mutate({ blockKey: key });
    setOpenKey((open) => (open === key ? null : open));
  };

  const term = query.trim().toLowerCase();
  const listed = term
    ? campaigns.filter((entry) =>
        `${entry.name} ${entry.trigger.note}`.toLowerCase().includes(term),
      )
    : campaigns;
  /** On the board only an explicitly opened card edits — never a default one. */
  const boardKey = openKey && decofile[openKey] !== undefined ? openKey : null;
  /** The list never shows an empty right pane while there is anything to show. */
  const detailKey =
    openKey && campaigns.some((entry) => entry.key === openKey)
      ? openKey
      : (listed[0]?.key ?? null);

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
          <Button type="button" size="sm" onClick={addCampaign}>
            <Plus size={14} />
            {t("sandbox.campaigns.add")}
          </Button>
          <SaveStatus
            isPending={save.isPending || deleteBlock.isPending}
            isError={save.isError || deleteBlock.isError}
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
                              onOpen={() => setOpenKey(campaign.key)}
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
          <div className="flex w-80 shrink-0 flex-col border-r">
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
                    <li key={campaign.key}>
                      <button
                        type="button"
                        onClick={() => setOpenKey(campaign.key)}
                        aria-current={campaign.key === detailKey}
                        className={cn(
                          "w-full cursor-pointer px-4 py-3 text-left transition-colors hover:bg-muted/50",
                          campaign.key === detailKey && "bg-muted",
                        )}
                      >
                        <p className="truncate text-sm font-medium">
                          {campaign.name || t("sandbox.campaigns.untitled")}
                        </p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <Badge variant={STATUS_VARIANT[campaign.status]}>
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
          <div className="min-w-0 flex-1 overflow-y-auto">
            {detailKey ? (
              <CampaignEditor
                key={detailKey}
                blockKey={detailKey}
                block={decofile[detailKey] as Record<string, unknown>}
                onSave={(data) => save.mutate({ blockKey: detailKey, data })}
                onRemove={() => removeCampaign(detailKey)}
              />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                {t("sandbox.campaigns.selectPrompt")}
              </div>
            )}
          </div>
        </div>
      )}

      {/* The board edits in a docked sheet, the way the Posts board does. */}
      <Dialog
        open={view === "board" && Boolean(boardKey)}
        onOpenChange={(next) => {
          if (!next) setOpenKey(null);
        }}
      >
        <DialogContent
          closeButtonClassName="hidden"
          className="left-auto right-4 top-4 bottom-4 flex h-auto translate-x-0 translate-y-0 flex-col gap-0 overflow-y-auto p-0 sm:max-w-2xl"
        >
          <DialogTitle className="sr-only">
            {t("sandbox.blogContext.tabCampaigns")}
          </DialogTitle>
          {boardKey && (
            <CampaignEditor
              key={boardKey}
              blockKey={boardKey}
              block={decofile[boardKey] as Record<string, unknown>}
              onSave={(data) => save.mutate({ blockKey: boardKey, data })}
              onRemove={() => removeCampaign(boardKey)}
              onClose={() => setOpenKey(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CampaignCard({
  campaign,
  moving,
  onOpen,
}: {
  campaign: CampaignEntry;
  /** A status write is in flight — freeze it so a second drop cannot race. */
  moving: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  const period = periodLabel(campaign);

  return (
    <button
      type="button"
      draggable={!moving}
      onDragStart={(e) => e.dataTransfer.setData(DRAG_KEY, campaign.key)}
      onClick={onOpen}
      className={cn(
        "block w-full rounded-lg border bg-card p-3 text-left shadow-sm transition-colors hover:border-primary/40",
        moving
          ? "cursor-wait opacity-80"
          : "cursor-grab active:cursor-grabbing",
      )}
    >
      <p className="line-clamp-2 text-sm font-medium">
        {campaign.name || t("sandbox.campaigns.untitled")}
      </p>
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
    </button>
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
