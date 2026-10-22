/**
 * Campaigns (the content browser's view on a Blocks v8 site, in place of v7's
 * Calendar view): every campaign of the saved block `campaigns` (type
 * `calendar`) in the draft, with its window, its status and "Used by". Every
 * dated variant names a campaign (`campaign { name }`), so these are all the
 * dates of the site; nothing is left out.
 *
 * List → detail: change the window, rename (every rule that names it is
 * rewritten in the same change), delete (never blocked, with an Undo; pages
 * that still use a campaign that isn't there are listed under the
 * campaigns). A timeline shows one row per campaign. Each change is one
 * guarded `blocks.apply` into the draft and goes live with the normal Publish.
 */

import { useState } from "react";
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  List,
  Plus,
} from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { ScrollArea } from "@decocms/ui/components/scroll-area.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@decocms/ui/components/toggle-group.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { SiteDraftViewHeader } from "@/components/site-draft-bar/view-header";
import { formatCampaignWindow } from "@/components/sections-editor/format-matcher";
import { planNamedRuleSet } from "@/components/sections-editor/named-rule-edits";
import {
  isoToLocalInput,
  windowFromInputs,
} from "@/components/sections-editor/named-rule-picker";
import { CampaignWindowInputs } from "@/components/sections-editor/named-rule-step";
import { NamedRuleUsedBy } from "@/components/sections-editor/named-rule-used-by";
import type { NamedRuleUseRow } from "@/components/sections-editor/named-rule-uses";
import {
  NamedRuleCreateDialog,
  NamedRuleDetailDelete,
  type NamedRuleDetailProps,
  NamedRuleDetailTitle,
  NamedRuleDraftNotes,
  NamedRuleEntryBadge,
  NamedRuleRenameSection,
  namedRuleDetailProps,
  namedRuleDetailUses,
  namedRuleUsesLabel,
  useNamedRuleRename,
  useNamedRuleView,
} from "@/components/sections-editor/named-rule-view";
import type { CampaignWindow } from "@/components/sections-editor/named-rules";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import {
  addMonths,
  MONTHS,
  startOfMonth,
} from "../variant-calendar/date-utils";
import {
  type CampaignRowModel,
  type CampaignStatus,
  campaignRows,
  removedCampaigns,
  timelineBar,
  timelineLabelPlacement,
  timelineStart,
} from "./campaigns-model";

type ViewMode = "list" | "timeline";

const STATUS_DOT: Record<CampaignStatus, string> = {
  running: "bg-success",
  upcoming: "bg-primary",
  always: "bg-success",
  ended: "bg-muted-foreground/50",
  unreadable: "bg-warning",
};

const STATUS_BAR: Record<CampaignStatus, string> = {
  running: "bg-success/80 text-success-foreground",
  upcoming: "bg-primary/80 text-primary-foreground",
  always: "bg-success/60 text-success-foreground",
  ended: "bg-muted text-muted-foreground",
  unreadable: "bg-warning/60 text-warning-foreground",
};

const TIMELINE_MONTHS = 4;

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
    <Badge variant="secondary" data-status={status}>
      <span className={cn("size-1.5 rounded-full", STATUS_DOT[status])} />
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
  onOpenUse,
  initialView = "list",
  title,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  decofile: Record<string, unknown>;
  meta: LiveMeta | null | undefined;
  /** Open a page or section that uses a campaign. */
  onOpenUse: (row: NamedRuleUseRow) => void;
  /** The Calendar view opens on the timeline; the content browser, the list. */
  initialView?: ViewMode;
  /**
   * The heading: "Campaigns" in the content browser; the Calendar view names
   * itself "Calendar", as its row and breadcrumb do.
   */
  title?: string;
}) {
  const t = useT();
  const view = useNamedRuleView("campaigns", {
    orgSlug,
    virtualMcpId,
    branch,
    decofile,
    meta,
  });
  const [mode, setMode] = useState<ViewMode>(initialView);
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

  const rows = campaignRows(decofile, view.uses, now);
  const removed = removedCampaigns(decofile, view.uses);

  const opened = rows.find((row) => row.name === view.openName) ?? null;
  if (opened) {
    return (
      <CampaignDetail
        key={opened.name}
        {...namedRuleDetailProps(view, opened, { decofile, meta, onOpenUse })}
      />
    );
  }

  return (
    <div className="flex h-full w-full flex-col">
      <SiteDraftViewHeader
        title={title ?? t("sandbox.dateCampaigns.title")}
        actions={
          <>
            <ToggleGroup
              type="single"
              variant="segmented"
              size="sm"
              value={mode}
              onValueChange={(next) => {
                if (next === "list" || next === "timeline") setMode(next);
              }}
            >
              <ToggleGroupItem value="list">
                <List />
                {t("sandbox.dateCampaigns.listMode")}
              </ToggleGroupItem>
              <ToggleGroupItem value="timeline">
                <Calendar />
                {t("sandbox.dateCampaigns.timelineMode")}
              </ToggleGroupItem>
            </ToggleGroup>
            <Button size="sm" onClick={() => view.setCreating(true)}>
              <Plus size={16} />
              {t("sandbox.dateCampaigns.new")}
            </Button>
          </>
        }
      />
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-4">
          <p className="text-sm text-muted-foreground">
            {t("sandbox.dateCampaigns.intro")}
          </p>
          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <Calendar size={24} className="text-muted-foreground/60" />
              <p className="text-sm font-medium">
                {t("sandbox.dateCampaigns.empty.title")}
              </p>
              <p className="max-w-sm text-sm text-muted-foreground">
                {t("sandbox.dateCampaigns.empty.desc")}
              </p>
            </div>
          ) : mode === "list" ? (
            <CampaignList rows={rows} onOpen={view.setOpenName} />
          ) : (
            <CampaignTimeline rows={rows} now={now} onOpen={view.setOpenName} />
          )}
          <NamedRuleDraftNotes
            kind="campaigns"
            missing={view.missing}
            missingNames={view.missingNames}
            removed={removed}
            onOpenUse={onOpenUse}
          />
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

