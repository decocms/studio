import type { ComponentProps, ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.ts";
import { Button } from "./button.tsx";

const emptyStateVariants = cva(
  "flex flex-col items-center justify-center gap-4 text-center",
  {
    variants: {
      size: {
        /** The whole view is empty. */
        page: "py-16",
        /** A list or chart inside a card or panel. */
        inline: "py-8",
      },
    },
    defaultVariants: { size: "page" },
  },
);

const iconVariants = cva(
  "flex size-10 items-center justify-center rounded-xl [&_svg]:size-5 [&_svg]:stroke-[1.33]",
  {
    variants: {
      tone: {
        default: "bg-muted text-muted-foreground",
        error: "bg-destructive/10 text-destructive",
      },
    },
    defaultVariants: { tone: "default" },
  },
);

/** Nothing here yet, nothing matched, or it failed: say why and offer the next step. */
export function EmptyState({
  icon,
  illustration,
  title,
  description,
  buttonProps,
  buttonComponent,
  size,
  tone,
  className,
  children,
}: VariantProps<typeof emptyStateVariants> &
  VariantProps<typeof iconVariants> & {
    icon?: ReactNode;
    /** Instead of the icon tile, for rare moments: the agent, a first run. */
    illustration?: ReactNode;
    title: string;
    description?: string | ReactNode;
    buttonProps?: ComponentProps<typeof Button>;
    buttonComponent?: ReactNode;
    className?: string;
    children?: ReactNode;
  }) {
  return (
    <div className={cn(emptyStateVariants({ size }), className)}>
      {illustration ??
        (icon && <div className={iconVariants({ tone })}>{icon}</div>)}
      <div className="flex max-w-xs flex-col items-center gap-1">
        <h3 className="text-foreground text-sm font-medium">{title}</h3>
        {description && (
          <div className="text-muted-foreground text-sm">{description}</div>
        )}
      </div>
      {buttonComponent ??
        (buttonProps && <Button size="sm" {...buttonProps} />)}
      {children}
    </div>
  );
}
