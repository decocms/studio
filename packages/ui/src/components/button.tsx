import type * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.ts";

/**
 * The second-tier button: the RAISED surface (`--card`, pure white in light,
 * a step lighter than the page in dark) lifted by the design system's
 * hairline-and-drop shadow. Deliberately NO `border` — `card-shadow` already
 * draws the hairline, so a border would double it.
 */
const SECONDARY =
  "bg-card text-card-foreground card-shadow hover:bg-accent hover:text-accent-foreground";

const buttonVariants = cva(
  "relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/20 focus-visible:ring-[2px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        secondary: SECONDARY,
        /** shadcn's name for `secondary`, kept for the call sites already on
         *  it. One definition, so the two can never drift apart. */
        outline: SECONDARY,
        success:
          "bg-success text-success-foreground hover:bg-success/90 focus-visible:ring-success/20 dark:focus-visible:ring-success/40",
        warning:
          "bg-warning text-warning-foreground hover:bg-warning/90 focus-visible:ring-warning/20 dark:focus-visible:ring-warning/40",
        brand:
          "bg-brand text-brand-foreground hover:bg-brand/90 focus-visible:ring-brand/20 dark:focus-visible:ring-brand/40",
        special:
          "bg-special text-special-foreground hover:bg-special/90 focus-visible:ring-special/20 dark:focus-visible:ring-special/40",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        /**
         * An icon button living in the SIDEBAR, so it wears the sidebar's own
         * tokens and matches `SidebarMenuButton` beside it: a quiet glyph that
         * comes up on hover, and the sidebar accent for hover and pressed.
         */
        sidebar:
          "text-sidebar-foreground hover:bg-sidebar-accent aria-pressed:bg-sidebar-accent [&_svg:not([class*='text-'])]:text-muted-foreground hover:[&_svg:not([class*='text-'])]:text-sidebar-foreground",
        link: "text-foreground/80 hover:text-foreground",
        /**
         * A view tab: the pills that select which view of a page is showing.
         * Selection is `aria-pressed`, because these navigate rather than sit
         * in a Radix tablist — the pressed styling has to come from the same
         * attribute that tells a screen reader which one is on, and it lifts
         * the pill the way {@link SECONDARY} does, since "selected" here is a
         * raised chip (see `ViewModeToggle`) rather than a filled one.
         */
        tab: "text-muted-foreground hover:bg-accent hover:text-foreground aria-pressed:bg-card aria-pressed:text-card-foreground aria-pressed:card-shadow",
        /**
         * A row in a popover menu — full width, text leading, regular weight.
         * Every caller was reaching for `ghost` and then re-adding
         * `w-full justify-start` by hand, which is the design system losing an
         * argument it should be having once.
         */
        menu: "w-full justify-start font-normal hover:bg-accent hover:text-accent-foreground",
      },
      size: {
        default: "h-8 px-3 has-[>svg]:px-2.5",
        sm: "h-7 gap-1.5 px-2.5 has-[>svg]:px-2",
        xs: "h-6 gap-1 px-1.5 text-xs has-[>svg]:px-1",
        lg: "h-10 px-3.5 has-[>svg]:px-3",
        xl: "h-12 px-4 has-[>svg]:px-3.5",
        icon: "size-8",
        "icon-sm": "size-7",
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
