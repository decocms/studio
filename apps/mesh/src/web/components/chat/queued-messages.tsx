/**
 * Pending message bubbles shown above the input — one per row in the
 * thread's gate queue, ordered oldest → newest. Clicking the X cancels
 * the message before the dispatcher claims it; once dispatch starts the
 * row is gone from this list (it'll surface as the streaming response in
 * the chat instead).
 *
 * Pure presentational — state lives in `useThreadQueue`.
 */

import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { X } from "@untitledui/icons";
import type { QueuedItem } from "./hooks/use-thread-queue";

interface QueuedMessagesProps {
  items: QueuedItem[];
  onCancel: (id: string) => void;
  className?: string;
}

export function QueuedMessages({
  items,
  onCancel,
  className,
}: QueuedMessagesProps) {
  if (items.length === 0) return null;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {items.map((item) => (
        <div
          key={item.id}
          className={cn(
            "group flex items-center gap-2 rounded-lg border border-dashed",
            "bg-muted/40 px-3 py-2 text-sm text-muted-foreground",
          )}
        >
          <span className="flex-1 truncate" title={item.content}>
            {item.content || "(no text)"}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 w-6 shrink-0 p-0 opacity-60 hover:opacity-100"
            onClick={() => onCancel(item.id)}
            aria-label="Remove queued message"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
}
