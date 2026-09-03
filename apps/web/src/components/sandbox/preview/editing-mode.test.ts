import { describe, expect, test } from "bun:test";
import {
  defaultPreviewEditingMode,
  isBlocksEditingEnabled,
  resolveEffectivePreviewEditingMode,
  toggleVisualEditingMode,
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

describe("toggleVisualEditingMode", () => {
  test("activates Visual from Preview or Blocks", () => {
    expect(toggleVisualEditingMode("preview", false)).toBe("visual");
    expect(toggleVisualEditingMode("blocks", true)).toBe("visual");
  });

  test("returns from Visual to Blocks when content editing is enabled", () => {
    expect(toggleVisualEditingMode("visual", true)).toBe("blocks");
  });

  test("returns from Visual to Preview when Blocks is unavailable", () => {
    expect(toggleVisualEditingMode("visual", false)).toBe("preview");
  });
});

describe("defaultPreviewEditingMode", () => {
  test("desktop opens Blocks whenever Content is enabled", () => {
    expect(
      defaultPreviewEditingMode({
        cmsMode: "on",
        isMobile: false,
      }),
    ).toBe("blocks");
  });

  test("mobile opens the plain preview", () => {
    expect(
      defaultPreviewEditingMode({
        cmsMode: "on",
        isMobile: true,
      }),
    ).toBe("preview");
  });

  test("CMS off opens the plain preview", () => {
    expect(defaultPreviewEditingMode({ cmsMode: "off", isMobile: false })).toBe(
      "preview",
    );
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
