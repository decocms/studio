import { cn } from "@deco/ui/lib/utils.ts";

/** Same asset as the Super Agent icon in getWellKnownDecopilotVirtualMCP. */
const DECOPILOT_ICON_URL =
  "https://assets.decocache.com/decocms/fd07a578-6b1c-40f1-bc05-88a3b981695d/f7fc4ffa81aec04e37ae670c3cd4936643a7b269.png";

/** Small avatar for the Deco agent. */
export function DecoAvatar({ className }: { className?: string }) {
  return (
    <img
      src={DECOPILOT_ICON_URL}
      alt="Deco"
      className={cn("size-4 shrink-0 rounded-full object-cover", className)}
    />
  );
}
