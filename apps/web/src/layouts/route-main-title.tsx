import { useRouterState } from "@tanstack/react-router";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Main } from "@/components/main";

/** Page identity and dynamic title contributions, independent of parent navigation. */
export function RouteMainTitle({
  title,
  hidden = false,
  compact = false,
  className,
}: {
  title: string;
  hidden?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  return (
    <Main.Title
      key={pathname}
      dir="auto"
      data-route-focus-identity={pathname}
      data-route-focus-pathname={pathname}
      className={cn(
        "min-w-0 flex-1",
        hidden ? "sr-only" : compact && "sr-only md:not-sr-only md:truncate",
        className,
      )}
    >
      <Main.Title.Target fallback={<span title={title}>{title}</span>} />
    </Main.Title>
  );
}
