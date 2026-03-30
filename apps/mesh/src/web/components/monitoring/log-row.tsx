/**
 * Log Row Component
 *
 * Displays a single monitoring log entry in the table.
 */

import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { Badge } from "@deco/ui/components/badge.tsx";
import type { EnrichedMonitoringLog } from "./types.tsx";
import { TableCell, TableRow } from "@deco/ui/components/table.tsx";

// ============================================================================
// Types
// ============================================================================

interface Connection {
  id: string;
  icon?: string | null;
  title?: string;
}

interface LogRowProps {
  log: EnrichedMonitoringLog;
  connection: Connection | undefined;
  virtualMcpName: string;
  onClick: () => void;
  lastLogRef?: (node: HTMLTableRowElement | null) => void;
}

// ============================================================================
// Component
// ============================================================================

export function LogRow({
  log,
  connection,
  virtualMcpName,
  onClick,
  lastLogRef,
}: LogRowProps) {
  const timestamp = new Date(log.timestamp);
  const dateStr = timestamp.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const timeStr = timestamp.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return (
    <TableRow
      ref={lastLogRef}
      className="h-14 md:h-16 transition-colors cursor-pointer hover:bg-muted/40"
      onClick={onClick}
    >
      {/* Connection Icon */}
      <TableCell className="w-12 md:w-16 px-2 md:px-4">
        <div className="flex items-center justify-center">
          <IntegrationIcon
            icon={connection?.icon || null}
            name={log.connectionTitle}
            size="xs"
            className="shadow-sm"
          />
        </div>
      </TableCell>

      {/* Tool Name + Connection Name */}
      <TableCell className="min-w-0 pr-2 md:pr-4">
        <div className="text-xs font-medium text-foreground truncate block">
          {log.toolName}
        </div>
        <div className="text-xs text-muted-foreground truncate block">
          {log.connectionTitle}
        </div>
      </TableCell>

      {/* Agent */}
      <TableCell className="w-24 md:w-32 px-2 md:px-3 text-xs text-muted-foreground">
        <div className="truncate">{virtualMcpName}</div>
      </TableCell>

      {/* User Name */}
      <TableCell className="w-20 md:w-24 px-2 md:px-3 text-xs text-muted-foreground">
        {log.userName}
      </TableCell>

      {/* Date */}
      <TableCell className="w-20 md:w-24 px-2 md:px-3 text-xs text-muted-foreground">
        {dateStr}
      </TableCell>

      {/* Time */}
      <TableCell className="w-20 md:w-28 px-2 md:px-3 text-xs text-muted-foreground">
        {timeStr}
      </TableCell>

      {/* Duration */}
      <TableCell className="w-16 md:w-20 px-2 md:px-3 text-xs text-muted-foreground font-mono text-right">
        {log.durationMs}ms
      </TableCell>

      {/* Status Badge */}
      <TableCell className="w-16 md:w-24 px-2 md:px-3 pr-3 md:pr-5">
        <div className="flex items-center justify-end">
          <Badge
            variant={log.isError ? "destructive" : "success"}
            className="text-xs px-1.5 md:px-2 py-0.5 md:py-1"
          >
            {log.isError ? "Error" : "OK"}
          </Badge>
        </div>
      </TableCell>
    </TableRow>
  );
}
