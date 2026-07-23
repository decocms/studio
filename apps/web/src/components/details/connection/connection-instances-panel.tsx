import { useMCPAuthStatus } from "@/hooks/use-mcp-auth-status";
import { IntegrationIcon } from "@/components/integration-icon.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Button } from "@deco/ui/components/button.tsx";
import type { ConnectionEntity } from "@/sdk";
import {
  Loading01,
  Plus,
  Power01,
  Settings02,
  SlashCircle01,
  Trash01,
} from "@untitledui/icons";
import { Suspense } from "react";
import { useT } from "@/i18n/use-t.ts";

interface ConnectionInstancesPanelProps {
  instances: ConnectionEntity[];
  onConfigure: (instance: ConnectionEntity) => void;
  onAuthenticate: (instance: ConnectionEntity) => void;
  onDelete: (instance: ConnectionEntity) => void;
  onToggleStatus: (
    instance: ConnectionEntity,
    status: "active" | "inactive",
  ) => void;
  onAdd: () => void;
  isAdding?: boolean;
}

function InstanceItem({
  instance,
  onConfigure,
  onAuthenticate,
  onDelete,
  onToggleStatus,
}: {
  instance: ConnectionEntity;
  onConfigure: (instance: ConnectionEntity) => void;
  onAuthenticate: (instance: ConnectionEntity) => void;
  onDelete: (instance: ConnectionEntity) => void;
  onToggleStatus: (
    instance: ConnectionEntity,
    status: "active" | "inactive",
  ) => void;
}) {
  const t = useT();
  const authStatus = useMCPAuthStatus({ connectionId: instance.id });
  const isVirtual = instance.connection_type === "VIRTUAL";
  const needsAuth =
    !isVirtual && authStatus.supportsOAuth && !authStatus.isAuthenticated;
  const isDisabled = instance.status !== "active";

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border px-4 py-2.5 transition-colors",
        needsAuth || isDisabled
          ? "border-destructive/50 bg-destructive/5"
          : "border-transparent",
      )}
    >
      <IntegrationIcon
        icon={instance.icon}
        name={instance.title}
        size="xs"
        className="shrink-0"
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{instance.title}</p>
        {needsAuth ? (
          <span className="text-xs text-destructive font-medium">
            {t("details.connectionInstancesPanel.needsAuthorization")}
          </span>
        ) : isDisabled ? (
          <span className="text-xs text-destructive font-medium">
            {instance.status === "error"
              ? t("details.connectionInstancesPanel.disabledError")
              : t("details.connectionInstancesPanel.disabled")}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {needsAuth && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => onAuthenticate(instance)}
          >
            {t("details.connectionInstancesPanel.authorize")}
          </Button>
        )}
        {isDisabled ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1.5"
            onClick={() => onToggleStatus(instance, "active")}
          >
            <Power01 size={13} />
            {t("details.connectionInstancesPanel.enable")}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground"
            onClick={() => onToggleStatus(instance, "inactive")}
            title={t("details.connectionInstancesPanel.disable")}
            aria-label={t("details.connectionInstancesPanel.disable")}
          >
            <SlashCircle01 size={13} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => onConfigure(instance)}
          title={t("details.connectionInstancesPanel.configure")}
          aria-label={t("details.connectionInstancesPanel.configure")}
        >
          <Settings02 size={13} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
          onClick={() => onDelete(instance)}
          title={t("details.connectionInstancesPanel.delete")}
          aria-label={t("details.connectionInstancesPanel.delete")}
        >
          <Trash01 size={13} />
        </Button>
      </div>
    </div>
  );
}

function InstanceItemFallback({
  instance,
  onConfigure,
}: {
  instance: ConnectionEntity;
  onConfigure: (instance: ConnectionEntity) => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-3 rounded-lg border border-transparent px-4 py-2.5 transition-colors">
      <IntegrationIcon
        icon={instance.icon}
        name={instance.title}
        size="xs"
        className="shrink-0"
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{instance.title}</p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => onConfigure(instance)}
          title={t("details.connectionInstancesPanel.configure")}
          aria-label={t("details.connectionInstancesPanel.configure")}
        >
          <Settings02 size={13} />
        </Button>
      </div>
    </div>
  );
}

export function ConnectionInstancesPanel({
  instances,
  onConfigure,
  onAuthenticate,
  onDelete,
  onToggleStatus,
  onAdd,
  isAdding,
}: ConnectionInstancesPanelProps) {
  const t = useT();
  if (instances.length === 0) return null;
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">
          {instances.length === 1
            ? t("details.connectionInstancesPanel.instance")
            : t("details.connectionInstancesPanel.instances")}
        </h3>
        <Button
          variant="default"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={onAdd}
          disabled={isAdding}
        >
          {isAdding ? (
            <Loading01 size={13} className="animate-spin" />
          ) : (
            <Plus size={13} />
          )}
          {t("details.connectionInstancesPanel.addInstance")}
        </Button>
      </div>
      <div className="p-2 flex flex-col gap-1">
        {instances.map((instance) => (
          <Suspense
            key={instance.id}
            fallback={
              <InstanceItemFallback
                instance={instance}
                onConfigure={onConfigure}
              />
            }
          >
            <InstanceItem
              instance={instance}
              onConfigure={onConfigure}
              onAuthenticate={onAuthenticate}
              onDelete={onDelete}
              onToggleStatus={onToggleStatus}
            />
          </Suspense>
        ))}
      </div>
    </div>
  );
}