function CampaignList({
  rows,
  onOpen,
}: {
  rows: CampaignRowModel[];
  onOpen: (name: string) => void;
}) {
  const t = useT();
  return (
    <ul
      className="divide-y divide-border rounded-md border border-border"
      data-testid="campaigns-list"
    >
      {rows.map((row) => (
        <li
          key={row.name}
          className="group relative flex items-center gap-4 px-4 py-3 hover:bg-muted/50"
          data-testid="campaign-row"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <button
              type="button"
              onClick={() => onOpen(row.name)}
              className="truncate text-left text-sm font-medium after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
            >
              {row.name}
            </button>
            <span className="truncate text-xs text-muted-foreground">
              {windowText(
                row.window,
                t("sectionsEditor.namedRulePicker.alwaysRunning"),
              )}
              {" · "}
              {namedRuleUsesLabel(t, "campaigns", row.uses)}
            </span>
          </div>
          <div className="hidden w-40 shrink-0 md:flex">
            <NamedRuleEntryBadge kind="campaigns" state={row.entryState} />
          </div>
          <div className="flex w-32 shrink-0">
            <CampaignStatusPill status={row.status} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** One row per campaign over a few months, today marked. */
function CampaignTimeline({
  rows,
  now,
  onOpen,
}: {
  rows: CampaignRowModel[];
  now: Date;
  onOpen: (name: string) => void;
}) {
  const t = useT();
  const [cursor, setCursor] = useState(() =>
    timelineStart(
      rows.map((row) => row.window),
      now,
      TIMELINE_MONTHS,
    ),
  );
  const rangeEnd = addMonths(cursor, TIMELINE_MONTHS);
  const months = Array.from({ length: TIMELINE_MONTHS }, (_, i) =>
    addMonths(cursor, i),
  );
  const today = timelineBar(
    {
      start: now.toISOString(),
      end: new Date(now.getTime() + 1).toISOString(),
    },
    cursor,
    rangeEnd,
  );
  const bars = rows.map((row) => ({
    row,
    bar: timelineBar(row.window, cursor, rangeEnd),
  }));
  const shown = bars.filter((entry) => entry.bar !== null);
  return (
    <div className="flex flex-col gap-2" data-testid="campaigns-timeline">
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCursor(startOfMonth(now))}
        >
          {t("sandbox.dateCampaigns.today")}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={t("sandbox.dateCampaigns.previous")}
          onClick={() => setCursor((c) => addMonths(c, -TIMELINE_MONTHS))}
        >
          <ChevronLeft size={16} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={t("sandbox.dateCampaigns.next")}
          onClick={() => setCursor((c) => addMonths(c, TIMELINE_MONTHS))}
        >
          <ChevronRight size={16} />
        </Button>
      </div>
      <div className="relative min-w-[640px] rounded-md border border-border">
        <div className="flex border-b">
          <div className="w-48 shrink-0 border-r" />
          <div
            className="grid flex-1"
            style={{
              gridTemplateColumns: `repeat(${TIMELINE_MONTHS}, minmax(0, 1fr))`,
            }}
          >
            {months.map((month) => (
              <div
                key={month.getTime()}
                className="border-r px-2 py-1.5 text-xs text-muted-foreground last:border-r-0"
              >
                {MONTHS[month.getMonth()]?.slice(0, 3)} {month.getFullYear()}
              </div>
            ))}
          </div>
        </div>
        {shown.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {t("sandbox.dateCampaigns.nothingInRange")}
          </p>
        ) : (
          shown.map(({ row, bar }) => {
            const label = timelineLabelPlacement(bar!, row.name);
            return (
              <div
                key={row.name}
                className="flex h-9 items-center border-b last:border-b-0"
              >
                <div className="w-48 shrink-0 truncate border-r px-3 text-sm">
                  {row.name}
                </div>
                <div className="relative h-full flex-1">
                  {today && (
                    <div
                      className="pointer-events-none absolute top-0 bottom-0 w-px bg-primary/70"
                      style={{ left: `${today.left}%` }}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => onOpen(row.name)}
                    aria-label={row.name}
                    title={windowText(
                      row.window,
                      t("sectionsEditor.namedRulePicker.alwaysRunning"),
                    )}
                    className={cn(
                      "absolute top-1/2 h-6 -translate-y-1/2 truncate rounded text-left text-2xs font-medium",
                      label === "inside" && "px-2",
                      STATUS_BAR[row.status],
                      bar!.openStart && "rounded-l-none",
                      bar!.openEnd && "rounded-r-none",
                    )}
                    style={{
                      left: `${bar!.left}%`,
                      width: `max(calc(${bar!.width}% - 2px), 6px)`,
                    }}
                    data-label={label}
                  >
                    {label === "inside" ? row.name : null}
                  </button>
                  {label !== "inside" && (
                    // A short campaign: its name beside the bar, readable.
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-hidden="true"
                      onClick={() => onOpen(row.name)}
                      className="absolute top-1/2 -translate-y-1/2 truncate whitespace-nowrap text-left text-2xs font-medium text-foreground hover:underline"
                      style={
                        label === "after"
                          ? {
                              left: `calc(${bar!.left + bar!.width}% + 6px)`,
                              maxWidth: `calc(${100 - bar!.left - bar!.width}% - 6px)`,
                            }
                          : {
                              right: `calc(${100 - bar!.left}% + 6px)`,
                              maxWidth: `calc(${bar!.left}% - 6px)`,
                            }
                      }
                      title={row.name}
                      data-testid="campaign-bar-label"
                    >
                      {row.name}
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function CampaignDetail(props: NamedRuleDetailProps<CampaignRowModel>) {
  const { row, decofile, meta, uses, pending, onBack, onOpenUse, onSave } =
    props;
  const t = useT();
  const [start, setStart] = useState(isoToLocalInput(row.window.start));
  const [end, setEnd] = useState(isoToLocalInput(row.window.end));
  const rename = useNamedRuleRename("campaigns", props);
  const window = windowFromInputs(start, end);
  const windowChanged =
    "window" in window &&
    (start !== isoToLocalInput(row.window.start) ||
      end !== isoToLocalInput(row.window.end));

  const { useRows, wholeRows } = namedRuleDetailUses(
    "campaigns",
    row.name,
    uses,
    decofile,
    meta,
  );

  const saveWindow = () => {
    if (!("window" in window)) return;
    void onSave(
      planNamedRuleSet(decofile, "campaigns", row.name, window.window),
    );
  };

  return (
    <div className="flex h-full w-full flex-col">
      <SiteDraftViewHeader
        back={{
          label: t("sandbox.dateCampaigns.allCampaigns"),
          onClick: onBack,
        }}
        actions={<NamedRuleDetailDelete kind="campaigns" detail={props} />}
      />
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex max-w-2xl flex-col gap-6 p-4">
          <NamedRuleDetailTitle
            kind="campaigns"
            name={row.name}
            status={<CampaignStatusPill status={row.status} />}
            entryState={row.entryState}
          />

          <section className="flex flex-col gap-2">
            <CampaignWindowInputs
              idPrefix="campaign"
              className="max-w-md"
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
            <div>
              <Button
                size="sm"
                disabled={pending || !windowChanged}
                onClick={saveWindow}
              >
                {t("sandbox.dateCampaigns.saveDates")}
              </Button>
            </div>
          </section>

          <NamedRuleRenameSection
            kind="campaigns"
            id="campaign-name"
            rename={rename}
            pending={pending}
            wholeUses={wholeRows.length}
          />

          <NamedRuleUsedBy
            kind="campaigns"
            rows={useRows}
            wholeRows={wholeRows}
            loading={!uses}
            marked={!!uses?.published}
            onOpen={onOpenUse}
          />
        </div>
      </ScrollArea>
    </div>
  );
}
