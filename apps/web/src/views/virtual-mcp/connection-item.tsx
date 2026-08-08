import { IntegrationIcon } from "@/components/integration-icon.tsx";
import { useMCPAuthStatus } from "@/hooks/use-mcp-auth-status";
import { getConnectionSlug } from "@decocms/shared/utils/connection-slug";
import { useT } from "@/i18n/use-t.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  type ConnectionEntity,
  useConnection,
  useConnectionActions,
  useConnections,
  useProjectContext,
} from "@/sdk";
import { Link } from "@tanstack/react-router";
import {
  Power01,
  Settings02,
  Settings04,
  SlashCircle01,
  XClose,
} from "@untitledui/icons";
import { Suspense } from "react";
import { toast } from "sonner";

const NEW_INSTANCE_VALUE = "__new_instance__";

/**
 * Connection Item - Card layout inspired by the reference design:
 * Body: icon + name + description (clickable → connection detail page)
 * Footer: instance selector + resources summary + edit (resource config) + remove
 */
export function ConnectionItem({
  connection_id,
  usedConnectionIds,
  onOpenSettings,
  onRemove,
  onAuthenticate,
  onSwitchInstance,
  onNewInstance,
}: {
  connection_id: string;
  usedConnectionIds: Set<string>;
  onOpenSettings: () => void;
  onRemove: () => void;
  onAuthenticate: (connectionId: string) => void;
  onSwitchInstance: (oldId: string, newId: string) => void;
  onNewInstance?: () => void;
}) {
  const connection = useConnection(connection_id);
  const { org } = useProjectContext();

  if (!connection) return null;

  const slug = getConnectionSlug(connection);

  return (
    <Suspense
      fallback={<ConnectionItemAuthFallback connection_id={connection_id} />}
    >
      <ConnectionItemWithAuth
        connection_id={connection_id}
        connectionTitle={connection.title}
        connectionDescription={connection.description}
        connectionIcon={connection.icon}
        connectionType={connection.connection_type}
        connectionStatus={connection.status}
        slug={slug}
        orgSlug={org.slug}
        appName={connection.app_name}
        usedConnectionIds={usedConnectionIds}
        onOpenSettings={onOpenSettings}
        onRemove={onRemove}
        onAuthenticate={onAuthenticate}
        onSwitchInstance={onSwitchInstance}
        onNewInstance={onNewInstance}
      />
    </Suspense>
  );
}

