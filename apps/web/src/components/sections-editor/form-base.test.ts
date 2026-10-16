import { describe, expect, it } from "bun:test";
import {
  displayedOverBase,
  formValueOnBase,
  markEditedSinceDisplayed,
  formSourceMovedOn,
  sectionTypeChanged,
  findSectionMovedTo,
  focusInside,
  isOwnVersion,
  mergedFormDisplay,
  rememberOwnVersion,
  sectionFormSource,
  trackFormChange,
  type FormBase,
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

describe("mergedFormDisplay", () => {
  const tracked = (): FormBase => ({
    sectionIndex: 0,
    variantIndex: 0,
    base: { title: "a" },
    emitted: { title: "typed" },
    sectionCount: 1,
    own: [],
  });

  it("waits for the user to leave the form when the merge kept the stored value of a field they changed", () => {
    // Showing it now would put their next keystrokes after the stored text.
    const form = tracked();
    expect(
      mergedFormDisplay({
        merged: true,
        tracked: form,
        current: form,
        saved: form.emitted,
        keptStored: true,
        editing: true,
      }),
    ).toBe("on-leave");
  });

  it("shows the merge at once when the user is not in the form", () => {
    const form = tracked();
    expect(
      mergedFormDisplay({
        merged: true,
        tracked: form,
        current: form,
        saved: form.emitted,
        keptStored: true,
        editing: false,
      }),
    ).toBe("now");
  });

  it("shows a merge that kept every field the form changed at once, even while typing", () => {
    const form = tracked();
    expect(
      mergedFormDisplay({
        merged: true,
        tracked: form,
        current: form,
        saved: form.emitted,
        keptStored: false,
        editing: true,
      }),
    ).toBe("now");
  });

  it("leaves the form alone when nothing was merged or it moved on", () => {
    const form = tracked();
    const base = {
      merged: true,
      tracked: form,
      current: form,
      saved: form.emitted,
      keptStored: false,
      editing: false,
    };
    expect(mergedFormDisplay({ ...base, merged: false })).toBe("never");
    expect(mergedFormDisplay({ ...base, current: tracked() })).toBe("never");
    expect(mergedFormDisplay({ ...base, saved: { title: "older" } })).toBe(
      "never",
    );
    expect(mergedFormDisplay({ ...base, tracked: null })).toBe("never");
  });
});

describe("focusInside", () => {
  const node = (children: unknown[] = []) => ({
    contains: (other: unknown) => children.includes(other),
  });

  it("is true only for an element within the container", () => {
    const input = {};
    const form = node([input]);
    expect(focusInside(form as Element, input as Element)).toBe(true);
    expect(focusInside(form as Element, {} as Element)).toBe(false);
    expect(focusInside(null, input as Element)).toBe(false);
    expect(focusInside(form as Element, null)).toBe(false);
  });
});

describe("formValueOnBase", () => {
  // The form shows the user's "Draft" while the stored headline is the other
  // editor's "Published" (and their new subtitle), which the user was told.
  const waiting = (): FormBase => ({
    sectionIndex: 0,
    variantIndex: 0,
    base: { headline: "Published", subtitle: "Theirs", cta: "Buy" },
    displayed: { headline: "Draft", subtitle: "Old", cta: "Buy" },
    emitted: { headline: "Draft", subtitle: "Old", cta: "Buy" },
    sectionCount: 1,
    own: [],
  });

  it("saves what the user types after the merge over the stored value", () => {
    expect(
      formValueOnBase(waiting(), {
        headline: "Draft more",
        subtitle: "Old",
        cta: "Buy",
      }),
    ).toEqual({ headline: "Draft more", subtitle: "Theirs", cta: "Buy" });
  });

  it("keeps the stored value of every field the user leaves alone", () => {
    expect(
      formValueOnBase(waiting(), {
        headline: "Draft",
        subtitle: "Old",
        cta: "Buy now",
      }),
    ).toEqual({ headline: "Published", subtitle: "Theirs", cta: "Buy now" });
  });

  it("passes the form's value through when it shows the stored section", () => {
    const value = { headline: "typed" };
    expect(formValueOnBase({ ...waiting(), displayed: undefined }, value)).toBe(
      value,
    );
    expect(formValueOnBase(null, value)).toBe(value);
  });
});

describe("displayedOverBase", () => {
  it("is unset when the form shows what is stored", () => {
    expect(displayedOverBase({ b: 1, a: 2 }, { a: 2, b: 1 })).toBeUndefined();
  });

  it("is what the form shows when it differs from what is stored", () => {
    const shown = { a: 1 };
    expect(displayedOverBase(shown, { a: 2 })).toBe(shown);
  });
});

describe("markEditedSinceDisplayed", () => {
  const displayed = { headline: "Draft", subtitle: "Old", cta: "Buy" };
  const base = { headline: "Published", subtitle: "Theirs", cta: "Buy" };
  const tracked = (shown: Record<string, unknown>): FormBase => ({
    sectionIndex: 0,
    variantIndex: 0,
    base,
    displayed: shown,
    emitted: shown,
    sectionCount: 1,
    own: [],
  });

  it("keeps a field the user typed back to the same text as theirs", () => {
    // Select all, type "Draft" again: the field went through other values.
    let shown: unknown = displayed;
    for (const headline of ["D", "Dr", "Dra", "Draf", "Draft"]) {
      shown = markEditedSinceDisplayed(shown, { ...displayed, headline });
    }
    expect(
      formValueOnBase(tracked(shown as Record<string, unknown>), displayed),
    ).toEqual({ headline: "Draft", subtitle: "Theirs", cta: "Buy" });
  });

  it("leaves the fields the user did not touch as shown", () => {
    const shown = markEditedSinceDisplayed(displayed, {
      ...displayed,
      cta: "Buy now",
    });
    expect(shown).toMatchObject({ headline: "Draft", subtitle: "Old" });
    expect(
      formValueOnBase(tracked(shown as Record<string, unknown>), {
        ...displayed,
        cta: "Buy now",
      }),
    ).toEqual({ headline: "Published", subtitle: "Theirs", cta: "Buy now" });
  });

  it("marks nested values one by one and a cleared value as edited", () => {
    const nested = { hero: { title: "a", text: "b" }, tag: "x" };
    const now = { hero: { title: "a2", text: "b" } };
    const shown = markEditedSinceDisplayed(nested, now) as Record<
      string,
      Record<string, unknown>
    >;
    expect(shown.hero?.text).toBe("b");
    expect(shown.hero?.title).not.toBe("a");
    expect(
      formValueOnBase(
        {
          ...tracked(shown),
          base: { hero: { title: "z", text: "y" }, tag: "w" },
        },
        now,
      ),
    ).toEqual({ hero: { title: "a2", text: "y" } });
  });
});
