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
  test.each(["idle", "cloning"] as const)(
    "loads while the daemon is not yet serving the snapshot (%s)",
    (lifecyclePhase) => {
      // Pre-daemon / pre-clone: the committed `.deco/*.gen.json` isn't readable
      // yet, so show loading regardless of the (necessarily stale) query state.
      expect(
        resolveBlocksTabState(
          input({ lifecyclePhase, hasEditableContent: true }),
        ),
      ).toEqual({ kind: "loading" });
    },
  );

  test.each(["checking-out", "installing", "starting"] as const)(
    "renders editable content from the committed snapshot while booting (%s)",
    (lifecyclePhase) => {
      // Repo is cloned and the daemon is up, so the snapshot is readable and the
      // Blocks editor opens before the dev server reaches `running` — matching
      // Content, which renders as soon as the sandbox handle exists.
      expect(
        resolveBlocksTabState(
          input({ lifecyclePhase, hasEditableContent: true }),
        ),
      ).toEqual({ kind: "content" });
    },
  );

  test.each(["checking-out", "installing", "starting"] as const)(
    "keeps loading (not a data error) when the snapshot is absent while booting (%s)",
    (lifecyclePhase) => {
      // An absent committed snapshot surfaces as a synthetic 502 from the read
      // fallback, not a 404. Before the dev server settles we must not flash a
      // red data-error card — the `→running` transition will resolve it.
      expect(
        resolveBlocksTabState(
          input({
            lifecyclePhase,
            decofile: { status: "error", hasData: false, errorStatus: 502 },
            meta: { status: "error", hasData: false, errorStatus: 502 },
          }),
        ),
      ).toEqual({ kind: "loading" });
    },
  );

  test("surfaces a data error once the dev server has settled (running)", () => {
    expect(
      resolveBlocksTabState(
        input({
          lifecyclePhase: "running",
          meta: { status: "error", hasData: false, errorStatus: 502 },
        }),
      ),
    ).toEqual({ kind: "error", source: "data" });
  });

  test("loads while the snapshot is still pending during boot (starting)", () => {
    expect(
      resolveBlocksTabState(
        input({
          lifecyclePhase: "starting",
          decofile: { status: "pending", hasData: false },
          meta: { status: "pending", hasData: false },
        }),
      ),
    ).toEqual({ kind: "loading" });
  });

  test("renders empty when the booting snapshot has no editable content (installing)", () => {
    expect(
      resolveBlocksTabState(input({ lifecyclePhase: "installing" })),
    ).toEqual({ kind: "empty" });
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
