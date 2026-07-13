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
        // Chat shares the toggles portal with the preview view-mode buttons
        // (sections / code) — force it to the far right regardless of mount order.
        "order-last wco-no-drag inline-flex h-10 md:h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50",
        chatOpen
          ? "bg-sidebar-accent text-sidebar-foreground"
          : "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground",
      )}
    >
      <MessageCircle01 size={16} />
      <span>Chat</span>
    </button>
  );
}
