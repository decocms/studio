import type { ComponentProps, ReactNode } from "react";

import { Button } from "./button.tsx";
import { cn } from "../lib/utils.ts";

export function EmptyState({
  icon,
  illustration,
  title,
  description,
  buttonProps,
  buttonComponent,
  size = "default",
  tone = "default",
  className,
  children,
}: {
  icon?: ReactNode;
  illustration?: ReactNode;
  title: string;
  description?: string | ReactNode;
  buttonProps?: ComponentProps<typeof Button>;
  buttonComponent?: ReactNode;
  /** `sm` fits popover bodies and side panels. */
  size?: "default" | "sm";
  /** `destructive` tints the icon tile for error states. */
  tone?: "default" | "destructive";
  className?: string;
  children?: ReactNode;
}) {
  const compact = size === "sm";
  const actions =
    buttonComponent ?? (buttonProps && <Button size="sm" {...buttonProps} />);

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "px-(--space-m) py-(--space-xl)" : "px-(--space-l) py-16",
        className,
      )}
    >
      {illustration ? (
        <div className="mb-(--space-m) text-muted-foreground/50">
          {illustration}
        </div>
      ) : icon ? (
        <div
          className={cn(
            // Flatten wrapper elements so any glyph renders at tile scale.
            "flex shrink-0 items-center justify-center rounded-m [&_svg]:size-5 [&>div]:contents",
            compact ? "mb-(--space-s) size-10" : "mb-(--space-m) size-12",
            tone === "destructive"
              ? "bg-destructive/10 text-destructive"
              : "bg-muted text-muted-foreground",
          )}
        >
          {icon}
        </div>
      ) : null}

      <div className="flex flex-col items-center gap-(--space-xxs)">
        <h3 className="text-m font-medium text-balance text-foreground">
          {title}
        </h3>
        {description && (
          <div className="max-w-[44ch] text-s text-balance text-muted-foreground">
            {description}
          </div>
        )}
      </div>

      {actions && (
        <div
          className={cn(
            "flex flex-wrap items-center justify-center gap-(--space-s)",
            compact ? "mt-(--space-s)" : "mt-(--space-m)",
          )}
        >
          {actions}
        </div>
      )}

      {children}
    </div>
  );
}
