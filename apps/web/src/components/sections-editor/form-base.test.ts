import { describe, expect, it } from "bun:test";
import {
  formSourceMovedOn,
  sectionTypeChanged,
  findSectionMovedTo,
  isOwnVersion,
  rememberOwnVersion,
  sectionFormSource,
  trackFormChange,
} from "./form-base";
import type { ParsedSection } from "./parse-sections";
import type { RawSection } from "./section-types";

describe("trackFormChange", () => {
  const seeded = { title: "loaded" };

  it("starts from the value the form showed before its first change", () => {
    const tracked = trackFormChange(null, {
      sectionIndex: 0,
      variantIndex: 0,
      shown: seeded,
      next: { title: "typed" },
      sectionCount: 1,
    });
    expect(tracked?.base).toBe(seeded);
  });

  it("keeps the starting point while the form keeps editing its own value", () => {
    const first = { title: "t" };
    const tracked = trackFormChange(null, {
      sectionIndex: 0,
      variantIndex: 0,
      shown: seeded,
      next: first,
      sectionCount: 1,
    });
    const again = trackFormChange(tracked, {
      sectionIndex: 0,
      variantIndex: 0,
      shown: first,
      next: { title: "ty" },
      sectionCount: 1,
    });
    expect(again).toBe(tracked);
    expect(again?.base).toBe(seeded);
  });

  it("restarts when something else replaced the form's value", () => {
    const tracked = trackFormChange(null, {
      sectionIndex: 0,
      variantIndex: 0,
      shown: seeded,
      next: { title: "t" },
      sectionCount: 1,
    });
    const reloaded = { title: "someone else's" };
    const restarted = trackFormChange(tracked, {
      sectionIndex: 0,
      variantIndex: 0,
      shown: reloaded,
      next: { title: "x" },
      sectionCount: 1,
    });
    expect(restarted?.base).toBe(reloaded);
  });

  it("restarts for another section or variant", () => {
    const tracked = trackFormChange(null, {
      sectionIndex: 0,
      variantIndex: 0,
      shown: seeded,
      next: { title: "t" },
      sectionCount: 1,
    });
    const other = { title: "other" };
    expect(
      trackFormChange(tracked, {
        sectionIndex: 1,
        variantIndex: 0,
        shown: other,
        next: {},
        sectionCount: 1,
      })?.base,
    ).toBe(other);
    expect(
      trackFormChange(tracked, {
        sectionIndex: 0,
        variantIndex: 1,
        shown: other,
        next: {},
        sectionCount: 1,
      })?.base,
    ).toBe(other);
  });
});

describe("formSourceMovedOn", () => {
  it("ignores key order", () => {
    expect(formSourceMovedOn({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
  });

  it("flags a stored section another editor changed", () => {
    expect(
      formSourceMovedOn(
        { menu: [{ label: "SSRio" }] },
        { menu: [{ label: "SS Rio" }] },
      ),
    ).toBe(true);
  });

  it("does not flag a section that is gone (the save is skipped anyway)", () => {
    expect(formSourceMovedOn({ a: 1 }, null)).toBe(false);
  });
});

describe("sectionFormSource", () => {
  const parsed = (over: Partial<ParsedSection>) =>
    ({
      isSavedBlock: false,
      isLazy: false,
      isHidden: false,
      isMultivariate: false,
      ...over,
    }) as ParsedSection;

  it("reads a saved block from the decofile, as the form edits it", () => {
    const decofile = { Header: { __resolveType: "site/Header.tsx", x: 1 } };
    expect(
      sectionFormSource(
        { __resolveType: "Header" } as RawSection,
        parsed({ isSavedBlock: true }),
        0,
        decofile,
      ),
    ).toEqual({ __resolveType: "site/Header.tsx", x: 1 });
  });

  it("reads an inline section as stored on the page", () => {
    const raw = { __resolveType: "site/sections/Hero.tsx", title: "a" };
    expect(sectionFormSource(raw as RawSection, parsed({}), 0, {})).toEqual(
      raw,
    );
  });

  it("returns null for a section that is not there", () => {
    expect(sectionFormSource(undefined, undefined, 0, {})).toBeNull();
  });
});

describe("sectionTypeChanged", () => {
  const hero = { __resolveType: "site/sections/Hero.tsx", title: "a" };

  it("is false for the same section edited elsewhere", () => {
    expect(sectionTypeChanged(hero, { ...hero, title: "b" })).toBe(false);
  });

  it("is true when another type now sits at the form's position", () => {
    expect(
      sectionTypeChanged(hero, { __resolveType: "site/sections/Banner.tsx" }),
    ).toBe(true);
  });
});

describe("findSectionMovedTo", () => {
  const hero = { __resolveType: "site/sections/Hero.tsx", title: "a" };
  const inserted = { __resolveType: "site/sections/Hero.tsx", title: "new" };

  it("follows the form's section after one was inserted above it", () => {
    expect(findSectionMovedTo(hero, [inserted, hero], 0, 1)).toBe(1);
  });

  it("stays put while the page has as many sections as before", () => {
    // Identical twins: someone edited the form's own spacer, not moved it.
    const spacer = { __resolveType: "site/sections/Spacer.tsx", height: 24 };
    expect(
      findSectionMovedTo(spacer, [{ ...spacer, height: 48 }, spacer], 0, 2),
    ).toBe("here");
  });

  it("gives up when the count changed and the section can't be told apart", () => {
    const spacer = { __resolveType: "site/sections/Spacer.tsx", height: 24 };
    expect(findSectionMovedTo(spacer, [inserted, spacer, spacer], 0, 2)).toBe(
      "unknown",
    );
    expect(
      findSectionMovedTo(hero, [inserted, { ...hero, title: "b" }], 0, 1),
    ).toBe("unknown");
  });
});

describe("own versions", () => {
  it("knows the version the form started from and every version it saved", () => {
    const tracked = trackFormChange(null, {
      sectionIndex: 0,
      variantIndex: 0,
      shown: { title: "a" },
      next: { title: "b" },
      sectionCount: 1,
    });
    if (!tracked) throw new Error("expected a tracked form");
    rememberOwnVersion(tracked, { title: "b" });
    expect(isOwnVersion(tracked, { title: "a" })).toBe(true);
    expect(isOwnVersion(tracked, { title: "b" })).toBe(true);
    expect(isOwnVersion(tracked, { title: "someone else" })).toBe(false);
  });

  it("ignores key order", () => {
    const tracked = trackFormChange(null, {
      sectionIndex: 0,
      variantIndex: 0,
      shown: { a: 1, b: 2 },
      next: {},
      sectionCount: 1,
    });
    if (!tracked) throw new Error("expected a tracked form");
    expect(isOwnVersion(tracked, { b: 2, a: 1 })).toBe(true);
  });
});
