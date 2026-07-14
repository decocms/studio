import { MessageCircle01, TextInput } from "@untitledui/icons";
import { HeaderTabButton } from "@/web/layouts/main-panel-tabs/header-tab-button";
import { track } from "@/web/lib/posthog-client";
import { LibraryToggle } from "./library-toggle";
import { TasksToggle } from "./tasks-toggle";

export interface ToggleButtonsProps {
  chatOpen: boolean;
  toggleChat: () => void;
  blocksAvailable?: boolean;
  blocksOpen?: boolean;
  toggleBlocks?: () => void;
  /**
   * When true, the chat toggle is disabled — chat is the only visible panel,
   * so turning it off would leave a blank content area.
   */
  disableChatToggle?: boolean;
  disableBlocksToggle?: boolean;
}

/**
 * Top-toolbar chat toggle. Renders through the shared HeaderTabButton so it
 * stays pixel-identical to the Main panel tabs (same height, icon and
 * label metrics, active/hover styling) — the only extras are the PWA titlebar
 * drag opt-out and a taller mobile touch target. (The New task action lives in
 * the sidebar toolbar, next to the thread list.)
 */
export function ToggleButtons({
  chatOpen,
  toggleChat,
  blocksAvailable = false,
  blocksOpen = false,
  toggleBlocks,
  disableChatToggle = false,
  disableBlocksToggle = false,
}: ToggleButtonsProps) {
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
      {blocksAvailable && toggleBlocks && (
        <HeaderTabButton
          title="Blocks"
          icon={{ kind: "component", Component: TextInput }}
          active={blocksOpen}
          disabled={disableBlocksToggle}
          className="wco-no-drag h-10 md:h-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
          onClick={() => {
            track("agent_toolbar_toggled", {
              button: "blocks",
              next_state: !blocksOpen ? "open" : "closed",
            });
            toggleBlocks();
          }}
        />
      )}
      {/* Tasks and Library are agent-independent overlays. */}
      <TasksToggle />
      <LibraryToggle />
    </>
  );
}
