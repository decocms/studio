/**
 * Ranking Detail Component
 *
 * Displays a single report with its full content.
 * Renders sections as returned by the Farmrio MCP (metrics, criteria, note, ranked-list).
 */

import type { FarmrioCollectionItem } from "@decocms/bindings";
import { Button } from "@deco/ui/components/button.tsx";
import { AlertCircle, ArrowLeft, Clock, Loading01 } from "@untitledui/icons";
import { useRankingReport } from "../hooks/use-ranking-reports";
import { RankingSectionRenderer } from "./ranking-sections";
import { StatusBadge } from "./status-badge";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function RankingDetail({
  reportId,
  collection,
  onBack,
}: {
  reportId: number;
  collection: FarmrioCollectionItem;
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
        <p className="text-sm text-muted-foreground">Carregando report...</p>
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <AlertCircle size={48} className="text-destructive mb-4" />
        <h3 className="text-lg font-medium mb-2">
          {error ? "Erro ao carregar report" : "Report não encontrado"}
        </h3>
        <p className="text-muted-foreground text-center mb-4">
          {error?.message ?? "O report solicitado não foi encontrado."}
        </p>
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft size={14} className="mr-1" />
          Voltar aos reports
        </Button>
      </div>
    );
  }

  const sortedSections = [...(report.sections ?? [])].sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0),
  );

  return (
    <div className="flex flex-col h-full overflow-y-auto py-6 px-64">
      <div className="border-b border-border py-4 space-y-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="self-start -ml-2 mb-2 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={14} className="mr-1" />
          Voltar
        </Button>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <h1 className="text-xl font-semibold leading-tight">
              {report.title}
            </h1>
            <p className="text-sm text-muted-foreground">{report.summary}</p>
          </div>
          {report.status && <StatusBadge status={report.status} />}
        </div>

        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          {report.category && (
            <span className="capitalize">{report.category}</span>
          )}
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
        {sortedSections.map((section, idx) => (
          <RankingSectionRenderer
            key={section.id ?? idx}
            section={section}
            decoCollectionId={collection.decoCollectionId}
          />
        ))}
      </div>
    </div>
  );
}
