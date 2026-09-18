import type { ReactNode } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";

/**
 * The glyph size the footer's three rows share: plan, invite, account.
 *
 * 16px, the same as every nav row above — the footer is the bottom of one
 * rail, not a block with its own scale. `shrink-0` so a glyph that arrives
 * wider is centred in the rail rather than squeezed back down to it.
 *
 * For an `Avatar`, ask for `size="2xs"` instead: it is the same 16px, but its
 * initials scale with it. Forcing the box by class leaves the type behind.
 */
export const SIDEBAR_FOOTER_ICON_SIZE = "size-4 shrink-0";

/**
 * The icon box the footer's three rows share: plan, invite, account.
 *
 * One definition rather than three, because "the same size with the same
 * padding around it" is a property of the box, not of each glyph. The box is
 * the sidebar's own rail: every nav row above centres its icon on the same
 * vertical line, and matching that is what keeps the footer from drifting off
 * it.
 */
export function SidebarFooterIcon({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn("flex w-4 shrink-0 items-center justify-center", className)}
    >
      {children}
    </span>
  );
}
