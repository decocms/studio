/**
 * Log Row Component
 *
 * Displays a single monitoring log entry in the table.
 */

import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { Container } from "@untitledui/icons";
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
  virtualMcpIcon: string | null;
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
  virtualMcpIcon,
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
        <div className="font-medium text-foreground truncate block">
          {log.toolName}
        </div>
        <div className="text-muted-foreground truncate block text-xs">
          {log.connectionTitle}
        </div>
      </TableCell>

      {/* Agent */}
      <TableCell className="w-36 md:w-44 px-2 md:px-3 text-muted-foreground">
        {virtualMcpName ? (
          <div className="flex items-center gap-2 min-w-0">
            <IntegrationIcon
              icon={virtualMcpIcon}
              name={virtualMcpName}
              size="xs"
              fallbackIcon={<Container />}
              className="shrink-0 size-5! min-w-5! rounded-md"
            />
            <span className="truncate">{virtualMcpName}</span>
          </div>
        ) : (
          <span className="text-muted-foreground/40">—</span>
        )}
      </TableCell>

      {/* User Name */}
      <TableCell className="w-28 md:w-36 px-2 md:px-3 text-muted-foreground">
        <div className="flex items-center gap-2 min-w-0">
          <Avatar
            url={log.userImage}
            fallback={log.userName}
            shape="circle"
            size="2xs"
            className="shrink-0"
          />
          <span className="truncate">{log.userName}</span>
        </div>
      </TableCell>

      {/* Timestamp (date + time) */}
      <TableCell className="w-32 md:w-40 px-2 md:px-3 text-muted-foreground">
        <div>{dateStr}</div>
        <div className="text-xs text-muted-foreground/60">{timeStr}</div>
      </TableCell>

      {/* Duration */}
      <TableCell className="w-16 md:w-20 px-2 md:px-3 text-muted-foreground font-mono">
        {log.durationMs}ms
      </TableCell>

      {/* Status Badge */}
      <TableCell className="w-16 md:w-24 px-2 md:px-3 pr-3 md:pr-5">
        <div className="flex items-center justify-end">
          <Badge
            variant={log.isError ? "destructive" : "success"}
            className="px-1.5 md:px-2 py-0.5 md:py-1"
          >
            {log.isError ? "Error" : "OK"}
          </Badge>
        </div>
      </TableCell>
    </TableRow>
  );
}
