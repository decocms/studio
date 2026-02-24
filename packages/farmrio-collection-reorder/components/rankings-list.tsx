/**
 * Rankings List Component
 *
 * Lists all reports from the Reports MCP. Click a report to view its detail.
 * Follows the same header + search + content pattern as Agents, Connections, Monitor.
 */

import type { ReportStatus, ReportSummary } from "@decocms/bindings";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@deco/ui/components/breadcrumb.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@deco/ui/components/card.tsx";
import { CollectionSearch } from "@deco/ui/components/collection-search.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { Clock } from "@untitledui/icons";
import { AlertCircle, BarChart01, Loading01 } from "@untitledui/icons";
import { useState } from "react";
import { useRankingReportsList } from "../hooks/use-ranking-reports";
import { STATUS_CONFIG, StatusBadge } from "./status-badge";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ReportCard({
  report,
  onSelect,
}: {
  report: ReportSummary;
  onSelect: (id: string) => void;
}) {
  return (
    <Card
      className="group relative cursor-pointer transition-shadow hover:shadow-md"
      onClick={() => onSelect(report.id)}
    >
      <CardHeader className="pb-2 pt-5 px-5">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-sm leading-snug line-clamp-2">
            {report.title}
          </CardTitle>
          <StatusBadge status={report.status} size="sm" />
        </div>
        <CardDescription className="mt-1 line-clamp-2 text-xs">
          {report.summary}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1 capitalize">
              {report.category}
            </span>
            {report.source && (
              <span className="inline-flex items-center gap-1 text-muted-foreground/70">
                {report.source}
              </span>
            )}
          </div>
          <span className="inline-flex items-center gap-1">
            <Clock size={12} />
            {formatDate(report.updatedAt)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

type PeriodKey = "today" | "thisWeek" | "older";

const PERIOD_LABELS: Record<PeriodKey, string> = {
  today: "Hoje",
  thisWeek: "Esta semana",
  older: "Mais antigos",
};

function getPeriodKey(iso: string): PeriodKey {
  const date = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const msPerDay = 24 * 60 * 60 * 1000;
  const diffDays = Math.floor(
    (startOfToday.getTime() - date.getTime()) / msPerDay,
  );
  if (diffDays <= 0) return "today";
  if (diffDays <= 6) return "thisWeek";
  return "older";
}

function matchesSearch(report: ReportSummary, q: string): boolean {
  if (!q.trim()) return true;
  const lower = q.toLowerCase().trim();
  return (
    report.title.toLowerCase().includes(lower) ||
    report.summary.toLowerCase().includes(lower) ||
    report.category.toLowerCase().includes(lower) ||
    (report.source?.toLowerCase().includes(lower) ?? false) ||
    (report.tags?.some((t) => t.toLowerCase().includes(lower)) ?? false)
  );
}

export default function RankingsList({
  onSelectReport,
}: {
  onSelectReport: (id: string) => void;
}) {
  const { data, isLoading, error } = useRankingReportsList();
  const reports = data?.reports ?? [];
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ReportStatus | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

  const filtered = reports.filter((r) => {
    if (!matchesSearch(r, search)) return false;
    if (statusFilter && r.status !== statusFilter) return false;
    if (categoryFilter && r.category !== categoryFilter) return false;
    return true;
  });

  const categories = [...new Set(reports.map((r) => r.category))].sort();

  const grouped = filtered.reduce<Record<PeriodKey, ReportSummary[]>>(
    (acc, r) => {
      const key = getPeriodKey(r.updatedAt);
      if (!acc[key]) acc[key] = [];
      acc[key].push(r);
      return acc;
    },
    { today: [], thisWeek: [], older: [] },
  );

  const periodOrder: PeriodKey[] = ["today", "thisWeek", "older"];

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <AlertCircle size={48} className="text-destructive mb-4" />
        <h3 className="text-lg font-medium mb-2">Error loading reports</h3>
        <p className="text-muted-foreground text-center">{error.message}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Page Header - same pattern as Agents, Connections, Monitor */}
      <div className="shrink-0 w-full border-b border-border h-12 overflow-x-auto flex items-center justify-between gap-3 px-4 min-w-max">
        <div className="flex items-center gap-2 shrink-0 overflow-hidden">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Collection Ranking</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
        {reports.length > 0 && (
          <div className="flex items-center gap-2 shrink-0 overflow-hidden border-l border-border pl-3">
            <Select
              value={categoryFilter ?? "__all__"}
              onValueChange={(v) =>
                setCategoryFilter(v === "__all__" ? null : v)
              }
            >
              <SelectTrigger size="sm">
                <SelectValue placeholder="Todas as categorias" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Todas as categorias</SelectItem>
                {categories.map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    <span className="capitalize">{cat}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={statusFilter ?? "__all__"}
              onValueChange={(v) =>
                setStatusFilter(v === "__all__" ? null : (v as ReportStatus))
              }
            >
              <SelectTrigger size="sm">
                <SelectValue placeholder="Todos os status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Todos os status</SelectItem>
                {(Object.keys(STATUS_CONFIG) as ReportStatus[]).map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_CONFIG[s].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {/* Search Bar - same as Agents, Connections */}
      <CollectionSearch
        value={search}
        onChange={setSearch}
        placeholder="Search reports..."
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setSearch("");
            (event.target as HTMLInputElement).blur();
          }
        }}
      />

      <div className="flex-1 overflow-auto p-6">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center h-full">
            <Loading01
              size={32}
              className="animate-spin text-muted-foreground mb-4"
            />
            <p className="text-sm text-muted-foreground">Loading reports...</p>
          </div>
        ) : reports.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <BarChart01 size={48} className="text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">No reports yet</h3>
            <p className="text-muted-foreground max-w-sm">
              Reports will appear here once the connected MCP server provides
              them.
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <BarChart01 size={48} className="text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">
              No reports match filters
            </h3>
            <p className="text-muted-foreground max-w-sm">
              Try adjusting your search or filters.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {periodOrder.map((key) => {
              const items = grouped[key];
              if (!items || items.length === 0) return null;
              return (
                <div key={key} className="space-y-3">
                  <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {PERIOD_LABELS[key]}
                  </h3>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {items.map((report) => (
                      <ReportCard
                        key={report.id}
                        report={report}
                        onSelect={onSelectReport}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
