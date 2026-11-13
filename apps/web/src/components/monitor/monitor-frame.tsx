/** The frame every Monitor view sits in, the one that scrolls. */

import type { ReactNode } from "react";

/**
 * Every Monitor view sits in this frame. The main panel clips what it holds
 * (`overflow-hidden`), so something inside has to scroll: a view with its own
 * scroller fills the frame's height and scrolls itself, and anything taller
 * that doesn't scroll on its own (the Experiments results, a connect card)
 * makes the frame scroll instead of being cut off.
 */
export function MonitorFrame({
  tabs,
  children,
}: {
  tabs?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      {tabs}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
