/**
 * What needs a person, worst first, in the home's "For you" shape: one quiet
 * line each that reads on its own (a tinted icon for how bad, then what moved
 * and by how much: "Orders 59% below expected"; in grey the counts, since when
 * and what it may have come from), where it happened on the right with its
 * platform's icon, as the chart cards show it, and the whole line is the next
 * step. No buttons, no pills.
 */

import { useState } from "react";
import { Link, type LinkProps } from "@tanstack/react-router";
import { AlertCircle, AlertTriangle, CheckCircle } from "@untitledui/icons";
import { taskKey } from "@decocms/shared/task-key";
import { ruleLabel } from "@/components/order-monitor/order-monitor-day";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import { formatTimeAgo } from "@/lib/format-time";
import { formatCount } from "@/layouts/main-panel-tabs/monitor-v8";
import { IntegrationIcon } from "@/components/integration-icon";
import type { ImpactMetric, Signal, SignalSeverity, SourceId } from "./board";
import { connectLink, formatPct, projectLink } from "./parts";
import { sourceName } from "./sources-panel";

export function metricLabel(metric: ImpactMetric, t: TFunction): string {
  switch (metric) {
    case "orders":
      return t("monitor.metric.orders");
    case "errors":
      return t("monitor.metric.errors");
    case "latency":
      return t("monitor.metric.latency");
    default: {
      const unhandled: never = metric;
      return unhandled;
    }
  }
}

const SEVERITY_ICON: Record<
  SignalSeverity,
  { icon: typeof AlertCircle; tone: string }
> = {
  alert: { icon: AlertCircle, tone: "text-destructive" },
  warning: { icon: AlertTriangle, tone: "text-warning" },
  ready: { icon: CheckCircle, tone: "text-success" },
};

function severityName(severity: SignalSeverity, t: TFunction): string {
  switch (severity) {
    case "alert":
      return t("orderMonitor.status.alert");
    case "warning":
      return t("orderMonitor.status.warning");
    case "ready":
      return t("monitor.severity.ready");
    default: {
      const unhandled: never = severity;
      return unhandled;
    }
  }
}

interface Row {
  title: string;
  /** How far off and since when, then what it may have come from. */
  reason: string;
  /** Where it happened: the store or the project. */
  place: string;
  /** The source it came from, for the icon beside the place. */
  source: SourceId;
  /** The line itself is the next step. */
  go: { link: LinkProps } | { onClick: () => void };
}

function rowOf(
  signal: Signal,
  t: TFunction,
  orgSlug: string,
  scopeId: string | null,
  onOpenStore: (connectionId: string) => void,
): Row {
  const since = t("orderMonitor.since", {
    ago: formatTimeAgo(new Date(signal.since)),
  });
  const taskLink = (keySeq: number | undefined) => {
    const key = keySeq === undefined ? null : taskKey(orgSlug, keySeq);
    return key
      ? {
          link: {
            to: "/$org/t/$taskKey",
            params: { org: orgSlug, taskKey: key },
          } as LinkProps,
        }
      : null;
  };
  switch (signal.kind) {
    case "orders": {
      const metric = ruleLabel(signal.rule, t);
      const expected = Math.round(signal.expected);
      return {
        title:
          signal.rule === "orders_drop"
            ? t("monitor.signal.below", {
                metric,
                pct: `${Math.round((1 - signal.observed / Math.max(1, signal.expected)) * 100)}%`,
              })
            : t("monitor.signal.above", {
                metric,
                times: String(
                  Math.round(
                    (signal.observed / Math.max(1, signal.expected)) * 10,
                  ) / 10,
                ),
              }),
        reason: [
          t("monitor.signal.vsExpected", {
            observed: signal.observed,
            expected,
          }),
          since,
          signal.after &&
            t("monitor.signal.afterDeploy", {
              minutes: signal.after.minutes,
              message: signal.after.message,
            }),
        ]
          .filter(Boolean)
          .join(" · "),
        place: storeName(signal.storeTitle),
        source: "orders",
        go: { onClick: () => onOpenStore(signal.storeId) },
      };
    }
    case "deploy":
      return {
        title: t("monitor.signal.deploy", {
          metric: metricLabel(signal.metric, t),
          pct: formatPct(signal.change),
        }),
        reason: `“${signal.message}” · ${since}`,
        place: signal.projectTitle,
        source: "deploys",
        go: taskLink(signal.task?.keySeq) ?? {
          link: projectLink(orgSlug, signal.projectId, "releases"),
        },
      };
    case "experiment":
      return {
        title: t("monitor.signal.experiment", { title: signal.title }),
        reason: t("monitor.signal.experimentDetail", {
          pct: `${Math.round(signal.probability * 100)}%`,
          count: formatCount(signal.participants),
        }),
        place: "",
        source: "site",
        go: { link: projectLink(orgSlug, signal.projectId, "experiments") },
      };
    case "source":
      return {
        title: t("monitor.signal.source"),
        reason: t("monitor.signal.sourceDetail", { minutes: signal.minutes }),
        place: storeName(signal.title),
        source: "orders",
        go: { link: connectLink(orgSlug, scopeId) },
      };
    default: {
      const unhandled: never = signal;
      return unhandled;
    }
  }
}

