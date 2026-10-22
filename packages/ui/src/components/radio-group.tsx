"use client";

import type * as React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";

import { cn } from "../lib/utils.ts";

function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn("grid gap-3", className)}
      {...props}
    />
  );
}

function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        "group relative inline-flex size-4 shrink-0 items-center justify-center rounded-full shadow-[inset_0_0_0_1.5px_var(--input)] transition-[background-color,box-shadow] duration-150 hover:shadow-[inset_0_0_0_1.5px_color-mix(in_oklch,var(--foreground)_30%,var(--input))] data-[state=checked]:bg-primary data-[state=checked]:shadow-[inset_0_0_0_1.5px_var(--primary)] aria-invalid:shadow-[inset_0_0_0_1.5px_var(--destructive)] focus-ring disabled:opacity-50 motion-reduce:transition-none",
        className,
      )}
      {...props}
    >
      {/* Always mounted, so the dot can grow in and shrink out. */}
      <span className="bg-primary-foreground size-1.5 scale-0 rounded-full transition-transform duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-data-[state=checked]:scale-100 motion-reduce:transition-none" />
    </RadioGroupPrimitive.Item>
  );
}

export { RadioGroup, RadioGroupItem };
