"use client";

import type * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "../lib/utils.ts";

type TabsVariant = "pill" | "underline" | "canvas";

interface TabsProps extends React.ComponentProps<typeof TabsPrimitive.Root> {
  variant?: TabsVariant;
}

function Tabs({ className, variant = "pill", ...props }: TabsProps) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-variant={variant}
      className={cn("flex flex-col gap-(--space-xs)", className)}
      {...props}
    />
  );
}

interface TabsListProps
  extends React.ComponentProps<typeof TabsPrimitive.List> {
  variant?: TabsVariant;
}

function TabsList({ className, variant, ...props }: TabsListProps) {
  // Get variant from parent Tabs if not explicitly provided
  const parentVariant = variant || "pill";

  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={parentVariant}
      className={cn(
        /* `underline` is deco's tabs; `pill` borrows the toggle-group shape. */
        parentVariant === "underline"
          ? "flex h-[52px] items-center gap-(--space-l) border-b border-border"
          : parentVariant === "canvas"
            ? "flex h-10 items-center bg-background relative"
            : "inline-flex h-(--studio-control-height-sm) w-fit items-center justify-center gap-(--space-xxs)",
        className,
      )}
      {...props}
    />
  );
}

interface TabsTriggerProps
  extends React.ComponentProps<typeof TabsPrimitive.Trigger> {
  variant?: TabsVariant;
}

function TabsTrigger({ className, variant, ...props }: TabsTriggerProps) {
  // Get variant from parent Tabs if not explicitly provided
  const parentVariant = variant || "pill";

  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      data-variant={parentVariant}
      className={cn(
        parentVariant === "underline"
          ? "relative flex h-full items-center gap-(--space-xs) px-0 py-(--space-xs) text-s font-regular whitespace-nowrap text-neutral-6 transition-colors duration-(--motion-duration) ease-motion focus-ring hover:text-foreground focus-visible:text-foreground data-[state=active]:text-foreground data-[state=active]:shadow-[inset_0_calc(-1*var(--border-l))_0_var(--foreground)] disabled:pointer-events-none disabled:text-neutral-4"
          : parentVariant === "canvas"
            ? "flex items-center h-full px-(--space-s) gap-(--space-xs) text-s font-regular whitespace-nowrap text-neutral-6 transition-colors duration-(--motion-duration) ease-motion focus-ring border-r border-b border-border hover:text-foreground data-[state=active]:text-foreground data-[state=active]:border-b-0 last:border-r-0 disabled:pointer-events-none disabled:text-neutral-4 max-w-2xs"
            : "inline-flex h-full flex-1 items-center justify-center gap-(--space-xs) rounded-(--radius-s) px-(--space-s) text-s font-medium whitespace-nowrap text-muted-foreground transition-[background-color,color] duration-(--motion-duration) ease-motion focus-ring hover:bg-neutral-3 hover:text-foreground data-[state=active]:bg-neutral-3 data-[state=active]:text-foreground disabled:pointer-events-none disabled:text-neutral-6 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none h-full", className)}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
