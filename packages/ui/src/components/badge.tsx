import type * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.ts";

/**
 * A status, a count or a tag: a pill with a 10% tint behind text in the full
 * colour. Entities (a goal, an app) are `Chip`s, not badges.
 */
const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-full text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1.5 [&>svg]:pointer-events-none focus-ring transition-[color,background-color] overflow-hidden",
  {
    variants: {
      variant: {
        /** Neutral grey, the default. */
        default: "bg-muted text-foreground [a&]:hover:bg-secondary-hover",
        neutral: "bg-muted text-foreground [a&]:hover:bg-secondary-hover",
        secondary: "bg-muted text-foreground [a&]:hover:bg-secondary-hover",
        success: "bg-success/10 text-success [a&]:hover:bg-success/15",
        warning: "bg-warning/10 text-warning [a&]:hover:bg-warning/15",
        destructive:
          "bg-destructive/10 text-destructive [a&]:hover:bg-destructive/15",
        /** The agent's work: a proposal, a hint. */
        agent:
          "bg-brand-purple-tint text-brand-purple-dark dark:bg-brand-purple/20 dark:text-brand-purple",
        /** Brand and the current step. */
        lime: "bg-brand-lime-tint text-brand-green-dark dark:bg-brand/20 dark:text-brand",
        info: "bg-brand-blue-tint text-brand-blue-dark dark:bg-brand-blue/20 dark:text-brand-blue",
        outline:
          "bg-card shadow-edge text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        /** A quiet classifier — a kind, a platform, a count. It names what
         *  something IS rather than how it is doing, so it carries no status
         *  colour and never competes with the label beside it. */
        muted: "bg-muted text-muted-foreground [a&]:hover:bg-secondary-hover",
        /** Live work by the product's own agents — the brand lime, kept pale so
         *  it marks activity without reading as a status. */
        brand:
          "bg-brand/30 text-foreground [a&]:hover:bg-brand/40 [button&]:hover:bg-brand/40",
      },
      size: {
        /** Counts. */
        sm: "h-4 gap-1 px-1.5 text-[0.6875rem]",
        default: "h-5 px-2",
        /** Tags. */
        lg: "h-6 px-2.5 text-sm [&>svg]:size-3.5",
        /** Sits in a toolbar beside buttons and tabs, so it takes their height. */
        control: "h-7 gap-1.5 pr-3 pl-1.5",
        icon: "size-5",
        /** A token built from parts — a filter chip's field / operator / value
         *  / remove. The sections carry their own padding and hairlines, so the
         *  badge only supplies the raised surface they sit on. Squared rather
         *  than the base's pill: a chip divided into segments needs ends that
         *  read as the same shape as the dividers between them. */
        segmented: "h-7 gap-0 rounded-lg bg-card p-0 shadow-edge",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

/** The 6px status dot that leads a badge, in the badge's own colour. */
function BadgeDot({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="badge-dot"
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full bg-current", className)}
      {...props}
    />
  );
}

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

export { Badge, BadgeDot, badgeVariants };
