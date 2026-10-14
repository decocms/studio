import { describe, expect, it } from "bun:test";
import {
  formSourceMovedOn,
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
    });
    const again = trackFormChange(tracked, {
      sectionIndex: 0,
      variantIndex: 0,
      shown: first,
      next: { title: "ty" },
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
    });
    const reloaded = { title: "someone else's" };
    const restarted = trackFormChange(tracked, {
      sectionIndex: 0,
      variantIndex: 0,
      shown: reloaded,
      next: { title: "x" },
    });
    expect(restarted?.base).toBe(reloaded);
  });

  it("restarts for another section or variant", () => {
    const tracked = trackFormChange(null, {
      sectionIndex: 0,
      variantIndex: 0,
      shown: seeded,
      next: { title: "t" },
    });
    const other = { title: "other" };
    expect(
      trackFormChange(tracked, {
        sectionIndex: 1,
        variantIndex: 0,
        shown: other,
        next: {},
      })?.base,
    ).toBe(other);
    expect(
      trackFormChange(tracked, {
        sectionIndex: 0,
        variantIndex: 1,
        shown: other,
        next: {},
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
