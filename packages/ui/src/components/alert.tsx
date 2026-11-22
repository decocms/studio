import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.ts";

const alertVariants = cva(
  "relative w-full rounded-m px-(--space-m) py-(--space-s) text-s flex items-start gap-(--space-s) [&>svg]:size-4 [&>svg]:flex-shrink-0 [&>svg]:mt-0.5 [&>svg]:text-current",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground shadow-(--edge)",
        destructive:
          "bg-destructive/5 text-destructive shadow-[0_0_0_var(--border-s)_var(--error-transparent)] [&>svg]:text-current *:data-[slot=alert-description]:text-destructive/90",
        warning:
          "bg-warning/10 text-warning-foreground shadow-[0_0_0_var(--border-s)_var(--warning)] [&>svg]:text-current *:data-[slot=alert-description]:text-warning-foreground/90",
        success:
          "bg-success/10 text-success-foreground shadow-[0_0_0_var(--border-s)_var(--success)] [&>svg]:text-current *:data-[slot=alert-description]:text-success-foreground/90",
        info: "bg-card text-card-foreground shadow-(--edge) [&>svg]:text-current *:data-[slot=alert-description]:text-muted-foreground/90",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn("line-clamp-1 min-h-4 text-s font-medium", className)}
      {...props}
    />
  );
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Alert, AlertDescription, AlertTitle };
