import { describe, expect, test } from "bun:test";
import {
  defaultPreviewEditingMode,
  isBlocksEditingEnabled,
  resolveEffectivePreviewEditingMode,
  togglePreviewEditorMode,
} from "./editing-mode";

describe("isBlocksEditingEnabled", () => {
  test("keeps Blocks desktop-only within the shared content-editing gate", () => {
    expect(
      isBlocksEditingEnabled({ contentEditingEnabled: true, isMobile: false }),
    ).toBe(true);
    expect(
      isBlocksEditingEnabled({ contentEditingEnabled: true, isMobile: true }),
    ).toBe(false);
    expect(
      isBlocksEditingEnabled({ contentEditingEnabled: false, isMobile: false }),
    ).toBe(false);
  });
});

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

/** MOVED from `defaultSurfaceTabId`, inverted: the Site Editor row lands on
 *  Preview for every session now, and what a desktop CMS session gets there is
 *  the blocks editor already open — not the Content view. */
describe("defaultPreviewEditingMode", () => {
  test("a desktop CMS session opens on the blocks editor", () => {
    expect(
      defaultPreviewEditingMode({
        runtime: "cms",
        cmsMode: "on",
        isMobile: false,
      }),
    ).toBe("blocks");
  });

  test("a mobile CMS session opens on the plain preview", () => {
    expect(
      defaultPreviewEditingMode({
        runtime: "cms",
        cmsMode: "on",
        isMobile: true,
      }),
    ).toBe("preview");
  });

  test("a sandbox session opens on the plain preview", () => {
    expect(
      defaultPreviewEditingMode({
        runtime: "sandbox",
        cmsMode: "on",
        isMobile: false,
      }),
    ).toBe("preview");
  });

  /** `off` is the one thing that overrides the runtime: an agent with no CMS
   *  has no blocks editor to land in. */
  test("off keeps even a CMS session on the plain preview", () => {
    for (const runtime of ["cms", "sandbox"] as const) {
      expect(
        defaultPreviewEditingMode({
          runtime,
          cmsMode: "off",
          isMobile: false,
        }),
      ).toBe("preview");
    }
  });
});

describe("resolveEffectivePreviewEditingMode", () => {
  test("keeps Blocks when desktop editing is available", () => {
    for (const sandboxDisplay of [false, true]) {
      expect(
        resolveEffectivePreviewEditingMode({
          editingMode: "blocks",
          sandboxDisplay,
          blocksEditingEnabled: true,
        }),
      ).toBe("blocks");
    }
  });

  test("downgrades Blocks when desktop editing is unavailable", () => {
    expect(
      resolveEffectivePreviewEditingMode({
        editingMode: "blocks",
        sandboxDisplay: true,
        blocksEditingEnabled: false,
      }),
    ).toBe("preview");
  });

  test("keeps Visual limited to a sandbox iframe", () => {
    expect(
      resolveEffectivePreviewEditingMode({
        editingMode: "visual",
        sandboxDisplay: false,
        blocksEditingEnabled: true,
      }),
    ).toBe("preview");
    expect(
      resolveEffectivePreviewEditingMode({
        editingMode: "visual",
        sandboxDisplay: true,
        blocksEditingEnabled: true,
      }),
    ).toBe("visual");
  });
});
