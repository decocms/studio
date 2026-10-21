/**
 * Campaigns (the content browser's view on a Blocks v8 site, in place of the
 * Calendar): every campaign of the saved block `campaigns` in the draft, with
 * its window, its status and "Used by". Every date rule names a campaign, so
 * this is the whole calendar of the site; nothing is left out.
 *
 * List → detail: change the window, rename (every rule that names it is
 * rewritten in the same change), delete (never blocked, with an Undo; pages
 * that still use a campaign that no longer exists are listed under the
 * campaigns). A timeline shows one row per campaign. Each change is one
 * guarded `blocks.apply` into the draft and goes live with the normal Publish.
 */

import { useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  Calendar,
  ChevronLeft,
  ChevronRight,
  List,
  Plus,
} from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { ScrollArea } from "@decocms/ui/components/scroll-area.tsx";
import { ViewModeToggle } from "@decocms/ui/components/view-mode-toggle.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { formatCampaignWindow } from "@/components/sections-editor/format-matcher";
import {
  planNamedRuleCreate,
  planNamedRuleSet,
} from "@/components/sections-editor/named-rule-edits";
import { NamedRuleDeleteButton } from "@/components/sections-editor/named-rule-delete";
import {
  isoToLocalInput,
  newNameProblem,
  windowFromInputs,
} from "@/components/sections-editor/named-rule-picker";
import { NamedRuleCreateForm } from "@/components/sections-editor/named-rule-step";
import {
  MissingNamedRuleUses,
  NamedRuleUsedBy,
} from "@/components/sections-editor/named-rule-used-by";
import {
  missingNamedRuleRows,
  type NamedRuleUseRow,
  type NamedRuleUses,
  namedRuleUseRows,
} from "@/components/sections-editor/named-rule-uses";
import {
  type CampaignWindow,
  namedRuleSupport,
  readNamedRuleBlock,
} from "@/components/sections-editor/named-rules";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { planNamedRuleRename } from "@/components/sections-editor/rule-references";
import { SITE_EDITOR_SAVE_TOAST } from "@/components/sections-editor/site-editor-toast";
import {
  type NamedRuleApplyOutcome,
  type NamedRuleChange,
  useApplyNamedRule,
} from "@/components/sections-editor/use-apply-named-rule";
import { useNamedRuleUses } from "@/components/sections-editor/use-named-rule-uses";
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
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  decofile: Record<string, unknown>;
  meta: LiveMeta | null | undefined;
  /** Open a page or section that uses a campaign. */
  onOpenUse: (row: NamedRuleUseRow) => void;
}) {
  const t = useT();
  const uses = useNamedRuleUses({
    orgSlug,
    virtualMcpId,
    branch,
    decofile,
    meta,
  });
  const { apply, reread, planStored, isPending } = useApplyNamedRule({
    orgSlug,
    virtualMcpId,
    branch,
  });
  const [view, setView] = useState<ViewMode>("list");
  const [openName, setOpenName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // One moment for the whole view, so every status agrees.
  const [now] = useState(() => new Date());

  const support = namedRuleSupport(meta, "campaigns");
  if (support === "missing") {
    return (
      <Guide
        title={t("sandbox.dateCampaigns.missing.title")}
        description={t("sandbox.dateCampaigns.missing.desc")}
      />
    );
  }
  if (support === "replaced") {
    return (
      <Guide
        title={t("sandbox.dateCampaigns.replaced.title")}
        description={t("sandbox.dateCampaigns.replaced.desc")}
      />
    );
  }
  if (readNamedRuleBlock(decofile, "campaigns").kind === "conflict") {
    return (
      <Guide
        title={t("sandbox.dateCampaigns.conflict.title")}
        description={t("sandbox.dateCampaigns.conflict.desc")}
      />
    );
  }

  const rows = campaignRows(decofile, uses, now);
  const removed = removedCampaigns(decofile, uses);
  const missing = uses
    ? missingNamedRuleRows(uses, "campaigns", decofile, meta)
    : [];

  const save = async (
    change: NamedRuleChange | null,
    title = t("sandbox.dateCampaigns.saved"),
  ) => {
    if (!change) return false;
    const outcome = await apply(change);
    if (outcome.ok) {
      toast.success(title, {
        id: SITE_EDITOR_SAVE_TOAST,
        description: t("sandbox.dateCampaigns.savedHint"),
      });
    }
    return outcome.ok;
  };

  const opened = rows.find((row) => row.name === openName) ?? null;
  if (opened) {
    return (
      <CampaignDetail
        key={opened.name}
        row={opened}
        decofile={decofile}
        meta={meta}
        uses={uses}
        pending={isPending}
        onBack={() => setOpenName(null)}
        onOpenUse={onOpenUse}
        onSave={save}
        onRenamed={setOpenName}
        apply={apply}
        reread={reread}
        planStored={planStored}
        onDeleted={() => setOpenName(null)}
        onUndo={(change) => void save(change)}
      />
    );
  }

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <h2 className="text-sm font-medium">
          {t("sandbox.dateCampaigns.title")}
        </h2>
        <div className="flex items-center gap-2">
          <ViewModeToggle<ViewMode>
            value={view}
            onValueChange={setView}
            options={[
              {
                value: "list",
                icon: <List />,
                label: t("sandbox.dateCampaigns.listMode"),
              },
              {
                value: "timeline",
                icon: <Calendar />,
                label: t("sandbox.dateCampaigns.timelineMode"),
              },
            ]}
          />
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus size={16} />
            {t("sandbox.dateCampaigns.new")}
          </Button>
        </div>
      </div>
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
          ) : view === "list" ? (
            <CampaignList rows={rows} onOpen={setOpenName} />
          ) : (
            <CampaignTimeline rows={rows} now={now} onOpen={setOpenName} />
          )}
          <MissingNamedRuleUses
            kind="campaigns"
            rows={missing}
            onOpen={onOpenUse}
          />
          {removed.length > 0 && (
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-medium">
                {t("sandbox.dateCampaigns.removedTitle")}
              </h3>
              <p className="text-xs text-muted-foreground">
                {t("sandbox.dateCampaigns.removedHint")}
              </p>
              <ul className="text-sm text-muted-foreground">
                {removed.map((name) => (
                  <li key={name} className="line-through">
                    {name}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </ScrollArea>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="p-0 sm:max-w-md">
          <DialogTitle className="sr-only">
            {t("sandbox.dateCampaigns.new")}
          </DialogTitle>
          <NamedRuleCreateForm
            kind="campaigns"
            initialName=""
            existingNames={rows.map((row) => row.name)}
            pending={isPending}
            submitLabel={t("sandbox.dateCampaigns.create")}
            onBack={() => setCreating(false)}
            onSubmit={(pick) => {
              if (pick.kind !== "campaigns" || !pick.create) return;
              const plan = planNamedRuleCreate(
                decofile,
                "campaigns",
                pick.name,
                pick.create.window,
              );
              if (!("change" in plan)) return;
              void save(
                plan.change,
                t("sandbox.dateCampaigns.created", { name: pick.name }),
              ).then((ok) => {
                if (ok) {
                  setCreating(false);
                  setOpenName(pick.name);
                }
              });
            }}
          />
        </DialogContent>
      </Dialog>
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
              {windowText(row.window, t("sandbox.dateCampaigns.noDates"))}
              {" · "}
              {row.uses > 0
                ? t("sandbox.dateCampaigns.usedBy", { count: String(row.uses) })
                : t("sandbox.dateCampaigns.notUsed")}
            </span>
          </div>
          <div className="hidden w-40 shrink-0 md:flex">
            {row.entryState === "new" && (
              <Badge variant="muted">
                {t("sandbox.dateCampaigns.state.new")}
              </Badge>
            )}
            {row.entryState === "changed" && (
              <Badge variant="muted">
                {t("sandbox.dateCampaigns.state.changed")}
              </Badge>
            )}
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
  const [cursor, setCursor] = useState(() => startOfMonth(now));
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
                className="border-r px-2 py-1.5 text-xs uppercase tracking-wide text-muted-foreground last:border-r-0"
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
          shown.map(({ row, bar }) => (
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
                  title={windowText(
                    row.window,
                    t("sandbox.dateCampaigns.noDates"),
                  )}
                  className={cn(
                    "absolute top-1/2 h-6 -translate-y-1/2 truncate rounded px-2 text-left text-[11px] font-medium",
                    STATUS_BAR[row.status],
                    bar!.openStart && "rounded-l-none",
                    bar!.openEnd && "rounded-r-none",
                  )}
                  style={{
                    left: `${bar!.left}%`,
                    width: `max(calc(${bar!.width}% - 2px), 6px)`,
                  }}
                >
                  {row.name}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function CampaignDetail({
  row,
  decofile,
  meta,
  uses,
  pending,
  onBack,
  onOpenUse,
  onSave,
  onRenamed,
  apply,
  reread,
  planStored,
  onDeleted,
  onUndo,
}: {
  row: CampaignRowModel;
  decofile: Record<string, unknown>;
  meta: LiveMeta | null | undefined;
  uses: NamedRuleUses | null;
  pending: boolean;
  onBack: () => void;
  onOpenUse: (row: NamedRuleUseRow) => void;
  onSave: (change: NamedRuleChange | null, title?: string) => Promise<boolean>;
  onRenamed: (name: string) => void;
  apply: (change: NamedRuleChange) => Promise<NamedRuleApplyOutcome>;
  reread: () => Promise<Record<string, unknown> | null>;
  /** Plans a rename from the draft as stored now (use-apply-named-rule.ts). */
  planStored: (
    plan: (decofile: Record<string, unknown>) => NamedRuleChange | null,
  ) => Promise<NamedRuleChange | null>;
  onDeleted: () => void;
  onUndo: (change: NamedRuleChange) => void;
}) {
  const t = useT();
  const [start, setStart] = useState(isoToLocalInput(row.window.start));
  const [end, setEnd] = useState(isoToLocalInput(row.window.end));
  const [name, setName] = useState(row.name);
  const window = windowFromInputs(start, end);
  const windowChanged =
    "window" in window &&
    (start !== isoToLocalInput(row.window.start) ||
      end !== isoToLocalInput(row.window.end));

  const block = readNamedRuleBlock(decofile, "campaigns");
  const others =
    block.kind === "conflict"
      ? []
      : Object.keys(block.block).filter(
          (key) => key !== "__resolveType" && key !== row.name,
        );
  const nameProblem =
    name.trim() === row.name ? null : newNameProblem(name, others);
  const nameMessage =
    nameProblem === "empty"
      ? t("sandbox.dateCampaigns.nameEmpty")
      : nameProblem === "taken"
        ? t("sandbox.dateCampaigns.nameTaken")
        : nameProblem === "reserved"
          ? t("sandbox.dateCampaigns.nameReserved")
          : null;

  const useRows = uses
    ? namedRuleUseRows(uses, "campaigns", row.name, decofile, meta)
    : [];
  const wholeRows = uses
    ? namedRuleUseRows(uses, "campaigns", null, decofile, meta)
    : [];

  const saveWindow = () => {
    if (!("window" in window)) return;
    void onSave(
      planNamedRuleSet(decofile, "campaigns", row.name, window.window),
    );
  };

  /** Planned from the draft as stored now, so every use gets the new name. */
  const rename = async () => {
    const next = name.trim();
    if (nameProblem || next === row.name) return;
    const plan = await planStored((stored) =>
      planNamedRuleRename(stored, "campaigns", row.name, next, meta),
    );
    if (
      plan &&
      (await onSave(plan, t("sandbox.dateCampaigns.renamed", { name: next })))
    ) {
      onRenamed(next);
    }
  };

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft size={16} />
          {t("sandbox.dateCampaigns.allCampaigns")}
        </Button>
        <NamedRuleDeleteButton
          kind="campaigns"
          name={row.name}
          meta={meta}
          pending={pending}
          apply={apply}
          reread={reread}
          onDeleted={onDeleted}
          onUndo={onUndo}
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex max-w-2xl flex-col gap-6 p-4">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold">{row.name}</h2>
            <CampaignStatusPill status={row.status} />
            {row.entryState === "new" && (
              <Badge variant="muted">
                {t("sandbox.dateCampaigns.state.new")}
              </Badge>
            )}
          </div>

          <section className="flex flex-col gap-2">
            <div className="grid max-w-md grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="campaign-start">
                  {t("sandbox.dateCampaigns.startLabel")}
                </Label>
                <Input
                  id="campaign-start"
                  type="datetime-local"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="campaign-end">
                  {t("sandbox.dateCampaigns.endLabel")}
                </Label>
                <Input
                  id="campaign-end"
                  type="datetime-local"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                />
              </div>
            </div>
            {"problem" in window && (
              <p className="text-xs text-destructive">
                {t("sandbox.dateCampaigns.endBeforeStart")}
              </p>
            )}
            {row.status === "unreadable" && (
              <p className="text-xs text-muted-foreground">
                {t("sandbox.dateCampaigns.unreadableHint")}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {t("sandbox.dateCampaigns.windowHint")}
            </p>
            {row.publishedWindow && (
              <p className="text-xs text-muted-foreground">
                {t("sandbox.dateCampaigns.publishedWindow", {
                  window: windowText(
                    row.publishedWindow,
                    t("sandbox.dateCampaigns.noDates"),
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

          <section className="flex flex-col gap-2">
            <Label htmlFor="campaign-name">
              {t("sandbox.dateCampaigns.nameLabel")}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="campaign-name"
                className="max-w-xs"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={pending || !!nameProblem || name.trim() === row.name}
                onClick={() => void rename()}
              >
                {t("sandbox.dateCampaigns.rename")}
              </Button>
            </div>
            {nameMessage && (
              <p className="text-xs text-destructive">{nameMessage}</p>
            )}
            <p className="text-xs text-muted-foreground">
              {t("sandbox.dateCampaigns.renameHint")}
            </p>
            {wholeRows.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("sandbox.dateCampaigns.renameWholeHint")}
              </p>
            )}
          </section>

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
