import { describe, expect, it } from "bun:test";
import { parseSections } from "./parse-sections";
import {
  savedBlockKey,
  unwrapBlockReference,
  unwrapSection,
} from "./unwrap-section";

const HERO = "site/sections/Hero/Hero.tsx";
const LAZY = "website/sections/Rendering/Lazy.tsx";
const MV = "website/flags/multivariate/section.ts";
const NEVER = "website/matchers/never.ts";

describe("unwrapSection", () => {
  it("unwraps a normal inline section", () => {
    const raw = { __resolveType: HERO, title: "Hello" };
    const parsed = parseSections([raw], {})[0]!;
    expect(unwrapSection(raw, parsed, {})).toEqual({
      data: { __resolveType: HERO, title: "Hello" },
      resolveType: HERO,
    });
  });

  it("unwraps a lazy-wrapped section", () => {
    const raw = {
      __resolveType: LAZY,
      section: { __resolveType: HERO, title: "Lazy hero" },
    };
    const parsed = parseSections([raw], {})[0]!;
    expect(unwrapSection(raw, parsed, {})).toEqual({
      data: { __resolveType: HERO, title: "Lazy hero" },
      resolveType: HERO,
    });
  });

  it("unwraps a hidden section variant value", () => {
    const raw = {
      __resolveType: MV,
      variants: [
        {
          value: { __resolveType: HERO, title: "Hidden" },
          rule: { __resolveType: NEVER },
        },
      ],
    };
    const parsed = parseSections([raw], {})[0]!;
    expect(unwrapSection(raw, parsed, {})).toEqual({
      data: { __resolveType: HERO, title: "Hidden" },
      resolveType: HERO,
    });
  });

  it("unwraps lazy-outer hidden section (legacy shape)", () => {
    const raw = {
      __resolveType: LAZY,
      section: {
        __resolveType: MV,
        variants: [
          {
            value: { __resolveType: HERO, title: "Inner" },
            rule: { __resolveType: NEVER },
          },
        ],
      },
    };
    const parsed = parseSections([raw], {})[0]!;
    expect(unwrapSection(raw, parsed, {})).toEqual({
      data: { __resolveType: HERO, title: "Inner" },
      resolveType: HERO,
    });
  });

  it("unwraps hidden variant with lazy inner section", () => {
    const raw = {
      __resolveType: MV,
      variants: [
        {
          value: {
            __resolveType: LAZY,
            section: { __resolveType: HERO, title: "Nested" },
          },
          rule: { __resolveType: NEVER },
        },
      ],
    };
    const parsed = parseSections([raw], {})[0]!;
    expect(unwrapSection(raw, parsed, {})).toEqual({
      data: { __resolveType: HERO, title: "Nested" },
      resolveType: HERO,
    });
  });

  it("loads saved block data from decofile", () => {
    const raw = { __resolveType: "Header" };
    const parsed = parseSections([raw], {
      Header: { __resolveType: HERO, title: "Site Header" },
    })[0]!;
    expect(
      unwrapSection(raw, parsed, {
        Header: { __resolveType: HERO, title: "Site Header" },
      }),
    ).toEqual({
      data: { __resolveType: HERO, title: "Site Header" },
      resolveType: HERO,
    });
  });

  it("returns null when saved block key is missing from decofile", () => {
    const raw = { __resolveType: "Header" };
    const parsed = parseSections([raw], {
      Header: { __resolveType: HERO, title: "Header block" },
    })[0]!;
    expect(unwrapSection(raw, parsed, {})).toBeNull();
  });

  it("unwraps a hidden saved-block section to its resolved data", () => {
    const raw = {
      __resolveType: MV,
      variants: [
        { value: { __resolveType: "Header" }, rule: { __resolveType: NEVER } },
      ],
    };
    const decofile = { Header: { __resolveType: HERO, title: "Site Header" } };
    const parsed = parseSections([raw], decofile)[0]!;
    expect(parsed.isSavedBlock).toBe(true);
    expect(unwrapSection(raw, parsed, decofile)).toEqual({
      data: { __resolveType: HERO, title: "Site Header" },
      resolveType: HERO,
    });
  });

  it("unwrapBlockReference loads saved block data for site theme pointers", () => {
    const decofile = {
      Deco: {
        __resolveType: "site/sections/Theme/Theme.tsx",
        variants: [{ value: { primary: "#000" } }],
      },
      site: { theme: { __resolveType: "Deco" } },
    };
    expect(unwrapBlockReference({ __resolveType: "Deco" }, decofile)).toEqual({
      blockKey: "Deco",
      data: {
        __resolveType: "site/sections/Theme/Theme.tsx",
        variants: [{ value: { primary: "#000" } }],
      },
      resolveType: "site/sections/Theme/Theme.tsx",
    });
  });

  it("returns null for a hidden variant section (would flatten the variants)", () => {
    const raw = {
      __resolveType: MV,
      variants: [
        {
          value: {
            __resolveType: MV,
            variants: [
              {
                value: { __resolveType: HERO, title: "A" },
                rule: { __resolveType: "website/matchers/always.ts" },
              },
              {
                value: { __resolveType: HERO, title: "B" },
                rule: { __resolveType: "website/matchers/device.ts" },
              },
            ],
          },
          rule: { __resolveType: NEVER },
        },
      ],
    };
    const parsed = parseSections([raw], {})[0]!;
    expect(parsed.isHidden).toBe(true);
    expect(unwrapSection(raw, parsed, {})).toBeNull();
  });

  it("returns null for multivariate sections", () => {
    const raw = {
      __resolveType: MV,
      variants: [
        {
          value: { __resolveType: HERO },
          rule: { __resolveType: "website/matchers/always.ts" },
        },
      ],
    };
    const parsed = parseSections([raw], {})[0]!;
    expect(unwrapSection(raw, parsed, {})).toBeNull();
  });
});

describe("savedBlockKey", () => {
  it("returns the block id for a plain saved block", () => {
    const raw = { __resolveType: "Header" };
    const decofile = { Header: { __resolveType: HERO } };
    const parsed = parseSections([raw], decofile)[0]!;
    expect(savedBlockKey(raw, parsed)).toBe("Header");
  });

  // Regression: a hidden global block must key on its inner id, not the wrapper.
  it("returns the inner block id for a hidden saved block, NOT the wrapper", () => {
    const raw = {
      __resolveType: MV,
      variants: [
        { value: { __resolveType: "Header" }, rule: { __resolveType: NEVER } },
      ],
    };
    const decofile = { Header: { __resolveType: HERO, title: "Site Header" } };
    const parsed = parseSections([raw], decofile)[0]!;
    expect(parsed.isSavedBlock).toBe(true);
    expect(parsed.isHidden).toBe(true);
    expect(savedBlockKey(raw, parsed)).toBe("Header");
    expect(savedBlockKey(raw, parsed)).not.toBe(MV);
  });

  it("returns the inner block id for a lazy-outer hidden saved block", () => {
    const raw = {
      __resolveType: LAZY,
      section: {
        __resolveType: MV,
        variants: [
          {
            value: { __resolveType: "Header" },
            rule: { __resolveType: NEVER },
          },
        ],
      },
    };
    const decofile = { Header: { __resolveType: HERO } };
    const parsed = parseSections([raw], decofile)[0]!;
    expect(savedBlockKey(raw, parsed)).toBe("Header");
  });

  it("returns null for non-saved-block sections", () => {
    const raw = { __resolveType: HERO, title: "Inline" };
    const parsed = parseSections([raw], {})[0]!;
    expect(savedBlockKey(raw, parsed)).toBeNull();
  });
});
