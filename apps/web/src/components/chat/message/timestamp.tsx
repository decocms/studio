import type { UIMessage } from "ai";
import { cn } from "@decocms/ui/lib/utils.ts";
import { toEpochMs } from "../../../lib/format-time.ts";

/**
 * Small muted label showing when a message was sent. Reads the server-stamped
 * top-level `created_at` (fallback: `metadata.created_at`) that every persisted
 * message row carries; renders nothing for optimistic rows not yet stamped.
 */
export function MessageTimestamp({
  message,
  className,
}: {
  message: UIMessage;
  className?: string;
}) {
  const raw =
    (message as unknown as { created_at?: string | Date | null }).created_at ??
    (message.metadata as { created_at?: string | Date | null } | undefined)
      ?.created_at ??
    null;
  const ms = toEpochMs(raw);
  if (ms === null) return null;

  const date = new Date(ms);
  return (
    <span
      title={date.toLocaleString()}
      className={cn(
        "text-[11px] text-muted-foreground/60 select-none",
        className,
      )}
    >
      {date.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      })}
    </span>
  );
}
