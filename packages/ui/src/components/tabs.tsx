"use client";

import type * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { ACTIVE_INDICATOR, trackActive } from "../lib/active-indicator.ts";
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
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  );
}

interface TabsListProps
  extends React.ComponentProps<typeof TabsPrimitive.List> {
  variant?: TabsVariant;
}

const trackActiveTab = trackActive(
  ':scope > [data-slot="tabs-trigger"][data-state="active"]',
);

function TabsList({ className, variant, children, ...props }: TabsListProps) {
  const parentVariant = variant || "pill";
  const sliding = parentVariant !== "canvas";

  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={parentVariant}
      className={cn(
        "relative",
        parentVariant === "underline"
          ? "flex h-[52px] items-center border-b border-border"
          : parentVariant === "canvas"
            ? "flex h-10 items-center bg-background"
            : "bg-muted text-subtle-foreground inline-flex h-9 w-fit items-center justify-center gap-1 rounded-full p-1",
        className,
      )}
      {...props}
    >
      {sliding && (
        <span
          aria-hidden
          ref={trackActiveTab}
          data-slot="tabs-indicator"
          className={cn(
            ACTIVE_INDICATOR,
            parentVariant === "underline"
              ? "bottom-[-1px] h-0.5 rounded-full bg-primary"
              : "top-1 bottom-1 rounded-full bg-background shadow-[0_1px_2px_0_#0000000d] dark:bg-input/30",
          )}
        />
      )}
      {children}
    </TabsPrimitive.List>
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
          ? "relative z-10 flex items-center h-full px-3 text-sm whitespace-nowrap transition-colors text-muted-foreground hover:text-foreground data-[state=active]:text-foreground focus-ring disabled:pointer-events-none disabled:opacity-50"
          : parentVariant === "canvas"
            ? "flex items-center h-full px-3 gap-2.5 text-sm whitespace-nowrap transition-all border-r border-b border-border [&>*]:opacity-50 data-[state=active]:[&>*]:opacity-100 data-[state=active]:border-b-0 last:border-r-0 disabled:pointer-events-none max-w-2xs"
            : "relative z-10 data-[state=active]:text-foreground hover:text-foreground focus-ring text-subtle-foreground inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-full px-3 text-sm font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
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
