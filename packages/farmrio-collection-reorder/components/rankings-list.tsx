/**
 * Rankings List Component
 *
 * Lists all reports for a given collection from the Farmrio MCP.
 * Displays in a dashboard layout matching the Figma design:
 * collection header, metric cards, A/B test bar, and runs table.
 */

import type {
  FarmrioCollectionItem,
  FarmrioReportSummary,
} from "@decocms/bindings";
import { Button } from "@deco/ui/components/button.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  AlertCircle,
  ArrowLeft,
  BarChart01,
  CalendarDate,
  ChevronDown,
  File02,
  Loading01,
  TrendDown01,
  TrendUp01,
} from "@untitledui/icons";
import { useState } from "react";
import { useRankingReportsList } from "../hooks/use-ranking-reports";

function formatRunDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function parseTagNumber(
  tags: string[] | undefined,
  key: string,
): number | null {
  if (!tags) return null;
  const tag = tags.find((t) => t.toLowerCase().startsWith(`${key}:`));
  if (!tag) return null;
  const val = parseInt(tag.split(":")[1] ?? "", 10);
  return Number.isNaN(val) ? null : val;
}

function parseSummaryNumber(summary: string, pattern: RegExp): number | null {
  const match = summary.match(pattern);
  if (!match || !match[1]) return null;
  const val = parseInt(match[1], 10);
  return Number.isNaN(val) ? null : val;
}

function getProducts(report: FarmrioReportSummary): string {
  const fromTags = parseTagNumber(report.tags, "products");
  if (fromTags !== null) return String(fromTags);
  const fromSummary = parseSummaryNumber(report.summary, /(\d+)\s*products?/i);
  if (fromSummary !== null) return String(fromSummary);
  return "-";
}

function getMoves(report: FarmrioReportSummary): string {
  const fromTags = parseTagNumber(report.tags, "moves");
  if (fromTags !== null) return String(fromTags);
  const fromSummary = parseSummaryNumber(report.summary, /(\d+)\s*moves?/i);
  if (fromSummary !== null) return String(fromSummary);
  return "-";
}

function getTypeLabel(category: string | undefined): string {
  if (!category) return "Daily";
  const lower = category.toLowerCase();
  if (lower.includes("week")) return "Weekly";
  return "Daily";
}

function TypeBadge({ category }: { category?: string }) {
  const label = getTypeLabel(category);
  const isWeekly = label === "Weekly";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border",
        isWeekly
          ? "bg-purple-50 text-purple-700 border-purple-200"
          : "bg-sky-50 text-sky-700 border-sky-200",
      )}
    >
      <CalendarDate size={11} />
      {label}
    </span>
  );
}

function StatusText({ status }: { status?: string }) {
  if (!status) return <span className="text-muted-foreground">-</span>;

  const styleMap: Record<string, string> = {
    passing: "text-emerald-700",
    applied: "text-emerald-700",
    warning: "text-amber-700",
    failing: "text-red-600",
    info: "text-blue-600",
  };
  const labelMap: Record<string, string> = {
    passing: "Applied",
    applied: "Applied",
    warning: "Warning",
    failing: "Failed",
    info: "Info",
  };
  const lower = status.toLowerCase();
  return (
    <span
      className={cn(
        "text-sm font-medium",
        styleMap[lower] ?? "text-foreground",
      )}
    >
      {labelMap[lower] ?? status}
    </span>
  );
}

