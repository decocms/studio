"use client";

import type * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";

import { cn } from "../lib/utils.ts";

function Label({
  className,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "flex items-center gap-(--space-xs) text-s font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:text-neutral-6 peer-disabled:cursor-not-allowed peer-disabled:text-neutral-6",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
