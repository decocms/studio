import { describe, expect, test } from "bun:test";
import {
  resolveBlocksTabState,
  type BlocksTabStateInput,
} from "./blocks-tab-state";

const success = { status: "success" as const, hasData: true };

function input(
  overrides: Partial<BlocksTabStateInput> = {},
): BlocksTabStateInput {
  return {
    lifecyclePhase: "running",
    decofile: success,
    meta: success,
    hasEditableContent: false,
    ...overrides,
  };
}

describe("resolveBlocksTabState", () => {
  test("loads while the sandbox is progressing", () => {
    expect(
      resolveBlocksTabState(input({ lifecyclePhase: "installing" })),
    ).toEqual({ kind: "loading" });
  });

  test("loads while initial Deco data is pending", () => {
    expect(
      resolveBlocksTabState(
        input({ decofile: { status: "pending", hasData: false } }),
      ),
    ).toEqual({ kind: "loading" });
  });

  test("renders content when editable Deco content is available", () => {
    expect(resolveBlocksTabState(input({ hasEditableContent: true }))).toEqual({
      kind: "content",
    });
  });

  test("renders empty after both resources settle without editable content", () => {
    expect(resolveBlocksTabState(input())).toEqual({ kind: "empty" });
  });

  test.each(["clone-failed", "install-failed", "start-failed"] as const)(
    "renders a sandbox error for %s",
    (lifecyclePhase) => {
      expect(resolveBlocksTabState(input({ lifecyclePhase }))).toEqual({
        kind: "error",
        source: "sandbox",
      });
    },
  );

  test("renders editable content from the committed snapshot when crashed", () => {
    // Dev server paused/crashed but the committed `.deco/*.gen.json` is still
    // readable, so the Blocks editor stays available for FS-backed edits.
    expect(
      resolveBlocksTabState(
        input({ lifecyclePhase: "crashed", hasEditableContent: true }),
      ),
    ).toEqual({ kind: "content" });
  });

  test("loads while crashed and the committed snapshot is still pending", () => {
    expect(
      resolveBlocksTabState(
        input({
          lifecyclePhase: "crashed",
          decofile: { status: "pending", hasData: false },
          meta: { status: "pending", hasData: false },
        }),
      ),
    ).toEqual({ kind: "loading" });
  });

  test("renders setup when a Blocks endpoint is missing", () => {
    expect(
      resolveBlocksTabState(
        input({
          meta: { status: "error", hasData: false, errorStatus: 404 },
        }),
      ),
    ).toEqual({ kind: "empty" });
  });

  test("renders a data error when another initial request fails", () => {
    expect(
      resolveBlocksTabState(
        input({
          meta: { status: "error", hasData: false, errorStatus: 500 },
        }),
      ),
    ).toEqual({ kind: "error", source: "data" });
  });

  test("keeps cached editable content during a failed background refetch", () => {
    expect(
      resolveBlocksTabState(
        input({
          meta: { status: "error", hasData: true },
          hasEditableContent: true,
        }),
      ),
    ).toEqual({ kind: "content" });
  });
});