function Sparkline({ variant = "up" }: { variant?: "up" | "down" | "flat" }) {
  const paths = {
    up: "M0,32 C10,28 20,24 30,20 S50,14 60,10 S80,6 90,4 S110,2 120,0",
    down: "M0,4 C10,8 20,12 30,16 S50,22 60,26 S80,30 90,32 S110,34 120,36",
    flat: "M0,20 C20,18 40,22 60,20 S80,18 100,20 S110,20 120,20",
  };
  const colors = {
    up: { stroke: "#6366f1", fill: "rgba(99,102,241,0.12)" },
    down: { stroke: "#f59e0b", fill: "rgba(245,158,11,0.12)" },
    flat: { stroke: "#94a3b8", fill: "rgba(148,163,184,0.08)" },
  };
  const { stroke, fill } = colors[variant];
  const d = paths[variant];
  const area = `${d} L120,40 L0,40 Z`;
  return (
    <svg width={120} height={40} viewBox="0 0 120 40" className="opacity-80">
      <path d={area} fill={fill} />
      <path d={d} stroke={stroke} strokeWidth="1.5" fill="none" />
    </svg>
  );
}

interface MetricCardData {
  label: string;
  value: string;
  delta: string | null;
  trending: "up" | "down" | null;
  sparkVariant: "up" | "down" | "flat";
}

function MetricCard({
  label,
  value,
  delta,
  trending,
  sparkVariant,
}: MetricCardData) {
  return (
    <div className="p-5 flex flex-col gap-2 min-w-0">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {label}
        </span>
      </div>
      <div className="flex items-end justify-between gap-2">
        <div className="flex flex-col gap-1">
          <span className="text-2xl font-semibold text-foreground leading-none">
            {value}
          </span>
          {delta && (
            <div
              className={cn(
                "flex items-center gap-1 text-xs font-medium",
                trending === "up" ? "text-emerald-600" : "text-amber-600",
              )}
            >
              {trending === "up" ? (
                <TrendUp01 size={12} />
              ) : (
                <TrendDown01 size={12} />
              )}
              {delta}
            </div>
          )}
        </div>
        <Sparkline variant={sparkVariant} />
      </div>
    </div>
  );
}

const PLACEHOLDER_METRICS: MetricCardData[] = [
  {
    label: "Sessions",
    value: "-",
    delta: null,
    trending: null,
    sparkVariant: "flat",
  },
  {
    label: "Engagement",
    value: "-",
    delta: null,
    trending: null,
    sparkVariant: "flat",
  },
  {
    label: "Add Cart",
    value: "-",
    delta: null,
    trending: null,
    sparkVariant: "flat",
  },
  {
    label: "Revenue",
    value: "-",
    delta: null,
    trending: null,
    sparkVariant: "flat",
  },
];

