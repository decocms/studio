import { describe, expect, it } from "bun:test";
import { showCmsPageSelector } from "./cms-controls";

describe("showCmsPageSelector", () => {
  it("shows it for a deco site (blocks resolved to content)", () => {
    expect(
      showCmsPageSelector({
        showPreviewToolbar: true,
        blocksState: { kind: "content" },
      }),
    ).toBe(true);
  });

  it("hides it for a non-deco repo (decofile/meta 404 → framework missing)", () => {
    expect(
      showCmsPageSelector({
        showPreviewToolbar: true,
        blocksState: { kind: "empty", reason: "framework-missing" },
      }),
    ).toBe(false);
  });

  it("keeps it for a deco site whose decofile has no pages yet (Create page stays reachable)", () => {
    expect(
      showCmsPageSelector({
        showPreviewToolbar: true,
        blocksState: { kind: "empty", reason: "no-content" },
      }),
    ).toBe(true);
  });

  it("hides it while the reads are still in flight", () => {
    expect(
      showCmsPageSelector({
        showPreviewToolbar: true,
        blocksState: { kind: "loading" },
      }),
    ).toBe(false);
  });

  it("keeps it when a read failed — absence is unproven, so don't revoke", () => {
    expect(
      showCmsPageSelector({
        showPreviewToolbar: true,
        blocksState: { kind: "error", source: "data" },
      }),
    ).toBe(true);
    expect(
      showCmsPageSelector({
        showPreviewToolbar: true,
        blocksState: { kind: "error", source: "sandbox" },
      }),
    ).toBe(true);
  });

  it("hides it when the toolbar itself is hidden", () => {
    expect(
      showCmsPageSelector({
        showPreviewToolbar: false,
        blocksState: { kind: "empty", reason: "no-content" },
      }),
    ).toBe(false);
  });
});
