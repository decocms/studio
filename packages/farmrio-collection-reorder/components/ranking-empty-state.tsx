/**
 * Plugin Empty State Component
 *
 * Shown when no report-compatible connections are available.
 */

import { BarChart01 } from "@untitledui/icons";

export default function RankingEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full p-8">
      <BarChart01 size={48} className="text-muted-foreground mb-4" />
      <h3 className="text-lg font-medium mb-2">No report source connected</h3>
      <p className="text-muted-foreground text-center max-w-md">
        Connect an MCP server that provides reports to view collection reorder
        ranking insights.
      </p>
    </div>
  );
}