/**
 * A store as people name it: its title without the platform, which the icon
 * beside it already shows ("Outlet · VTEX" is "Outlet").
 */
const storeName = (title: string) => title.replace(/\s·\s(VTEX|Shopify)$/i, "");

/** Signals shown before "show more": the worst ones, the rest a click away. */
const VISIBLE = 3;

const LINE =
  "group flex h-10 w-full items-center gap-3 rounded-lg px-2 text-left transition-colors hover:bg-accent/50";

export function SignalsPanel({
  signals,
  orgSlug,
  scopeId,
  onOpenStore,
  iconOf,
}: {
  signals: readonly Signal[];
  orgSlug: string;
  scopeId: string | null;
  onOpenStore: (connectionId: string) => void;
  /** Each source's icon, as the chart cards show it. */
  iconOf: (source: SourceId) => string | null;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const shown = open ? signals : signals.slice(0, VISIBLE);
  const hidden = signals.length - shown.length;
  return (
    <section className="surface flex flex-col gap-2 p-3">
      <h2 className="flex items-center gap-2 px-2 pt-1 pb-1 text-sm font-medium text-foreground">
        {t("monitor.signals.title")}
        <span className="text-muted-foreground tabular-nums">
          {signals.length}
        </span>
      </h2>
      <div className="flex flex-col">
        {shown.map((signal) => {
          const row = rowOf(signal, t, orgSlug, scopeId, onOpenStore);
          const { icon: Icon, tone } = SEVERITY_ICON[signal.severity];
          const content = (
            <>
              <span
                role="img"
                aria-label={severityName(signal.severity, t)}
                className={cn("flex size-4 shrink-0 items-center", tone)}
              >
                <Icon size={16} />
              </span>
              <span className="min-w-0 shrink-0 truncate text-sm text-foreground">
                {row.title}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                {row.reason}
              </span>
              {row.place && (
                <span className="hidden max-w-56 shrink-0 items-center gap-1.5 text-xs text-muted-foreground md:flex">
                  <IntegrationIcon
                    icon={iconOf(row.source)}
                    name={sourceName(row.source, t)}
                    size="xs"
                    fit="cover"
                  />
                  <span className="truncate">{row.place}</span>
                </span>
              )}
            </>
          );
          return "link" in row.go ? (
            <Link key={signal.id} {...row.go.link} className={LINE}>
              {content}
            </Link>
          ) : (
            <button
              key={signal.id}
              type="button"
              onClick={row.go.onClick}
              className={LINE}
            >
              {content}
            </button>
          );
        })}
        {signals.length > VISIBLE && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className={cn(LINE, "text-sm text-muted-foreground")}
          >
            <span className="size-4 shrink-0" />
            {open
              ? t("monitor.signals.less")
              : t("monitor.signals.more", { count: hidden })}
          </button>
        )}
      </div>
    </section>
  );
}
