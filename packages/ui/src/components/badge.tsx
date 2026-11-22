import type * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.ts";

const OPTION_BADGE =
  "bg-(--chip) text-(color:--chip-foreground) [a&]:hover:bg-neutral-4";

const badgeVariants = cva(
  "inline-flex items-center justify-center gap-(--space-xxs) rounded-xs text-xs font-medium w-fit whitespace-nowrap shrink-0 overflow-hidden transition-[background-color,box-shadow,color] duration-(--motion-duration) ease-motion focus-ring aria-invalid:shadow-[0_0_0_var(--border-s)_var(--error)] [&>svg]:size-3 [&>svg]:pointer-events-none",
  {
    variants: {
      variant: {
        /* deco's option badge. */
        default: OPTION_BADGE,
        secondary: OPTION_BADGE,
        destructive:
          "bg-destructive text-destructive-foreground [a&]:hover:bg-destructive/90",
        success: "bg-success text-success-foreground [a&]:hover:bg-success/90",
        warning: "bg-warning text-warning-foreground [a&]:hover:bg-warning/90",
        outline:
          "text-foreground shadow-[inset_0_0_0_var(--border-s)_var(--neutral-4)] [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        /** A quiet classifier — a kind, a platform, a count. It names what
         *  something IS rather than how it is doing, so it carries no status
         *  colour and never competes with the label beside it. */
        muted: "bg-(--chip) text-muted-foreground [a&]:hover:bg-neutral-3",
      },
      size: {
        default: "px-(--space-xs) py-0.5",
        icon: "size-5",
        /** A filter chip built from parts; the badge supplies only the surface. */
        segmented: "h-7 gap-0 rounded-(--radius-s) bg-card p-0 card-shadow",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Badge({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span";

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
