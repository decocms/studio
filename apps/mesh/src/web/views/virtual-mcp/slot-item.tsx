import { Suspense } from "react";
import { Link } from "@tanstack/react-router";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Settings02, XClose } from "@untitledui/icons";
import { useConnection } from "@decocms/mesh-sdk";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { getConnectionSlug } from "@/shared/utils/connection-slug";
import { useResolveConnectionForUser } from "@/web/hooks/use-resolve-connection-for-user";
import { EnableToggle } from "./enable-toggle";
import { slotDisplayState } from "./slot-display";

function SlotItemSkeleton() {
  return (
    <div className="rounded-xl border border-special/50 bg-special/5 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="size-8 rounded-md bg-muted animate-pulse shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="h-4 w-24 bg-muted rounded animate-pulse" />
        </div>
      </div>
    </div>
  );
}

/**
 * Renders one typed slot in the agent settings connections list. Mirrors the
 * concrete connection card — same body + footer layout — differing only in the
 * violet `special` tint and the inline "Personal" pill. Resolves the slot's
 * app_id to the caller's own connection: resolved slots get an enable/disable
 * switch (matching concrete cards). Settings is only reachable once every slot
 * resolves (the agent-view connect gate handles connecting), so the unresolved
 * branch is a defensive "not connected" fallback with only a remove action.
 */
export function SlotItem({
  slotAppId,
  orgId,
  orgSlug,
  enabled,
  onToggleEnabled,
  onRemove,
}: {
  slotAppId: string;
  orgId: string;
  orgSlug: string;
  enabled: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  const resolveQuery = useResolveConnectionForUser(orgId, orgSlug, slotAppId);
  if (resolveQuery.isLoading) return <SlotItemSkeleton />;
  const resolvedId = resolveQuery.data?.connectionId ?? null;
  return (
    <Suspense fallback={<SlotItemSkeleton />}>
      <SlotItemInner
        slotAppId={slotAppId}
        resolvedId={resolvedId}
        orgSlug={orgSlug}
        enabled={enabled}
        onToggleEnabled={onToggleEnabled}
        onRemove={onRemove}
      />
    </Suspense>
  );
}

function SlotItemInner({
  slotAppId,
  resolvedId,
  orgSlug,
  enabled,
  onToggleEnabled,
  onRemove,
}: {
  slotAppId: string;
  resolvedId: string | null;
  orgSlug: string;
  enabled: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  // useConnection tolerates undefined (returns null without suspending); when a
  // resolvedId is present it suspends until loaded (caught by the parent).
  const connection = useConnection(resolvedId ?? undefined);
  const resolved =
    resolvedId && connection
      ? { title: connection.title, icon: connection.icon }
      : null;
  const display = slotDisplayState(slotAppId, resolved);
  const detailSlug = connection ? getConnectionSlug(connection) : null;
  const isResolved = display.state === "resolved" && detailSlug !== null;

  return (
    <div className="rounded-xl border border-special/50 bg-special/5 overflow-hidden transition-colors">
      {isResolved ? (
        <Link
          to="/$org/settings/connections/$appSlug"
          params={{ org: orgSlug, appSlug: detailSlug! }}
          className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/50 transition-colors"
        >
          <IntegrationIcon
            icon={display.icon}
            name={display.title}
            size="sm"
            className={cn("shrink-0", !enabled && "opacity-50")}
          />
          <div className={cn("flex-1 min-w-0", !enabled && "opacity-50")}>
            <p className="text-sm font-medium truncate">{display.title}</p>
            {connection?.description && (
              <p className="text-xs text-muted-foreground truncate">
                {connection.description}
              </p>
            )}
          </div>
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center justify-center rounded-md h-7 w-7 hover:bg-accent text-muted-foreground shrink-0 transition-colors">
                <Settings02 size={16} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">Connection settings</TooltipContent>
          </Tooltip>
        </Link>
      ) : (
        <div className="flex items-center gap-3 px-4 py-3">
          <IntegrationIcon
            icon={display.icon}
            name={display.title}
            size="sm"
            className="shrink-0"
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{display.title}</p>
            <p className="text-xs text-muted-foreground truncate">
              Not connected for you
            </p>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 px-4 py-2 border-t border-special/30 bg-special/5">
        <Badge variant="outline" className="shrink-0 text-special">
          Personal
        </Badge>
        <div className="flex items-center gap-2 ml-auto">
          {isResolved && (
            <EnableToggle enabled={enabled} onToggle={onToggleEnabled} />
          )}
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                onClick={onRemove}
                aria-label="Remove slot"
              >
                <XClose size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Remove</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
