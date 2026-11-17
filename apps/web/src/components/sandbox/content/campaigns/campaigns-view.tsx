/**
 * Campaigns (the content browser's view on a Blocks v8 site, in place of v7's
 * Calendar view): every campaign of the saved block `campaigns` (type
 * `calendar`) in the draft, with its window and its status. Every dated
 * variant names a campaign (`campaign { name }`), so these are all the dates
 * of the site; nothing is left out.
 *
 * A row opens in place: change the window, or delete (it just deletes, with an
 * Undo; `deco check` reports a rule that names a campaign that isn't there).
 * The view doesn't say where a campaign is used and doesn't rename one. A
 * strip shows each campaign's window. Each change is one guarded
 * `blocks.apply` into the draft and goes live with the normal Publish.
 */

import { type ReactNode, useState } from "react";
import { Calendar, ChevronRight, Plus } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { ScrollArea } from "@decocms/ui/components/scroll-area.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@decocms/ui/components/toggle-group.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { canonicalBlockJson } from "@decocms/shared/decofile";
import { useT } from "@/i18n/use-t.ts";
import { LOCALE_TAG } from "@/i18n/locale.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import {
  SITE_DRAFT_VIEW_INSET,
  SiteDraftViewHeader,
} from "@/components/site-draft-bar/view-header";
import { formatCampaignWindow } from "@/components/sections-editor/format-matcher";
import { planNamedRuleSet } from "@/components/sections-editor/named-rule-edits";
import {
  isoToLocalInput,
  windowFromInputs,
} from "@/components/sections-editor/named-rule-picker";
import { CampaignWindowInputs } from "@/components/sections-editor/named-rule-step";
import {
  NamedRuleCreateDialog,
  NamedRuleDetailDelete,
  type NamedRuleDetailProps,
  NamedRuleDraftNotes,
  NamedRuleEntryBadge,
  namedRuleDetailProps,
  useNamedRuleView,
} from "@/components/sections-editor/named-rule-view";
import {
  copyScope,
  useCopyEpochs,
} from "@/components/sections-editor/held-copy";
import {
  type CampaignWindow,
  namedRuleKindInfo,
} from "@/components/sections-editor/named-rules";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { addMonths, startOfMonth } from "../variant-calendar/date-utils";
import {
  type CampaignRowModel,
  type CampaignStatus,
  campaignRows,
  removedCampaigns,
  shortCampaignWindow,
  timelineBar,
  timelineStart,
} from "./campaigns-model";

type CampaignTab = "current" | "ended";

const STATUS_DOT: Record<CampaignStatus, string> = {
  running: "bg-success",
  upcoming: "bg-brand-blue",
  always: "bg-success",
  ended: "bg-muted-foreground/50",
  unreadable: "bg-warning",
};

const STATUS_BAR: Record<CampaignStatus, string> = {
  running: "bg-success",
  upcoming: "bg-brand-blue",
  always: "bg-success/60",
  ended: "bg-muted-foreground/40",
  unreadable: "bg-warning/60",
};

const STATUS_BADGE: Record<
  CampaignStatus,
  "success" | "info" | "muted" | "warning"
> = {
  running: "success",
  upcoming: "info",
  always: "success",
  ended: "muted",
  unreadable: "warning",
};

/** Months on each row's strip. */
const STRIP_MONTHS = 3;

/** Name, strip, status, Edit: the list's columns, header and rows alike. */
const ROW_GRID =
  "grid grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)_7rem_auto] items-center gap-4";

const CAMPAIGNS_BLOCK = namedRuleKindInfo("campaigns").blockKey;

/** Whether two copies of a block differ. */
const differs = (a: unknown, b: unknown) =>
  canonicalBlockJson(a ?? null) !== canonicalBlockJson(b ?? null);

function useStatusLabel() {
  const t = useT();
  return (status: CampaignStatus) => {
    switch (status) {
      case "running":
        return t("sandbox.dateCampaigns.status.running");
      case "upcoming":
        return t("sandbox.dateCampaigns.status.upcoming");
      case "ended":
        return t("sandbox.dateCampaigns.status.ended");
      case "always":
        return t("sandbox.dateCampaigns.status.always");
      case "unreadable":
        return t("sandbox.dateCampaigns.status.unreadable");
    }
  };
}

function CampaignStatusPill({ status }: { status: CampaignStatus }) {
  const label = useStatusLabel();
  return (
    <Badge variant={STATUS_BADGE[status]} data-status={status}>
      {label(status)}
    </Badge>
  );
}

