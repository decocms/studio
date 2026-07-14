import { MessageCircle01 } from "@untitledui/icons";
import { useReportsOnly } from "@/web/hooks/use-organization-settings";
import { HeaderTabButton } from "@/web/layouts/main-panel-tabs/header-tab-button";
import { track } from "@/web/lib/posthog-client";
import { LibraryToggle } from "./library-toggle";

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
 * Top-toolbar chat toggle. Renders through the shared HeaderTabButton so it
 * stays pixel-identical to the Preview/Blocks/Code tabs (same height, icon and
 * label metrics, active/hover styling) — the only extras are the PWA titlebar
 * drag opt-out and a taller mobile touch target. (The New task action lives in
 * the sidebar toolbar, next to the thread list.)
 */
export function ToggleButtons({
  chatOpen,
  toggleChat,
  disableChatToggle = false,
}: ToggleButtonsProps) {
  // Reports-only orgs collapse the toolbar to just the chat toggle.
  const reportsOnly = useReportsOnly();
  return (
    <>
      <HeaderTabButton
        title="Chat"
        icon={{ kind: "component", Component: MessageCircle01 }}
        active={chatOpen}
        disabled={disableChatToggle}
        className="wco-no-drag h-10 md:h-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
        onClick={() => {
          track("agent_toolbar_toggled", {
            button: "chat",
            next_state: !chatOpen ? "open" : "closed",
          });
          toggleChat();
        }}
      />
      {/* Library is agent-independent, so it lives here in the left group next
          to Chat rather than in the per-agent tab bar on the right. */}
      {!reportsOnly && <LibraryToggle />}
    </>
  );
}
