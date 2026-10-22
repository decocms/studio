/**
 * Small pieces every Monitor section shares: the status mark (OK is a quiet
 * dot, so a wall of green never shouts), a signed change in the tone of what
 * "better" means for it, section chrome, and where a project's screens are.
 */

import type { ReactNode } from "react";
import type { LinkProps } from "@tanstack/react-router";
import { ArrowDown, ArrowUp } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  DESTINATION_ROUTE,
  PROJECT_ROUTE,
} from "@/hooks/use-destination-route";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import { changeTone } from "@/layouts/main-panel-tabs/monitor-v8";
import type { DeployVerdict, MonitorStatus } from "./board";

export function MonitorStatusMark({ status }: { status: MonitorStatus }) {
  const t = useT();
  switch (status) {
    case "ok":
      return (
        <span className="flex items-center gap-1.5 text-meta">
          <span className="size-1.5 rounded-full bg-success" />
          {t("monitor.statusOk")}
        </span>
      );
    case "low-volume":
      return (
        <Badge variant="muted">{t("orderMonitor.status.lowVolume")}</Badge>
      );
    case "warning":
      return (
        <Badge variant="warning">{t("orderMonitor.status.warning")}</Badge>
      );
    case "alert":
      return (
        <Badge variant="destructive">{t("orderMonitor.status.alert")}</Badge>
      );
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

/** The dot alone, for rows and toggles. */
export function StatusDot({ status }: { status: MonitorStatus }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[status])}
    />
  );
}

const STATUS_DOT: Record<MonitorStatus, string> = {
  ok: "bg-success",
  warning: "bg-warning",
  alert: "bg-destructive",
  "low-volume": "bg-muted-foreground/50",
};

export const TONE_TEXT = {
  good: "text-success",
  bad: "text-destructive",
  neutral: "text-muted-foreground",
} as const;

export function formatPct(change: number): string {
  const pct = Math.round(change * 100);
  return `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct)}%`;
}

export function Change({
  change,
  better,
  children,
}: {
  change: number | null;
  better: "up" | "down" | "none";
  /** Wraps the formatted change, e.g. into "{pct} vs yesterday". */
  children?: (pct: string) => ReactNode;
}) {
  if (change === null) return null;
  const tone = changeTone(change, better);
  const pct = formatPct(change);
  return (
    // Nested: tailwind-merge reads `text-meta` and a text color as one group.
    <span className="text-meta tnum">
      <span className={TONE_TEXT[tone]}>{children ? children(pct) : pct}</span>
    </span>
  );
}

export function SectionHeader({
  title,
  caption,
  count,
  action,
}: {
  title: string;
  caption?: string;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          {count !== undefined && count > 0 && (
            <span className="text-meta tnum">{count}</span>
          )}
        </div>
        {caption && <p className="text-meta">{caption}</p>}
      </div>
      {action}
    </div>
  );
}

export type ProjectScreen =
  | "monitoring"
  | "releases"
  | "experiments"
  | "analytics"
  | "connectSources";

export function projectLink(
  orgSlug: string,
  projectId: string,
  screen: ProjectScreen,
): LinkProps {
  const params = { org: orgSlug, agentId: projectId };
  switch (screen) {
    case "monitoring":
      return { to: PROJECT_ROUTE.monitoring, params };
    case "releases":
      return { to: PROJECT_ROUTE.releases, params };
    case "experiments":
      return { to: PROJECT_ROUTE.experiments, params };
    case "analytics":
      return { to: PROJECT_ROUTE.analytics, params };
    case "connectSources":
      return { to: PROJECT_ROUTE.connectSources, params };
    default: {
      const unhandled: never = screen;
      return unhandled;
    }
  }
}

/** Sources connect from the project's connect flow, or from Context at org scope. */
export function connectLink(
  orgSlug: string,
  scopeId: string | null,
): LinkProps {
  return scopeId
    ? projectLink(orgSlug, scopeId, "connectSources")
    : { to: DESTINATION_ROUTE.library, params: { org: orgSlug } };
}

export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

export const minutesSince = (iso: string) =>
  Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));

/**
 * Up or down against a reference, the board analytics way: an arrow and the
 * size of the change, coloured by whether that is good, then what it is
 * against in the quiet meta tone.
 */
export function Trend({
  change,
  better,
  reference,
}: {
  change: number | null;
  better: "up" | "down" | "none";
  reference: string;
}) {
  const t = useT();
  if (change === null) return null;
  const tone = changeTone(change, better);
  const pct = Math.abs(Math.round(change * 100));
  return (
    <span className="text-meta inline-flex items-center gap-1">
      {pct === 0 ? (
        t("monitor.unchanged")
      ) : (
        <span
          className={cn(
            "tnum inline-flex items-center gap-0.5 font-medium",
            tone === "good" && "text-success",
            tone === "bad" && "text-destructive",
          )}
        >
          {change > 0 ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
          {pct}%
        </span>
      )}
      <span>{reference}</span>
    </span>
  );
}

/** A list row inside a metric card, hairline between rows like the board's. */
export const ROW = "border-b border-border/50 last:border-b-0";

export function verdictName(verdict: DeployVerdict, t: TFunction): string {
  switch (verdict) {
    case "improvement":
      return t("monitor.verdict.improvement");
    case "neutral":
      return t("monitor.verdict.neutral");
    case "regression":
      return t("monitor.verdict.regression");
    case "settling":
      return t("monitor.verdict.settling");
    default: {
      const unhandled: never = verdict;
      return unhandled;
    }
  }
}
