import { describe, expect, test } from "bun:test";
import {
  enumFallbackOptions,
  filterOptions,
  hasNoOptionSource,
  normalizeOptions,
  resolveOptions,
  resolveOptionsPreviewUrl,
  shouldOfferTypedValue,
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

describe("enumFallbackOptions", () => {
  test("maps string enum literals to value/label options", () => {
    expect(enumFallbackOptions(["user", "chat", "earth"])).toEqual([
      { value: "user", label: "user" },
      { value: "chat", label: "chat" },
      { value: "earth", label: "earth" },
    ]);
  });

  test("ignores non-string enum entries", () => {
    expect(enumFallbackOptions(["a", 1, null, { x: 1 }, "b"])).toEqual([
      { value: "a", label: "a" },
      { value: "b", label: "b" },
    ]);
  });

  test("returns empty array for undefined or non-array input", () => {
    expect(enumFallbackOptions(undefined)).toEqual([]);
    expect(enumFallbackOptions([])).toEqual([]);
  });
});

describe("resolveOptions", () => {
  const loader = [{ value: "activity", icon: "<svg/>" }];
  const fallback = [{ value: "user", label: "user" }];

  test("prefers loader options when the loader returned any", () => {
    expect(resolveOptions(loader, fallback)).toBe(loader);
  });

  test("falls back to enum options when the loader returned nothing", () => {
    expect(resolveOptions([], fallback)).toBe(fallback);
  });

  test("returns empty when neither source has options", () => {
    expect(resolveOptions([], [])).toEqual([]);
  });
});

describe("shouldOfferTypedValue", () => {
  const base = {
    loaderPath: "site/loaders/collections.ts",
    isIconSelect: false,
    enumFallbackCount: 0,
    trimmedSearch: "5455",
    optionValues: [] as string[],
    optionsSettled: true,
  };

  test("offers the typed value for a settled, empty loader result", () => {
    expect(shouldOfferTypedValue(base)).toBe(true);
  });

  test("offers it when the loader returned options but none match", () => {
    expect(
      shouldOfferTypedValue({ ...base, optionValues: ["100", "200"] }),
    ).toBe(true);
  });

  test("does not offer while the query is still settling", () => {
    // Debounce/fetch window: options are empty only because nothing loaded yet.
    expect(shouldOfferTypedValue({ ...base, optionsSettled: false })).toBe(
      false,
    );
  });

  test("does not offer when the typed value already exists as an option", () => {
    expect(
      shouldOfferTypedValue({ ...base, optionValues: ["5455", "200"] }),
    ).toBe(false);
  });

  test("does not offer for an empty (or whitespace-trimmed) search", () => {
    expect(shouldOfferTypedValue({ ...base, trimmedSearch: "" })).toBe(false);
  });

  test("does not offer without a dynamic loader", () => {
    expect(shouldOfferTypedValue({ ...base, loaderPath: undefined })).toBe(
      false,
    );
  });

  test("does not offer for the constrained icon-select format", () => {
    expect(shouldOfferTypedValue({ ...base, isIconSelect: true })).toBe(false);
  });

  test("does not offer when a schema enum makes it a closed set", () => {
    expect(shouldOfferTypedValue({ ...base, enumFallbackCount: 3 })).toBe(
      false,
    );
  });
});

describe("resolveOptionsPreviewUrl", () => {
  const SANDBOX = "https://abc.preview.example.com";
  const BASE = "https://site.deco.site";

  test("prefers the sandbox dev server when one is running", () => {
    expect(resolveOptionsPreviewUrl(SANDBOX, BASE)).toBe(SANDBOX);
  });

  test("falls back to the gallery preview base without a sandbox", () => {
    expect(resolveOptionsPreviewUrl(undefined, BASE)).toBe(BASE);
  });

  test("stays undefined when neither base exists (content protocol)", () => {
    expect(resolveOptionsPreviewUrl(undefined, null)).toBeUndefined();
    expect(resolveOptionsPreviewUrl(undefined, undefined)).toBeUndefined();
  });
});

describe("hasNoOptionSource", () => {
  const LOADER = "odin-ui/loaders/icons.ts";
  const URL = "https://site.deco.site";

  test("false for a loader-backed enum-less field once a preview base reaches it", () => {
    expect(
      hasNoOptionSource({
        previewUrl: URL,
        loaderPath: LOADER,
        enumFallbackCount: 0,
      }),
    ).toBe(false);
  });

  test("true with a loader but nowhere to invoke it and no enum", () => {
    expect(
      hasNoOptionSource({
        previewUrl: undefined,
        loaderPath: LOADER,
        enumFallbackCount: 0,
      }),
    ).toBe(true);
  });

  test("false when the schema enum can carry the list alone", () => {
    expect(
      hasNoOptionSource({
        previewUrl: undefined,
        loaderPath: undefined,
        enumFallbackCount: 42,
      }),
    ).toBe(false);
  });

  test("true when there is no loader and no enum", () => {
    expect(
      hasNoOptionSource({
        previewUrl: URL,
        loaderPath: undefined,
        enumFallbackCount: 0,
      }),
    ).toBe(true);
  });
});