function SiblingInstanceSelector({
  appName,
  connectionId,
  usedConnectionIds,
  onSwitchInstance,
  onNewInstance,
}: {
  appName: string;
  connectionId: string;
  usedConnectionIds: Set<string>;
  onSwitchInstance: (oldId: string, newId: string) => void;
  onNewInstance?: () => void;
}) {
  const t = useT();
  const siblings = useConnections({
    filters: [{ column: "app_name", value: appName }],
  });

  if (siblings.length <= 1) return null;

  return (
    <Select
      value={connectionId}
      onValueChange={(newId) => {
        if (newId === NEW_INSTANCE_VALUE) {
          onNewInstance?.();
        } else {
          onSwitchInstance(connectionId, newId);
        }
      }}
    >
      <SelectTrigger
        size="sm"
        className="w-auto text-xs gap-1 px-2 shadow-none"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {siblings.map((s) => (
          <SelectItem
            key={s.id}
            value={s.id}
            className="text-xs"
            disabled={s.id !== connectionId && usedConnectionIds.has(s.id)}
          >
            {s.title}
          </SelectItem>
        ))}
        {onNewInstance && (
          <SelectItem
            value={NEW_INSTANCE_VALUE}
            className="text-xs text-muted-foreground"
          >
            + {t("virtualMcp.connectionItem.newInstance")}
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}

function ConnectionItemWithAuth({
  connection_id,
  connectionTitle,
  connectionDescription,
  connectionIcon,
  connectionType,
  connectionStatus,
  slug,
  orgSlug,
  appName,
  usedConnectionIds,
  onOpenSettings,
  onRemove,
  onAuthenticate,
  onSwitchInstance,
  onNewInstance,
}: {
  connection_id: string;
  connectionTitle: string;
  connectionDescription?: string | null;
  connectionIcon?: string | null;
  connectionType: string;
  connectionStatus: ConnectionEntity["status"];
  slug: string;
  orgSlug: string;
  appName?: string | null;
  usedConnectionIds: Set<string>;
  onOpenSettings: () => void;
  onRemove: () => void;
  onAuthenticate: (connectionId: string) => void;
  onSwitchInstance: (oldId: string, newId: string) => void;
  onNewInstance?: () => void;
}) {
  const authStatus = useMCPAuthStatus({ connectionId: connection_id });
  const connectionActions = useConnectionActions();
  const isVirtual = connectionType === "VIRTUAL";
  const needsAuth =
    !isVirtual && authStatus.supportsOAuth && !authStatus.isAuthenticated;
  const isDisabled = connectionStatus !== "active";

  const t = useT();

  const toggleStatus = async (status: "active" | "inactive") => {
    try {
      await connectionActions.update.mutateAsync({
        id: connection_id,
        data: { status },
      });
      toast.success(
        status === "active"
          ? t("virtualMcp.connectionItem.connectionEnabled")
          : t("virtualMcp.connectionItem.connectionDisabled"),
      );
    } catch {
      toast.error(t("virtualMcp.connectionItem.failedToUpdateConnection"));
    }
  };

  return (
    <div
      className={cn(
        "rounded-xl border overflow-hidden transition-colors",
        needsAuth || isDisabled
          ? "border-destructive/50 bg-destructive/5"
          : "border-border bg-card",
      )}
    >
      {/* Body — clickable, navigates to connection detail */}
      <Link
        to="/$org/settings/connections/$appSlug"
        params={{
          org: orgSlug,
          appSlug: slug,
        }}
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/50 transition-colors"
      >
        <IntegrationIcon
          icon={connectionIcon}
          name={connectionTitle}
          size="sm"
          className="shrink-0"
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{connectionTitle}</p>
          {needsAuth ? (
            <span className="text-xs text-destructive font-medium">
              {t("virtualMcp.connectionItem.needsAuthorization")}
            </span>
          ) : isDisabled ? (
            <span className="text-xs text-destructive font-medium">
              {connectionStatus === "error"
                ? t("virtualMcp.connectionItem.disabledError")
                : t("virtualMcp.connectionItem.disabled")}
            </span>
          ) : (
            connectionDescription && (
              <p className="text-xs text-muted-foreground truncate">
                {connectionDescription}
              </p>
            )
          )}
        </div>
        {needsAuth ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs shrink-0"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onAuthenticate(connection_id);
            }}
          >
            {t("virtualMcp.connectionItem.authorize")}
          </Button>
        ) : isDisabled ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1.5 shrink-0"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              toggleStatus("active");
            }}
          >
            <Power01 size={13} />
            {t("virtualMcp.connectionItem.enable")}
          </Button>
        ) : (
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center justify-center rounded-md h-7 w-7 hover:bg-accent text-muted-foreground shrink-0 transition-colors">
                <Settings02 size={16} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t("virtualMcp.connectionItem.connectionSettings")}
            </TooltipContent>
          </Tooltip>
        )}
      </Link>

      {/* Footer — instance selector + resources summary + edit + remove */}
      <div className="flex items-center gap-3 px-4 py-2 border-t border-border bg-muted/25">
        {/* Instance selector */}
        {appName && (
          <SiblingInstanceSelector
            appName={appName}
            connectionId={connection_id}
            usedConnectionIds={usedConnectionIds}
            onSwitchInstance={onSwitchInstance}
            onNewInstance={onNewInstance}
          />
        )}

        <div className="flex items-center gap-0.5 ml-auto">
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={onOpenSettings}
                aria-label={t("virtualMcp.connectionItem.configureResources")}
              >
                <Settings04 size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t("virtualMcp.connectionItem.configureResources")}
            </TooltipContent>
          </Tooltip>
          {!isDisabled && (
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground"
                  onClick={() => toggleStatus("inactive")}
                  aria-label={t("virtualMcp.connectionItem.disableConnection")}
                >
                  <SlashCircle01 size={13} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t("virtualMcp.connectionItem.disable")}
              </TooltipContent>
            </Tooltip>
          )}
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                onClick={onRemove}
                aria-label={t("virtualMcp.connectionItem.removeConnection")}
              >
                <XClose size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t("virtualMcp.connectionItem.remove")}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

function ConnectionItemAuthFallback({
  connection_id,
}: {
  connection_id: string;
}) {
  const connection = useConnection(connection_id);
  if (!connection) return <ConnectionItemSkeleton />;

  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <IntegrationIcon
          icon={connection.icon}
          name={connection.title}
          size="sm"
          className="shrink-0"
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{connection.title}</p>
          {connection.description && (
            <p className="text-xs text-muted-foreground truncate">
              {connection.description}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center px-4 py-2 border-t border-border bg-muted/25">
        <div className="h-5 w-20 rounded bg-muted animate-pulse" />
      </div>
    </div>
  );
}

export function ConnectionItemSkeleton() {
  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="size-8 rounded-md bg-muted animate-pulse shrink-0" />
        <div className="flex-1 space-y-1.5">
          <div className="h-4 w-32 rounded bg-muted animate-pulse" />
          <div className="h-3 w-48 rounded bg-muted animate-pulse" />
        </div>
      </div>
      <div className="flex items-center px-4 py-2 border-t border-border bg-muted/25">
        <div className="h-5 w-20 rounded bg-muted animate-pulse" />
      </div>
    </div>
  );
}
