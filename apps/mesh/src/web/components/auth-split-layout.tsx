import type { ReactNode } from "react";

interface AuthSplitLayoutProps {
  children: ReactNode;
  /**
   * Content for the right-side panel. Defaults to an empty placeholder —
   * pass a node here to drop in an image or any other visual.
   */
  visual?: ReactNode;
}

export function AuthSplitLayout({ children, visual }: AuthSplitLayoutProps) {
  return (
    <main className="flex min-h-screen w-full">
      <section className="flex flex-1 items-center justify-center bg-sidebar p-6 md:p-10">
        <div className="w-full max-w-[440px]">{children}</div>
      </section>
      <aside className="relative flex-1 overflow-hidden bg-white">
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
