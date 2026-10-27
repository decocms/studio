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

  // Separate listener on purpose: #5567's no-swallow rule still holds above.
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

  // Without it a repeat click was an identical payload, so the form never reopened.
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

// Over-eager re-breaks the preview (#5567); under-eager lets the redirect through.
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

// Stringifying alignSections only works while it stays self-contained.
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

  it("handles the in-place render message and swaps the document via POST", () => {
    expect(CMS_EDITOR_SCRIPT).toContain('e.data.type === "cms-editor::render"');
    expect(CMS_EDITOR_SCRIPT).toContain("var renderInPlace = function");
    // The swap and its no-reload contract: POST for HTML, replace the document.
    expect(CMS_EDITOR_SCRIPT).toContain('method: "POST"');
    expect(CMS_EDITOR_SCRIPT).toContain("document.documentElement.innerHTML");
    // The overlay nodes live on the old body — re-attach after the swap.
    expect(CMS_EDITOR_SCRIPT).toContain("document.body.appendChild(highlight)");
    // Status contract the parent listens for to drive the nav indicator.
    expect(CMS_EDITOR_SCRIPT).toContain("cms-editor::render-start");
    expect(CMS_EDITOR_SCRIPT).toContain("cms-editor::render-end");
  });

  it("hides the stale overlay on swap instead of leaving it floating over the new page", () => {
    const start = CMS_EDITOR_SCRIPT.indexOf("var swap = function()");
    const end = CMS_EDITOR_SCRIPT.indexOf("var headHtml = html.slice", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const swap = CMS_EDITOR_SCRIPT.slice(start, end);
    expect(swap).toContain('highlight.style.display = "none"');
    expect(swap).toContain('badge.style.display = "none"');
  });

  it("hides the overlay as soon as a render starts, so a hover during the fetch can't re-show it before the swap's view transition snapshots it", () => {
    const start = CMS_EDITOR_SCRIPT.indexOf("var renderInPlace = function");
    const end = CMS_EDITOR_SCRIPT.indexOf(
      'postMessage({ type: "cms-editor::render-start"',
      start,
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const setup = CMS_EDITOR_SCRIPT.slice(start, end);
    expect(setup).toContain("renderPending = true");
    expect(setup).toContain('highlight.style.display = "none"');
    expect(setup).toContain('badge.style.display = "none"');
    // moveHandler must not reposition/show the overlay while a render is pending.
    const moveStart = CMS_EDITOR_SCRIPT.indexOf(
      "var moveHandler = function(e)",
    );
    const moveGuardEnd = CMS_EDITOR_SCRIPT.indexOf(
      "rafPending = true",
      moveStart,
    );
    const moveGuard = CMS_EDITOR_SCRIPT.slice(moveStart, moveGuardEnd);
    expect(moveGuard).toContain("renderPending");
    // The already-scheduled rAF callback must also recheck renderPending.
    const rafBodyStart = CMS_EDITOR_SCRIPT.indexOf(
      "rafPending = false;",
      moveStart,
    );
    const rafBodyEnd = CMS_EDITOR_SCRIPT.indexOf("});", rafBodyStart);
    const rafBody = CMS_EDITOR_SCRIPT.slice(rafBodyStart, rafBodyEnd);
    expect(rafBody).toContain("if (renderPending) return;");
  });

  it("drops a bridge message whose source isn't this frame's parent", () => {
    const start = CMS_EDITOR_SCRIPT.indexOf(
      'window.addEventListener("message", function(e)',
    );
    const bodyStart = CMS_EDITOR_SCRIPT.indexOf("{", start) + 1;
    const guardEnd = CMS_EDITOR_SCRIPT.indexOf(
      "if (e.data && e.data.type",
      bodyStart,
    );
    expect(bodyStart).toBeGreaterThan(0);
    expect(guardEnd).toBeGreaterThan(bodyStart);
    const guard = CMS_EDITOR_SCRIPT.slice(bodyStart, guardEnd);
    const runGuard = new Function(
      "window",
      "e",
      `${guard}; return "reached";`,
    ) as (window: unknown, e: unknown) => string | undefined;

    const parent = {};
    expect(runGuard({ parent }, { source: { evil: true } })).toBeUndefined();
    expect(runGuard({ parent }, { source: parent })).toBe("reached");
  });

  it("runs the embedded alignment against a stubbed DOM", () => {
    // The embedded copy, on the regression case (a section that rendered no node).
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

// A quick second save skips the running transition; Chrome then rejects its
// ready promise with "AbortError: Transition was skipped".
describe("runSwapTransition", () => {
  const buildRunner = (document: unknown) => {
    const start = CMS_EDITOR_SCRIPT.indexOf("var settleTransition = function(");
    const end = CMS_EDITOR_SCRIPT.indexOf("var renderInPlace", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const src = CMS_EDITOR_SCRIPT.slice(start, end);
    return new Function(
      "document",
      "window",
      `${src}; return runSwapTransition;`,
    )(document, { addEventListener: () => {} }) as (
      swap: () => void,
    ) => Promise<unknown>;
  };

  it("leaves no rejection unhandled when the transition is skipped", async () => {
    const skipped = () => {
      const error = new Error("Transition was skipped");
      error.name = "AbortError";
      return error;
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let swapped = 0;
      const run = buildRunner({
        startViewTransition: (swap: () => void) => {
          swap();
          return {
            ready: Promise.reject(skipped()),
            updateCallbackDone: Promise.reject(skipped()),
            finished: Promise.resolve(),
          };
        },
      });
      await run(() => swapped++);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(swapped).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("swaps right away where view transitions don't exist", async () => {
    let swapped = 0;
    await buildRunner({})(() => swapped++);
    expect(swapped).toBe(1);
  });
});

// A site with `@view-transition { navigation: auto }` gets a cross-document
// transition on every reload a save makes; the next save's navigation skips
// it, and the page being left rejects its ready promise (QA-8027 step 8).
describe("outgoing page transitions", () => {
  const buildPageSwap = (window: { addEventListener: unknown }) => {
    const start = CMS_EDITOR_SCRIPT.indexOf("var settleTransition = function(");
    const end = CMS_EDITOR_SCRIPT.indexOf("var runSwapTransition", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    new Function("window", CMS_EDITOR_SCRIPT.slice(start, end))(window);
  };
  const skipped = () => {
    const error = new Error("Transition was skipped");
    error.name = "AbortError";
    return error;
  };

  it("settles a skipped pageswap transition, once per page", async () => {
    const listeners: { type: string; fn: (e: unknown) => void }[] = [];
    const win = {
      addEventListener: (type: string, fn: (e: unknown) => void) =>
        listeners.push({ type, fn }),
    };
    buildPageSwap(win);
    // Injected again (mode switch, page navigation): still one listener.
    buildPageSwap(win);
    expect(listeners.map((l) => l.type)).toEqual(["pageswap"]);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      for (let i = 0; i < 5; i++) {
        listeners[0]!.fn({
          viewTransition: {
            ready: Promise.reject(skipped()),
            updateCallbackDone: Promise.resolve(),
            finished: Promise.resolve(),
          },
        });
      }
      // A navigation without a transition (the site didn't opt in).
      listeners[0]!.fn({ viewTransition: null });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
