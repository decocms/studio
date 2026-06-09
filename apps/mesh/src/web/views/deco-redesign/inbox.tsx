// Inbox — the Findings page. One place for every finding Deco flagged across
// capabilities (System Health + content), so you can triage them one by one
// instead of hunting through the home. These are FINDINGS, not tasks: each one
// carries its own next step — review a drafted fix, review content changes,
// acknowledge something Deco handled on its own, or dismiss a watch. The card
// reflects that. Lives at /$org/inbox inside the org shell (sidebar + toolbar).
import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { cn } from "@deco/ui/lib/utils.ts";
import { Button } from "@deco/ui/components/button.tsx";
import {
  ArrowRight,
  Bell01,
  Check,
  GitBranch01,
  LayoutAlt01,
  Zap,
} from "@untitledui/icons";
import {
  effectiveState,
  INCIDENTS,
  type AutonomyMode,
  type IncidentState,
  type Severity,
} from "./mock-data";
import { CMS_PROPOSALS } from "./mock-cms";
import { setIncidentState, useOverrides } from "./mock-store";

const SEV_DOT: Record<Severity, string> = {
  critical: "bg-destructive",
  warning: "bg-warning",
  info: "bg-muted-foreground",
};

const STATE_META: Record<IncidentState, { label: string; tone: string }> = {
  needs_review: { label: "Needs review", tone: "text-foreground" },
  in_progress: { label: "Shipping", tone: "text-muted-foreground" },
  resolved: { label: "Done", tone: "text-success" },
  watching: { label: "Watching", tone: "text-muted-foreground" },
  acknowledged: { label: "Acknowledged", tone: "text-muted-foreground" },
  dismissed: { label: "Dismissed", tone: "text-muted-foreground" },
};

const STATE_ORDER: Record<IncidentState, number> = {
  needs_review: 0,
  in_progress: 1,
  watching: 2,
  resolved: 3,
  acknowledged: 4,
  dismissed: 5,
};
const SEV_ORDER: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

type FindingKind = "health" | "content";

interface InboxItem {
  id: string;
  title: string;
  severity: Severity;
  state: IncidentState;
  autonomy: AutonomyMode;
  kind: FindingKind;
  hasFix: boolean;
  event: string; // the trigger that started it
  detectedAt: string;
  meta: string; // service (health) or scope (content)
  blurb: string; // one-line context — what Deco found
}

/** What this finding wants from you — the part that makes findings ≠ tasks.
 *  Driven by state + autonomy + whether Deco drafted a fix. */
type ChipTone = "fix" | "auto" | "watch" | "muted";

interface FindingAction {
  chip: { label: string; tone: ChipTone; icon: typeof Check };
  primaryLabel: string;
  /** Lightweight inline acknowledge — only for pure-FYI watches. */
  canAcknowledge: boolean;
}

const CHIP_TONE: Record<ChipTone, string> = {
  fix: "bg-foreground/5 text-foreground",
  auto: "bg-success/15 text-success",
  watch: "bg-warning/15 text-warning",
  muted: "bg-muted text-muted-foreground",
};

function findingAction(item: InboxItem): FindingAction {
  switch (item.state) {
    case "needs_review":
      return item.hasFix
        ? {
            chip: { label: "Fix ready", tone: "fix", icon: GitBranch01 },
            primaryLabel: "Review fix",
            canAcknowledge: false,
          }
        : {
            chip: {
              label: item.kind === "content" ? "Changes ready" : "Ready",
              tone: "fix",
              icon: LayoutAlt01,
            },
            primaryLabel: item.kind === "content" ? "Review changes" : "Review",
            canAcknowledge: false,
          };
    case "in_progress":
      return {
        chip: { label: "Shipping", tone: "muted", icon: Zap },
        primaryLabel: "View progress",
        canAcknowledge: false,
      };
    case "resolved":
      // A change shipped — either Deco auto-shipped it (act & report) or you
      // approved it. Both are "done with a change live", labelled by which.
      return {
        chip: {
          label: item.autonomy === "auto" ? "Handled by Deco" : "Shipped",
          tone: "auto",
          icon: Check,
        },
        primaryLabel: "View change",
        canAcknowledge: false,
      };
    case "watching":
      return {
        chip: { label: "Watching", tone: "watch", icon: Bell01 },
        primaryLabel: "Take a look",
        canAcknowledge: true,
      };
    case "acknowledged":
      // You cleared a watch — seen, no change needed. NOT "dismissed" (that
      // would tell Deco the finding wasn't real and tune its memory).
      return {
        chip: { label: "Acknowledged", tone: "muted", icon: Check },
        primaryLabel: "View",
        canAcknowledge: false,
      };
    case "dismissed":
      return {
        chip: { label: "Dismissed", tone: "muted", icon: Check },
        primaryLabel: "View",
        canAcknowledge: false,
      };
    default: {
      const _exhaustive: never = item.state;
      return _exhaustive;
    }
  }
}

