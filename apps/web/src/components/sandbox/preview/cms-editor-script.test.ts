import { describe, expect, test } from "bun:test";
import { CMS_EDITOR_SCRIPT } from "./cms-editor-script";

describe("CMS editor iframe interactions", () => {
  test("observes section clicks without cancelling the page's native click", () => {
    const handlerStart = CMS_EDITOR_SCRIPT.indexOf(
      "var clickHandler = function(e)",
    );
    const handlerEnd = CMS_EDITOR_SCRIPT.indexOf(
      'document.addEventListener("click", clickHandler, true)',
      handlerStart,
    );

    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);

    const clickHandler = CMS_EDITOR_SCRIPT.slice(handlerStart, handlerEnd);
    expect(clickHandler).toContain('type: "cms-editor::section-clicked"');
    expect(clickHandler).not.toContain("preventDefault");
    expect(clickHandler).not.toContain("stopPropagation");
    expect(clickHandler).not.toContain("stopImmediatePropagation");
  });
});
