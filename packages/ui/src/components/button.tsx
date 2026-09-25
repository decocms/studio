import type * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.ts";

/** Compact layout raises secondary controls onto the card surface. Variables
 *  keep both layouts compatible with the caller's className overrides. */
const SECONDARY =
  "bg-[var(--studio-secondary-background)] text-[color:var(--studio-secondary-foreground)] shadow-[var(--studio-secondary-shadow)] hover:bg-[var(--studio-secondary-hover-background)] hover:text-[color:var(--studio-secondary-hover-foreground)]";

const buttonVariants = cva(
  [
    "relative inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap",
    /* A pill at every size, in every layout — see `--studio-button-radius`. */
    "rounded-[var(--studio-button-radius)] text-sm font-medium",
    /* Colour and shadow ease; the press is instant, because a button that
       takes 150ms to look pressed feels like it missed the click. */
    "transition-[background-color,box-shadow,color,opacity] duration-150 ease-[var(--ease-out-cubic)]",
    "active:scale-[0.98] active:transition-none motion-reduce:active:scale-100",
    "focus-ring",
    "disabled:pointer-events-none disabled:opacity-45",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
    "aria-invalid:outline-destructive",
  ],
  {
    variants: {
      variant: {
        /* The one filled button on a screen. Ink, so it is unmistakably the
           thing to press, and nothing else on the page is this dark. */
        default: "bg-primary text-primary-foreground hover:bg-primary/85",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 dark:bg-destructive/70",
        secondary: SECONDARY,
        outline:
          "bg-[var(--studio-input-background)] text-[color:var(--studio-outline-foreground)] hover:bg-[var(--studio-outline-hover-background)] hover:text-accent-foreground card-shadow",
        success: "bg-success text-success-foreground hover:bg-success/90",
        warning: "bg-warning text-warning-foreground hover:bg-warning/90",
        /* Lime. Reserved for starting work — see the accent rule. */
        brand: "bg-brand text-brand-foreground hover:bg-brand/85",
        special: "bg-special text-special-foreground hover:bg-special/90",
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
         * Selection is `aria-pressed`, or `aria-current="page"` when the tab IS
         * a link — the styling has to come from whichever attribute tells a
         * screen reader this one is on, never a class beside it. It lifts
         * the pill the way {@link SECONDARY} does, since "selected" here is a
         * raised chip (see `ViewModeToggle`) rather than a filled one.
         */
        tab: "text-muted-foreground hover:bg-accent hover:text-foreground aria-pressed:bg-card aria-pressed:text-card-foreground aria-pressed:card-shadow aria-[current=page]:bg-card aria-[current=page]:text-card-foreground aria-[current=page]:card-shadow",
        /**
         * A row in a popover menu — full width, text leading, regular weight.
         * Every caller was reaching for `ghost` and then re-adding
         * `w-full justify-start` by hand, which is the design system losing an
         * argument it should be having once.
         */
        menu: "w-full justify-start font-normal hover:bg-accent hover:text-accent-foreground",
      },
      /* A pill needs more room at the ends than a rectangle does — the curve
         eats the first and last few pixels, so the label sits closer to the
         edge than it measures. Padding grows faster than height for that
         reason, and an icon-led button gives a little back because a glyph
         reads as its own margin. */
      size: {
        default: "h-8 px-3.5 has-[>svg]:px-3",
        sm: "h-7 gap-1.5 px-3 has-[>svg]:px-2.5",
        xs: "h-6 gap-1 px-2.5 text-xs has-[>svg]:px-2",
        lg: "h-10 px-4.5 has-[>svg]:px-4",
        xl: "h-12 px-6 text-base has-[>svg]:px-5",
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
