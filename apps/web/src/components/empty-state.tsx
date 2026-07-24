import type { ReactNode } from "react";
import { cn } from "@deco/ui/lib/utils.ts";

interface EmptyStateProps {
  image?: ReactNode;
  title: string;
  description: string | ReactNode;
  actions?: ReactNode;
  className?: string;
  descriptionClassName?: string;
  actionsClassName?: string;
}

/**
 * Default stacked cards illustration for empty states
 * PNG exported from Figma design
 */
function StackedCardsIllustration() {
  return (
    <img
      src="/empty-state-cards.png"
      alt=""
      width={336}
      height={320}
      aria-hidden="true"
    />
  );
}

export function EmptyState({
  image,
  title,
  description,
  actions,
  className,
  descriptionClassName,
  actionsClassName,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-8 p-4",
        className,
      )}
    >
      {/* Image/Illustration */}
      {image !== null && (
        <div className="flex items-center justify-center">
          {image ?? <StackedCardsIllustration />}
        </div>
      )}

      {/* Text content */}
      <div className="flex flex-col items-center gap-4">
        <div className="flex flex-col items-center gap-2">
          <h3 className="text-center text-lg font-medium text-foreground">
            {title}
          </h3>
          <div
            className={cn(
              "text-sm text-muted-foreground text-center max-w-[300px]",
              descriptionClassName,
            )}
          >
            {description}
          </div>
        </div>

        {/* Actions */}
        {actions && (
          <div className={cn("flex items-center gap-2", actionsClassName)}>
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
