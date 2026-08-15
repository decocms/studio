export type BlocksTarget =
  | { kind: "page"; key: string; path: string }
  | { kind: "section"; key: string }
  | { kind: "loader"; key: string };

export interface BlocksPreviewWorkspaceState {
  target: BlocksTarget | null;
  editSeoPageKey: string | null;
  /**
   * `x-deco-matchers-override` params published by the Blocks panel so the
   * (independent) Preview iframe renders the variant currently selected in the
   * sections editor. `null` clears any prior override.
   */
  variantOverride: string[] | null;
}

export type BlocksPreviewWorkspaceAction =
  | { type: "select"; target: BlocksTarget }
  | {
      type: "edit-seo";
      target: Extract<BlocksTarget, { kind: "page" }>;
    }
  | { type: "consume-edit-seo" }
  | { type: "variant-override"; params: string[] | null };

export const INITIAL_BLOCKS_PREVIEW_WORKSPACE: BlocksPreviewWorkspaceState = {
  target: null,
  editSeoPageKey: null,
  variantOverride: null,
};

export function blocksPreviewWorkspaceReducer(
  state: BlocksPreviewWorkspaceState,
  action: BlocksPreviewWorkspaceAction,
): BlocksPreviewWorkspaceState {
  switch (action.type) {
    case "select":
      // Selecting away drops the stale variant override and SEO-edit intent.
      return {
        ...state,
        target: action.target,
        variantOverride: null,
        editSeoPageKey: null,
      };
    case "edit-seo":
      // Switching target drops a variant override scoped to the prior selection, same as "select".
      return {
        ...state,
        target: action.target,
        editSeoPageKey: action.target.key,
        variantOverride: null,
      };
    case "consume-edit-seo":
      return { ...state, editSeoPageKey: null };
    case "variant-override":
      return { ...state, variantOverride: action.params };
  }
}
