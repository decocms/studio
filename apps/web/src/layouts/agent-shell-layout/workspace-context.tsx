import { createContext, use, type PropsWithChildren } from "react";
import type {
  WorkspaceLayoutActions,
  WorkspaceLayoutState,
} from "@/hooks/use-layout-state";

export type WorkspaceContextValue = WorkspaceLayoutState &
  WorkspaceLayoutActions;

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({
  children,
  value,
}: PropsWithChildren<{ value: WorkspaceContextValue }>) {
  return <WorkspaceContext value={value}>{children}</WorkspaceContext>;
}

export function useWorkspace(): WorkspaceContextValue {
  const context = use(WorkspaceContext);
  if (!context) {
    throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  }
  return context;
}
