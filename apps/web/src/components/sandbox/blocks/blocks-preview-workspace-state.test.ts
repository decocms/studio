import { describe, expect, test } from "bun:test";
import { previewDraftValue } from "@/components/sections-editor/preview-draft-link";
import {
  blocksPreviewWorkspaceReducer,
  INITIAL_BLOCKS_PREVIEW_WORKSPACE,
} from "./blocks-preview-workspace-state";

describe("blocksPreviewWorkspaceReducer", () => {
  test("selects a page", () => {
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
  });

  test("selects a loader", () => {
    const next = blocksPreviewWorkspaceReducer(
      INITIAL_BLOCKS_PREVIEW_WORKSPACE,
      {
        type: "select",
        target: { kind: "loader", key: "myLoader" },
      },
    );

    expect(next.target).toEqual({ kind: "loader", key: "myLoader" });
  });

  test("selecting a loader clears a stale variant override", () => {
    const withOverride = blocksPreviewWorkspaceReducer(
      INITIAL_BLOCKS_PREVIEW_WORKSPACE,
      {
        type: "variant-override",
        params: ["pages-home@sections.variants.1.rule=1"],
      },
    );

    const next = blocksPreviewWorkspaceReducer(withOverride, {
      type: "select",
      target: { kind: "loader", key: "myLoader" },
    });

    expect(next.variantOverride).toBeNull();
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
      variantOverride: null,
      focusedBlockKey: null,
    });
  });

  test("selecting a new target drops the block the JSON view was following", () => {
    const focused = blocksPreviewWorkspaceReducer(
      INITIAL_BLOCKS_PREVIEW_WORKSPACE,
      { type: "focus-block", key: "sections-SharedHero" },
    );
    expect(focused.focusedBlockKey).toBe("sections-SharedHero");

    const next = blocksPreviewWorkspaceReducer(focused, {
      type: "select",
      target: { kind: "page", key: "pages-about", path: "/about" },
    });

    expect(next.focusedBlockKey).toBeNull();
  });

  test("selecting a new target clears a pending SEO-edit intent", () => {
    const editing = blocksPreviewWorkspaceReducer(
      INITIAL_BLOCKS_PREVIEW_WORKSPACE,
      {
        type: "edit-seo",
        target: { kind: "page", key: "pages-home", path: "/" },
      },
    );

    const next = blocksPreviewWorkspaceReducer(editing, {
      type: "select",
      target: { kind: "page", key: "pages-about", path: "/about" },
    });

    expect(next.editSeoPageKey).toBeNull();
  });

  test("editing SEO for a new target clears a stale variant override", () => {
    const withOverride = blocksPreviewWorkspaceReducer(
      INITIAL_BLOCKS_PREVIEW_WORKSPACE,
      {
        type: "variant-override",
        params: ["pages-home@sections.variants.1.rule=1"],
      },
    );

    const next = blocksPreviewWorkspaceReducer(withOverride, {
      type: "edit-seo",
      target: { kind: "page", key: "pages-about", path: "/about" },
    });

    expect(next.variantOverride).toBeNull();
  });

  test("records variant override params for the preview iframe", () => {
    const next = blocksPreviewWorkspaceReducer(
      INITIAL_BLOCKS_PREVIEW_WORKSPACE,
      {
        type: "variant-override",
        params: ["pages-home@sections.variants.1.rule=1"],
      },
    );

    expect(next.variantOverride).toEqual([
      "pages-home@sections.variants.1.rule=1",
    ]);
  });

  test("selecting a new target clears a stale variant override", () => {
    const withOverride = blocksPreviewWorkspaceReducer(
      INITIAL_BLOCKS_PREVIEW_WORKSPACE,
      {
        type: "variant-override",
        params: ["pages-home@sections.variants.1.rule=1"],
      },
    );

    const next = blocksPreviewWorkspaceReducer(withOverride, {
      type: "select",
      target: { kind: "page", key: "pages-about", path: "/about" },
    });

    expect(next.variantOverride).toBeNull();
  });
});

describe('"Preview as" over a pinned variant', () => {
  const pinned = blocksPreviewWorkspaceReducer(
    INITIAL_BLOCKS_PREVIEW_WORKSPACE,
    { type: "variant-override", params: ["pages-home@sections=1"] },
  );

  test("changing it drops the pin, so its moment and tests decide", () => {
    expect(pinned.variantOverride).toEqual(["pages-home@sections=1"]);
    const next = blocksPreviewWorkspaceReducer(pinned, { type: "preview-as" });
    expect(next.variantOverride).toBeNull();
  });

  test("the frame's __draft then carries the test, not the pin", () => {
    const pointer = "delivery.example.com/sites/acme/drafts/s1/index.json@e1";
    const frame = (forced: string[] | null) =>
      previewDraftValue({
        pointer,
        forcedVariants: forced ?? [],
        previewOptions: { tests: { "hero-test": true } },
      })!;
    expect(frame(pinned.variantOverride)).toContain("__variant=");
    const next = blocksPreviewWorkspaceReducer(pinned, { type: "preview-as" });
    expect(frame(next.variantOverride)).not.toContain("__variant=");
    expect(frame(next.variantOverride)).toContain("__test=hero-test%3Don");
  });

  test("a variant picked afterwards pins again, on top of it", () => {
    const cleared = blocksPreviewWorkspaceReducer(pinned, {
      type: "preview-as",
    });
    const repinned = blocksPreviewWorkspaceReducer(cleared, {
      type: "variant-override",
      params: ["pages-home@sections=0"],
    });
    expect(repinned.variantOverride).toEqual(["pages-home@sections=0"]);
  });

  test("with no pin it changes nothing", () => {
    expect(
      blocksPreviewWorkspaceReducer(INITIAL_BLOCKS_PREVIEW_WORKSPACE, {
        type: "preview-as",
      }),
    ).toBe(INITIAL_BLOCKS_PREVIEW_WORKSPACE);
  });
});
