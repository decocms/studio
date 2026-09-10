import type { ComponentProps, Ref } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";
import { INSET_FOCUS_RING } from "@decocms/ui/lib/focus-ring.ts";

/**
 * The ONE definition of how an interactive button in a panel header looks —
 * its resting/hover/selected colours, the timing they cross-fade on, and its
 * focus ring. Shared by `ToolbarIconButton` and `HeaderTabButton` so the
 * buttons that sit shoulder to shoulder in the main panel header (the chat
 * toggle, then the Preview / Content view tabs) cannot drift apart. They had:
 * two hover durations, and a focus ring on one of them only — the tabs fell
 * back to the browser's own stark white outline.
 *
 * The ring itself is {@link INSET_FOCUS_RING}, shared with the header buttons
 * that are not this shape — the branch picker, the page selector, the overflow
 * menu and the publish split button — so the whole row agrees.
 *
 * Metrics (size, padding, radius) stay with each component: these buttons are
 * deliberately different shapes, only the same skin.
 */
export function panelButtonChrome(active?: boolean): string {
  return cn(
    "[transition:background-color_180ms_ease,color_180ms_ease]",
    INSET_FOCUS_RING,
    active
      ? "bg-sidebar-accent text-sidebar-foreground"
      : "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground",
  );
}

export interface ToolbarIconButtonProps extends ComponentProps<"button"> {
  active?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function ToolbarIconButton({
  active,
  className,
  ref,
  type = "button",
  ...props
}: ToolbarIconButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "relative flex size-10 md:size-7 shrink-0 items-center justify-center rounded-md",
        "max-md:[&_svg]:size-5",
        panelButtonChrome(active),
        className,
      )}
      {...props}
    />
  );
}
