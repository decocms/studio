import { createContext, useContext } from "react";

export interface PanelControls {
  chatOpen: boolean;
  tasksOpen: boolean;
  mainOpen: boolean;
  onNewTask: React.MutableRefObject<(() => void) | null>;
  setChatOpen: (open: boolean) => void;
  setTasksOpen: (open: boolean) => void;
  setTaskId: (taskId: string) => void;
  createNewTask: () => void;
  openMainView: (
    view: string,
    opts?: { id?: string; toolName?: string },
  ) => void;
  closeMainView: () => void;
}

export const PanelContext = createContext<PanelControls | null>(null);

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
  const { chatOpen, setChatOpen } = usePanelContext();
  return [chatOpen, setChatOpen] as const;
}

export function useTasksPanel() {
  const { tasksOpen, setTasksOpen } = usePanelContext();
  return [tasksOpen, setTasksOpen] as const;
}

export function useMainViewActions() {
  const { openMainView, closeMainView } = usePanelContext();
  return { openMainView, closeMainView };
}

export function useTaskActions() {
  const { setTaskId, createNewTask } = usePanelContext();
  return { setTaskId, createNewTask };
}
