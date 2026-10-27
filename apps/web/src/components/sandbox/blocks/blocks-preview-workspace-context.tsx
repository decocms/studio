import { createContext, use, useState, type ReactNode } from "react";
import {
  blocksPreviewWorkspaceReducer,
  INITIAL_BLOCKS_PREVIEW_WORKSPACE,
  type BlocksPreviewWorkspaceAction,
  type BlocksPreviewWorkspaceState,
  type BlocksTarget,
} from "./blocks-preview-workspace-state";

interface BlocksPreviewWorkspaceContextValue {
  state: BlocksPreviewWorkspaceState;
  selectTarget: (target: BlocksTarget) => void;
  editSeo: (target: Extract<BlocksTarget, { kind: "page" }>) => void;
  consumeEditSeo: () => void;
  setVariantOverride: (params: string[] | null) => void;
  setFocusedBlock: (key: string | null) => void;
}

const BlocksPreviewWorkspaceContext =
  createContext<BlocksPreviewWorkspaceContextValue | null>(null);

export function BlocksPreviewWorkspaceProvider({
  resetKey,
  children,
}: {
  /** Starts the workspace over when it changes, without remounting `children`
   *  the way a `key` would. */
  resetKey?: string;
  children: ReactNode;
}) {
  const [workspace, setWorkspace] = useState({
    key: resetKey,
    state: INITIAL_BLOCKS_PREVIEW_WORKSPACE,
  });
  const state =
    workspace.key === resetKey
      ? workspace.state
      : INITIAL_BLOCKS_PREVIEW_WORKSPACE;
  const dispatch = (action: BlocksPreviewWorkspaceAction) =>
    setWorkspace((prev) => ({
      key: resetKey,
      state: blocksPreviewWorkspaceReducer(
        prev.key === resetKey ? prev.state : INITIAL_BLOCKS_PREVIEW_WORKSPACE,
        action,
      ),
    }));

  return (
    <BlocksPreviewWorkspaceContext
      value={{
        state,
        selectTarget: (target) => dispatch({ type: "select", target }),
        editSeo: (target) => dispatch({ type: "edit-seo", target }),
        consumeEditSeo: () => dispatch({ type: "consume-edit-seo" }),
        setVariantOverride: (params) =>
          dispatch({ type: "variant-override", params }),
        setFocusedBlock: (key) => dispatch({ type: "focus-block", key }),
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
