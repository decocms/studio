import { useCompactPageLayout } from "@/hooks/use-preferences";
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
  const compact = useCompactPageLayout();
  const title = displayTitle ?? connection.title;
  return (
    <div className="flex items-center classic:gap-4 classic:md:gap-6 classic:py-5 classic:md:py-7 px-4 md:px-8 bg-background border-b border-border shrink-0 compact:gap-3 compact:py-4">
      <IntegrationIcon
        icon={connection.icon}
        name={title}
        size={compact ? "md" : "xl"}
        className="shrink-0"
      />
      <div className="flex-1 min-w-0">
        {compact ? (
          <Page.Title>{title}</Page.Title>
        ) : (
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <h1 className="text-lg md:text-xl font-semibold tracking-tight text-foreground leading-none">
              {title}
            </h1>
          </div>
        )}
        {connection.description && (
          <p className="text-sm text-muted-foreground leading-relaxed line-clamp-2">
            {connection.description}
          </p>
        )}
      </div>
    </div>
  );
}
