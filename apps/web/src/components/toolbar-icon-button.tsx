import type { ComponentProps, Ref } from "react";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { INSET_FOCUS_RING } from "@decocms/ui/lib/focus-ring.ts";
import { useCompactPageLayout } from "@/hooks/use-preferences";

/**
 * Shared colors, transitions, and focus treatment for panel icon controls.
 *
 * The ring itself is {@link INSET_FOCUS_RING}, shared with the header buttons
 * that are not this shape — the branch picker, the page selector, the overflow
 * menu and the publish split button — so the whole row agrees.
 *
 * Size can vary by placement; Button owns the shared radius and disabled state.
 */
export function panelButtonChrome(active?: boolean): string {
  return cn(
    "[transition:background-color_180ms_ease,color_180ms_ease] hover:bg-sidebar-accent hover:text-sidebar-foreground dark:hover:bg-sidebar-accent",
    INSET_FOCUS_RING,
    active
      ? "bg-sidebar-accent text-sidebar-foreground"
      : "text-sidebar-foreground/60",
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
  const compact = useCompactPageLayout();
  if (!compact) {
    return (
      <button
        ref={ref}
        // oxlint-disable-next-line react/button-has-type -- prop, defaulted to "button" above
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
  return (
    <Button
      ref={ref}
      type={type}
      variant="ghost"
      size="icon-sm"
      className={cn(
        "relative size-10 md:size-7",
        "max-md:[&_svg:not([class*='size-'])]:size-5",
        panelButtonChrome(active),
        className,
      )}
      {...props}
    />
  );
}
