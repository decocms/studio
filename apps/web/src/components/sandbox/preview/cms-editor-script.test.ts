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

  // Navigation blocking (below) is a SEPARATE listener on purpose. #5567's rule
  // — section selection must not cancel the page's own clicks — still holds
  // above; nothing here may start swallowing propagation, or every interactive
  // control in the preview dies again.
  test("blocks navigation without swallowing the page's click listeners", () => {
    const start = CMS_EDITOR_SCRIPT.indexOf("var navBlocker = function(e)");
    const end = CMS_EDITOR_SCRIPT.indexOf(
      'document.addEventListener("click", navBlocker, true)',
      start,
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const navBlocker = CMS_EDITOR_SCRIPT.slice(start, end);
    expect(navBlocker).toContain("preventDefault");
    expect(navBlocker).not.toContain("stopPropagation");
    expect(navBlocker).not.toContain("stopImmediatePropagation");
  });

  // Without the counter, re-clicking a section the editor had navigated away
  // from sent an identical payload, the panel saw "no change", and the form
  // never reopened — only clicking a DIFFERENT section worked.
  test("stamps every click with an incrementing counter", () => {
    const start = CMS_EDITOR_SCRIPT.indexOf("var clickHandler = function(e)");
    const end = CMS_EDITOR_SCRIPT.indexOf(
      'document.addEventListener("click", clickHandler, true)',
      start,
    );
    const clickHandler = CMS_EDITOR_SCRIPT.slice(start, end);
    expect(clickHandler).toContain("clickSeq++");
    expect(clickHandler).toContain("clickSeq: clickSeq");
    // Declared once, outside the handler, or it resets on every click.
    expect(CMS_EDITOR_SCRIPT).toContain("var clickSeq = 0;");
    expect(clickHandler).not.toContain("var clickSeq");
  });

  test("detaches the navigation blockers on deactivate", () => {
    expect(CMS_EDITOR_SCRIPT).toContain(
      'document.removeEventListener("click", navBlocker, true)',
    );
    expect(CMS_EDITOR_SCRIPT).toContain(
      'document.removeEventListener("submit", submitBlocker, true)',
    );
  });
});

// Behavioural test of the extracted `isNavigatingAnchor` predicate — string
// assertions above prove the wiring, this proves the decision. An over-eager
// predicate re-breaks the preview (#5567); an under-eager one lets the redirect
// through, which is the bug being fixed.
describe("isNavigatingAnchor", () => {
  const buildPredicate = () => {
    const start = CMS_EDITOR_SCRIPT.indexOf(
      "var isNavigatingAnchor = function(a)",
    );
    const end = CMS_EDITOR_SCRIPT.indexOf("var navBlocker", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const src = CMS_EDITOR_SCRIPT.slice(start, end);
    // `location` is the only global the predicate closes over.
    return new Function("location", `${src}; return isNavigatingAnchor;`)({
      href: "https://site.test/current",
    }) as (a: unknown) => boolean;
  };

  const anchor = (href: string | null, resolved?: string) => ({
    getAttribute: () => href,
    href:
      resolved ?? (href ? `https://site.test/${href.replace(/^\//, "")}` : ""),
  });

  it("blocks links that leave the page", () => {
    const isNav = buildPredicate();
    expect(isNav(anchor("/produtos", "https://site.test/produtos"))).toBe(true);
    expect(isNav(anchor("https://outro.test/", "https://outro.test/"))).toBe(
      true,
    );
  });

  it("lets in-page and non-navigating anchors through", () => {
    const isNav = buildPredicate();
    expect(isNav(null)).toBe(false);
    expect(isNav(anchor(null))).toBe(false);
    expect(isNav(anchor(""))).toBe(false);
    expect(isNav(anchor("#secao"))).toBe(false);
    expect(isNav(anchor("  #secao"))).toBe(false);
    expect(isNav(anchor("javascript:void(0)"))).toBe(false);
    expect(isNav(anchor("JavaScript:doThing()"))).toBe(false);
    // Same document + fragment → only scrolls.
    expect(
      isNav(anchor("/current#bloco", "https://site.test/current#bloco")),
    ).toBe(false);
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
