import { describe, expect, test } from "bun:test";
import { togglePreviewEditorMode } from "./editing-mode";

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
