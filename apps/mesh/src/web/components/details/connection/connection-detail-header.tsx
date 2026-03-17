import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import type { ConnectionEntity } from "@decocms/mesh-sdk";

interface ConnectionDetailHeaderProps {
  connection: ConnectionEntity;
  displayTitle?: string;
}

export function ConnectionDetailHeader({
  connection,
  displayTitle,
}: ConnectionDetailHeaderProps) {
  const title = displayTitle ?? connection.title;
  return (
    <div className="flex items-center gap-6 py-7 px-8 bg-background border-b border-border shrink-0">
      <IntegrationIcon
        icon={connection.icon}
        name={title}
        size="xl"
        className="shrink-0"
      />
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <h1 className="text-xl font-semibold tracking-tight text-foreground leading-none">
            {title}
          </h1>
        </div>
        {connection.description && (
          <p className="text-sm text-muted-foreground leading-relaxed">
            {connection.description}
          </p>
        )}
      </div>
    </div>
  );
}
