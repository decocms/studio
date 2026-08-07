import { describe, expect, it, test } from "bun:test";
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

// The script embeds alignSections by stringifying it, so the editor and the
// iframe share one implementation of an algorithm whose off-by-one failures are
// invisible until someone edits the wrong component. That trick only holds if
// the function is self-contained: a bundler that rewrites a captured import
// into a module reference (`(0, _mod.helper)(…)`) would produce a script that
// throws inside the iframe, where no module scope exists. Assert it parses and
// that the body came along whole.
describe("CMS_EDITOR_SCRIPT", () => {
  it("is syntactically valid standalone JavaScript", () => {
    expect(() => new Function(CMS_EDITOR_SCRIPT)).not.toThrow();
  });

  it("inlines the alignment implementation rather than referencing a module", () => {
    expect(CMS_EDITOR_SCRIPT).toContain("var alignSections = function");
    // Body markers — if these vanish, the function was replaced by a reference.
    expect(CMS_EDITOR_SCRIPT).toContain("visible.push");
    expect(CMS_EDITOR_SCRIPT).not.toMatch(/alignSections\s*=\s*\(0,/);
  });

  it("runs the embedded alignment against a stubbed DOM", () => {
    // Exercise the embedded copy end-to-end: build the script's alignSections
    // and feed it the regression case (a section that rendered no node).
    const start = CMS_EDITOR_SCRIPT.indexOf("var alignSections = ");
    const end = CMS_EDITOR_SCRIPT.indexOf("var computeAlignment");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const embedded = CMS_EDITOR_SCRIPT.slice(start, end);
    const align = new Function(`${embedded}; return alignSections;`)() as (
      c: (string[] | null)[],
      d: (string | null)[],
    ) => (number | null)[];
    expect(
      align([["a.tsx"], ["b.tsx"], ["c.tsx"]], ["a.tsx", "c.tsx"]),
    ).toEqual([0, null, 1]);
  });
});
