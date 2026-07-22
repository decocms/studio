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
  setVariantOverride: (params: string[] | null) => void;
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
        setVariantOverride: (params) =>
          dispatch({ type: "variant-override", params }),
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
