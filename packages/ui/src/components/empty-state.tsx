import type { ComponentProps, ReactNode } from "react";

import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";

export function EmptyState({
  icon,
  illustration,
  title,
  description,
  buttonProps,
  buttonComponent,
  className,
  children,
}: {
  icon?: ReactNode;
  illustration?: ReactNode;
  title: string;
  description?: string | ReactNode;
  buttonProps?: ComponentProps<typeof Button>;
  buttonComponent?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center py-16 text-center",
        className,
      )}
    >
      {illustration ? (
        <div className="mb-4 text-muted-foreground/50">{illustration}</div>
      ) : icon ? (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-muted/50 text-muted-foreground">
          {icon}
        </div>
      ) : null}

      <div className="flex flex-col items-center gap-1 max-w-sm">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {description && (
          <div className="text-sm text-muted-foreground">{description}</div>
        )}
      </div>

      {(buttonComponent ?? buttonProps) && (
        <div className="mt-4">
          {buttonComponent ??
            (buttonProps && (
              <Button
                size="sm"
                className={cn(buttonProps?.className)}
                {...buttonProps}
              />
            ))}
        </div>
      )}

      {children}
    </div>
  );
}
