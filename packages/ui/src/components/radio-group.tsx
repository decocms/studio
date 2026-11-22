"use client";

import type * as React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { Circle } from "@untitledui/icons";

import { cn } from "../lib/utils.ts";

function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn("grid gap-(--space-s)", className)}
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
        "aspect-square size-4 shrink-0 rounded-full bg-neutral-1 shadow-[inset_0_0_0_var(--border-s)_var(--neutral-5)] transition-[background-color,box-shadow] duration-(--motion-duration) ease-motion focus-ring",
        "enabled:hover:shadow-[inset_0_0_0_var(--border-s)_var(--neutral-7)] data-[state=checked]:shadow-[inset_0_0_0_var(--border-s)_var(--primary)]",
        "aria-invalid:shadow-[0_0_0_var(--border-s)_var(--error)]",
        "disabled:bg-neutral-3 disabled:shadow-[inset_0_0_0_var(--border-s)_var(--neutral-4)] disabled:data-[state=checked]:shadow-[inset_0_0_0_var(--border-s)_var(--neutral-4)]",
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="relative flex items-center justify-center text-primary data-[disabled]:text-neutral-6"
      >
        <Circle className="fill-current absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}

export { RadioGroup, RadioGroupItem };
