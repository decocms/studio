import { Card } from "@decocms/ui/components/card.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import type { ReactNode } from "react";
import { useT } from "@/i18n/use-t.ts";
import { IntegrationIcon } from "../integration-icon.tsx";

export interface ConnectionCardData {
  id?: string;
  title: string;
  description?: string | null;
  icon?: string | null;
}

export interface ConnectionCardProps {
  connection: ConnectionCardData;
  onClick?: () => void;
  headerActions?: React.ReactNode;
  headerActionsAlwaysVisible?: boolean;
  footer?: React.ReactNode;
  className?: string;
  fallbackIcon?: ReactNode;
}

export function ConnectionCard({
  connection,
  onClick,
  headerActions,
  headerActionsAlwaysVisible = false,
  footer,
  className,
  fallbackIcon,
}: ConnectionCardProps) {
  const t = useT();
  return (
    <Card
      className={cn(
        "transition-colors group overflow-hidden flex flex-col h-full",
        onClick && "cursor-pointer hover:bg-muted/50",
        className,
      )}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              // Skip keydowns bubbled from a nested control (header actions).
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <div className="flex flex-col flex-1">
        {/* Top Section: Icon, Title, Description, Header Actions */}
        <div className="flex flex-col gap-3 p-4.5">
          {/* Header: Icon + Header Actions */}
          <div className="flex items-start justify-between">
            <IntegrationIcon
              icon={connection.icon}
              name={connection.title}
              size="sm"
              className="shrink-0 shadow-sm"
              fallbackIcon={fallbackIcon}
            />
            {/* Header Actions container */}
            <div className="relative">
              {headerActions && (
                <div
                  className={cn(
                    "transition-opacity",
                    !headerActionsAlwaysVisible &&
                      "sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100",
                  )}
                  onClick={(e) => e.stopPropagation()}
                >
                  {headerActions}
                </div>
              )}
            </div>
          </div>

          {/* Title and Description */}
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium text-foreground truncate">
              {connection.title}
            </h3>
            <p className="text-sm text-muted-foreground line-clamp-2">
              {connection.description ||
                t("connections.connectionCard.noDescription")}
            </p>
          </div>
        </div>

        {/* Footer: Custom footer with border-t spanning full width */}
        {footer && (
          <div className="border-t border-border mt-auto">
            <div
              className="h-14 flex items-center p-4.5"
              onClick={(e) => e.stopPropagation()}
            >
              {footer}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
