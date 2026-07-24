import { cn } from "@deco/ui/lib/utils.ts";

export function DecoChatSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("flex h-full w-full flex-col bg-background", className)}>
      {/* Header skeleton */}
      <div className="flex items-center h-12 flex-none border-b border-border/80 px-4">
        <div className="flex items-center justify-between gap-3 w-full">
          <div className="flex items-center gap-3">
            {/* Avatar skeleton */}
            <div className="size-6 rounded-lg bg-muted animate-pulse" />
            <div className="flex flex-col gap-2">
              {/* Title skeleton */}
              <div className="h-3.5 w-28 rounded bg-muted animate-pulse" />
              {/* Subtitle skeleton */}
              <div className="h-3 w-40 rounded bg-muted/60 animate-pulse" />
            </div>
          </div>
          <div className="flex items-end gap-2">
            {/* Badge skeleton */}
            <div className="h-6 w-6 rounded-full bg-muted animate-pulse" />
            {/* Model selector skeleton */}
            <div className="h-6 w-6 rounded-lg bg-muted animate-pulse" />
          </div>
        </div>
      </div>

      {/* Messages area skeleton */}
      <div className="flex-1 overflow-hidden px-4 py-4">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
          {/* Example message bubbles */}
          <MessageSkeleton align="right" width="w-3/4" />
          <MessageSkeleton align="left" width="w-full" lines={3} />
          <MessageSkeleton align="right" width="w-2/3" />
          <MessageSkeleton align="left" width="w-5/6" lines={2} />
        </div>
      </div>

      {/* Input area skeleton */}
      <div className="px-4 py-4">
        <div className="mx-auto w-full max-w-2xl">
          {/* Input box skeleton */}
          <div className="relative flex min-h-[130px] flex-col rounded-xl bg-background card-shadow">
            <div className="relative flex flex-1 flex-col gap-2 p-2.5">
              <div className="relative flex-1">
                {/* Text area lines */}
                <div className="space-y-2 p-2">
                  <div className="h-3 w-full rounded bg-muted/40 animate-pulse" />
                  <div className="h-3 w-4/5 rounded bg-muted/40 animate-pulse" />
                </div>
              </div>
            </div>
            <div className="flex items-center justify-between px-2.5 pb-2.5">
              <div className="flex items-center gap-1">
                {/* Left button skeleton */}
                <div className="size-8 rounded-full bg-muted/60 animate-pulse" />
              </div>
              <div className="flex items-center gap-1">
                {/* Right actions skeleton */}
                <div className="h-8 w-32 rounded-lg bg-muted/60 animate-pulse" />
                <div className="size-8 rounded-full bg-muted animate-pulse" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface MessageSkeletonProps {
  align: "left" | "right";
  width?: string;
  lines?: number;
}

function MessageSkeleton({
  align,
  width = "w-full",
  lines = 1,
}: MessageSkeletonProps) {
  return (
    <div
      className={cn(
        "flex w-full gap-4 px-4 py-2",
        align === "right" ? "flex-row-reverse" : "flex-row",
      )}
    >
      <div
        className={cn(
          "flex min-w-0 flex-col gap-2",
          align === "right"
            ? "ml-auto max-w-3/4 items-end"
            : "w-full items-start",
        )}
      >
        {/* Timestamp skeleton */}
        <div className="h-3 w-16 rounded bg-muted/40 animate-pulse" />

        {/* Message content skeleton */}
        <div
          className={cn(
            "min-w-0 rounded-2xl p-4",
            align === "right"
              ? "bg-muted"
              : "bg-transparent border border-border/40",
            width,
          )}
        >
          <div className="space-y-2">
            {Array.from({ length: lines }).map((_, i) => (
              <div
                key={i}
                className={cn(
                  "h-3 rounded bg-muted-foreground/20 animate-pulse",
                  i === lines - 1 ? "w-3/4" : "w-full",
                )}
                style={{
                  animationDelay: `${i * 0.1}s`,
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
