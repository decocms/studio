import { isValidElement, type ReactNode } from "react";
import { EmptyState as DesignSystemEmptyState } from "@decocms/ui/components/empty-state.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";

interface EmptyStateProps {
  /** Icons render in the design-system tile; `<img>` illustrations render as-is. */
  image?: ReactNode;
  title: string;
  description: string | ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function EmptyState({
  image,
  title,
  description,
  actions,
  className,
}: EmptyStateProps) {
  const isIllustration = isValidElement(image) && image.type === "img";

  return (
    <DesignSystemEmptyState
      className={cn("flex-1", className)}
      icon={isIllustration ? undefined : image}
      illustration={isIllustration ? image : undefined}
      title={title}
      description={description}
      buttonComponent={actions || undefined}
    />
  );
}
