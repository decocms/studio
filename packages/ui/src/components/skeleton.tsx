import { cn } from "../lib/utils.ts";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("bg-neutral-3 animate-pulse rounded-xs", className)}
      {...props}
    />
  );
}

export { Skeleton };
