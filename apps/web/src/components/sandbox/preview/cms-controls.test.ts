import { describe, expect, it } from "bun:test";
import { showCmsControls } from "./cms-controls";

describe("showCmsControls", () => {
  it("shows them for a deco site (blocks resolved to content)", () => {
    expect(
      showCmsControls({
        showPreviewToolbar: true,
        blocksState: { kind: "content" },
      }),
    ).toBe(true);
  });

  it("hides them for a non-deco repo (no decofile → empty)", () => {
    expect(
      showCmsControls({
        showPreviewToolbar: true,
        blocksState: { kind: "empty" },
      }),
    ).toBe(false);
  });

  it("hides them while the reads are still in flight", () => {
    expect(
      showCmsControls({
        showPreviewToolbar: true,
        blocksState: { kind: "loading" },
      }),
    ).toBe(false);
  });

  it("hides them when the reads failed", () => {
    expect(
      showCmsControls({
        showPreviewToolbar: true,
        blocksState: { kind: "error", source: "data" },
      }),
    ).toBe(false);
  });

  it("hides them when the toolbar itself is hidden", () => {
    expect(
      showCmsControls({
        showPreviewToolbar: false,
        blocksState: { kind: "content" },
      }),
    ).toBe(false);
  });
});
