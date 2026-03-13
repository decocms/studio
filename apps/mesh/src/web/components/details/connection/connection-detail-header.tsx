import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import type { ConnectionEntity } from "@decocms/mesh-sdk";
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
    <div className="flex items-center gap-6 py-7 px-8 bg-background border-b border-border shrink-0">
      <IntegrationIcon
        icon={connection.icon}
        name={connection.title}
        size="xl"
        className="shrink-0"
      />
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <h1 className="text-xl font-semibold tracking-tight text-foreground leading-none">
            {connection.title}
          </h1>
        </div>
        {connection.description && (
          <p className="text-sm text-muted-foreground leading-relaxed">
            {connection.description}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          onClick={onOpenSettings}
          title="Configure connection"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
        >
          <Settings01 size={15} />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onDisconnect}
          className="text-destructive border-destructive/25 hover:bg-destructive/5 hover:text-destructive hover:border-destructive/40"
        >
          Disconnect
        </Button>
      </div>
    </div>
  );
}
