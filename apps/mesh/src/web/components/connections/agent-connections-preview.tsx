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

/**
 * Connection Icon Preview Component - Shows a single connection icon
 */
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

/**
 * Connection Icon Preview Fallback Component - Shows loading state while connection loads
 */
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

/**
 * Agent Connections Preview Component
 *
 * Displays up to maxVisibleIcons connection icons, and if there are more,
 * shows a "+{n-maxVisibleIcons}" badge styled as an icon.
 */
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
      {/* Visible icons with overlapping */}
      {visibleIds.map((id) => (
        <Suspense
          key={id}
          fallback={<ConnectionIconPreview.Fallback iconSize={iconSize} />}
        >
          <ConnectionIconPreview connection_id={id} iconSize={iconSize} />
        </Suspense>
      ))}

      {/* "+{n}" badge styled as an icon for remaining connections */}
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
          >
            +{remainingCount}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Fallback component for loading state
 */
AgentConnectionsPreview.Fallback = function AgentConnectionsPreviewFallback({
  maxVisibleIcons = 2,
  iconSize = "xs",
}: {
  maxVisibleIcons?: number;
  iconSize?: "xs" | "sm";
}) {
  const sizeClass = iconSize === "sm" ? "size-6" : "size-5";
  const badgeSizeClass = iconSize === "sm" ? "size-8" : "size-6";
  return (
    <div className="flex items-center -space-x-2">
      {Array.from({ length: Math.min(maxVisibleIcons, 2) }).map((_, i) => (
        <div
          key={i}
          className="shrink-0 bg-background ring-1 ring-background rounded-lg"
        >
          <div className={cn(sizeClass, "rounded bg-muted animate-pulse")} />
        </div>
      ))}
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
    </div>
  );
};
