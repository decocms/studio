export type BlocksTarget =
  | { kind: "page"; key: string; path: string }
  | { kind: "section"; key: string };

export interface BlocksPreviewWorkspaceState {
  target: BlocksTarget | null;
  editSeoPageKey: string | null;
  previewRevision: number;
}

export type BlocksPreviewWorkspaceAction =
  | { type: "select"; target: BlocksTarget }
  | {
      type: "edit-seo";
      target: Extract<BlocksTarget, { kind: "page" }>;
    }
  | { type: "consume-edit-seo" }
  | { type: "saved" };

export const INITIAL_BLOCKS_PREVIEW_WORKSPACE: BlocksPreviewWorkspaceState = {
  target: null,
  editSeoPageKey: null,
  previewRevision: 0,
};

export function blocksPreviewWorkspaceReducer(
  state: BlocksPreviewWorkspaceState,
  action: BlocksPreviewWorkspaceAction,
): BlocksPreviewWorkspaceState {
  switch (action.type) {
    case "select":
      return { ...state, target: action.target };
    case "edit-seo":
      return {
        ...state,
        target: action.target,
        editSeoPageKey: action.target.key,
      };
    case "consume-edit-seo":
      return { ...state, editSeoPageKey: null };
    case "saved":
      return { ...state, previewRevision: state.previewRevision + 1 };
  }
}
