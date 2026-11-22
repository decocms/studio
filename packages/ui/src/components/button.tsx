import type * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.ts";

/* Variables keep the caller's className overrides working. */
const SECONDARY =
  "bg-[var(--studio-secondary-background)] text-[color:var(--studio-secondary-foreground)] shadow-(--edge) hover:bg-[var(--studio-secondary-hover-background)] hover:text-[color:var(--studio-secondary-hover-foreground)] disabled:text-neutral-6";

const FILLED =
  "shadow-(--edge-inset) hover:shadow-[var(--edge-inset),var(--shadow-s)] disabled:bg-neutral-3 disabled:text-neutral-6";

const buttonVariants = cva(
  [
    "relative inline-flex shrink-0 items-center justify-center gap-(--space-xs) whitespace-nowrap",
    "rounded-[var(--studio-button-radius)] font-medium",
    /* Colour and shadow ease; the press is instant (`active:transition-none`). */
    "transition-[background-color,box-shadow,color] duration-(--motion-duration) ease-motion",
    "active:translate-y-(--motion-press-distance) active:transition-none motion-reduce:active:translate-y-0",
    "focus-ring",
    "disabled:pointer-events-none",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
    "aria-invalid:outline-destructive",
  ],
  {
    variants: {
      variant: {
        /* The one filled button on a screen: ink, and nothing else is this dark. */
        default: cn("bg-primary text-primary-foreground", FILLED),
        destructive: cn("bg-destructive text-destructive-foreground", FILLED),
        secondary: SECONDARY,
        outline:
          "bg-transparent text-[color:var(--studio-outline-foreground)] shadow-[inset_0_0_0_var(--border-s)_var(--border)] hover:bg-[var(--studio-outline-hover-background)] disabled:text-neutral-6 disabled:shadow-[inset_0_0_0_var(--border-s)_var(--neutral-4-transparent)]",
        success: cn("bg-success text-success-foreground", FILLED),
        warning: cn("bg-warning text-warning-foreground", FILLED),
        /* Lime. Reserved for starting work — see the accent rule. */
        brand: cn("bg-brand text-brand-foreground", FILLED),
        special: cn("bg-special text-special-foreground", FILLED),
        ghost: "hover:bg-neutral-3-transparent disabled:text-neutral-6",
        /**
         * An icon button living in the SIDEBAR, so it wears the sidebar's own
         * tokens and matches `SidebarMenuButton` beside it: a quiet glyph that
         * comes up on hover, and the sidebar accent for hover and pressed.
         */
        sidebar:
          "text-sidebar-foreground hover:bg-sidebar-accent aria-pressed:bg-sidebar-accent [&_svg:not([class*='text-'])]:text-muted-foreground hover:[&_svg:not([class*='text-'])]:text-sidebar-foreground",
        link: "text-foreground/80 hover:text-foreground disabled:text-neutral-6",
        /**
         * A view tab: the pills that select which view of a page is showing.
         * Selection is `aria-pressed`, or `aria-current="page"` when the tab IS
         * a link — the styling has to come from whichever attribute tells a
         * screen reader this one is on, never a class beside it.
         */
        tab: "text-muted-foreground hover:bg-neutral-3 hover:text-foreground aria-pressed:bg-neutral-3 aria-pressed:text-foreground aria-[current=page]:bg-neutral-3 aria-[current=page]:text-foreground disabled:text-neutral-6",
        /**
         * A row in a popover menu — full width, text leading, regular weight.
         * Every caller was reaching for `ghost` and then re-adding
         * `w-full justify-start` by hand, which is the design system losing an
         * argument it should be having once.
         */
        menu: "w-full justify-start rounded-xs font-regular hover:bg-accent hover:text-accent-foreground disabled:text-neutral-6",
      },
      /* deco defines only the default size; the others step around it. */
      size: {
        default:
          "h-(--studio-control-height) px-(--space-m) text-s has-[>svg]:px-(--space-s)",
        sm: "h-(--studio-control-height-sm) px-(--space-s) text-s has-[>svg]:px-(--space-xs)",
        xs: "h-(--studio-control-height-xs) gap-(--space-xxs) px-(--space-xs) text-xs [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-(--studio-control-height-lg) px-(--space-l) text-s has-[>svg]:px-(--space-m)",
        xl: "h-(--studio-control-height-xl) px-(--space-xl) text-s has-[>svg]:px-(--space-l)",
        icon: "size-(--studio-control-height)",
        "icon-sm": "size-(--studio-control-height-sm) text-s",
        "icon-xs":
          "size-(--studio-control-height-xs) text-xs [&_svg:not([class*='size-'])]:size-3.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
