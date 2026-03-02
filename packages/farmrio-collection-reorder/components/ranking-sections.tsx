/**
 * Section renderers for ranking reports.
 * Renders sections as returned by the Farmrio MCP:
 * metrics (metricItems), criteria (criteriaItems), note (content), ranked-list (rankedItems).
 */

import type {
  FarmrioSection,
  FarmrioMetricItem,
  FarmrioCriteriaItem,
  FarmrioRankedItem,
} from "@decocms/bindings";
import { FARMRIO_REORDER_BINDING } from "@decocms/bindings";
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
  File02,
  Hash02,
  Loading01,
  Minus,
  Rows03,
} from "@untitledui/icons";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { buildVtexApplyPayload } from "../lib/vtex-reorder";
import { useVtexConnectionContext } from "./vtex-connection-context";

const STATUS_DOT: Record<string, string> = {
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

function MetricCard({ metric }: { metric: FarmrioMetricItem }) {
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
              STATUS_DOT[metric.status] ?? "bg-muted-foreground",
            )}
          />
        )}
        <span className="text-sm text-foreground">{metric.label}</span>
      </div>
    </div>
  );
}

function MetricsSection({
  title,
  items,
}: {
  title?: string | null;
  items: FarmrioMetricItem[];
}) {
  return (
    <div className="space-y-4">
      {title && <SectionHeader icon={Rows03} title={title} />}
      <div className="flex gap-4 items-stretch">
        {items.map((metric, i) => (
          <MetricCard key={`${metric.label}-${i}`} metric={metric} />
        ))}
      </div>
    </div>
  );
}

function CriteriaSection({
  title,
  items,
}: {
  title?: string | null;
  items: FarmrioCriteriaItem[];
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
      <Markdown>{content}</Markdown>
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

function RankedTable({ rows }: { rows: FarmrioRankedItem[] }) {
  return (
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
            <TableHead className="font-mono text-xs uppercase text-muted-foreground">
              SESSÕES
            </TableHead>
            <TableHead className="font-mono text-xs uppercase text-muted-foreground">
              SELECT RATE
            </TableHead>
            <TableHead className="font-mono text-xs uppercase text-muted-foreground">
              ADD TO CART
            </TableHead>
            <TableHead className="font-mono text-xs uppercase text-muted-foreground">
              PURCHASE RATE
            </TableHead>
            <TableHead className="font-mono text-xs uppercase text-muted-foreground">
              DISPONIB.
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, rowIdx) => (
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
                {row.delta !== undefined ? (
                  <DeltaBadge delta={row.delta} />
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  {row.image && (
                    <img
                      src={row.image}
                      alt=""
                      className="h-12 w-8 object-cover rounded-sm shrink-0 bg-muted"
                    />
                  )}
                  <span className="text-sm font-medium text-foreground truncate max-w-48">
                    {row.label}
                  </span>
                </div>
              </TableCell>
              <TableCell className="text-sm tabular-nums">
                {row.sessions?.toLocaleString() ?? "—"}
              </TableCell>
              <TableCell className="text-sm tabular-nums">
                {row.valueSelectRate ??
                  (row.selectRate != null
                    ? `${(row.selectRate * 100).toFixed(2)}%`
                    : "—")}
              </TableCell>
              <TableCell className="text-sm tabular-nums">
                {row.addToCartRate != null
                  ? `${(row.addToCartRate * 100).toFixed(2)}%`
                  : "—"}
              </TableCell>
              <TableCell className="text-sm tabular-nums">
                {row.purchaseRate != null
                  ? `${(row.purchaseRate * 100).toFixed(3)}%`
                  : "—"}
              </TableCell>
              <TableCell className="text-sm tabular-nums">
                {row.valueAvailability ?? "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function RankedListSection({
  title,
  rows,
  decoCollectionId,
}: {
  title?: string | null;
  rows: FarmrioRankedItem[];
  decoCollectionId: string | undefined;
}) {
  const { connection } = usePluginContext<typeof FARMRIO_REORDER_BINDING>();
  const { connection: vtexConnection, toolCaller: vtexToolCaller } =
    useVtexConnectionContext();

  const applyPayload = decoCollectionId
    ? buildVtexApplyPayload(rows, decoCollectionId)
    : {
        ok: false as const,
        error: "decoCollectionId não disponível para esta collection.",
      };
  const hasVtexReorderTool =
    vtexConnection?.tools?.some(
      (tool) => tool.name === "VTEX_REORDER_COLLECTION",
    ) ?? false;
  const missingVtexConnection = !vtexConnection || !vtexToolCaller;
  const applyBlockedReason = missingVtexConnection
    ? "Configure uma conexão VTEX para aplicar a sugestão."
    : !hasVtexReorderTool
      ? "A conexão VTEX selecionada não possui a tool VTEX_REORDER_COLLECTION."
      : !applyPayload.ok
        ? applyPayload.error
        : null;

  const applyMutation = useMutation({
    mutationFn: async () => {
      if (missingVtexConnection || !vtexToolCaller) {
        throw new Error("Configure uma conexão VTEX para aplicar a sugestão.");
      }
      if (!hasVtexReorderTool) {
        throw new Error(
          "A conexão VTEX selecionada não possui a tool VTEX_REORDER_COLLECTION.",
        );
      }
      if (!applyPayload.ok) {
        throw new Error(applyPayload.error);
      }

      return vtexToolCaller("VTEX_REORDER_COLLECTION", {
        collectionId: applyPayload.collectionId,
        productIds: applyPayload.productIds,
      });
    },
    onSuccess: () => {
      const productCount = applyPayload.ok
        ? applyPayload.productCount
        : rows.length;
      toast.success(
        `Sugestão aplicada com sucesso (${productCount} produtos).`,
      );
    },
    onError: (error) => {
      const message =
        error instanceof Error ? error.message : "Falha ao aplicar sugestão.";
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
        </div>
      </div>
      {applyBlockedReason ? (
        <p className="text-xs text-muted-foreground">{applyBlockedReason}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Report via: {connection.title}
        </p>
      )}
      <RankedTable rows={rows} />
    </div>
  );
}

export function RankingSectionRenderer({
  section,
  decoCollectionId,
}: {
  section: FarmrioSection;
  decoCollectionId: string | undefined;
}) {
  switch (section.type) {
    case "metrics":
      return (
        <MetricsSection
          title={section.title}
          items={section.metricItems ?? []}
        />
      );
    case "criteria":
      return (
        <CriteriaSection
          title={section.title}
          items={section.criteriaItems ?? []}
        />
      );
    case "note":
      return section.content ? <NoteSection content={section.content} /> : null;
    case "ranked-list":
      return (
        <RankedListSection
          title={section.title}
          rows={section.rankedItems ?? []}
          decoCollectionId={decoCollectionId}
        />
      );
    default:
      return null;
  }
}
