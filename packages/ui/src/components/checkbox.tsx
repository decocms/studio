"use client";

import type * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Minus } from "@untitledui/icons";

import { cn } from "../lib/utils.ts";

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "checkbox-draw peer relative size-4 shrink-0 rounded-[4px] text-primary-foreground outline-none focus-ring aria-invalid:[--checkbox-line:var(--destructive)] disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {/* Outside the Indicator so it stays mounted and can animate both ways. */}
      <svg viewBox="0 0 21 21" aria-hidden className="size-full">
        <path d="M5,10.75 L8.5,14.25 L19.4,2.3 C18.8333333,1.43333333 18.0333333,1 17,1 L4,1 C2.35,1 1,2.35 1,4 L1,17 C1,18.65 2.35,20 4,20 L17,20 C18.65,20 20,18.65 20,17 L20,7.99769186" />
      </svg>
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="absolute inset-0 hidden items-center justify-center data-[state=indeterminate]:flex"
      >
        <Minus className="size-3" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
