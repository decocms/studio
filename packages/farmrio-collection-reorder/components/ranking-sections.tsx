/**
 * Section renderers for ranking reports.
 * Renders metrics, criteria, and ranked-list sections with specialized UI.
 */

import type {
  CriterionItem,
  MetricItem,
  RankedListRow,
  ReportSection,
  ReportStatus,
} from "@decocms/bindings";
import { REPORTS_BINDING } from "@decocms/bindings";
import { usePluginContext } from "@decocms/mesh-sdk/plugins";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@deco/ui/components/table.tsx";
import { Markdown } from "@deco/ui/components/markdown.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  ArrowDown,
  ArrowUp,
  CheckVerified02,
  Columns02,
  File02,
  Hash02,
  Loading01,
  Minus,
  Rows03,
} from "@untitledui/icons";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { buildVtexApplyPayload } from "../lib/vtex-reorder";
import { useVtexConnectionContext } from "./vtex-connection-context";

const STATUS_DOT: Record<ReportStatus, string> = {
  passing: "bg-emerald-500",
  warning: "bg-amber-500",
  failing: "bg-red-500",
  info: "bg-blue-500",
};

const CRITERIA_COLORS = ["#A595FF", "#FFC116", "#DE3A6E"];

function SectionHeader({
  icon: Icon,
  title,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
}) {
  return (
    <div className="flex gap-2 items-center">
      <Icon size={16} className="opacity-75 shrink-0 text-foreground" />
      <span className="text-base text-foreground opacity-75">{title}</span>
    </div>
  );
}

function MarkdownSection({ content }: { content: string }) {
  return <Markdown>{content}</Markdown>;
}

function MetricCard({ metric }: { metric: MetricItem }) {
  return (
    <div className="flex flex-col gap-3 items-start justify-end border border-border rounded-lg p-5 flex-1">
      <div className="text-2xl leading-8 text-foreground font-normal tabular-nums">
        {metric.value}
        {metric.unit && (
          <span className="text-base text-muted-foreground ml-1">
            {metric.unit}
          </span>
        )}
      </div>
      <div className="flex gap-1.5 items-center">
        {metric.status && (
          <span
            className={cn(
              "inline-block size-2 rounded-full shrink-0",
              STATUS_DOT[metric.status],
            )}
          />
        )}
        <span className="text-sm text-foreground">{metric.label}</span>
      </div>
    </div>
  );
}

export function MetricsSection({
  title,
  items,
  stacked = false,
}: {
  title?: string;
  items: MetricItem[];
  stacked?: boolean;
}) {
  return (
    <div className="space-y-4">
      {title && <SectionHeader icon={Rows03} title={title} />}
      <div
        className={cn(
          "flex gap-4",
          stacked ? "flex-col items-stretch" : "items-stretch",
        )}
      >
        {items.map((metric, i) => (
          <MetricCard key={`${metric.label}-${i}`} metric={metric} />
        ))}
      </div>
    </div>
  );
}

