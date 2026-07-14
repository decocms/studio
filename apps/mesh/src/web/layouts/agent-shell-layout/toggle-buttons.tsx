import { MessageCircle01 } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { track } from "@/web/lib/posthog-client";

export interface ToggleButtonsProps {
  chatOpen: boolean;
  toggleChat: () => void;
  /**
   * When true, the chat toggle is disabled — chat is the only visible panel,
   * so turning it off would leave a blank content area.
   */
  disableChatToggle?: boolean;
}

/**
 * Top-toolbar chat toggle. (The New task action lives in the sidebar toolbar,
 * next to the thread list.)
 */
export function ToggleButtons({
  chatOpen,
  toggleChat,
  disableChatToggle = false,
}: ToggleButtonsProps) {
  return (
    <button
      type="button"
      onClick={() => {
        if (disableChatToggle) return;
        track("agent_toolbar_toggled", {
          button: "chat",
          next_state: !chatOpen ? "open" : "closed",
        });
        toggleChat();
      }}
      disabled={disableChatToggle}
      aria-pressed={chatOpen}
      aria-label="Chat"
      className={cn(
        // Chat is the leftmost item of the tab cluster (before Preview/Blocks/
        // Code). Match HeaderTabButton's metrics (h-8, gap, padding, icon +
        // label sizing) so it lines up pixel-for-pixel with the tabs; keep the
        // taller h-10 touch target on mobile.
        "wco-no-drag inline-flex h-10 md:h-8 shrink-0 items-center gap-1.5 rounded-md px-2 transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50",
        chatOpen
          ? "bg-sidebar-accent text-sidebar-foreground"
          : "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground",
      )}
    >
      <span className="flex size-5 items-center justify-center shrink-0">
        <MessageCircle01 size={16} />
      </span>
      <span className="whitespace-nowrap text-sm font-medium leading-none">
        Chat
      </span>
    </button>
  );
}
