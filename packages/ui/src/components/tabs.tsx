"use client";

import type * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@deco/ui/lib/utils.ts";

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

function TabsList({ className, variant, ...props }: TabsListProps) {
  // Get variant from parent Tabs if not explicitly provided
  const parentVariant = variant || "pill";

  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={parentVariant}
      className={cn(
        parentVariant === "underline"
          ? "flex h-[52px] items-center border-b border-border"
          : parentVariant === "canvas"
            ? "flex h-10 items-center bg-background relative"
            : "bg-muted text-muted-foreground inline-flex h-10 w-fit items-center justify-center rounded-xl p-[3px]",
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
          ? "cursor-pointer flex items-center h-full px-3 relative text-sm whitespace-nowrap border-b-2 mb-[-1px] transition-all text-muted-foreground border-transparent hover:text-foreground data-[state=active]:text-foreground data-[state=active]:border-primary disabled:pointer-events-none disabled:opacity-50"
          : parentVariant === "canvas"
            ? "cursor-pointer flex items-center h-full px-3 gap-2.5 text-sm whitespace-nowrap transition-all border-r border-b border-border [&>*]:opacity-50 data-[state=active]:[&>*]:opacity-100 data-[state=active]:border-b-0 last:border-r-0 disabled:pointer-events-none max-w-2xs"
            : "data-[state=active]:bg-background dark:data-[state=active]:text-foreground cursor-pointer focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 text-foreground dark:text-muted-foreground inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-lg border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:shadow-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
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
