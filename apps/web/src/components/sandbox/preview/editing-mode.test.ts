import { describe, expect, test } from "bun:test";
import {
  defaultPreviewEditingMode,
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

/** MOVED from `defaultSurfaceTabId`, inverted: the Site Editor row lands on
 *  Preview for every session now, and what a CMS session gets there is the
 *  blocks editor already open — not the Content view. */
describe("defaultPreviewEditingMode", () => {
  test("a CMS session opens on the blocks editor", () => {
    expect(defaultPreviewEditingMode({ runtime: "cms", cmsMode: "on" })).toBe(
      "blocks",
    );
  });

  test("a sandbox session opens on the plain preview", () => {
    expect(
      defaultPreviewEditingMode({ runtime: "sandbox", cmsMode: "on" }),
    ).toBe("preview");
  });

  /** `off` is the one thing that overrides the runtime: an agent with no CMS
   *  has no blocks editor to land in. */
  test("off keeps even a CMS session on the plain preview", () => {
    for (const runtime of ["cms", "sandbox"] as const) {
      expect(defaultPreviewEditingMode({ runtime, cmsMode: "off" })).toBe(
        "preview",
      );
    }
  });
});