function windowText(window: CampaignWindow, noDates: string): string {
  return formatCampaignWindow(window) ?? noDates;
}

function Guide({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <Calendar size={24} className="text-muted-foreground/60" />
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

export function CampaignsView({
  orgSlug,
  virtualMcpId,
  branch,
  decofile,
  meta,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  decofile: Record<string, unknown>;
  meta: LiveMeta | null | undefined;
}) {
  const t = useT();
  const [preferences] = usePreferences();
  const view = useNamedRuleView("campaigns", {
    orgSlug,
    virtualMcpId,
    branch,
    decofile,
    meta,
  });
  // Unpicked, the list opens where the open campaign is.
  const [pickedTab, setTab] = useState<CampaignTab | null>(null);
  // A reconcile of the campaigns (hosted v8) replaced the copy the detail
  // shows: it is seeded again from the draft's copy.
  const copyEpoch = useCopyEpochs(copyScope({ orgSlug, virtualMcpId, branch }))(
    CAMPAIGNS_BLOCK,
  );
  // One moment for the whole view, so every status agrees.
  const [now] = useState(() => new Date());

  if (view.blocked) {
    const guide = {
      missing: {
        title: t("sandbox.dateCampaigns.missing.title"),
        description: t("sandbox.dateCampaigns.missing.desc"),
      },
      replaced: {
        title: t("sandbox.dateCampaigns.replaced.title"),
        description: t("sandbox.dateCampaigns.replaced.desc"),
      },
      conflict: {
        title: t("sandbox.dateCampaigns.conflict.title"),
        description: t("sandbox.dateCampaigns.conflict.desc"),
      },
    }[view.blocked];
    return <Guide {...guide} />;
  }

  const rows = campaignRows(decofile, view.published, now);
  const removed = removedCampaigns(decofile, view.published);
  const ended = rows.filter((row) => row.status === "ended");
  const current = rows.filter((row) => row.status !== "ended");
  const openEnded = ended.some((row) => row.name === view.openName);
  const tab = pickedTab ?? (openEnded ? "ended" : "current");
  const shown = tab === "ended" ? ended : current;
  // Ended campaigns look back from this month; the rest look ahead.
  const stripStart =
    tab === "ended"
      ? addMonths(startOfMonth(now), -(STRIP_MONTHS - 1))
      : timelineStart(
          shown.map((row) => row.window),
          now,
          STRIP_MONTHS,
        );
  const strip = {
    start: stripStart,
    end: addMonths(stripStart, STRIP_MONTHS),
    today: timelineBar(
      {
        start: now.toISOString(),
        end: new Date(now.getTime() + 1).toISOString(),
      },
      stripStart,
      addMonths(stripStart, STRIP_MONTHS),
    )?.left,
  };
  const monthName = new Intl.DateTimeFormat(LOCALE_TAG[preferences.language], {
    month: "short",
  });
  const months = Array.from({ length: STRIP_MONTHS }, (_, i) =>
    monthName.format(addMonths(stripStart, i)).replace(".", ""),
  );
  const empty = rows.length === 0;

  return (
    <div className="flex h-full w-full flex-col">
      <SiteDraftViewHeader
        intro={t("sandbox.dateCampaigns.intro")}
        actions={
          empty ? undefined : (
            <Button size="sm" onClick={() => view.setCreating(true)}>
              <Plus size={16} />
              {t("sandbox.dateCampaigns.new")}
            </Button>
          )
        }
      />
      <ScrollArea className="min-h-0 flex-1">
        <div className={cn("flex flex-col gap-4", SITE_DRAFT_VIEW_INSET)}>
          {empty ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-16 text-center">
              <span className="flex size-10 items-center justify-center rounded-lg bg-muted">
                <Calendar size={20} className="text-muted-foreground" />
              </span>
              <p className="text-sm font-medium">
                {t("sandbox.dateCampaigns.empty.title")}
              </p>
              <p className="max-w-sm text-sm text-muted-foreground">
                {t("sandbox.dateCampaigns.empty.desc")}
              </p>
              <Button
                size="sm"
                className="mt-2"
                onClick={() => view.setCreating(true)}
              >
                <Plus size={16} />
                {t("sandbox.dateCampaigns.new")}
              </Button>
            </div>
          ) : (
            <>
              <ToggleGroup
                type="single"
                variant="segmented"
                size="sm"
                value={tab}
                aria-label={t("sandbox.dateCampaigns.tabsLabel")}
                className="self-start"
                onValueChange={(next) => {
                  if (next === "current" || next === "ended") setTab(next);
                }}
              >
                <ToggleGroupItem value="current">
                  <Calendar />
                  {t("sandbox.dateCampaigns.tabCurrent")}
                </ToggleGroupItem>
                <ToggleGroupItem value="ended">
                  {t("sandbox.dateCampaigns.tabEnded")}
                </ToggleGroupItem>
              </ToggleGroup>
              <div
                className="overflow-hidden rounded-xl border border-border"
                data-testid="campaigns-list"
              >
                <div
                  className={cn(
                    ROW_GRID,
                    "border-b border-border px-4 py-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground",
                  )}
                >
                  <span className="pl-6">
                    {t("sandbox.dateCampaigns.colCampaign")}
                  </span>
                  <span>
                    {t("sandbox.dateCampaigns.colWindow", {
                      months: months.join(" / "),
                    })}
                  </span>
                  <span>{t("sandbox.dateCampaigns.colStatus")}</span>
                  <span className="w-16" />
                </div>
                {shown.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                    {tab === "ended"
                      ? t("sandbox.dateCampaigns.noneEnded")
                      : t("sandbox.dateCampaigns.noneCurrent")}
                  </p>
                ) : (
                  <ul className="divide-y divide-border">
                    {shown.map((row) => {
                      const expanded = row.name === view.openName;
                      return (
                        <CampaignRow
                          key={row.name}
                          row={row}
                          dates={shortCampaignWindow(
                            row.window,
                            LOCALE_TAG[preferences.language],
                            now,
                          )}
                          strip={strip}
                          expanded={expanded}
                          onToggle={() =>
                            view.setOpenName(expanded ? null : row.name)
                          }
                        >
                          {expanded && (
                            <CampaignEditor
                              key={`${row.name}:${copyEpoch}`}
                              {...namedRuleDetailProps(view, row, {
                                decofile,
                                meta,
                              })}
                            />
                          )}
                        </CampaignRow>
                      );
                    })}
                  </ul>
                )}
              </div>
            </>
          )}
          <NamedRuleDraftNotes kind="campaigns" removed={removed} />
        </div>
      </ScrollArea>
      <NamedRuleCreateDialog
        kind="campaigns"
        open={view.creating}
        onOpenChange={view.setCreating}
        existingNames={rows.map((row) => row.name)}
        pending={view.isPending}
        onCreate={view.create}
      />
    </div>
  );
}

