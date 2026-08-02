"use client";

import type * as React from "react";
import { DotsGrid } from "@untitledui/icons";
import * as ResizablePrimitive from "react-resizable-panels";
export type {
  GroupImperativeHandle,
  PanelImperativeHandle,
} from "react-resizable-panels";

import { cn } from "@deco/ui/lib/utils.ts";

function ResizablePanelGroup({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Group> & {
  ref?: React.Ref<ResizablePrimitive.GroupImperativeHandle | null>;
}) {
  return (
    <ResizablePrimitive.Group
      groupRef={ref}
      data-slot="resizable-panel-group"
      className={cn("flex h-full w-full", className)}
      {...props}
    />
  );
}

function ResizablePanel({
  ref,
  style,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Panel> & {
  ref?: React.Ref<ResizablePrimitive.PanelImperativeHandle | null>;
}) {
  return (
    <ResizablePrimitive.Panel
      panelRef={ref}
      data-slot="resizable-panel"
      style={{ overflow: "hidden", ...style }}
      {...props}
    />
  );
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Separator> & {
  withHandle?: boolean;
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "bg-border focus-visible:ring-ring relative flex w-[0.5px] items-center justify-center after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:-translate-y-1/2 aria-[orientation=horizontal]:after:translate-x-0 [&[aria-orientation=horizontal]>div]:rotate-90",
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div className="bg-border z-10 flex h-4 w-3 items-center justify-center rounded-xs border">
          <DotsGrid className="size-2.5" />
        </div>
      )}
    </ResizablePrimitive.Separator>
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
