/**
 * "Used by" on a hosted draft, from the index (design: the counts and the
 * rename/delete rewrites read each entry's `meta.rules`, not every body): a
 * block not loaded is an index stub, counted through its `rules` and
 * `refs`, and the views load only the blocks they must read
 * (named-rule-loads.ts).
 */
import { describe, expect, it } from "bun:test";
import type { ChangeDetail } from "@decocms/blocks/protocol";
import { type ContentIndex, isIndexStub, listingOf } from "./hosted-content";
import {
  NAMED_RULE_BLOCKS,
  namedRuleDetailNames,
  namedRuleViewNames,
} from "./named-rule-loads";
import {
  missingNamedRules,
  namedRuleUseCount,
  namedRuleUseCounts,
  namedRuleUseRows,
  namedRuleUses,
} from "./named-rule-uses";
import { planNamedRuleRename } from "./rule-references";

const builtIn = { $ref: "#/definitions/x", namespace: "deco" };
const meta = {
  manifest: {
    blocks: {
      matchers: {
        always: builtIn,
        campaign: builtIn,
        experiment: builtIn,
      },
      loaders: { multivariate: builtIn, lazy: builtIn },
      content: { "split-traffic": builtIn, calendar: builtIn },
      pages: { page: builtIn },
      sections: {},
    },
  },
  schema: {},
} as never;

