import { describe, expect, test } from "bun:test";
import {
  blocksPreviewWorkspaceReducer,
  INITIAL_BLOCKS_PREVIEW_WORKSPACE,
} from "./blocks-preview-workspace-state";

describe("blocksPreviewWorkspaceReducer", () => {
  test("selects a page without requesting a preview refresh", () => {
    const next = blocksPreviewWorkspaceReducer(
      INITIAL_BLOCKS_PREVIEW_WORKSPACE,
      {
        type: "select",
        target: { kind: "page", key: "pages-home", path: "/" },
      },
    );

    expect(next.target).toEqual({
      kind: "page",
      key: "pages-home",
      path: "/",
    });
    expect(next.previewRevision).toBe(0);
  });

  test("save requests exactly one preview refresh", () => {
    const next = blocksPreviewWorkspaceReducer(
      INITIAL_BLOCKS_PREVIEW_WORKSPACE,
      { type: "saved" },
    );

    expect(next.previewRevision).toBe(1);
  });

  test("edit SEO records both target and intent", () => {
    const next = blocksPreviewWorkspaceReducer(
      INITIAL_BLOCKS_PREVIEW_WORKSPACE,
      {
        type: "edit-seo",
        target: { kind: "page", key: "pages-home", path: "/" },
      },
    );

    expect(next.editSeoPageKey).toBe("pages-home");
    expect(next.target?.key).toBe("pages-home");
  });

  test("consumes an SEO intent without changing the selection", () => {
    const editing = blocksPreviewWorkspaceReducer(
      INITIAL_BLOCKS_PREVIEW_WORKSPACE,
      {
        type: "edit-seo",
        target: { kind: "page", key: "pages-home", path: "/" },
      },
    );

    expect(
      blocksPreviewWorkspaceReducer(editing, { type: "consume-edit-seo" }),
    ).toEqual({
      target: { kind: "page", key: "pages-home", path: "/" },
      editSeoPageKey: null,
      previewRevision: 0,
    });
  });
});
