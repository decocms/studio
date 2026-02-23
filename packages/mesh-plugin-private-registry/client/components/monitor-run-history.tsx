import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Card } from "@deco/ui/components/card.tsx";
import { useMonitorRuns } from "../hooks/use-monitor";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  formatMonitorDuration,
  monitorStatusBadgeClass,
} from "../lib/monitor-utils";

function passRate(run: { passed_items: number; tested_items: number }): string {
  if (!run.tested_items) return "-";
  return `${Math.round((run.passed_items / run.tested_items) * 100)}%`;
}

export function MonitorRunHistory({
  selectedRunId,
  onSelectRun,
}: {
  selectedRunId?: string;
  onSelectRun: (runId: string) => void;
}) {
  const query = useMonitorRuns();
  const runs = query.data?.items ?? [];

  return (
    <Card className="p-4">
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">QA run history</h3>
            <p className="text-[11px] text-muted-foreground">
              Browse previous QA executions and reopen their logs.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => query.refetch()}>
            Refresh
          </Button>
        </div>
        <div className="space-y-2 max-h-[520px] overflow-auto">
          {runs.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-4">
              No runs yet. Start QA from the Dashboard tab.
            </p>
          )}
          {runs.map((run) => {
            const duration = formatMonitorDuration(
              run.started_at,
              run.finished_at,
            );
            const rate = passRate(run);
            const isSelected = selectedRunId === run.id;
            return (
              <button
                type="button"
                key={run.id}
                onClick={() => onSelectRun(run.id)}
                className={cn(
                  "w-full text-left rounded-lg border p-3 transition-colors",
                  isSelected
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-muted/30",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-muted-foreground">
                      {new Date(run.created_at).toLocaleString()}
                    </p>
                  </div>
                  <Badge
                    className={cn(
                      "capitalize",
                      monitorStatusBadgeClass(run.status),
                    )}
                  >
                    {run.status}
                  </Badge>
                </div>
                <div className="mt-2 flex items-center gap-3 text-xs flex-wrap">
                  <span className="text-muted-foreground">
                    {run.tested_items}/{run.total_items} tested
                  </span>
                  <span className="text-emerald-600 font-medium">
                    {run.passed_items} passed
                  </span>
                  {run.failed_items > 0 && (
                    <span className="text-red-600 font-medium">
                      {run.failed_items} failed
                    </span>
                  )}
                  {run.skipped_items > 0 && (
                    <span className="text-muted-foreground">
                      {run.skipped_items} skipped
                    </span>
                  )}
                  <span className="text-muted-foreground">
                    pass rate: {rate}
                  </span>
                  {duration && (
                    <span className="text-muted-foreground">{duration}</span>
                  )}
                </div>
                {run.config_snapshot && (
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <Badge variant="outline" className="text-[9px]">
                      {(
                        run.config_snapshot.monitorMode ??
                        (run.config_snapshot as { testMode?: string })
                          .testMode ??
                        "health_check"
                      ).replace("_", " ")}
                    </Badge>
                    {run.config_snapshot.onFailure !== "none" && (
                      <Badge
                        variant="outline"
                        className="text-[9px] text-red-600"
                      >
                        on fail:{" "}
                        {run.config_snapshot.onFailure.replace(/_/g, " ")}
                      </Badge>
                    )}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