function TableSection({
  title,
  columns,
  rows,
}: {
  title?: string;
  columns: string[];
  rows: (string | number | null)[][];
}) {
  return (
    <div className="space-y-4">
      {title && <SectionHeader icon={Rows03} title={title} />}
      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((col) => (
                <TableHead
                  key={col}
                  className="font-mono text-xs uppercase text-muted-foreground"
                >
                  {col}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, rowIdx) => (
              <TableRow key={rowIdx}>
                {row.map((cell, cellIdx) => (
                  <TableCell key={cellIdx} className="text-sm">
                    {cell ?? <span className="text-muted-foreground">—</span>}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export function CriteriaSection({
  title,
  items,
}: {
  title?: string;
  items: CriterionItem[];
}) {
  return (
    <div className="space-y-4">
      {title && <SectionHeader icon={CheckVerified02} title={title} />}
      <div className="flex flex-col">
        {items.map((item, i) => (
          <div key={`${item.label}-${i}`} className="flex gap-4 items-stretch">
            <div className="flex flex-col items-center justify-center w-4 shrink-0">
              <div className="h-full w-px bg-border" />
              <div
                className="w-2 h-4 rounded-full flex"
                style={{
                  backgroundColor: CRITERIA_COLORS[i % CRITERIA_COLORS.length],
                }}
              />
              <div
                className={cn(
                  "h-full w-px bg-border",
                  i === items.length - 1 && "invisible",
                )}
              />
            </div>
            <div className="flex flex-col gap-2 items-start py-3 pb-4 min-w-0">
              <span className="text-sm font-medium text-foreground leading-none">
                {item.label}
              </span>
              {item.description && (
                <p className="text-sm text-foreground opacity-80 leading-5">
                  {item.description}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function NoteSection({ content }: { content: string }) {
  return (
    <div className="space-y-4">
      <SectionHeader icon={File02} title="Notas" />
      <p className="text-sm text-foreground opacity-80 leading-5">{content}</p>
    </div>
  );
}

function DeltaBadge({ delta }: { delta: number }) {
  if (delta === 0) {
    return (
      <span className="inline-flex items-center justify-center">
        <Minus size={16} className="text-muted-foreground" />
      </span>
    );
  }
  const isUp = delta > 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-sm font-medium",
        isUp ? "text-emerald-600" : "text-destructive",
      )}
    >
      {isUp ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
      {Math.abs(delta)}
    </span>
  );
}

function buildMockedPreviousRows(rows: RankedListRow[]): RankedListRow[] {
  if (rows.length === 0) return [];
  return rows
    .map((row) => {
      const previousPosition =
        row.reference_position !== undefined
          ? row.reference_position
          : row.position + (row.delta ?? 0);
      return {
        ...row,
        position: previousPosition,
        delta: 0,
        reference_position: undefined,
      };
    })
    .sort((a, b) => a.position - b.position);
}

function RankedTable({
  rows,
  label,
}: {
  rows: RankedListRow[];
  label?: string;
}) {
  const valueColCount = Math.max(4, ...rows.map((r) => r.values.length));
  const valueHeaders = [
    "IMPRESSIONS",
    "SELECT RATE",
    "ATC",
    "PURCHASE RATE",
    ...Array.from(
      { length: Math.max(0, valueColCount - 4) },
      (_, i) => `Val ${i + 5}`,
    ),
  ];

  return (
    <div className="flex flex-col gap-2 min-w-0 flex-1">
      {label && (
        <span className="text-xs font-mono uppercase text-muted-foreground opacity-60 tracking-wide px-1">
          {label}
        </span>
      )}
      <div className="border border-border rounded-lg overflow-auto max-h-[820px]">
        <Table>
          <TableHeader className="sticky top-0 bg-background z-10">
            <TableRow>
              <TableHead className="font-mono text-xs uppercase text-muted-foreground w-[60px]">
                #
              </TableHead>
              <TableHead className="font-mono text-xs uppercase text-muted-foreground w-[60px]">
                DELTA
              </TableHead>
              <TableHead className="font-mono text-xs uppercase text-muted-foreground">
                PRODUTO
              </TableHead>
              {valueHeaders.slice(0, valueColCount).map((h) => (
                <TableHead
                  key={h}
                  className="font-mono text-xs uppercase text-muted-foreground"
                >
                  {h}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, rowIdx) => {
              const delta =
                row.reference_position !== undefined
                  ? row.reference_position - row.position
                  : (row.delta ?? 0);

              return (
                <TableRow key={rowIdx}>
                  <TableCell>
                    <div className="flex items-center gap-1 opacity-50">
                      <Hash02 size={16} className="text-muted-foreground" />
                      <span className="text-sm font-medium text-muted-foreground tabular-nums">
                        {row.position}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <DeltaBadge delta={delta} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      {row.image && (
                        <img
                          src={row.image}
                          alt=""
                          className="h-12 w-8 object-cover rounded-sm shrink-0 bg-muted"
                        />
                      )}
                      <span className="text-sm font-medium text-foreground truncate">
                        {row.label}
                      </span>
                    </div>
                  </TableCell>
                  {(() => {
                    const columnNoteKeys = [
                      "sessions",
                      "select_rate",
                      "add_to_cart_rate",
                      "purchase_rate",
                    ];
                    const noteObj =
                      typeof row.note === "object" && row.note !== null
                        ? (row.note as Record<string, string | number | null>)
                        : null;
                    const allValues: (string | number | null)[] = Array.from(
                      { length: valueColCount },
                      (_, i) =>
                        noteObj?.[columnNoteKeys[i] ?? ""] ??
                        row.values[i] ??
                        null,
                    );
                    return allValues.map((val, cellIdx) => (
                      <TableCell key={cellIdx} className="text-sm tabular-nums">
                        {val ?? "—"}
                      </TableCell>
                    ));
                  })()}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function RankedListSection({
  title,
  rows,
}: {
  title?: string;
  rows: RankedListRow[];
}) {
  const { connection } = usePluginContext<typeof REPORTS_BINDING>();
  const { connection: vtexConnection, toolCaller: vtexToolCaller } =
    useVtexConnectionContext();
  const [showComparison, setShowComparison] = useState(false);
  const mockedPreviousRows = buildMockedPreviousRows(rows);
  const applyPayload = buildVtexApplyPayload(rows);
  const hasVtexReorderTool =
    vtexConnection?.tools?.some(
      (tool) => tool.name === "VTEX_REORDER_COLLECTION",
    ) ?? false;
  const missingVtexConnection = !vtexConnection || !vtexToolCaller;
  const applyBlockedReason = missingVtexConnection
    ? "Configure uma conexao VTEX para aplicar a sugestao."
    : !hasVtexReorderTool
      ? "A conexao VTEX selecionada nao possui a tool VTEX_REORDER_COLLECTION."
      : !applyPayload.ok
        ? applyPayload.error
        : null;
  const reportsConnectionLabel = connection.title;

  const applyMutation = useMutation({
    mutationFn: async () => {
      if (missingVtexConnection || !vtexToolCaller) {
        throw new Error("Configure uma conexao VTEX para aplicar a sugestao.");
      }
      if (!hasVtexReorderTool) {
        throw new Error(
          "A conexao VTEX selecionada nao possui a tool VTEX_REORDER_COLLECTION.",
        );
      }
      if (!applyPayload.ok) {
        throw new Error(applyPayload.error);
      }

      return vtexToolCaller("VTEX_REORDER_COLLECTION", {
        collectionId: applyPayload.collectionId,
        xml: applyPayload.xml,
      });
    },
    onSuccess: () => {
      const skuCount = applyPayload.ok ? applyPayload.skuCount : rows.length;
      toast.success(`Sugestao aplicada com sucesso (${skuCount} SKUs).`);
    },
    onError: (error) => {
      const message =
        error instanceof Error ? error.message : "Falha ao aplicar sugestao.";
      toast.error(message);
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        {title && <SectionHeader icon={Rows03} title={title} />}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => applyMutation.mutate()}
            disabled={applyMutation.isPending || !!applyBlockedReason}
            title={applyBlockedReason ?? undefined}
          >
            {applyMutation.isPending ? (
              <Loading01 size={14} className="animate-spin" />
            ) : null}
            Apply Suggestion
          </Button>
          <button
            type="button"
            onClick={() => setShowComparison((prev) => !prev)}
            className={cn(
              "inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border transition-colors",
              showComparison
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-transparent text-muted-foreground border-border hover:text-foreground hover:border-foreground/30",
            )}
          >
            <Columns02 size={14} />
            Comparar com Ordenacao Atual
          </button>
        </div>
      </div>
      {applyBlockedReason && (
        <p className="text-xs text-muted-foreground">{applyBlockedReason}</p>
      )}
      {!applyBlockedReason && (
        <p className="text-xs text-muted-foreground">
          Report conectado via: {reportsConnectionLabel}
        </p>
      )}

      {showComparison ? (
        <div className="flex gap-4 items-start">
          <RankedTable rows={rows} label="Ordenação Proposta" />
          <RankedTable rows={mockedPreviousRows} label="Ordenação Atual" />
        </div>
      ) : (
        <RankedTable rows={rows} />
      )}
    </div>
  );
}

export function RankingSectionRenderer({
  section,
}: {
  section: ReportSection;
}) {
  switch (section.type) {
    case "markdown":
      return <MarkdownSection content={section.content} />;
    case "metrics":
      return <MetricsSection title={section.title} items={section.items} />;
    case "table":
      return (
        <TableSection
          title={section.title}
          columns={section.columns}
          rows={section.rows}
        />
      );
    case "criteria":
      return <CriteriaSection title={section.title} items={section.items} />;
    case "note":
      return <NoteSection content={section.content} />;
    case "ranked-list":
      return <RankedListSection title={section.title} rows={section.rows} />;
    default:
      return null;
  }
}
