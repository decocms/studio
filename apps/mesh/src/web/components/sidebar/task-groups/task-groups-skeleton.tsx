import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { useSidebar } from "@deco/ui/components/sidebar.tsx";
import { cn } from "@deco/ui/lib/utils.ts";

const COLLAPSED_ITEMS = 5;
const EXPANDED_GROUPS = [
  { nameWidth: "w-24", taskRows: 2 },
  { nameWidth: "w-28", taskRows: 0 },
  { nameWidth: "w-20", taskRows: 1 },
  { nameWidth: "w-32", taskRows: 0 },
  { nameWidth: "w-24", taskRows: 0 },
] as const;

export function TaskGroupsSkeleton() {
  const { state } = useSidebar();
  if (state === "collapsed") {
    return (
      <div className="flex flex-col gap-1.5">
        {Array.from({ length: COLLAPSED_ITEMS }).map((_, i) => (
          <Skeleton key={i} className="size-10 rounded-lg mx-auto" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 px-1 h-10 md:h-7 mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1">
          <Skeleton className="size-6 rounded-md" />
          <Skeleton className="size-6 rounded-md" />
          <Skeleton className="size-6 rounded-md" />
        </div>
        <Skeleton className="h-6 w-20 rounded-md" />
      </div>
      <div className="flex flex-col gap-0.5">
        {EXPANDED_GROUPS.map((group, i) => (
          <div key={i} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2 px-2 py-1.5">
              <Skeleton className="size-5 rounded-full shrink-0" />
              <Skeleton className={cn("h-3", group.nameWidth, "rounded-sm")} />
            </div>
            {group.taskRows > 0 && (
              <div className="flex flex-col gap-0.5 pb-1 pl-4">
                {Array.from({ length: group.taskRows }).map((_, j) => (
                  <div key={j} className="flex items-center gap-2 px-2 py-1.5">
                    <Skeleton className="h-3 flex-1 rounded-sm" />
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
