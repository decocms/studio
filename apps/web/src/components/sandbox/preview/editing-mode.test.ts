import { describe, expect, test } from "bun:test";
import {
  resolveEffectiveEditingMode,
  shouldAutoOpenCms,
  togglePreviewEditorMode,
} from "./editing-mode";

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

describe("resolveEffectiveEditingMode", () => {
  const base = { sandboxDisplay: true, cmsCapable: false } as const;

  test("passes through when nothing blocks the request", () => {
    for (const mode of ["preview", "visual", "blocks"] as const) {
      expect(resolveEffectiveEditingMode({ ...base, editingMode: mode })).toBe(
        mode,
      );
    }
  });

  test("visual falls back to preview without the sandbox iframe", () => {
    expect(
      resolveEffectiveEditingMode({
        ...base,
        editingMode: "visual",
        sandboxDisplay: false,
      }),
    ).toBe("preview");
  });

  /** The side panel owns block editing there; the inline pane would duplicate it. */
  test("blocks never opens inline on a CMS project", () => {
    expect(
      resolveEffectiveEditingMode({
        ...base,
        editingMode: "blocks",
        cmsCapable: true,
      }),
    ).toBe("preview");
  });

  /**
   * Project-level, not per-branch: a CMS draft that gains a sandbox must not
   * resurrect the inline pane alongside the side panel's copy.
   */
  test("a CMS project keeps blocks out inline in both modes", () => {
    for (const sandboxDisplay of [true, false]) {
      expect(
        resolveEffectiveEditingMode({
          editingMode: "blocks",
          sandboxDisplay,
          cmsCapable: true,
        }),
      ).toBe("preview");
    }
  });

  test("a non-CMS project keeps its inline blocks pane", () => {
    expect(
      resolveEffectiveEditingMode({
        editingMode: "blocks",
        sandboxDisplay: false,
        cmsCapable: false,
      }),
    ).toBe("blocks");
  });
});
