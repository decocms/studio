"use client";

import * as React from "react";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import type { VariantProps } from "class-variance-authority";

import { ACTIVE_INDICATOR, trackActive } from "../lib/active-indicator.ts";
import { cn } from "../lib/utils.ts";
import { toggleVariants } from "./toggle.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.tsx";

const ToggleGroupContext = React.createContext<
  VariantProps<typeof toggleVariants>
>({
  size: "default",
  variant: "default",
});

const trackActiveItem = trackActive(
  ':scope > [data-slot="toggle-group-item"][data-state="on"]',
);

function ToggleGroup({
  className,
  variant,
  size,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> &
  VariantProps<typeof toggleVariants>) {
  // A single-choice segmented control slides one pill between its options.
  const sliding = variant === "segmented" && props.type === "single";
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      data-sliding={sliding || undefined}
      className={cn(
        "group/toggle-group relative flex w-fit items-center rounded-full data-[variant=segmented]:bg-muted data-[variant=segmented]:gap-0.5 data-[variant=segmented]:p-0.5 data-[variant=outline]:after:pointer-events-none data-[variant=outline]:after:absolute data-[variant=outline]:after:inset-0 data-[variant=outline]:after:rounded-full data-[variant=outline]:after:shadow-edge data-[variant=outline]:bg-card data-[variant=outline]:after:content-['']",
        className,
      )}
      {...props}
    >
      {sliding && (
        <span
          aria-hidden
          ref={trackActiveItem}
          data-slot="toggle-group-indicator"
          className={cn(
            ACTIVE_INDICATOR,
            "bg-background dark:bg-accent top-0.5 bottom-0.5 rounded-full shadow-[0_1px_2px_0_#0000000d] opacity-0 in-data-has-active:opacity-100",
          )}
        />
      )}
      <ToggleGroupContext.Provider value={{ variant, size }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  );
}

/** The tooltip trigger would stamp its own `data-state` over the item's on/off. */
function ItemKeepingState({
  "data-state": _tooltipState,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> & {
  "data-state"?: string;
}) {
  return <ToggleGroupPrimitive.Item {...props} />;
}

function ToggleGroupItem({
  className,
  children,
  variant,
  size,
  tooltip,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> &
  VariantProps<typeof toggleVariants> & {
    /** Shown on hover and used as the name of an icon-only item. */
    tooltip?: string;
  }) {
  const context = React.useContext(ToggleGroupContext);
  // CSS can't see a bare text node beside an icon, so decide icon-only here.
  const iconOnly = React.isValidElement(children);

  const item = (
    <ItemKeepingState
      data-slot="toggle-group-item"
      data-variant={context.variant || variant}
      data-size={context.size || size}
      data-icon-only={iconOnly || undefined}
      aria-label={tooltip}
      className={cn(
        toggleVariants({
          variant: context.variant || variant,
          size: context.size || size,
        }),
        "relative z-10 min-w-0 flex-1 shrink-0 rounded-none first:rounded-l-full last:rounded-r-full focus:z-10 focus-visible:z-10 data-[icon-only]:aspect-square data-[icon-only]:px-0",
        "data-[variant=segmented]:flex-none data-[variant=segmented]:rounded-full in-data-sliding:data-[state=on]:bg-transparent in-data-sliding:data-[state=on]:shadow-none",
        "data-[variant=outline]:shadow-none data-[variant=outline]:border-hairline data-[variant=outline]:not-first:border-l",
        className,
      )}
      {...props}
    >
      {children}
    </ItemKeepingState>
  );

  if (!tooltip) return item;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{item}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export { ToggleGroup, ToggleGroupItem };
