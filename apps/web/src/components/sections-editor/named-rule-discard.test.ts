import { describe, expect, test } from "bun:test";
import type { ChangeDetail } from "@decocms/blocks/protocol";
import { namedRuleDiscardBreaks } from "./named-rule-discard";

const builtIn = { $ref: "#/definitions/x", namespace: "deco" };
const meta = {
  manifest: {
    blocks: {
      matchers: { always: builtIn, date: builtIn, experiment: builtIn },
      loaders: { multivariate: builtIn, lazy: builtIn },
      content: { "split-traffic": builtIn, "date-windows": builtIn },
      pages: { page: builtIn },
    },
  },
  schema: {},
} as never;

const lazy = (value: unknown) => ({ __resolveType: "lazy", value });
const page = (name: string, path: string, rule: unknown) => ({
  __resolveType: "page",
  name,
  path,
  sections: {
    __resolveType: "multivariate",
    variants: [
      { rule: { __resolveType: "always" }, value: lazy([]) },
      { rule, value: lazy([]) },
    ],
  },
});
const test_ = (name: string) => ({ __resolveType: "experiment", name });

/** A change from `before` (the base) to `after` (the draft). */
const side = (
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): ChangeDetail => ({
  kind: after === null ? "delete" : "set",
  before,
  after,
  version: after === null ? null : "v",
  baseVersion: before === null ? null : "b",
});

describe("namedRuleDiscardBreaks", () => {
  test("discarding only the A/B tests change while a page in the draft uses a test it created: blocked", () => {
    const baseTests = { __resolveType: "split-traffic", hero: 50 };
    const draftTests = { ...baseTests, promo: 20 };
    const draftPromo = page("Promo", "/promo", test_("promo"));
    const draft = { experiments: draftTests, "pages-promo": draftPromo };
    const sides = {
      experiments: side(baseTests, draftTests),
      "pages-promo": side(null, draftPromo),
    };
    const breaks = namedRuleDiscardBreaks({
      draft,
      sides,
      names: ["experiments"],
      meta,
    });
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toMatchObject({
      kind: "experiments",
      name: "promo",
      cause: "removes",
    });
    expect(breaks[0]!.rows).toEqual([
      expect.objectContaining({
        blockKey: "pages-promo",
        blockKind: "page",
        title: "Promo",
        path: "/promo",
        variant: 2,
      }),
    ]);
    // Both together, or the page first, are fine.
    expect(
      namedRuleDiscardBreaks({
        draft,
        sides,
        names: ["experiments", "pages-promo"],
        meta,
      }),
    ).toEqual([]);
    expect(
      namedRuleDiscardBreaks({ draft, sides, names: ["pages-promo"], meta }),
    ).toEqual([]);
  });

  test("discarding a page change that brings back a use of a test the draft deleted: blocked", () => {
    const baseTests = { __resolveType: "split-traffic", hero: 50, old: 10 };
    const draftTests = { __resolveType: "split-traffic", hero: 50 };
    const baseHome = page("Home", "/", test_("old"));
    const draftHome = page("Home", "/", { __resolveType: "always" });
    const draft = { experiments: draftTests, "pages-home": draftHome };
    const sides = {
      experiments: side(baseTests, draftTests),
      "pages-home": side(baseHome, draftHome),
    };
    const breaks = namedRuleDiscardBreaks({
      draft,
      sides,
      names: ["pages-home"],
      meta,
    });
    expect(breaks).toEqual([
      expect.objectContaining({
        kind: "experiments",
        name: "old",
        cause: "returns",
      }),
    ]);
    expect(breaks[0]!.rows.map((row) => row.title)).toEqual(["Home"]);
    // The tests change first (the test comes back), then the page: fine.
    expect(
      namedRuleDiscardBreaks({ draft, sides, names: ["experiments"], meta }),
    ).toEqual([]);
  });

  test("a campaign the discard takes away, through a saved rule", () => {
    const baseDates = { __resolveType: "date-windows" };
    const draftDates = { ...baseDates, bf: { start: "2026-11-27T00:00:00Z" } };
    const rule = { __resolveType: "date", campaign: "bf" };
    const sale = page("Sale", "/sale", { __resolveType: "BF%20rule" });
    const draft = {
      campaigns: draftDates,
      "BF%20rule": rule,
      "pages-sale": sale,
    };
    const breaks = namedRuleDiscardBreaks({
      draft,
      sides: { campaigns: side(baseDates, draftDates) },
      names: ["campaigns"],
      meta,
    });
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toMatchObject({
      kind: "campaigns",
      name: "bf",
      cause: "removes",
    });
    expect(breaks[0]!.rows.map((row) => [row.blockKind, row.title])).toEqual([
      ["rule", "BF rule"],
      ["page", "Sale"],
    ]);
  });

  test("a name already missing in the draft isn't the discard's doing", () => {
    const tests = { __resolveType: "split-traffic", hero: 50 };
    const ghost = page("Ghost", "/ghost", test_("gone"));
    const banner = { __resolveType: "site/sections/Banner.tsx", title: "a" };
    const draft = {
      experiments: tests,
      "pages-ghost": ghost,
      Banner: { ...banner, title: "b" },
    };
    expect(
      namedRuleDiscardBreaks({
        draft,
        sides: { Banner: side(banner, draft.Banner) },
        names: ["Banner"],
        meta,
      }),
    ).toEqual([]);
  });

  test("a discard that touches no test or campaign is safe", () => {
    const tests = { __resolveType: "split-traffic", hero: 50 };
    const home = page("Home", "/", test_("hero"));
    const draft = {
      experiments: tests,
      "pages-home": { ...home, name: "Start" },
    };
    expect(
      namedRuleDiscardBreaks({
        draft,
        sides: { "pages-home": side(home, draft["pages-home"]) },
        names: ["pages-home"],
        meta,
      }),
    ).toEqual([]);
  });
});
