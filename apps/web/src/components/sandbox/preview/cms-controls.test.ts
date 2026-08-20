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

  it("hides them for a non-deco repo (decofile/meta 404 → framework missing)", () => {
    expect(
      showCmsControls({
        showPreviewToolbar: true,
        blocksState: { kind: "empty", reason: "framework-missing" },
      }),
    ).toBe(false);
  });

  it("keeps them for a deco site whose decofile has no pages yet (Create page stays reachable)", () => {
    expect(
      showCmsControls({
        showPreviewToolbar: true,
        blocksState: { kind: "empty", reason: "no-content" },
      }),
    ).toBe(true);
  });

  it("hides them while the reads are still in flight", () => {
    expect(
      showCmsControls({
        showPreviewToolbar: true,
        blocksState: { kind: "loading" },
      }),
    ).toBe(false);
  });

  it("keeps them when a read failed — absence is unproven, so don't revoke", () => {
    expect(
      showCmsControls({
        showPreviewToolbar: true,
        blocksState: { kind: "error", source: "data" },
      }),
    ).toBe(true);
    expect(
      showCmsControls({
        showPreviewToolbar: true,
        blocksState: { kind: "error", source: "sandbox" },
      }),
    ).toBe(true);
  });

  it("hides them when the toolbar itself is hidden", () => {
    expect(
      showCmsControls({
        showPreviewToolbar: false,
        blocksState: { kind: "empty", reason: "no-content" },
      }),
    ).toBe(false);
  });
});
