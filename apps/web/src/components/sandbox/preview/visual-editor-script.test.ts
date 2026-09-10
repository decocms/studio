import { describe, expect, it } from "bun:test";
import { VISUAL_EDITOR_SCRIPT } from "./visual-editor-script";

describe("VISUAL_EDITOR_SCRIPT", () => {
  it("drops a bridge message whose source isn't this frame's parent", () => {
    const start = VISUAL_EDITOR_SCRIPT.indexOf(
      'window.addEventListener("message", function(e)',
    );
    const bodyStart = VISUAL_EDITOR_SCRIPT.indexOf("{", start) + 1;
    const guardEnd = VISUAL_EDITOR_SCRIPT.indexOf(
      "if (e.data && e.data.type",
      bodyStart,
    );
    expect(bodyStart).toBeGreaterThan(0);
    expect(guardEnd).toBeGreaterThan(bodyStart);
    const guard = VISUAL_EDITOR_SCRIPT.slice(bodyStart, guardEnd);
    const runGuard = new Function(
      "window",
      "e",
      `${guard}; return "reached";`,
    ) as (window: unknown, e: unknown) => string | undefined;

    const parent = {};
    expect(runGuard({ parent }, { source: { evil: true } })).toBeUndefined();
    expect(runGuard({ parent }, { source: parent })).toBe("reached");
  });
});
