/**
 * Errors grouped by fingerprint: what broke, where, how often and for how
 * many visitors, with the stack a fault is actually debugged from.
 */

import { AlertTriangle, ChevronRight } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@decocms/ui/components/collapsible.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import {
  fmtInt,
  fmtWhen,
  n0,
  num,
  Panel,
  type Row,
  rowsOf,
  SectionEmpty,
  SectionError,
  SectionSkeleton,
  str,
  useSectionView,
} from "./panels";
import type { SectionProps } from "./types";

const GRID =
  "grid grid-cols-[minmax(0,1fr)_6rem_5rem_7.5rem_1rem] items-center gap-x-4";

/** `file:line`, with the origin dropped: the path is what tells files apart. */
function where(r: Row): string {
  const file = str(r.file);
  if (!file) return "";
  let path = file;
  try {
    path = new URL(file).pathname;
  } catch {
    // Not a URL: a bare path or a bundler id, shown as sent.
  }
  const line = num(r.line);
  return line ? `${path}:${line}` : path;
}

export function ErrorsSection(props: SectionProps) {
  const t = useT();
  const view = useSectionView(props, "errors");
  if (view.isLoading) return <SectionSkeleton />;
  if (view.error) return <SectionError error={view.error} />;
  const rows = rowsOf(view.data, "errors");

  if (rows.length === 0) {
    return (
      <SectionEmpty
        icon={<AlertTriangle size={20} />}
        title={t("monitor.analytics.panels.errors.empty")}
        description={t("monitor.analytics.panels.errors.emptyDesc")}
      />
    );
  }
  const total = rows.reduce((a, r) => a + n0(r.occurrences), 0);

  return (
    <Panel
      title={t("monitor.analytics.panels.errors.title")}
      value={fmtInt(total)}
    >
      <div className="flex flex-col">
        <div
          className={cn(
            GRID,
            "border-b border-border pb-2 text-xs text-muted-foreground",
          )}
        >
          <span>{t("monitor.analytics.panels.errors.error")}</span>
          <span className="text-right">
            {t("monitor.analytics.panels.errors.occurrences")}
          </span>
          <span className="text-right">
            {t("monitor.analytics.panels.col.visitors")}
          </span>
          <span className="text-right">
            {t("monitor.analytics.panels.errors.lastSeen")}
          </span>
          <span />
        </div>
        {rows.map((r) => (
          <ErrorRow key={str(r.fp)} row={r} />
        ))}
      </div>
    </Panel>
  );
}

function ErrorRow({ row }: { row: Row }) {
  const t = useT();
  const stack = str(row.stack);
  const at = where(row);
  const occurrences = n0(row.occurrences);
  const reports = n0(row.rows);
  const body = (
    <>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-2">
          <Badge variant="destructive" className="shrink-0">
            {str(row.type) || "Error"}
          </Badge>
          <span className="truncate text-sm text-foreground">
            {str(row.message)}
          </span>
        </span>
        {at && (
          <span className="truncate font-mono text-xs text-muted-foreground">
            {at}
          </span>
        )}
      </span>
      <span className="flex flex-col items-end">
        <span className="tnum text-sm text-foreground">
          {fmtInt(occurrences)}
        </span>
        {occurrences > reports && reports > 0 && (
          <span className="text-meta tnum">
            {t("monitor.analytics.panels.errors.inReports", {
              n: fmtInt(reports),
            })}
          </span>
        )}
      </span>
      <span className="tnum text-right text-sm text-foreground">
        {fmtInt(row.visitors)}
      </span>
      <span className="text-meta tnum text-right">
        {fmtWhen(row.last_seen)}
      </span>
    </>
  );
  if (!stack) {
    return (
      <div
        className={cn(GRID, "border-b border-border/50 py-2.5 last:border-0")}
      >
        {body}
        <span />
      </div>
    );
  }
  return (
    <Collapsible className="group/err border-b border-border/50 last:border-0">
      <CollapsibleTrigger
        className={cn(
          GRID,
          "focus-ring w-full cursor-pointer rounded-md py-2.5 text-left hover:bg-accent/40",
        )}
        aria-label={t("monitor.analytics.panels.errors.stack")}
      >
        {body}
        <ChevronRight
          size={16}
          className="text-muted-foreground transition-transform group-data-[state=open]/err:rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="surface-inset mb-3 max-h-64 overflow-auto rounded-lg p-3 font-mono text-xs text-foreground">
          {stack}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
