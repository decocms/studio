import { createContext, use } from "react";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import type { WorkspaceVisibility } from "@/hooks/use-layout-state";

export interface WorkspaceContextValue extends WorkspaceVisibility {
  virtualMcpId: string;
  entity: VirtualMCPEntity | null;
  threadId: string | null;
  toggleSidePanel: () => void;
  toggleMain: () => void;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(
  null,
);

/** Editors also render outside the workspace, where no project surface exists. */
export function useOptionalWorkspace(): WorkspaceContextValue | null {
  return use(WorkspaceContext);
}

export function useWorkspace(): WorkspaceContextValue {
  const workspace = useOptionalWorkspace();
  if (!workspace) throw new Error("Workspace pages require a workspace layout");
  return workspace;
}
