import { describe, expect, it } from "bun:test";
import {
  type FormBase,
  formSaveGuard,
  formSourceMovedOn,
  sectionTypeChanged,
  findSectionMovedTo,
  focusInside,
  isOwnVersion,
  rememberOwnVersion,
  sectionFormSource,
  showMergeInForm,
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
        false,
      ),
    ).toEqual({ __resolveType: "site/Header.tsx", x: 1 });
  });

  it("reads an inline section as stored on the page", () => {
    const raw = { __resolveType: "site/sections/Hero.tsx", title: "a" };
    expect(
      sectionFormSource(raw as RawSection, parsed({}), 0, {}, false),
    ).toEqual(raw);
  });

  it("returns null for a section that is not there", () => {
    expect(sectionFormSource(undefined, undefined, 0, {}, false)).toBeNull();
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

describe("formSaveGuard (v8 section saves)", () => {
  const base = (): FormBase => ({
    sectionIndex: 0,
    variantIndex: 0,
    base: { title: "loaded" },
    emitted: { title: "typed" },
    sectionCount: 1,
    own: [],
  });

  it("guards a saved block with the version of the copy the form started from", () => {
    const formBase = base();
    const guard = formSaveGuard({
      formBase,
      rebased: false,
      versionOf: () => "v1",
    });
    expect(guard.ifMatch("Hero")).toEqual({ Hero: "v1" });
    expect(guard.reloadOnConflict).toBe(true);
    expect(formBase.version).toBe("v1");
  });

  it("a save queued behind the form's own landed save expects that save's version", () => {
    const formBase = base();
    let cached = "v1";
    const versionOf = () => cached;
    // Both saves are scheduled before either runs.
    const first = formSaveGuard({ formBase, rebased: false, versionOf });
    const second = formSaveGuard({ formBase, rebased: false, versionOf });
    expect(first.ifMatch("Hero")).toEqual({ Hero: "v1" });
    first.onApplied?.({ Hero: "v2" });
    // Another writer's version reaching the cache must not move the form's.
    cached = "v9";
    expect(second.ifMatch("Hero")).toEqual({ Hero: "v2" });
  });

  it("takes the stored copy's version when the form's edits were rebased on it", () => {
    const formBase = { ...base(), version: "v1" };
    const guard = formSaveGuard({
      formBase,
      rebased: true,
      versionOf: () => "v3",
    });
    expect(guard.ifMatch("Hero")).toEqual({ Hero: "v3" });
  });

  it("keeps the form's version when another writer's copy reached the cache", () => {
    const formBase = { ...base(), version: "v1" };
    const guard = formSaveGuard({
      formBase,
      rebased: false,
      versionOf: () => "v2",
    });
    expect(guard.ifMatch("Hero")).toEqual({ Hero: "v1" });
  });

  it("guards a page with its cached version, read when the save runs", () => {
    let cached = "p1";
    const guard = formSaveGuard({
      formBase: null,
      rebased: false,
      versionOf: () => cached,
    });
    cached = "p2";
    expect(guard.ifMatch("pages-home")).toEqual({ "pages-home": "p2" });
  });

  it("guards a block the content does not have as create-only", () => {
    const guard = formSaveGuard({
      formBase: null,
      rebased: false,
      versionOf: () => null,
    });
    expect(guard.ifMatch("Hero")).toEqual({ Hero: null });
  });

  it("sends no guard while the version is unknown", () => {
    const guard = formSaveGuard({
      formBase: base(),
      rebased: false,
      versionOf: () => undefined,
    });
    expect(guard.ifMatch("Hero")).toBeUndefined();
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

describe("showMergeInForm", () => {
  const tracked = (): FormBase => ({
    sectionIndex: 0,
    variantIndex: 0,
    base: { title: "a" },
    emitted: { title: "typed" },
    sectionCount: 1,
    own: [],
  });

  it("shows a merge at once while the form is still on the value saved", () => {
    // The merge kept every value the user changed: nothing under the cursor
    // changes (values both changed wait for the user's choice instead).
    const form = tracked();
    expect(
      showMergeInForm({
        merged: true,
        tracked: form,
        current: form,
        saved: form.emitted,
      }),
    ).toBe(true);
  });

  it("leaves the form alone when nothing was merged or it moved on", () => {
    const form = tracked();
    const base = {
      merged: true,
      tracked: form,
      current: form,
      saved: form.emitted,
    };
    expect(showMergeInForm({ ...base, merged: false })).toBe(false);
    expect(showMergeInForm({ ...base, current: tracked() })).toBe(false);
    expect(showMergeInForm({ ...base, saved: { title: "older" } })).toBe(false);
    expect(showMergeInForm({ ...base, tracked: null })).toBe(false);
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
