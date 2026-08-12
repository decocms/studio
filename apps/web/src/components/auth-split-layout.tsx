import { cn } from "@decocms/ui/lib/utils.ts";
import type { ReactNode } from "react";

interface AuthSplitLayoutProps {
  children: ReactNode;
  /**
   * Content for the right-side panel. Defaults to an empty placeholder —
   * pass a node here to drop in an image or any other visual.
   */
  visual?: ReactNode;
  /**
   * Vertical alignment of the left column. Defaults to `"center"`. Use
   * `"fill"` for tall app-shell content (e.g. the connect-tools screen): on
   * mobile the column becomes exactly one dynamic-viewport tall and hands its
   * inner content area a flex context, so a child can use `flex-1`/`h-full` to
   * fill the available space (header pinned, body scrolls, footer pinned)
   * without hardcoding this component's padding. Desktop stays centered.
   */
  align?: "center" | "fill";
}

export function AuthSplitLayout({
  children,
  visual,
  align = "center",
}: AuthSplitLayoutProps) {
  const fill = align === "fill";
  return (
    <main
      className={cn(
        "flex w-full",
        // A fill screen owns exactly the visible (dynamic) viewport on mobile so
        // its pinned footer never sits behind the browser chrome; min-h-screen
        // elsewhere lets short screens still cover the fold.
        fill ? "min-h-[100dvh] md:min-h-screen" : "min-h-screen",
      )}
    >
      <section
        className={cn(
          "flex flex-1 flex-col items-center bg-sidebar px-6 md:justify-center md:px-10 md:py-10",
          fill
            ? "h-[100dvh] justify-start pt-4 pb-8 md:h-auto"
            : "justify-center py-6",
        )}
      >
        <div
          className={cn(
            "w-full max-w-[440px]",
            // Give the content a flex column that fills the padded viewport so
            // children fill via flex-1 instead of duplicating the padding above.
            fill && "flex min-h-0 flex-1 flex-col md:block md:flex-none",
          )}
        >
          {children}
        </div>
      </section>
      <aside className="relative hidden flex-1 overflow-hidden bg-muted md:flex">
        {visual ?? (
          <img
            src="/onboarding-placeholder.png"
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
      </aside>
    </main>
  );
}
