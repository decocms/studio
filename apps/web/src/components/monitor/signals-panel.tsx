/** What needs a person, worst first: one line per alert, marked by how bad, that opens where to act. */

import { useState } from "react";
import { Link, type LinkProps } from "@tanstack/react-router";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  ChevronRight,
} from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { taskKey } from "@decocms/shared/task-key";
import { ruleLabel } from "@/components/order-monitor/order-monitor-day";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import { formatTimeAgo } from "@/lib/format-time";
import { formatCount } from "@/layouts/main-panel-tabs/monitor-v8";
import type { ImpactMetric, Signal, SignalSeverity } from "./board";
import { connectLink, formatPct, projectLink } from "./parts";

function metricLabel(metric: ImpactMetric, t: TFunction): string {
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

const SEVERITY: Record<
  SignalSeverity,
  { icon: typeof AlertCircle; tone: string; mark: string }
> = {
  alert: {
    icon: AlertCircle,
    tone: "text-destructive",
    mark: "bg-destructive/10",
  },
  warning: {
    icon: AlertTriangle,
    tone: "text-warning",
    mark: "bg-warning/10",
  },
  ready: {
    icon: CheckCircle,
    tone: "text-success",
    mark: "bg-success/10",
  },
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
  /** Since when, and what it may have come from. */
  reason: string;
  /** Where it happened: the store or the project. */
  place: string;
  /** The next step. */
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
        go: { link: projectLink(orgSlug, signal.projectId, "experiments") },
      };
    case "source":
      return {
        title: t("monitor.signal.source"),
        reason: t("monitor.signal.sourceDetail", { minutes: signal.minutes }),
        place: storeName(signal.title),
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
const VISIBLE = 5;

const ROW =
  "focus-ring group flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-accent/30";

export function SignalsPanel({
  signals,
  orgSlug,
  scopeId,
  onOpenStore,
}: {
  signals: readonly Signal[];
  orgSlug: string;
  scopeId: string | null;
  onOpenStore: (connectionId: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const shown = open ? signals : signals.slice(0, VISIBLE);
  const hidden = signals.length - shown.length;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-foreground">
        {t("monitor.signals.title")}
      </h2>
      <ul className="surface divide-y divide-border/70 overflow-hidden">
        {shown.map((signal) => {
          const row = rowOf(signal, t, orgSlug, scopeId, onOpenStore);
          const { icon: Icon, tone, mark } = SEVERITY[signal.severity];
          const content = (
            <>
              <span
                role="img"
                aria-label={severityName(signal.severity, t)}
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-full",
                  mark,
                  tone,
                )}
              >
                <Icon size={18} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-medium text-foreground">
                  {row.title}
                </span>
                <span className="text-meta truncate">
                  {[row.place, row.reason].filter(Boolean).join(" · ")}
                </span>
              </span>
              <ChevronRight
                size={16}
                className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
              />
            </>
          );
          const go = row.go;
          return (
            <li key={signal.id}>
              {"link" in go ? (
                <Link {...go.link} className={ROW}>
                  {content}
                </Link>
              ) : (
                <button type="button" onClick={go.onClick} className={ROW}>
                  {content}
                </button>
              )}
            </li>
          );
        })}
        {(hidden > 0 || open) && (
          <li>
            <button
              type="button"
              onClick={() => setOpen(!open)}
              className="focus-ring w-full px-5 py-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground"
            >
              {open
                ? t("monitor.signals.less")
                : t("monitor.signals.more", { count: hidden })}
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}

/** The same place when every rule is quiet: what is watched, so an empty Overview still says the stores are covered. */
export function AllClear() {
  const t = useT();
  return (
    <div className="surface flex items-center gap-4 px-5 py-4">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-success/10 text-success">
        <CheckCircle size={18} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">
          {t("monitor.signals.allClear")}
        </span>
        <span className="text-meta">{t("monitor.signals.watching")}</span>
      </span>
    </div>
  );
}