export default function RankingsList({
  collection,
  onBack,
  onSelectReport,
  onToggleCollection,
}: {
  collection: FarmrioCollectionItem;
  onBack: () => void;
  onSelectReport: (id: number) => void;
  onToggleCollection?: (
    collection: FarmrioCollectionItem,
    isEnabled: boolean,
  ) => Promise<void>;
}) {
  const {
    data: reports = [],
    isLoading,
    error,
  } = useRankingReportsList(collection.id);

  const [isToggling, setIsToggling] = useState(false);

  const handleToggle = async (value: boolean) => {
    if (!onToggleCollection) return;
    setIsToggling(true);
    try {
      await onToggleCollection(collection, value);
    } finally {
      setIsToggling(false);
    }
  };

  const sorted = [...reports].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Collection Header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center justify-center size-7 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft size={15} />
          </button>
          <span className="text-muted-foreground text-base select-none">/</span>
          <span className="text-base font-semibold text-foreground">
            {collection.title}
          </span>
          <Switch
            checked={collection.isEnabled}
            disabled={isToggling || !onToggleCollection}
            onCheckedChange={(v) => void handleToggle(v)}
            className="ml-1 cursor-pointer"
          />
        </div>
        <button
          type="button"
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors rounded px-2 py-1 hover:bg-muted"
        >
          <span>
            {new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toLocaleDateString(
              "en-US",
              { day: "2-digit", month: "long", year: "numeric" },
            )}{" "}
            -{" "}
            {new Date().toLocaleDateString("en-US", {
              day: "2-digit",
              month: "long",
              year: "numeric",
            })}
          </span>
          <ChevronDown size={14} />
        </button>
      </div>

      {/* Metric Cards */}
      <div className="grid grid-cols-4 border-b border-border divide-x divide-border shrink-0">
        {PLACEHOLDER_METRICS.map((m) => (
          <MetricCard key={m.label} {...m} />
        ))}
      </div>

      {/* A/B Test Bar */}
      <div className="flex items-center gap-4 px-5 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <div className="size-4 rounded border border-border flex items-center justify-center shrink-0">
            <div className="size-2 rounded-sm bg-foreground" />
          </div>
          <span className="text-xs font-medium text-muted-foreground tracking-wide">
            A/B TEST
          </span>
        </div>
        <div className="flex-1 flex items-center gap-3">
          <span className="text-xs font-medium text-foreground whitespace-nowrap">
            AI 50%
          </span>
          <div className="flex-1 h-3.5 flex rounded-full overflow-hidden">
            <div className="flex-1 bg-indigo-500" />
            <div className="flex-1 bg-amber-400" />
          </div>
          <span className="text-xs font-medium text-foreground whitespace-nowrap">
            50% MANUAL
          </span>
        </div>
        <Button size="sm" variant="outline" className="shrink-0 h-8 text-xs">
          Compare A/B
        </Button>
      </div>

      {/* Runs Table */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center h-full">
            <Loading01
              size={28}
              className="animate-spin text-muted-foreground mb-3"
            />
            <p className="text-sm text-muted-foreground">Loading runs...</p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full p-8">
            <AlertCircle size={40} className="text-destructive mb-3" />
            <h3 className="text-base font-medium mb-1">Error loading runs</h3>
            <p className="text-muted-foreground text-center text-sm">
              {error.message}
            </p>
          </div>
        ) : reports.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-8">
            <BarChart01 size={40} className="text-muted-foreground mb-3" />
            <h3 className="text-base font-medium mb-1">No runs yet</h3>
            <p className="text-muted-foreground max-w-sm text-sm">
              Runs will appear here once the MCP generates rankings for this
              collection.
            </p>
          </div>
        ) : (
          <>
            <div className="px-5 pt-5 pb-3">
              <h3 className="text-sm font-semibold text-foreground">Runs</h3>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wide px-5 py-2.5 w-14">
                    #
                  </th>
                  <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wide px-4 py-2.5">
                    Run Date
                  </th>
                  <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wide px-4 py-2.5">
                    Type
                  </th>
                  <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wide px-4 py-2.5">
                    Products
                  </th>
                  <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wide px-4 py-2.5">
                    Moves
                  </th>
                  <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wide px-4 py-2.5">
                    Status
                  </th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((report) => {
                  const products = getProducts(report);
                  const moves = getMoves(report);
                  const hasNote = !!report.summary;
                  return (
                    <tr
                      key={report.id}
                      className="border-b border-border hover:bg-muted/40 transition-colors cursor-pointer group"
                      onClick={() => onSelectReport(report.id)}
                    >
                      <td className="px-5 py-4 text-sm text-muted-foreground font-mono">
                        #{report.id}
                      </td>
                      <td className="px-4 py-4 text-sm text-foreground whitespace-nowrap">
                        {formatRunDate(report.updatedAt)}
                      </td>
                      <td className="px-4 py-4">
                        <TypeBadge category={report.category} />
                      </td>
                      <td className="px-4 py-4 text-sm text-foreground tabular-nums">
                        {products}
                      </td>
                      <td className="px-4 py-4 text-sm text-foreground tabular-nums">
                        {moves}
                      </td>
                      <td className="px-4 py-4">
                        <StatusText status={report.status} />
                      </td>
                      <td className="px-3 py-4">
                        {hasNote && (
                          <File02
                            size={14}
                            className="text-muted-foreground/50 opacity-0 group-hover:opacity-100 transition-opacity"
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
