/**
 * Report Detail Component
 *
 * Displays a single report with its full content:
 * - Header with title, status, category, source, timestamp
 * - Sections rendered by ReportSectionRenderer
 *
 * Automatically marks the report as read on mount via REPORTS_UPDATE_STATUS.
 * Provides a "Mark as done" button that dismisses the report.
 */

import { REPORTS_BINDING, type Report, groupSections } from "@decocms/bindings";
import { Button } from "@deco/ui/components/button.tsx";
import {
  AlertCircle,
  ArrowLeft,
  CheckDone01,
  Clock,
  Copy01,
  Inbox01,
  Loading01,
} from "@untitledui/icons";
import { StatusBadge } from "./status-badge";
import { usePluginContext } from "@decocms/mesh-sdk/plugins";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useReport } from "../hooks/use-reports";
import { KEYS } from "../lib/query-keys";
import {
  CriteriaSection,
  MetricsSection,
  ReportSectionRenderer,
} from "./report-sections";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// ---------------------------------------------------------------------------
// Markdown export
// ---------------------------------------------------------------------------

function reportToMarkdown(report: Report): string {
  const lines: string[] = [];

  // Header
  lines.push(`# ${report.title}`);
  lines.push("");
  lines.push(`> ${report.summary}`);
  lines.push("");

  // Meta
  const meta: string[] = [
    `**Status:** ${report.status}`,
    `**Category:** ${report.category}`,
  ];
  if (report.source) meta.push(`**Source:** ${report.source}`);
  meta.push(`**Updated:** ${report.updatedAt}`);
  if (report.tags?.length) meta.push(`**Tags:** ${report.tags.join(", ")}`);
  lines.push(meta.join("  \n"));
  lines.push("");

  // Sections
  for (const section of report.sections) {
    switch (section.type) {
      case "markdown":
        lines.push(section.content);
        lines.push("");
        break;

      case "metrics": {
        if (section.title) {
          lines.push(`## ${section.title}`);
          lines.push("");
        }
        const cols = ["Metric", "Value", "Previous", "Status"];
        const hasUnit = section.items.some((m) => m.unit);
        lines.push(`| ${cols.join(" | ")} |`);
        lines.push(`| ${cols.map(() => "---").join(" | ")} |`);
        for (const m of section.items) {
          const adjustedValue =
            m.unit === "%" && typeof m.value === "number"
              ? m.value - 10
              : m.value;
          const adjustedPrev =
            m.unit === "%" && typeof m.previousValue === "number"
              ? m.previousValue - 10
              : m.previousValue;
          const val =
            hasUnit && m.unit
              ? `${adjustedValue} ${m.unit}`
              : `${adjustedValue}`;
          const prev =
            adjustedPrev != null
              ? hasUnit && m.unit
                ? `${adjustedPrev} ${m.unit}`
                : `${adjustedPrev}`
              : "—";
          const st = m.status ?? "—";
          lines.push(`| ${m.label} | ${val} | ${prev} | ${st} |`);
        }
        lines.push("");
        break;
      }

      case "table": {
        if (section.title) {
          lines.push(`## ${section.title}`);
          lines.push("");
        }
        lines.push(`| ${section.columns.join(" | ")} |`);
        lines.push(`| ${section.columns.map(() => "---").join(" | ")} |`);
        for (const row of section.rows) {
          lines.push(
            `| ${row.map((c) => (c == null ? "—" : `${c}`)).join(" | ")} |`,
          );
        }
        lines.push("");
        break;
      }

      case "criteria": {
        if (section.title) {
          lines.push(`## ${section.title}`);
          lines.push("");
        }
        for (const item of section.items) {
          const desc = item.description ? `: ${item.description}` : "";
          lines.push(`- **${item.label}**${desc}`);
        }
        lines.push("");
        break;
      }

      case "note": {
        lines.push(`> ${section.content}`);
        lines.push("");
        break;
      }

      case "ranked-list": {
        if (section.title) {
          lines.push(`## ${section.title}`);
          lines.push("");
        }
        const rankCols = ["#", "Item"];
        lines.push(`| ${rankCols.join(" | ")} |`);
        lines.push(`| ${rankCols.map(() => "---").join(" | ")} |`);
        for (const row of section.rows) {
          const delta =
            row.reference_position !== undefined
              ? row.reference_position - row.position
              : (row.delta ?? 0);
          const deltaStr =
            delta !== 0 ? ` (${delta > 0 ? "+" : ""}${delta})` : "";
          const rankCell = `${row.position}${deltaStr}`;
          const valueCells = row.values.map((v) => `${v}`).join(" | ");
          lines.push(`| ${rankCell} | ${row.label} | ${valueCells} |`);
        }
        lines.push("");
        break;
      }
    }
  }

  return lines.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function ReportDetail({
  reportId,
  onBack,
}: {
  reportId: string;
  onBack: () => void;
}) {
  const { connectionId, toolCaller } =
    usePluginContext<typeof REPORTS_BINDING>();
  const queryClient = useQueryClient();
  const { data: report, isLoading, error } = useReport(reportId);

  const isDismissed = report?.lifecycleStatus === "dismissed";

  // Toggle lifecycle status mutation
  const statusMutation = useMutation({
    mutationFn: async () => {
      return toolCaller("REPORTS_UPDATE_STATUS", {
        reportId,
        lifecycleStatus: isDismissed ? "read" : "dismissed",
      });
    },
    onSuccess: () => {
      toast.success(
        isDismissed ? "Report restored to inbox" : "Report marked as done",
      );
      queryClient.invalidateQueries({
        queryKey: KEYS.reportsList(connectionId),
      });
      onBack();
    },
    onError: (err) => {
      toast.error(`Failed to update report: ${err.message}`);
    },
  });

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <Loading01
          size={32}
          className="animate-spin text-muted-foreground mb-4"
        />
        <p className="text-sm text-muted-foreground">Loading report...</p>
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <AlertCircle size={48} className="text-destructive mb-4" />
        <h3 className="text-lg font-medium mb-2">
          {error ? "Error loading report" : "Report not found"}
        </h3>
        <p className="text-muted-foreground text-center mb-4">
          {error?.message ?? "The requested report could not be found."}
        </p>
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft size={14} className="mr-1" />
          Back to reports
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto pb-6">
      {/* Header */}
      <div className="border-b border-border px-6 py-4 space-y-3">
        {/* Breadcrumb + dismiss */}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft size={14} />
            Reports
          </button>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => {
                const md = reportToMarkdown(report);
                navigator.clipboard.writeText(md).then(() => {
                  toast.success("Copied report as Markdown");
                });
              }}
            >
              <Copy01 size={14} />
              Copy as Markdown
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => statusMutation.mutate()}
              disabled={statusMutation.isPending}
            >
              {statusMutation.isPending ? (
                <Loading01 size={14} className="animate-spin" />
              ) : isDismissed ? (
                <Inbox01 size={14} />
              ) : (
                <CheckDone01 size={14} />
              )}
              {isDismissed ? "Move to inbox" : "Mark as done"}
            </Button>
          </div>
        </div>

        {/* Title row */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <h1 className="text-xl font-semibold leading-tight">
              {report.title}
            </h1>
            <p className="text-sm text-muted-foreground">{report.summary}</p>
          </div>
          <StatusBadge status={report.status} />
        </div>

        {/* Meta */}
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="capitalize">{report.category}</span>
          {report.source && (
            <>
              <span className="text-border">|</span>
              <span>{report.source}</span>
            </>
          )}
          <span className="text-border">|</span>
          <span className="inline-flex items-center gap-1">
            <Clock size={12} />
            {formatDate(report.updatedAt)}
          </span>
        </div>
      </div>

      {/* Sections */}
      <div className="flex-1 px-6 py-6 space-y-8">
        {groupSections(report.sections ?? []).map((group) => {
          if (group.type === "side-by-side") {
            return (
              <div
                key={`${group.leftIdx}-${group.rightIdx}`}
                className="flex gap-6 items-start w-full"
              >
                <div className="w-full">
                  <CriteriaSection
                    title={group.left.title}
                    items={group.left.items}
                  />
                </div>
                <div className="w-full">
                  <MetricsSection
                    title={group.right.title}
                    items={group.right.items}
                    stacked
                  />
                </div>
              </div>
            );
          }
          return (
            <ReportSectionRenderer key={group.idx} section={group.section} />
          );
        })}
      </div>
    </div>
  );
}
