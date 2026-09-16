/** The ONE sidebar shell — header, back row, body, footer — and the only place
 *  those four are spaced. Three sidebars used to hand-roll this arrangement
 *  (desktop org, mobile org, settings), each with its own padding, gaps and
 *  margins, so the same row landed at a different height depending on which
 *  shell it was dropped into. A caller now chooses only WHAT goes in a slot;
 *  never how far apart the slots sit. */

import type { ReactNode } from "react";
import { Sidebar, SidebarContent } from "@decocms/ui/components/sidebar.tsx";
import { LAYOUT_TOUR_ANCHORS } from "@/components/layout-tour/anchors";

interface SidebarShellProps {
  /** The top strip. A row beside the picker when the sidebar is open, a column
   *  under it in the icon rail — the same children, one flex-direction apart.
   *  It stays RENDERED when collapsed, which is what lets the rail keep the
   *  org/project mark and the collapse toggle without the body rebuilding a
   *  second copy of them. */
  header?: ReactNode;
  /** The "← Back to X" row, above the body and STICKY, so the way out is never
   *  scrolled away from. Sticky rather than a sibling above the scroller
   *  because this row only exists on some routes: a slot that is 48px in
   *  settings and 0px on the org root moved the whole nav list when you
   *  navigated between them. Inside, the scroll box never changes. */
  back?: ReactNode;
  /** The nav itself. The shell owns the scrolling, so a body is a plain list. */
  body: ReactNode;
  /** Pinned under the body. */
  footer?: ReactNode;
  /** Set when a mobile Sheet already supplies the surface. `<Sidebar>` renders
   *  its OWN Sheet on mobile, bound to `openMobile`, so mounting it inside one
   *  would nest two — the sheet variant paints the surface and declares the
   *  `group/sidebar` collapse context itself instead. This is the whole reason
   *  a second shell component ever existed. */
  sheet?: boolean;
}

/** The gutter a panel card puts above its own 48px `Page.Header`
 *  (`ChatLayout`'s `pt-1` plus its card wrapper's `p-0.5`). The sidebar has
 *  no card, so it repeats the inset here to start its header on the same line.
 *  Invisible: the gutter it exposes is `bg-sidebar`, same as the sidebar. */
const SIDEBAR_TOP_INSET = "pt-1.5";

export function SidebarShell({
  header,
  back,
  body,
  footer,
  sheet,
}: SidebarShellProps) {
  const content = (
    <>
      {header && (
        <div
          data-slot="sidebar-picker-header"
          className="flex h-12 shrink-0 flex-row items-center gap-1 px-2 group-data-[state=collapsed]/sidebar:h-auto group-data-[state=collapsed]/sidebar:flex-col group-data-[state=collapsed]/sidebar:gap-2 group-data-[state=collapsed]/sidebar:py-2"
        >
          {header}
        </div>
      )}
      <SidebarContent className="gap-0 overflow-y-auto px-2 pt-3 pb-2 group-data-[state=collapsed]/sidebar:[scrollbar-width:none] group-data-[state=collapsed]/sidebar:[&::-webkit-scrollbar]:hidden">
        {back && (
          <div className="sticky top-0 z-10 shrink-0 bg-sidebar pb-1">
            {back}
          </div>
        )}
        {body}
      </SidebarContent>
      {footer}
    </>
  );

  if (sheet) {
    return (
      <div
        className="group/sidebar flex h-full w-full flex-col bg-sidebar text-sidebar-foreground"
        data-sidebar="sidebar"
        data-state="expanded"
        data-tour={LAYOUT_TOUR_ANCHORS.nav}
      >
        {content}
      </div>
    );
  }

  /** The tour's "navigation lives here" step highlights the WHOLE sidebar, so
   *  the anchor belongs on the shell rather than on any one list inside it —
   *  and on both surfaces, since this component is the only sidebar there is.
   *  `Sidebar` spreads its extra props onto `sidebar-container`, a real
   *  full-height element, so the spotlight gets a box worth drawing.
   *
   *  Desktop and mobile can both be mounted, but only one is ever VISIBLE (the
   *  desktop shell is `hidden md:flex`), and the tour drops a step whose first
   *  match is hidden — so the duplicate degrades to a skipped step, never to a
   *  spotlight on an invisible box. */
  return (
    <Sidebar className={SIDEBAR_TOP_INSET} data-tour={LAYOUT_TOUR_ANCHORS.nav}>
      {content}
    </Sidebar>
  );
}