// `hero` is off (0): a running test's name is locked.
const experiments = { __resolveType: "split-traffic", hero: 0, shared: 10 };
const campaigns = {
  __resolveType: "calendar",
  summer: { start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" },
  shared: { start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" },
};

/** A draft's index: who uses what, as `meta.rules` and `meta.refs` say. */
function index(): ContentIndex {
  const entry = (meta: Record<string, unknown>) => ({ version: "v", meta });
  return {
    revision: "t1",
    resolvedRef: "rel-1",
    sequence: 1,
    entries: {
      experiments: entry({ type: "split-traffic" }),
      campaigns: entry({ type: "calendar" }),
      home: entry({ type: "page", path: "/", rules: ["hero", "summer"] }),
      about: entry({ type: "page", path: "/about", rules: ["hero"] }),
      // A saved rule naming the test, and a page that uses it.
      "Hero test": entry({ type: "experiment", rules: ["hero"] }),
      promo: entry({ type: "page", path: "/promo", refs: ["Hero test"] }),
      // A section that reads every test in its own code.
      Tests: entry({ type: "site/sections/Tests.tsx", refs: ["experiments"] }),
      // A name neither block holds: which kind is only in the body.
      ghost: entry({ type: "page", path: "/ghost", rules: ["gone"] }),
      // A name both blocks hold.
      both: entry({ type: "page", path: "/both", rules: ["shared"] }),
      plain: entry({ type: "page", path: "/plain" }),
    },
    draft: {},
  };
}

const ghostBody = {
  __resolveType: "page",
  path: "/ghost",
  sections: {
    __resolveType: "multivariate",
    variants: [
      { rule: { __resolveType: "campaign", name: "gone" }, value: [] },
    ],
  },
};

const usesOf = (
  decofile: Record<string, unknown>,
  sides?: Record<string, ChangeDetail>,
) =>
  namedRuleUses({
    decofile,
    meta,
    changeCount: sides ? Object.keys(sides).length : 0,
    sides,
  });

describe("Used by from the index (hosted)", () => {
  const listing = listingOf(index(), { experiments, campaigns });

  it("counts each name's users from the stubs' rules, through saved rules too", () => {
    expect(isIndexStub(listing.home)).toBe(true);
    const uses = usesOf(listing);
    // home, about, and promo through the saved rule (which isn't counted).
    expect(namedRuleUseCount(uses, "experiments", "hero")).toBe(3);
    expect(namedRuleUseCounts(listing, meta, "experiments", "hero")).toEqual({
      pages: 3,
      sections: 0,
    });
    expect(namedRuleUseCount(uses, "campaigns", "summer")).toBe(1);
    // A test's name is not a campaign's.
    expect(namedRuleUseCount(uses, "campaigns", "hero")).toBe(0);
    // One list for both kinds: a name both hold counts for each (A-35).
    expect(namedRuleUseCount(uses, "experiments", "shared")).toBe(1);
    expect(namedRuleUseCount(uses, "campaigns", "shared")).toBe(1);
  });

  it("lists the stubs as rows, and the sections that read the whole map", () => {
    const uses = usesOf(listing);
    expect(
      namedRuleUseRows(uses, "experiments", "hero", listing, meta).map(
        (row) => [row.blockKey, row.blockKind, row.path],
      ),
    ).toEqual([
      ["about", "page", "/about"],
      ["home", "page", "/"],
      ["promo", "page", "/promo"],
    ]);
    expect(
      namedRuleUseRows(uses, "experiments", null, listing, meta).map(
        (row) => row.blockKey,
      ),
    ).toEqual(["Tests"]);
  });

  it("a name neither block holds counts nowhere until its user is loaded", () => {
    const uses = usesOf(listing);
    expect(uses.refs.experiments.byName.has("gone")).toBe(false);
    expect(uses.refs.campaigns.byName.has("gone")).toBe(false);
    const loaded = listingOf(index(), {
      experiments,
      campaigns,
      ghost: ghostBody,
    });
    const after = usesOf(loaded);
    expect(missingNamedRules(after, "campaigns", loaded)).toEqual(["gone"]);
    expect(missingNamedRules(after, "experiments", loaded)).toEqual([]);
  });

  it("marks a stub's use against the published side's body", () => {
    // about changed in the draft: published, it used no test.
    const sides: Record<string, ChangeDetail> = {
      about: {
        kind: "set",
        before: { __resolveType: "page", path: "/about" },
        after: null,
        version: "v",
        baseVersion: "v0",
      } as unknown as ChangeDetail,
    };
    const uses = usesOf(listing, sides);
    const states = Object.fromEntries(
      (uses.refs.experiments.byName.get("hero") ?? []).map((ref) => [
        ref.blockKey,
        ref.state,
      ]),
    );
    expect(states).toMatchObject({
      home: "published",
      about: "draft-only",
      promo: "published",
    });
  });

  it("a rename over a stub user plans nothing; over its loaded body it rewrites only the users", () => {
    expect(planNamedRuleRename(listing, "experiments", "hero", "x", meta)).toBe(
      null,
    );
    const rule = (name: string) => ({
      __resolveType: "page",
      path: "/",
      v: { __resolveType: "experiment", name },
    });
    const loaded = listingOf(index(), {
      experiments,
      campaigns,
      home: rule("hero"),
      about: { ...rule("hero"), path: "/about" },
      "Hero test": { __resolveType: "experiment", name: "hero" },
    });
    const plan = planNamedRuleRename(loaded, "experiments", "hero", "x", meta);
    // promo uses it through the saved rule, rewritten where the rule is.
    expect(Object.keys(plan?.writes ?? {}).sort()).toEqual([
      "Hero test",
      "about",
      "experiments",
      "home",
    ]);
  });
});

describe("what the views load (named-rule-loads.ts)", () => {
  it("first the tests and campaigns blocks, then only the users of a name neither holds", () => {
    expect(namedRuleViewNames(index(), listingOf(index(), {}), meta)).toEqual([
      ...NAMED_RULE_BLOCKS,
    ]);
    expect(
      namedRuleViewNames(
        index(),
        listingOf(index(), { experiments, campaigns }),
        meta,
      ),
    ).toEqual([...NAMED_RULE_BLOCKS, "ghost"]);
  });

  it("an opened name: its users, through saved rules, and the whole-map readers", () => {
    const listing = listingOf(index(), { experiments, campaigns });
    expect(
      namedRuleDetailNames(index(), listing, meta, "experiments", "hero"),
    ).toEqual(["home", "about", "Hero test", "promo", "Tests"]);
    expect(
      namedRuleDetailNames(index(), listing, meta, "campaigns", "summer"),
    ).toEqual(["home"]);
  });
});
