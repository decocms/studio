"use client";

import type * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.ts";

/** A 4px bar: purple by default, warning when behind target, ink for neutral
 *  work such as an upload. */
const progressIndicatorVariants = cva(
  "h-full w-full flex-1 rounded-full transition-transform duration-200 ease-[var(--ease-out-cubic)]",
  {
    variants: {
      tone: {
        default: "bg-brand-purple",
        warning: "bg-warning",
        dark: "bg-primary",
      },
    },
    defaultVariants: { tone: "default" },
  },
);

function Progress({
  className,
  value,
  tone,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> &
  VariantProps<typeof progressIndicatorVariants>) {
  // Clamped because the indicator is positioned by `translateX(-(100 - v)%)`
  // inside an `overflow-hidden` track: a value above 100 translates it
  // POSITIVELY, sliding it out of the track so an over-quota bar renders
  // EMPTY — reading as "nothing used" at the exact moment it is over the
  // limit. Below 0 it slides out the other side. A progress bar handed 137
  // means full, and one handed -5 means empty.
  const pct = Math.min(100, Math.max(0, value ?? 0));
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "bg-muted relative h-1 w-full overflow-hidden rounded-full",
        className,
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={progressIndicatorVariants({ tone })}
        style={{ transform: `translateX(-${100 - pct}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress, progressIndicatorVariants };
