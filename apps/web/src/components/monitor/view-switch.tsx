/**
 * A switch between views inside a card, drawn as the Monitor's own view tabs
 * (the pills under the page title) so the two read as the same control.
 */

import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";

function ViewSwitchRoot({
  label,
  className,
  children,
}: {
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex min-w-0 items-center gap-1", className)}
    >
      {children}
    </div>
  );
}

function ViewSwitchItem({
  pressed,
  icon = false,
  className,
  ...props
}: Omit<ComponentPropsWithoutRef<"button">, "type"> & {
  pressed: boolean;
  /** An icon alone: a square tab, so it rounds into a circle. */
  icon?: boolean;
}) {
  return (
    <Button
      {...props}
      type="button"
      variant="tab"
      size={icon ? "icon-sm" : "sm"}
      aria-pressed={pressed}
      className={cn("shrink-0", className)}
    />
  );
}

export const ViewSwitch = Object.assign(ViewSwitchRoot, {
  Item: ViewSwitchItem,
});