type Filter = "review" | "active" | "done" | "all";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "review", label: "Needs review" },
  { key: "active", label: "Active" },
  { key: "done", label: "Done" },
  { key: "all", label: "All" },
];

function inFilter(state: IncidentState, filter: Filter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "review":
      return state === "needs_review";
    case "active":
      return state === "watching" || state === "in_progress";
    case "done":
      return (
        state === "resolved" ||
        state === "acknowledged" ||
        state === "dismissed"
      );
    default: {
      const _exhaustive: never = filter;
      return _exhaustive;
    }
  }
}

export function InboxView() {
  const navigate = useNavigate();
  const { org } = useParams({ strict: false }) as { org?: string };
  const overrides = useOverrides();
  const [filter, setFilter] = useState<Filter>("review");

  const items: InboxItem[] = [
    ...INCIDENTS.map(
      (i): InboxItem => ({
        id: i.id,
        title: i.title,
        severity: i.severity,
        state: effectiveState(i, overrides),
        autonomy: i.autonomy,
        kind: "health",
        hasFix: Boolean(i.fix),
        event: i.trigger.event,
        detectedAt: i.detectedAt,
        meta: i.service,
        blurb: i.blurb,
      }),
    ),
    ...CMS_PROPOSALS.map(
      (p): InboxItem => ({
        id: p.id,
        title: p.title,
        severity: "info" as Severity,
        state: effectiveState(p, overrides),
        autonomy: p.autonomy,
        kind: "content",
        hasFix: false,
        event: p.trigger.event,
        detectedAt: p.detectedAt,
        meta: p.scope,
        blurb: p.blurb,
      }),
    ),
  ];

  const count = (f: Filter) =>
    items.filter((it) => inFilter(it.state, f)).length;

  const visible = items
    .filter((it) => inFilter(it.state, filter))
    .sort(
      (a, b) =>
        STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
        SEV_ORDER[a.severity] - SEV_ORDER[b.severity],
    );

  const open = (id: string) => {
    if (org) navigate({ to: "/$org/$taskId", params: { org, taskId: id } });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[900px] flex-col gap-6 px-10 py-10">
        <h1 className="text-xl font-medium text-foreground">Inbox</h1>

        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn(
                "rounded-full px-3 py-1.5 text-sm transition-colors",
                filter === f.key
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-accent/50",
              )}
            >
              {f.label}
              <span className="ml-1.5 text-xs opacity-70">{count(f.key)}</span>
            </button>
          ))}
        </div>

        {visible.length === 0 ? (
          <div className="rounded-xl border border-border bg-card px-4 py-12 text-center text-sm text-muted-foreground">
            Nothing here.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {visible.map((it) => (
              <FindingCard
                key={it.id}
                item={it}
                onOpen={() => open(it.id)}
                onAcknowledge={() => setIncidentState(it.id, "acknowledged")}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FindingCard({
  item,
  onOpen,
  onAcknowledge,
}: {
  item: InboxItem;
  onOpen: () => void;
  onAcknowledge: () => void;
}) {
  const action = findingAction(item);
  const status = STATE_META[item.state];
  const ChipIcon = action.chip.icon;
  const dimmed = item.state === "dismissed";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "group flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-ring/40",
        dimmed && "opacity-60",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-1.5 size-2 shrink-0 rounded-full",
            SEV_DOT[item.severity],
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {item.title}
            </span>
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs",
                CHIP_TONE[action.chip.tone],
              )}
            >
              <ChipIcon size={11} />
              {action.chip.label}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
            {item.blurb}
          </p>
        </div>
        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
          {item.detectedAt}
        </span>
      </div>

      <div className="ml-5 flex items-center gap-2 border-t border-border pt-3">
        <span className="truncate font-mono text-xs text-muted-foreground/70">
          {item.event}
        </span>
        <span className="text-muted-foreground/40">·</span>
        <span className="truncate text-xs text-muted-foreground">
          {item.meta}
        </span>
        <span className={cn("ml-auto shrink-0 text-xs", status.tone)}>
          {status.label}
        </span>
        {action.canAcknowledge && (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 text-muted-foreground"
            onClick={(e) => {
              e.stopPropagation();
              onAcknowledge();
            }}
          >
            Acknowledge
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          {action.primaryLabel}
          <ArrowRight size={14} />
        </Button>
      </div>
    </div>
  );
}
