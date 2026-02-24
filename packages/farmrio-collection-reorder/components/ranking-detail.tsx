/**
 * Ranking Detail Component
 *
 * Displays a single report with its full content:
 * header, metrics, criteria, and ranked-list sections.
 */

import {
  type Report,
  type ReportSection,
  type SectionGroup,
  groupSections,
} from "@decocms/bindings";
import { Button } from "@deco/ui/components/button.tsx";
import { AlertCircle, ArrowLeft, Clock, Loading01 } from "@untitledui/icons";
import { StatusBadge } from "./status-badge";
import { useRankingReport } from "../hooks/use-ranking-reports";
import {
  CriteriaSection,
  MetricsSection,
  RankingSectionRenderer,
} from "./ranking-sections";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function RankingDetail({
  reportId,
  onBack,
}: {
  reportId: string;
  onBack: () => void;
}) {
  const { data: report, isLoading, error } = useRankingReport(reportId);

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
    <div className="flex flex-col h-full overflow-y-auto py-6 px-64">
      <div className="border-b border-border py-4 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <h1 className="text-xl font-semibold leading-tight">
              {report.title}
            </h1>
            <p className="text-sm text-muted-foreground">{report.summary}</p>
          </div>
          <StatusBadge status={report.status} />
        </div>

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

      <div className="flex-1 py-6 space-y-8">
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
            <RankingSectionRenderer key={group.idx} section={group.section} />
          );
        })}
      </div>
    </div>
  );
}
