import { createContext, useContext, type PropsWithChildren } from "react";

interface ChatBridge {
  sendMessage: (text: string) => void;
  openChat: () => void;
}

const ChatBridgeContext = createContext<ChatBridge | null>(null);

export function ChatBridgeProvider({
  children,
  sendMessage,
  openChat,
}: PropsWithChildren<ChatBridge>) {
  return (
    <ChatBridgeContext value={{ sendMessage, openChat }}>
      {children}
    </ChatBridgeContext>
  );
}

export function useChatBridge(): ChatBridge | null {
  return useContext(ChatBridgeContext);
}
