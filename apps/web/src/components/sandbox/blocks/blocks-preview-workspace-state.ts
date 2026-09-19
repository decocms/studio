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
  /**
   * The decofile key of the block whose form the sections editor is currently
   * showing — a page, or the global section opened inside it. The JSON view
   * follows it so it shows the block being edited rather than the page that
   * happens to contain it. `null` falls back to the active page.
   */
  focusedBlockKey: string | null;
}

export type BlocksPreviewWorkspaceAction =
  | { type: "select"; target: BlocksTarget }
  | {
      type: "edit-seo";
      target: Extract<BlocksTarget, { kind: "page" }>;
    }
  | { type: "consume-edit-seo" }
  | { type: "variant-override"; params: string[] | null }
  | { type: "focus-block"; key: string | null };

export const INITIAL_BLOCKS_PREVIEW_WORKSPACE: BlocksPreviewWorkspaceState = {
  target: null,
  editSeoPageKey: null,
  variantOverride: null,
  focusedBlockKey: null,
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
        focusedBlockKey: null,
      };
    case "edit-seo":
      // Switching target drops a variant override scoped to the prior selection, same as "select".
      return {
        ...state,
        target: action.target,
        editSeoPageKey: action.target.key,
        variantOverride: null,
        focusedBlockKey: null,
      };
    case "consume-edit-seo":
      return { ...state, editSeoPageKey: null };
    case "variant-override":
      return { ...state, variantOverride: action.params };
    case "focus-block":
      return { ...state, focusedBlockKey: action.key };
  }
}
