import { createContext, use, useReducer, type ReactNode } from "react";
import {
  blocksPreviewWorkspaceReducer,
  INITIAL_BLOCKS_PREVIEW_WORKSPACE,
  type BlocksPreviewWorkspaceState,
  type BlocksTarget,
} from "./blocks-preview-workspace-state";

interface BlocksPreviewWorkspaceContextValue {
  state: BlocksPreviewWorkspaceState;
  selectTarget: (target: BlocksTarget) => void;
  editSeo: (target: Extract<BlocksTarget, { kind: "page" }>) => void;
  consumeEditSeo: () => void;
  notifySaved: () => void;
}

const BlocksPreviewWorkspaceContext =
  createContext<BlocksPreviewWorkspaceContextValue | null>(null);

export function BlocksPreviewWorkspaceProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(
    blocksPreviewWorkspaceReducer,
    INITIAL_BLOCKS_PREVIEW_WORKSPACE,
  );

  return (
    <BlocksPreviewWorkspaceContext
      value={{
        state,
        selectTarget: (target) => dispatch({ type: "select", target }),
        editSeo: (target) => dispatch({ type: "edit-seo", target }),
        consumeEditSeo: () => dispatch({ type: "consume-edit-seo" }),
        notifySaved: () => dispatch({ type: "saved" }),
      }}
    >
      {children}
    </BlocksPreviewWorkspaceContext>
  );
}

export function useBlocksPreviewWorkspace(): BlocksPreviewWorkspaceContextValue {
  const value = use(BlocksPreviewWorkspaceContext);
  if (!value) {
    throw new Error(
      "useBlocksPreviewWorkspace must be used inside BlocksPreviewWorkspaceProvider",
    );
  }
  return value;
}
