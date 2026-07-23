import { describe, expect, test } from "bun:test";
import { parseSpriteSymbols } from "./icon-sprite";

const SPRITE = `<svg style="display:none" xmlns="http://www.w3.org/2000/svg" version="1.1">
<symbol id="Close" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
  <path d="M5 5L19 19" />
</symbol>
<symbol id="Granado" viewBox="0 0 72 32" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M1 16" fill="currentColor" />
</symbol>
</svg>`;

describe("parseSpriteSymbols", () => {
  test("maps each symbol id to a standalone svg preserving its viewBox/fill", () => {
    const map = parseSpriteSymbols(SPRITE);
    expect(Object.keys(map).sort()).toEqual(["Close", "Granado"]);
    expect(map.Close).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">\n  <path d="M5 5L19 19" />\n</svg>',
    );
    // viewBox may appear after fill/xmlns in the source — still captured.
    expect(map.Granado).toContain('viewBox="0 0 72 32"');
    expect(map.Granado).toContain('fill="none"');
    expect(map.Granado).toContain('<path d="M1 16" fill="currentColor" />');
  });

  test("omits fill when the symbol has none", () => {
    const map = parseSpriteSymbols(
      '<svg><symbol id="X" viewBox="0 0 8 8"><circle /></symbol></svg>',
    );
    expect(map.X).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle /></svg>',
    );
  });

  test("tolerates a literal > inside a quoted attribute value", () => {
    const map = parseSpriteSymbols(
      '<svg><symbol id="X" data-label="a>b" viewBox="0 0 8 8"><circle /></symbol></svg>',
    );
    expect(map.X).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle /></svg>',
    );
  });

  test("skips symbols without an id", () => {
    const map = parseSpriteSymbols(
      '<svg><symbol viewBox="0 0 8 8"><circle /></symbol></svg>',
    );
    expect(map).toEqual({});
  });

  test("returns empty object for non-string / empty input", () => {
    expect(parseSpriteSymbols(null)).toEqual({});
    expect(parseSpriteSymbols(undefined)).toEqual({});
    expect(parseSpriteSymbols("")).toEqual({});
    expect(parseSpriteSymbols("<svg></svg>")).toEqual({});
  });
});
