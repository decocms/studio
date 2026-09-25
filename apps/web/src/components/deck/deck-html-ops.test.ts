import { setupComponentTest } from "../../../test/setup"; // happy-dom (DOMParser)
setupComponentTest();
import { describe, expect, test } from "bun:test";
import { DeckOpError, applyDeckOp, countDeckSlides } from "./deck-html-ops";

const DECK = `<!DOCTYPE html>
<html lang="en"><head><title>T</title><style>section { color: red; }</style></head>
<body>
<deck-viewer width="1920" height="1080">
<section class="a"><h1>One</h1></section>
<section class="b"><h2>Two</h2></section>
<section class="c"><h2>Three</h2></section>
</deck-viewer>
<script src="/deck-runtime/v1/deck-viewer.js"></script>
</body></html>
`;

function headings(source: string): string[] {
  const doc = new DOMParser().parseFromString(source, "text/html");
  return [...doc.querySelectorAll("deck-viewer > section")].map(
    (s) => s.textContent?.trim() ?? "",
  );
}

describe("countDeckSlides", () => {
  test("counts element children of deck-viewer", () => {
    expect(countDeckSlides(DECK)).toBe(3);
  });
  test("null without a deck-viewer", () => {
    expect(countDeckSlides("<html><body><p>x</p></body></html>")).toBeNull();
  });
});

describe("applyDeckOp", () => {
  test("remove", () => {
    const out = applyDeckOp(DECK, { kind: "remove", at: 1 });
    expect(headings(out)).toEqual(["One", "Three"]);
    expect(out.startsWith("<!DOCTYPE html>")).toBe(true);
    // The rest of the document survives the round-trip.
    expect(out).toContain("section { color: red; }");
    expect(out).toContain('script src="/deck-runtime/v1/deck-viewer.js"');
  });

  test("remove refuses the last slide", () => {
    const one = `<deck-viewer><section><h1>Only</h1></section></deck-viewer>`;
    expect(() => applyDeckOp(one, { kind: "remove", at: 0 })).toThrow(
      DeckOpError,
    );
  });

  test("duplicate strips ids", () => {
    const src = DECK.replace(
      '<section class="b">',
      '<section class="b" id="x">',
    );
    const out = applyDeckOp(src, { kind: "duplicate", at: 1 });
    expect(headings(out)).toEqual(["One", "Two", "Two", "Three"]);
    const doc = new DOMParser().parseFromString(out, "text/html");
    expect(doc.querySelectorAll("#x").length).toBe(1);
  });

  test("move down and up", () => {
    expect(
      headings(applyDeckOp(DECK, { kind: "move", from: 0, to: 2 })),
    ).toEqual(["Two", "Three", "One"]);
    expect(
      headings(applyDeckOp(DECK, { kind: "move", from: 2, to: 0 })),
    ).toEqual(["Three", "One", "Two"]);
  });

  test("set-attr / remove-attr (skip toggle)", () => {
    const skipped = applyDeckOp(DECK, {
      kind: "set-attr",
      at: 1,
      name: "data-deck-skip",
      value: "",
    });
    expect(skipped).toContain("data-deck-skip");
    const unskipped = applyDeckOp(skipped, {
      kind: "remove-attr",
      at: 1,
      name: "data-deck-skip",
    });
    expect(unskipped).not.toContain("data-deck-skip");
  });

  test("replace swaps the section content", () => {
    const out = applyDeckOp(DECK, {
      kind: "replace",
      at: 0,
      html: '<section class="a"><h1>Edited</h1> <p>extra</p></section>',
    });
    expect(headings(out)).toEqual(["Edited extra", "Two", "Three"]);
  });

  test("stale index throws DeckOpError", () => {
    expect(() => applyDeckOp(DECK, { kind: "remove", at: 9 })).toThrow(
      DeckOpError,
    );
    try {
      applyDeckOp(DECK, { kind: "remove", at: 9 });
    } catch (err) {
      expect((err as DeckOpError).code).toBe("stale-index");
    }
  });

  test("missing deck-viewer throws", () => {
    expect(() =>
      applyDeckOp("<html><body></body></html>", { kind: "remove", at: 0 }),
    ).toThrow(DeckOpError);
  });

  test("invalid attribute name rejected", () => {
    expect(() =>
      applyDeckOp(DECK, {
        kind: "set-attr",
        at: 0,
        name: "on click",
        value: "x",
      }),
    ).toThrow(DeckOpError);
  });

  test("event handler attribute rejected", () => {
    expect(() =>
      applyDeckOp(DECK, {
        kind: "set-attr",
        at: 0,
        name: "onclick",
        value: "alert(1)",
      }),
    ).toThrow(DeckOpError);
  });

  test("javascript: URI attribute rejected", () => {
    expect(() =>
      applyDeckOp(DECK, {
        kind: "set-attr",
        at: 0,
        name: "href",
        value: "javascript:alert(1)",
      }),
    ).toThrow(DeckOpError);
  });

  test("replace strips script tags", () => {
    const out = applyDeckOp(DECK, {
      kind: "replace",
      at: 0,
      html: '<section class="a"><h1>Edited</h1><script>alert(1)</script></section>',
    });
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(headings(out)).toEqual(["Edited", "Two", "Three"]);
  });

  test("replace strips event-handler attributes", () => {
    const out = applyDeckOp(DECK, {
      kind: "replace",
      at: 0,
      html: '<section class="a"><img src="x" onerror="alert(1)"></section>',
    });
    expect(out).not.toContain("onerror");
  });

  test("replace strips javascript: href but keeps the link", () => {
    const out = applyDeckOp(DECK, {
      kind: "replace",
      at: 0,
      html: '<section class="a"><a href="javascript:alert(1)">click</a></section>',
    });
    expect(out).not.toContain("javascript:");
    expect(out).toContain("<a>click</a>");
  });

  test("replace keeps pasted base64 images", () => {
    const out = applyDeckOp(DECK, {
      kind: "replace",
      at: 0,
      html: '<section class="a"><img src="data:image/png;base64,AAA="></section>',
    });
    expect(out).toContain("data:image/png;base64,AAA=");
  });
});
