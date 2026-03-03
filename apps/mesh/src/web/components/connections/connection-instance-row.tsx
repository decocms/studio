import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import type { ConnectionEntity } from "@decocms/mesh-sdk";
import { ChevronRight } from "@untitledui/icons";
import { User } from "@/web/components/user/user.tsx";

type StatusValue = "active" | "error" | "inactive";

function StatusDot({ status }: { status: StatusValue }) {
  if (status === "active") {
    return (
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="size-1.5 rounded-full bg-emerald-500 shrink-0" />
        <span className="text-xs text-emerald-600">Connected</span>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="size-1.5 rounded-full bg-destructive shrink-0" />
        <span className="text-xs text-destructive">Error</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <span className="size-1.5 rounded-full bg-muted-foreground/30 shrink-0" />
      <span className="text-xs text-muted-foreground">Inactive</span>
    </div>
  );
}

export interface ConnectionInstanceRowProps {
  connection: ConnectionEntity;
  onClick: () => void;
  /** Show the integration icon — used for solo connections that render without an accordion header */
  showIcon?: boolean;
}

export function ConnectionInstanceRow({
  connection,
  onClick,
  showIcon = false,
}: ConnectionInstanceRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group w-full flex items-center gap-3 px-4 py-3.5 text-left",
        "border-b border-border last:border-b-0",
        "hover:bg-muted/40 transition-colors",
      )}
    >
      {showIcon && (
        <IntegrationIcon
          icon={connection.icon}
          name={connection.title}
          size="sm"
          className="shrink-0"
        />
      )}

      {/* Title and description */}
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-sm font-medium text-foreground truncate">
          {connection.title}
        </span>
        {connection.description && (
          <span className="text-xs text-muted-foreground truncate mt-0.5">
            {connection.description}
          </span>
        )}
      </div>

      {/* Status indicator */}
      <StatusDot status={connection.status} />

      {/* Creator avatar */}
      <User id={connection.created_by} size="xs" />

      {/* Chevron */}
      <ChevronRight
        size={14}
        className="text-muted-foreground/40 group-hover:text-muted-foreground transition-colors shrink-0"
      />
    </button>
  );
}
