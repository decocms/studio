import { useState } from "react";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Card } from "@deco/ui/components/card.tsx";
import type { MonitorResult } from "@/lib/registry/types";
import { cn } from "@deco/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";

export function BrokenMCPList({ results }: { results: MonitorResult[] }) {
  const t = useT();
  if (results.length === 0) {
    return (
      <Card className="p-4 text-sm text-muted-foreground text-center">
        {t("registry.brokenMcpList.noBrokenMcps")}
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {results.map((result) => (
        <BrokenMCPCard key={result.id} result={result} />
      ))}
    </div>
  );
}

function BrokenMCPCard({ result }: { result: MonitorResult }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const failedTools = result.tool_results.filter((r) => !r.success);

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        className="w-full text-left p-3 flex items-start gap-3 hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-destructive text-sm mt-0.5">✗</span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-medium truncate">
              {result.item_title}
            </h4>
            <Badge
              variant="destructive"
              className="capitalize text-[10px] shrink-0"
            >
              {result.status.replace("_", " ")}
            </Badge>
          </div>

          {/* Quick summary line */}
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground flex-wrap">
            <span>
              {t("registry.brokenMcpList.connStatus")}:{" "}
              {result.connection_ok ? "✓" : "✗"}
            </span>
            <span>
              {t("registry.brokenMcpList.toolsListed")}:{" "}
              {result.tools_listed ? "✓" : "✗"}
            </span>
            <span>{result.duration_ms}ms</span>
            {failedTools.length > 0 && (
              <span className="text-destructive">
                {t("registry.brokenMcpList.toolsFailed", {
                  count: failedTools.length,
                })}
              </span>
            )}
            {result.action_taken !== "none" && (
              <Badge variant="destructive" className="text-[9px] px-1.5 py-0">
                {result.action_taken.replace(/_/g, " ")}
              </Badge>
            )}
          </div>

          {/* Error message preview */}
          {result.error_message && (
            <p className="text-xs text-destructive line-clamp-2">
              {result.error_message}
            </p>
          )}
        </div>
        <span className="text-[10px] text-muted-foreground shrink-0 mt-1">
          {expanded ? "▲" : "▼"}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border p-3 space-y-2 bg-muted/10">
          {/* Full error message */}
          {result.error_message && (
            <div className="space-y-0.5">
              <p className="text-[10px] font-semibold text-destructive">
                {t("registry.brokenMcpList.fullError")}
              </p>
              <pre className="text-[11px] bg-destructive/5 border border-destructive/10 rounded px-2.5 py-1.5 whitespace-pre-wrap break-all text-destructive">
                {result.error_message}
              </pre>
            </div>
          )}

          {/* Connection / tools status */}
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded border border-border px-2 py-1.5">
              <p className="text-[10px] text-muted-foreground">
                {t("registry.brokenMcpList.connectionLabel")}
              </p>
              <p
                className={cn(
                  "text-xs font-medium",
                  result.connection_ok ? "text-success" : "text-destructive",
                )}
              >
                {result.connection_ok
                  ? t("registry.brokenMcpList.statusOk")
                  : t("registry.brokenMcpList.statusFailed")}
              </p>
            </div>
            <div className="rounded border border-border px-2 py-1.5">
              <p className="text-[10px] text-muted-foreground">
                {t("registry.brokenMcpList.toolsListedLabel")}
              </p>
              <p
                className={cn(
                  "text-xs font-medium",
                  result.tools_listed ? "text-success" : "text-destructive",
                )}
              >
                {result.tools_listed
                  ? t("registry.brokenMcpList.yes")
                  : t("registry.brokenMcpList.no")}
              </p>
            </div>
            <div className="rounded border border-border px-2 py-1.5">
              <p className="text-[10px] text-muted-foreground">
                {t("registry.brokenMcpList.durationLabel")}
              </p>
              <p className="text-xs font-medium">{result.duration_ms}ms</p>
            </div>
          </div>

          {/* Failed tool details */}
          {failedTools.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] font-semibold text-destructive">
                {t("registry.brokenMcpList.failedToolsHeader", {
                  count: failedTools.length,
                })}
              </p>
              {failedTools.map((tool) => (
                <div
                  key={`${result.id}-${tool.toolName}`}
                  className="rounded border border-destructive/10 bg-destructive/5 px-2.5 py-1.5 space-y-1"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono font-medium text-destructive">
                      {tool.toolName}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {tool.durationMs}ms
                    </span>
                  </div>
                  {tool.error && (
                    <pre className="text-[11px] whitespace-pre-wrap break-all text-destructive">
                      {tool.error}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* All tools (passed) */}
          {result.tool_results.length > 0 &&
            result.tool_results.some((r) => r.success) && (
              <div className="space-y-0.5">
                <p className="text-[10px] font-semibold text-muted-foreground">
                  {t("registry.brokenMcpList.passingTools")}
                </p>
                <div className="flex flex-wrap gap-1">
                  {result.tool_results
                    .filter((r) => r.success)
                    .map((tool) => (
                      <Badge
                        key={`${result.id}-${tool.toolName}-pass`}
                        variant="secondary"
                        className="text-[10px]"
                      >
                        ✓ {tool.toolName}
                      </Badge>
                    ))}
                </div>
              </div>
            )}
        </div>
      )}
    </Card>
  );
}
