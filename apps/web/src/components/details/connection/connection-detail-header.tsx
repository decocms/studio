import { Page } from "@/components/page";
import { IntegrationIcon } from "@/components/integration-icon.tsx";
import type { ConnectionEntity } from "@/sdk";

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
    <div className="flex items-center gap-3 py-4 px-4 md:px-8 bg-background border-b border-border shrink-0">
      <IntegrationIcon
        icon={connection.icon}
        name={title}
        size="md"
        className="shrink-0"
      />
      <div className="flex-1 min-w-0">
        <Page.Title>{title}</Page.Title>
        {connection.description && (
          <p className="text-sm text-muted-foreground leading-relaxed line-clamp-2">
            {connection.description}
          </p>
        )}
      </div>
    </div>
  );
}
