import { cn } from "@deco/ui/lib/utils.ts";
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
   * `"top"` for tall content (e.g. the connect-tools screen) so it scrolls
   * from the top on mobile instead of being centered and clipped by the
   * browser chrome; desktop stays centered.
   */
  align?: "center" | "top";
}

export function AuthSplitLayout({
  children,
  visual,
  align = "center",
}: AuthSplitLayoutProps) {
  return (
    <main className="flex min-h-screen w-full">
      <section
        className={cn(
          "flex flex-1 justify-center bg-sidebar px-6 md:px-10 md:py-10",
          align === "top"
            ? "items-start pt-4 pb-8 md:items-center"
            : "items-center py-6",
        )}
      >
        <div className="w-full max-w-[440px]">{children}</div>
      </section>
      <aside className="relative hidden md:flex flex-1 overflow-hidden bg-muted">
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
