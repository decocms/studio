import { describe, expect, test } from "bun:test";
import { canToggleVisualEditor, viewModeForSurface } from "./preview-surface";

describe("preview surface", () => {
  test("Preview owns preview mode and its visual editor toggle", () => {
    expect(viewModeForSurface("preview", "preview")).toBe("preview");
    expect(viewModeForSurface("preview", "visual")).toBe("visual");
    expect(canToggleVisualEditor("preview")).toBe(true);
  });

  test("Blocks owns CMS mode and cannot toggle into Preview", () => {
    expect(viewModeForSurface("blocks", "preview")).toBe("cms");
    expect(viewModeForSurface("blocks", "visual")).toBe("cms");
    expect(canToggleVisualEditor("blocks")).toBe(false);
  });
});