interface Strip {
  start: Date;
  end: Date;
  /** Where today falls, in percent; `undefined` when it is off the strip. */
  today: number | undefined;
}

function CampaignRow({
  row,
  dates,
  strip,
  expanded,
  onToggle,
  children,
}: {
  row: CampaignRowModel;
  /** The window, short; `null` falls back to the long form. */
  dates: string | null;
  strip: Strip;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const t = useT();
  const window = windowText(
    row.window,
    t("sectionsEditor.namedRulePicker.alwaysRunning"),
  );
  return (
    <li data-testid="campaign-row">
      <div className={cn(ROW_GRID, "px-4 py-3")}>
        <div className="flex min-w-0 items-center gap-2">
          <ChevronRight
            size={14}
            aria-hidden
            className={cn(
              "shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
          />
          <span
            aria-hidden
            className={cn(
              "size-2 shrink-0 rounded-full",
              STATUS_DOT[row.status],
            )}
          />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                onClick={onToggle}
                aria-expanded={expanded}
                className="truncate text-left text-sm font-medium focus-visible:underline focus-visible:outline-none"
              >
                {row.name}
              </button>
              <NamedRuleEntryBadge kind="campaigns" state={row.entryState} />
            </div>
            <p
              className="truncate text-xs text-muted-foreground"
              title={window}
            >
              {dates ?? window}
            </p>
          </div>
        </div>
        <CampaignStrip row={row} strip={strip} title={window} />
        <div>
          <CampaignStatusPill status={row.status} />
        </div>
        <Button
          variant="outline"
          size="sm"
          className="w-16"
          aria-expanded={expanded}
          aria-label={t("sandbox.dateCampaigns.editNamed", { name: row.name })}
          onClick={onToggle}
        >
          {t("sandbox.dateCampaigns.edit")}
        </Button>
      </div>
      {children}
    </li>
  );
}

/** A campaign's window on the row's months, with today as a red line. */
function CampaignStrip({
  row,
  strip,
  title,
}: {
  row: CampaignRowModel;
  strip: Strip;
  title: string;
}) {
  const bar = timelineBar(row.window, strip.start, strip.end);
  return (
    <div
      className="relative h-5 overflow-hidden rounded-md bg-muted"
      title={title}
      data-testid="campaign-strip"
    >
      {Array.from({ length: STRIP_MONTHS - 1 }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className="absolute inset-y-0 w-px bg-border"
          style={{ left: `${((i + 1) / STRIP_MONTHS) * 100}%` }}
        />
      ))}
      {bar && (
        <span
          aria-hidden
          className={cn(
            "absolute top-1/2 h-2.5 -translate-y-1/2 rounded-full",
            STATUS_BAR[row.status],
            bar.openStart && "rounded-l-none",
            bar.openEnd && "rounded-r-none",
          )}
          style={{
            left: `${bar.left}%`,
            width: `max(${bar.width}%, 6px)`,
          }}
        />
      )}
      {strip.today !== undefined && (
        <span
          aria-hidden
          className="absolute inset-y-0 w-0.5 bg-destructive"
          style={{ left: `${strip.today}%` }}
        />
      )}
    </div>
  );
}

function CampaignEditor(props: NamedRuleDetailProps<CampaignRowModel>) {
  const { row, decofile, pending, holdsCopy, onSave } = props;
  const t = useT();
  const stored = {
    block: decofile[CAMPAIGNS_BLOCK],
    start: isoToLocalInput(row.window.start),
    end: isoToLocalInput(row.window.end),
  };
  // The copy the form shows (hosted v8): the campaigns as it was seeded
  // from them, or as its own last save left them. Its saves are built on it.
  const [shown, setShown] = useState(stored);
  const [start, setStart] = useState(stored.start);
  const [end, setEnd] = useState(stored.end);
  // Untouched, the form follows the draft (a poll brought someone else's
  // dates); a typed date stays the user's, and its save asks about theirs.
  if (
    holdsCopy &&
    start === shown.start &&
    end === shown.end &&
    differs(stored.block, shown.block)
  ) {
    setShown(stored);
    setStart(stored.start);
    setEnd(stored.end);
  }
  const window = windowFromInputs(start, end);
  const seeded = holdsCopy ? shown : stored;
  const windowChanged =
    "window" in window && (start !== seeded.start || end !== seeded.end);

  const saveWindow = () => {
    if (!("window" in window)) return;
    const change = planNamedRuleSet(
      decofile,
      "campaigns",
      row.name,
      window.window,
    );
    if (!change || !holdsCopy) {
      void onSave(change);
      return;
    }
    void onSave({
      ...change,
      basis: { [CAMPAIGNS_BLOCK]: shown.block },
    }).then((ok) => {
      // Saved as typed: the next save is built on it. A reconcile that
      // ended elsewhere seeds the form again (the view's key).
      if (ok) setShown({ block: change.writes[CAMPAIGNS_BLOCK], start, end });
    });
  };

  return (
    <div
      className="flex flex-col gap-3 border-t border-border bg-muted/30 px-4 py-4 pl-12"
      data-testid="campaign-editor"
    >
      <CampaignWindowInputs
        idPrefix="campaign"
        className="max-w-xl"
        start={start}
        end={end}
        onStartChange={setStart}
        onEndChange={setEnd}
      />
      {"problem" in window && (
        <p className="text-xs text-destructive">
          {t("sectionsEditor.namedRules.endBeforeStart")}
        </p>
      )}
      {row.status === "unreadable" && (
        <p className="text-xs text-muted-foreground">
          {t("sandbox.dateCampaigns.unreadableHint")}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {t("sectionsEditor.namedRules.windowHint")}
      </p>
      {row.publishedWindow && (
        <p className="text-xs text-muted-foreground">
          {t("sandbox.dateCampaigns.publishedWindow", {
            window: windowText(
              row.publishedWindow,
              t("sectionsEditor.namedRulePicker.alwaysRunning"),
            ),
          })}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={pending || !windowChanged}
          onClick={saveWindow}
        >
          {t("sandbox.dateCampaigns.saveDates")}
        </Button>
        <div className="ml-auto">
          <NamedRuleDetailDelete kind="campaigns" detail={props} />
        </div>
      </div>
    </div>
  );
}
