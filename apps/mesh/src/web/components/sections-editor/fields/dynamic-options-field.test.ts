import { describe, expect, test } from "bun:test";
import {
  filterOptions,
  normalizeOptions,
  svgPreviewDataUri,
} from "./dynamic-options-field";

describe("normalizeOptions", () => {
  test("returns empty array for non-array input", () => {
    expect(normalizeOptions(null)).toEqual([]);
    expect(normalizeOptions(undefined)).toEqual([]);
    expect(normalizeOptions("hello")).toEqual([]);
    expect(normalizeOptions(42)).toEqual([]);
    expect(normalizeOptions({})).toEqual([]);
  });

  test("returns empty array for empty array", () => {
    expect(normalizeOptions([])).toEqual([]);
  });

  test("converts string items to {value, label}", () => {
    expect(normalizeOptions(["a", "b"])).toEqual([
      { value: "a", label: "a" },
      { value: "b", label: "b" },
    ]);
  });

  test("passes through object items with value field", () => {
    const input = [
      { value: "x", label: "Option X" },
      { value: "y", label: "Option Y", image: "https://img.test/y.png" },
    ];
    expect(normalizeOptions(input)).toEqual([
      { value: "x", label: "Option X", image: undefined, icon: undefined },
      {
        value: "y",
        label: "Option Y",
        image: "https://img.test/y.png",
        icon: undefined,
      },
    ]);
  });

  test("keeps inline SVG icon from icon-select loaders", () => {
    // Real shape returned by e.g. odin-ui/loaders/icons.ts (deco icon-select).
    const svg = '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
    expect(normalizeOptions([{ value: "activity", icon: svg }])).toEqual([
      { value: "activity", label: "activity", image: undefined, icon: svg },
    ]);
  });

  test("ignores non-string icon values", () => {
    expect(normalizeOptions([{ value: "v", icon: 42 }])).toEqual([
      { value: "v", label: "v", image: undefined, icon: undefined },
    ]);
  });

  test("uses String(value) as label when label is missing", () => {
    expect(normalizeOptions([{ value: 123 }])).toEqual([
      { value: "123", label: "123", image: undefined, icon: undefined },
    ]);
  });

  test("ignores items without value field", () => {
    expect(normalizeOptions([{ label: "no value" }, null, 42])).toEqual([]);
  });

  test("handles mixed string and object items", () => {
    const result = normalizeOptions([
      "plain",
      { value: "obj", label: "Object" },
    ]);
    expect(result).toEqual([
      { value: "plain", label: "plain" },
      { value: "obj", label: "Object", image: undefined, icon: undefined },
    ]);
  });

  test("ignores non-string image values", () => {
    expect(normalizeOptions([{ value: "v", image: 123 }])).toEqual([
      { value: "v", label: "v", image: undefined, icon: undefined },
    ]);
  });
});

describe("filterOptions", () => {
  const options = [
    { value: "#00db00", label: "brand" },
    { value: "#eef1f0", label: "body" },
    { value: "activity", label: "activity" },
  ];

  test("returns all options for empty or whitespace search", () => {
    expect(filterOptions(options, "")).toEqual(options);
    expect(filterOptions(options, "   ")).toEqual(options);
  });

  test("matches on label, case-insensitively", () => {
    expect(filterOptions(options, "BRAND")).toEqual([options[0]!]);
  });

  test("matches on value (e.g. color hex)", () => {
    expect(filterOptions(options, "#eef")).toEqual([options[1]!]);
  });

  test("returns empty when nothing matches", () => {
    expect(filterOptions(options, "zzz")).toEqual([]);
  });

  test("options without label still match by value", () => {
    expect(filterOptions([{ value: "plain" }], "pla")).toEqual([
      { value: "plain" },
    ]);
  });
});

describe("svgPreviewDataUri", () => {
  test("injects the current-color shim inside the root svg tag", () => {
    // odin-ui color-swatch shape: fill-current class + color on the root.
    const svg =
      '<svg viewBox="0 0 8 8" style="color: #00db00;" xmlns="http://www.w3.org/2000/svg"><circle class="fill-current" cx="4" cy="4" r="4" /></svg>';
    const uri = svgPreviewDataUri(svg);
    expect(uri.startsWith("data:image/svg+xml;utf8,")).toBe(true);
    const decoded = decodeURIComponent(
      uri.slice("data:image/svg+xml;utf8,".length),
    );
    expect(decoded).toContain(
      '<svg viewBox="0 0 8 8" style="color: #00db00;" xmlns="http://www.w3.org/2000/svg"><style>.fill-current{fill:currentColor}',
    );
    expect(decoded).toContain('<circle class="fill-current"');
  });

  test("injects a theme fallback color that inline style still overrides", () => {
    // Monochrome icon sets (fill="currentColor") default to black inside an
    // isolated <img> SVG document — the fallback rule makes them theme-colored.
    const svg = '<svg viewBox="0 0 24 24"><path fill="currentColor"/></svg>';
    const uri = svgPreviewDataUri(svg, "rgb(250, 250, 250)");
    const decoded = decodeURIComponent(uri.split(",")[1]!);
    expect(decoded).toContain("<style>svg{color:rgb(250, 250, 250)}");
  });

  test("leaves markup without an svg tag unchanged (besides encoding)", () => {
    const uri = svgPreviewDataUri("<div>not svg</div>");
    expect(decodeURIComponent(uri.split(",")[1]!)).toBe("<div>not svg</div>");
  });
});
