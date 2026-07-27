import { describe, expect, test } from "bun:test";
import { shouldAutoOpenCms, togglePreviewEditorMode } from "./editing-mode";

describe("togglePreviewEditorMode", () => {
  test("activates an editor from the neutral preview", () => {
    expect(togglePreviewEditorMode("preview", "visual")).toBe("visual");
    expect(togglePreviewEditorMode("preview", "blocks")).toBe("blocks");
  });

  test("turns off the active editor", () => {
    expect(togglePreviewEditorMode("visual", "visual")).toBe("preview");
    expect(togglePreviewEditorMode("blocks", "blocks")).toBe("preview");
  });

  test("switches directly between mutually exclusive editors", () => {
    expect(togglePreviewEditorMode("visual", "blocks")).toBe("blocks");
    expect(togglePreviewEditorMode("blocks", "visual")).toBe("visual");
  });
});

describe("shouldAutoOpenCms", () => {
  const ready = {
    cmsDefaultOpen: true,
    blocksReady: true,
    autoOpenResolved: false,
    editingMode: "preview",
  } as const;

  test("fires only when all four conditions hold", () => {
    expect(shouldAutoOpenCms(ready)).toBe(true);
  });

  test("off by default: never fires when the setting is disabled", () => {
    expect(shouldAutoOpenCms({ ...ready, cmsDefaultOpen: false })).toBe(false);
  });

  test("waits until Blocks metadata is ready", () => {
    expect(shouldAutoOpenCms({ ...ready, blocksReady: false })).toBe(false);
  });

  test("does not re-fire once resolved (user took control / already opened)", () => {
    expect(shouldAutoOpenCms({ ...ready, autoOpenResolved: true })).toBe(false);
  });

  test("does not fire when the user is already in an editor", () => {
    expect(shouldAutoOpenCms({ ...ready, editingMode: "blocks" })).toBe(false);
    expect(shouldAutoOpenCms({ ...ready, editingMode: "visual" })).toBe(false);
  });
});
