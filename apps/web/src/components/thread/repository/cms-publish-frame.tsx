/**
 * The publish surface's geometry, rendered by BOTH its loading fallback and
 * its loaded content. Padding, dividers and the scroll region are defined once
 * here, so a ghost and the thing it stands in for cannot drift apart — the
 * previous hand-built skeleton had a smaller discard control and a shorter
 * card than the cards it was standing in for.
 *
 * `state` is published as `data-publish-state` for tests to anchor on, since
 * the visible copy alone cannot distinguish a ghosted card list from a real
 * one. It is deliberately not `data-state`, which Radix already stamps on the
 * popover content one level up.
 */

import { cn } from "@decocms/ui/lib/utils.ts";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

/** `loading`: no card list yet. `manifest`: cards real, bodies still landing.
 *  `ready`: everything the surface will ever show is on screen. */
export type PublishSurfaceState = "loading" | "manifest" | "ready";

interface PublishFrameProps {
  state: PublishSurfaceState;
  /** Title row and its sub-line. */
  header: ReactNode;
  /** The change list, empty state, or error — owns its own scrolling. */
  body: ReactNode;
  /** Version-note block; omitted when there is nothing to publish. */
  note?: ReactNode;
  /** Review-gate row; omitted unless the gate has something to say. */
  gate?: ReactNode;
  footer: ReactNode;
}

export function PublishFrame({
  state,
  header,
  body,
  note,
  gate,
  footer,
}: PublishFrameProps) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-publish-state={state}
      aria-busy={state !== "ready"}
    >
      <div className="space-y-0.5 px-4 py-3">{header}</div>
      <div className="border-t" />
      <div className="flex min-h-0 flex-1 flex-col">
        {body}
        {note ? (
          <div className="space-y-1.5 border-t px-4 py-3">{note}</div>
        ) : null}
      </div>
      {gate}
      <div className="border-t" />
      <div className="space-y-2 px-4 py-3">{footer}</div>
    </div>
  );
}

/** The scrolling change-list region — same padding and fade in both states. */
export function PublishListRegion({ children }: { children: ReactNode }) {
  return (
    <div className="scroll-fade min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 pt-3 pb-2 [scrollbar-width:thin]">
      {children}
    </div>
  );
}

/** One card's outer box. The real card adds its own interaction affordances. */
export function PublishCardFrame({
  className,
  children,
  ...rest
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn("rounded-lg border bg-card px-3 py-2.5", className)}
      {...rest}
    >
      {children}
    </div>
  );
}

export function PublishGhost({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-pulse rounded bg-muted motion-reduce:animate-none",
        className,
      )}
    />
  );
}

/**
 * A card-shaped placeholder. Deliberately sub-line-free: content only ever
 * grows downward from here, so nothing already on screen moves when it lands.
 */
export function PublishGhostCard() {
  return (
    <PublishCardFrame>
      <div className="flex items-center gap-2.5">
        <PublishGhost className="size-4 rounded-md" />
        <PublishGhost className="h-3 w-24" />
        <PublishGhost className="h-2.5 w-16" />
        <PublishGhost className="ml-auto size-6 rounded" />
      </div>
    </PublishCardFrame>
  );
}
