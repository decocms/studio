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
    expect(
      resolveBlocksTabState(input({ hasEditableContent: true })),
    ).toEqual({ kind: "content" });
  });

  test("renders empty after both resources settle without editable content", () => {
    expect(resolveBlocksTabState(input())).toEqual({ kind: "empty" });
  });

  test.each([
    "clone-failed",
    "install-failed",
    "start-failed",
    "crashed",
  ] as const)("renders a sandbox error for %s", (lifecyclePhase) => {
    expect(resolveBlocksTabState(input({ lifecyclePhase }))).toEqual({
      kind: "error",
      source: "sandbox",
    });
  });

  test("renders a data error when an initial request fails", () => {
    expect(
      resolveBlocksTabState(
        input({ meta: { status: "error", hasData: false } }),
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
