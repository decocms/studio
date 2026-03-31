import { useState } from "react";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Card } from "@deco/ui/components/card.tsx";
import type { MonitorResult } from "@/web/lib/registry/types";
import { cn } from "@deco/ui/lib/utils.ts";

export function BrokenMCPList({ results }: { results: MonitorResult[] }) {
  if (results.length === 0) {
    return (
      <Card className="p-4 text-sm text-muted-foreground text-center">
        No broken MCPs in this run. All healthy! ✓
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
  const [expanded, setExpanded] = useState(false);
  const failedTools = result.tool_results.filter((t) => !t.success);

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        className="w-full text-left p-3 flex items-start gap-3 hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-red-500 text-sm mt-0.5">✗</span>
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
            <span>conn: {result.connection_ok ? "✓" : "✗"}</span>
            <span>tools listed: {result.tools_listed ? "✓" : "✗"}</span>
            <span>{result.duration_ms}ms</span>
            {failedTools.length > 0 && (
              <span className="text-red-600">
                {failedTools.length} tool{failedTools.length > 1 ? "s" : ""}{" "}
                failed
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
            <p className="text-xs text-red-600 line-clamp-2">
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
              <p className="text-[10px] font-semibold text-red-600">
                Full Error
              </p>
              <pre className="text-[11px] bg-red-500/5 border border-red-500/10 rounded px-2.5 py-1.5 whitespace-pre-wrap break-all text-red-700">
                {result.error_message}
              </pre>
            </div>
          )}

          {/* Connection / tools status */}
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded border border-border px-2 py-1.5">
              <p className="text-[10px] text-muted-foreground">Connection</p>
              <p
                className={cn(
                  "text-xs font-medium",
                  result.connection_ok ? "text-emerald-600" : "text-red-600",
                )}
              >
                {result.connection_ok ? "OK" : "Failed"}
              </p>
            </div>
            <div className="rounded border border-border px-2 py-1.5">
              <p className="text-[10px] text-muted-foreground">Tools Listed</p>
              <p
                className={cn(
                  "text-xs font-medium",
                  result.tools_listed ? "text-emerald-600" : "text-red-600",
                )}
              >
                {result.tools_listed ? "Yes" : "No"}
              </p>
            </div>
            <div className="rounded border border-border px-2 py-1.5">
              <p className="text-[10px] text-muted-foreground">Duration</p>
              <p className="text-xs font-medium">{result.duration_ms}ms</p>
            </div>
          </div>

          {/* Failed tool details */}
          {failedTools.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] font-semibold text-red-600">
                Failed Tools ({failedTools.length})
              </p>
              {failedTools.map((tool) => (
                <div
                  key={`${result.id}-${tool.toolName}`}
                  className="rounded border border-red-500/10 bg-red-500/5 px-2.5 py-1.5 space-y-1"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono font-medium text-red-700">
                      {tool.toolName}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {tool.durationMs}ms
                    </span>
                  </div>
                  {tool.error && (
                    <pre className="text-[11px] whitespace-pre-wrap break-all text-red-600">
                      {tool.error}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* All tools (passed) */}
          {result.tool_results.length > 0 &&
            result.tool_results.some((t) => t.success) && (
              <div className="space-y-0.5">
                <p className="text-[10px] font-semibold text-muted-foreground">
                  Passing Tools
                </p>
                <div className="flex flex-wrap gap-1">
                  {result.tool_results
                    .filter((t) => t.success)
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
