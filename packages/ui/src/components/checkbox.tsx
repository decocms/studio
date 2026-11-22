"use client";

import type * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "@untitledui/icons";

import { cn } from "../lib/utils.ts";

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer size-4 shrink-0 rounded-xs bg-neutral-1 shadow-(--edge-inset) transition-[background-color,box-shadow] duration-(--motion-duration) ease-motion focus-ring",
        "enabled:hover:shadow-[inset_0_0_0_var(--border-s)_var(--neutral-5)]",
        "data-[state=checked]:bg-primary data-[state=checked]:shadow-none data-[state=indeterminate]:bg-primary data-[state=indeterminate]:shadow-none",
        "aria-invalid:shadow-[0_0_0_var(--border-s)_var(--error)]",
        "disabled:bg-neutral-3 disabled:data-[state=checked]:bg-neutral-3 disabled:data-[state=indeterminate]:bg-neutral-3",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-primary-foreground transition-none data-[disabled]:text-neutral-6"
      >
        <Check className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
