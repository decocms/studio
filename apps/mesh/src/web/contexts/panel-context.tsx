import { createContext, useContext } from "react";
import type { ImperativePanelHandle } from "@deco/ui/components/resizable.tsx";

export interface PanelControls {
  chatOpen: boolean;
  tasksOpen: boolean;
  mainOpen: boolean;
  chatPanelRef: React.RefObject<ImperativePanelHandle | null>;
  tasksPanelRef: React.RefObject<ImperativePanelHandle | null>;
  mainPanelRef: React.RefObject<ImperativePanelHandle | null>;
  chatPanelWidth: number;
  onNewTask: React.MutableRefObject<(() => void) | null>;
}

const PanelContext = createContext<PanelControls | null>(null);

export const PanelContextProvider = PanelContext.Provider;

function usePanelContext() {
  const ctx = useContext(PanelContext);
  if (!ctx) {
    throw new Error(
      "usePanelContext must be used within a PanelContextProvider",
    );
  }
  return ctx;
}

export function useChatPanel() {
  const { chatOpen, chatPanelRef, chatPanelWidth } = usePanelContext();
  const openChat = () => {
    console.log("[useChatPanel] openChat called, resizing chatPanelRef to", Math.min(chatPanelWidth, 35));
    chatPanelRef.current?.resize(Math.min(chatPanelWidth, 35));
  };
  const closeChat = () => chatPanelRef.current?.collapse();
  const setChatOpen = (open: boolean) => {
    if (open) openChat();
    else closeChat();
  };
  return [chatOpen, setChatOpen] as const;
}

export function useTasksPanel() {
  const { tasksOpen, tasksPanelRef } = usePanelContext();
  const setTasksOpen = (open: boolean) => {
    if (open) tasksPanelRef.current?.expand();
    else tasksPanelRef.current?.collapse();
  };
  return [tasksOpen, setTasksOpen] as const;
}
