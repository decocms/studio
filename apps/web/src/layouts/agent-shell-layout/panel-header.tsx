/** The shared 48px strip used by the workspace's Chat panel header. */

import type { ComponentProps } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";

/**
 * 48px header strip for the workspace Chat panel. Route-owned Main surfaces
 * compose their own `Main.Topbar`.
 *
 * Declares `@container/panel-header`, the query container every control inside
 * degrades against. It has to be the panel header rather than the viewport:
 * this strip is one panel wide, so the same viewport yields very different
 * header widths depending on whether chat is open and how the splitter sits
 * (at a 1074px viewport the main header measures ~826px). Keying off the
 * viewport made controls collapse at widths that had nothing to do with the
 * room they actually had.
 */
export function PanelHeader({
  children,
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "@container/panel-header flex h-12 shrink-0 items-center gap-1 px-1.5",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
