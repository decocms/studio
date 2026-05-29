import { Suspense } from "react";
import { Link } from "@tanstack/react-router";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { XClose } from "@untitledui/icons";
import { useConnection } from "@decocms/mesh-sdk";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { getConnectionSlug } from "@/shared/utils/connection-slug";
import { useResolveConnectionForUser } from "@/web/hooks/use-resolve-connection-for-user";
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
 * Renders one typed slot in the agent settings connections list. Resolves the
 * slot's app_id to the caller's own connection: resolved slots render like a
 * concrete connection (violet-tinted), unresolved slots show a Connect link.
 */
export function SlotItem({
  slotAppId,
  orgId,
  orgSlug,
  onRemove,
}: {
  slotAppId: string;
  orgId: string;
  orgSlug: string;
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
        onRemove={onRemove}
      />
    </Suspense>
  );
}

function SlotItemInner({
  slotAppId,
  resolvedId,
  orgSlug,
  onRemove,
}: {
  slotAppId: string;
  resolvedId: string | null;
  orgSlug: string;
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
            className="shrink-0"
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{display.title}</p>
            <p className="text-xs text-muted-foreground truncate">
              Resolves to your connection
            </p>
          </div>
          <Badge variant="special" className="shrink-0">
            Personal
          </Badge>
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
          <Badge variant="special" className="shrink-0">
            Personal
          </Badge>
          <Button
            asChild
            variant="outline"
            size="sm"
            className="h-7 text-xs shrink-0"
          >
            <Link to="/$org/settings/connections" params={{ org: orgSlug }}>
              Connect
            </Link>
          </Button>
        </div>
      )}

      <div className="flex items-center gap-3 px-4 py-2 border-t border-special/30 bg-special/5">
        <div className="flex items-center gap-0.5 ml-auto">
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
