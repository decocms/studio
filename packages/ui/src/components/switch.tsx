"use client";

import type * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

import { cn } from "../lib/utils.ts";

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-(--radius-s) p-px transition-[background-color] duration-(--motion-duration) ease-motion focus-ring",
        "data-[state=unchecked]:bg-neutral-4 data-[state=checked]:bg-primary",
        "disabled:data-[state=unchecked]:bg-neutral-3 disabled:data-[state=checked]:bg-neutral-3",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-4 rounded-xs bg-neutral-1 shadow-(--card-shadow) dark:bg-neutral-10 data-[state=checked]:bg-primary-foreground dark:data-[state=checked]:bg-primary-foreground transition-transform duration-(--motion-duration) ease-motion data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0",
          "data-[disabled]:bg-neutral-5 dark:data-[disabled]:bg-neutral-5 data-[disabled]:shadow-none",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
