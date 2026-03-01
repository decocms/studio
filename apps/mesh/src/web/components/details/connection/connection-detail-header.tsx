import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { ConnectionStatus } from "@/web/components/connections/connection-status.tsx";
import type { ConnectionEntity } from "@decocms/mesh-sdk";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Settings01 } from "@untitledui/icons";

interface ConnectionDetailHeaderProps {
  connection: ConnectionEntity;
  onOpenSettings: () => void;
  onDisconnect: () => void;
}

export function ConnectionDetailHeader({
  connection,
  onOpenSettings,
  onDisconnect,
}: ConnectionDetailHeaderProps) {
  return (
    <div className="flex items-start gap-5 py-6 px-8 bg-background border-b border-border shrink-0">
      <IntegrationIcon
        icon={connection.icon}
        name={connection.title}
        size="xl"
        className="shrink-0"
      />
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2 mb-1.5">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {connection.title}
          </h1>
          {connection.app_name && (
            <Badge variant="secondary" className="font-normal text-xs">
              {connection.app_name}
            </Badge>
          )}
          <ConnectionStatus status={connection.status} />
        </div>
        {connection.description && (
          <p className="text-sm text-muted-foreground leading-relaxed">
            {connection.description}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0 pt-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={onOpenSettings}
          title="Configure connection"
          className="h-8 w-8"
        >
          <Settings01 size={16} />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onDisconnect}
          className="text-destructive border-destructive/30 hover:bg-destructive/5 hover:text-destructive"
        >
          Disconnect
        </Button>
      </div>
    </div>
  );
}
