"use client";

import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { useConnection } from "@decocms/mesh-sdk";
import { cn } from "@deco/ui/lib/utils.ts";
import { Suspense } from "react";

interface AgentConnectionsPreviewProps {
  connectionIds: string[];
  maxVisibleIcons?: number;
  iconSize?: "xs" | "sm";
  className?: string;
}

function ConnectionIconPreview({
  connection_id,
  iconSize = "xs",
}: {
  connection_id: string;
  iconSize?: "xs" | "sm";
}) {
  const connection = useConnection(connection_id);

  if (!connection) return null;

  return (
    <div className="shrink-0 bg-background ring-1 ring-background rounded-lg">
      <IntegrationIcon
        icon={connection.icon}
        name={connection.title}
        size={iconSize}
      />
    </div>
  );
}

ConnectionIconPreview.Fallback = function ConnectionIconPreviewFallback({
  iconSize = "xs",
}: {
  iconSize?: "xs" | "sm";
}) {
  const sizeClass = iconSize === "sm" ? "size-6" : "size-5";
  return (
    <div className="shrink-0 bg-background ring-1 ring-background rounded-lg">
      <div className={cn(sizeClass, "rounded bg-muted animate-pulse")} />
    </div>
  );
};

export function AgentConnectionsPreview({
  connectionIds,
  maxVisibleIcons = 2,
  iconSize = "xs",
  className,
}: AgentConnectionsPreviewProps) {
  if (connectionIds.length === 0) {
    return null;
  }

  const visibleIds = connectionIds.slice(0, maxVisibleIcons);
  const remainingCount = connectionIds.length - maxVisibleIcons;

  return (
    <div className={cn("flex items-center justify-end -space-x-2", className)}>
      {visibleIds.map((id) => (
        <Suspense
          key={id}
          fallback={<ConnectionIconPreview.Fallback iconSize={iconSize} />}
        >
          <ConnectionIconPreview connection_id={id} iconSize={iconSize} />
        </Suspense>
      ))}
      {remainingCount > 0 && (
        <div
          className={cn(
            "shrink-0 bg-background ring-1 ring-background border border-border rounded-lg flex items-center justify-center",
            iconSize === "sm" ? "size-8" : "size-6",
          )}
        >
          <span
            className={cn(
              iconSize === "sm" ? "text-sm" : "text-xs",
              "font-medium text-muted-foreground",
            )}
            aria-label={`and ${remainingCount} more`}
          >
            +{remainingCount}
          </span>
        </div>
      )}
    </div>
  );
}

AgentConnectionsPreview.Fallback = function AgentConnectionsPreviewFallback({
  maxVisibleIcons = 2,
  totalCount,
  iconSize = "xs",
}: {
  maxVisibleIcons?: number;
  /** When provided, mirrors the real component's overflow badge logic. */
  totalCount?: number;
  iconSize?: "xs" | "sm";
}) {
  const sizeClass = iconSize === "sm" ? "size-6" : "size-5";
  const badgeSizeClass = iconSize === "sm" ? "size-8" : "size-6";
  const showOverflow = totalCount !== undefined && totalCount > maxVisibleIcons;
  return (
    <div className="flex items-center -space-x-2">
      {Array.from({ length: maxVisibleIcons }).map((_, i) => (
        <div
          key={i}
          className="shrink-0 bg-background ring-1 ring-background rounded-lg"
        >
          <div className={cn(sizeClass, "rounded bg-muted animate-pulse")} />
        </div>
      ))}
      {showOverflow && (
        <div
          className={cn(
            "shrink-0 bg-background ring-1 ring-background border border-border rounded-lg flex items-center justify-center",
            badgeSizeClass,
          )}
        >
          <div
            className={cn(
              iconSize === "sm" ? "h-3.5 w-5" : "h-3 w-4",
              "rounded bg-muted animate-pulse",
            )}
          />
        </div>
      )}
    </div>
  );
};
