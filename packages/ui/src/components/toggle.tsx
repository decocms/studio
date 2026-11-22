"use client";

import type * as React from "react";
import * as TogglePrimitive from "@radix-ui/react-toggle";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.ts";

const toggleVariants = cva(
  "inline-flex items-center justify-center gap-(--space-xs) rounded-(--radius-s) text-s font-medium text-foreground whitespace-nowrap transition-[background-color,box-shadow,color] duration-(--motion-duration) ease-motion focus-ring hover:bg-neutral-3 data-[state=on]:bg-neutral-3 disabled:pointer-events-none disabled:text-neutral-6 aria-invalid:shadow-[0_0_0_var(--border-s)_var(--error)] [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline:
          "bg-transparent shadow-[inset_0_0_0_var(--border-s)_var(--border)]",
      },
      size: {
        default:
          "h-(--studio-control-height) min-w-(--studio-control-height) px-(--space-s)",
        sm: "h-(--studio-control-height-sm) min-w-(--studio-control-height-sm) px-(--space-xs) text-s",
        lg: "h-(--studio-control-height-lg) min-w-(--studio-control-height-lg) px-(--space-m)",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Toggle({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> &
  VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
