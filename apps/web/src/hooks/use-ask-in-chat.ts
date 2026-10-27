import { useChatStream } from "@/components/chat/context";
import { usePanelActions } from "@/layouts/shell-layout";

/** Hands a prompt to the chat beside the page, opening it. */
export function useAskInChat() {
  const { sendMessage } = useChatStream();
  const { openSidePanel } = usePanelActions();
  return (text: string) => {
    openSidePanel();
    void sendMessage({ parts: [{ type: "text", text }] });
  };
}
