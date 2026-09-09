"use client";

import type * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";

import { cn } from "../lib/utils.ts";

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
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
        "bg-primary/20 relative h-2 w-full overflow-hidden rounded-full",
        className,
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="bg-primary h-full w-full flex-1 transition-all"
        style={{ transform: `translateX(-${100 - pct}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
