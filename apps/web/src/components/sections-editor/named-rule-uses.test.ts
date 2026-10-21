import { describe, expect, it } from "bun:test";
import type { ChangeDetail } from "@decocms/blocks/protocol";
import {
  namedRuleEntryState,
  namedRulesLeftInUse,
  namedRulesRemovedInDraft,
  planNamedRuleCreate,
  planNamedRuleDelete,
  planNamedRuleSet,
  publishedNamedRuleValue,
} from "./named-rule-edits";
import {
  namedRuleBlockingRows,
  namedRuleUseCount,
  namedRuleUseRows,
  namedRuleUses,
} from "./named-rule-uses";
import { planNamedRuleRename } from "./rule-references";

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
};

const experiment = (name: string) => ({ __resolveType: "experiment", name });
const campaign = (name: string) => ({ __resolveType: "date", campaign: name });
const lazy = (value: unknown) => ({ __resolveType: "lazy", value });

const page = (name: string, path: string, rule: unknown) => ({
  __resolveType: "page",
  name,
  path,
  sections: {
    __resolveType: "multivariate",
    variants: [
      { rule, value: lazy([]) },
      { rule: { __resolveType: "always" }, value: lazy([]) },
    ],
  },
});

const side = (
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): ChangeDetail => ({
  kind: after ? "set" : "delete",
  before,
  after,
  version: after ? "v2" : null,
  baseVersion: before ? "v1" : null,
});

describe("namedRuleUses", () => {
  const published = {
    experiments: { __resolveType: "split-traffic", "hero-test": 50 },
    "pages-home-1": page("Home", "/", experiment("hero-test")),
  };
  const draft = {
    ...published,
    experiments: {
      __resolveType: "split-traffic",
      "hero-test": 50,
      "cta-test": 10,
    },
    "pages-pdp-2": page("Product", "/p/:slug", experiment("hero-test")),
    banner: {
      __resolveType: "multivariate",
      variants: [{ rule: experiment("cta-test"), value: lazy({}) }],
    },
  };
  const sides = {
    experiments: side(published.experiments, draft.experiments),
    "pages-pdp-2": side(null, draft["pages-pdp-2"]),
    banner: side(null, draft.banner),
  };

  it("marks the uses the draft added as not published yet", () => {
    const uses = namedRuleUses({
      decofile: draft,
      meta,
      changeCount: 3,
      sides,
    });
    expect(uses.published).not.toBeNull();
    const rows = namedRuleUseRows(
      uses,
      "experiments",
      "hero-test",
      draft,
      meta,
    );
    expect(rows.map((r) => [r.title, r.path, r.variant, r.state])).toEqual([
      ["Home", "/", 1, "published"],
      ["Product", "/p/:slug", 1, "draft-only"],
    ]);
    expect(rows.every((r) => r.blockKind === "page")).toBe(true);
    const cta = namedRuleUseRows(uses, "experiments", "cta-test", draft, meta);
    expect(cta).toEqual([
      {
        blockKey: "banner",
        blockKind: "section",
        title: "Banner",
        variant: 1,
        wholeBlock: false,
        state: "draft-only",
      },
    ]);
  });

  it("lists a use the draft removed, labelled from the published content", () => {
    const { "pages-home-1": _home, ...withoutHome } = draft;
    const uses = namedRuleUses({
      decofile: withoutHome,
      meta,
      changeCount: 4,
      sides: {
        ...sides,
        "pages-home-1": side(published["pages-home-1"], null),
      },
    });
    const rows = namedRuleUseRows(
      uses,
      "experiments",
      "hero-test",
      withoutHome,
      meta,
    );
    expect(rows.map((r) => [r.title, r.state])).toEqual([
      ["Product", "draft-only"],
      ["Home", "removed-in-draft"],
    ]);
    // The count is of what the draft uses.
    expect(namedRuleUseCount(uses, "experiments", "hero-test")).toBe(1);
  });

  it("calls everything published when the draft has no changes", () => {
    const uses = namedRuleUses({
      decofile: published,
      meta,
      changeCount: 0,
      sides: undefined,
    });
    expect(uses.published).toBe(published);
    expect(
      namedRuleUseRows(uses, "experiments", "hero-test", published, meta).map(
        (r) => r.state,
      ),
    ).toEqual(["published"]);
  });

  it("shows no marks while the changes are still being read", () => {
    const uses = namedRuleUses({
      decofile: draft,
      meta,
      changeCount: undefined,
      sides: undefined,
    });
    expect(uses.published).toBeNull();
    expect(
      namedRuleUseRows(uses, "experiments", "hero-test", draft, meta).map(
        (r) => r.state,
      ),
    ).toEqual(["published", "published"]);
  });

  it("lists sections that read the whole block apart", () => {
    const decofile = {
      campaigns: {
        __resolveType: "date-windows",
        "black-friday": { start: "2026-11-27T00:00:00-03:00" },
      },
      hero: {
        __resolveType: "site/sections/Hero.tsx",
        campaigns: { __resolveType: "campaigns" },
      },
      "pages-home-1": page("Home", "/", campaign("black-friday")),
    };
    const uses = namedRuleUses({
      decofile,
      meta,
      changeCount: 0,
      sides: undefined,
    });
    expect(
      namedRuleUseRows(uses, "campaigns", null, decofile, meta).map((r) => [
        r.blockKey,
        r.wholeBlock,
      ]),
    ).toEqual([["hero", true]]);
    expect(
      namedRuleUseRows(uses, "campaigns", "black-friday", decofile, meta).map(
        (r) => r.title,
      ),
    ).toEqual(["Home"]);
  });

  it("lists a block once per variant that uses the name", () => {
    const decofile = {
      "pages-home-1": {
        __resolveType: "page",
        name: "Home",
        path: "/",
        sections: {
          __resolveType: "multivariate",
          variants: [
            { rule: experiment("t"), value: lazy([]) },
            { rule: experiment("t"), value: lazy([]) },
          ],
        },
      },
    };
    const uses = namedRuleUses({
      decofile,
      meta,
      changeCount: 0,
      sides: undefined,
    });
    expect(
      namedRuleUseRows(uses, "experiments", "t", decofile, meta).map(
        (r) => r.variant,
      ),
    ).toEqual([1, 2]);
    expect(namedRuleUseCount(uses, "experiments", "t")).toBe(1);
  });
});

describe("named rule edits", () => {
  const decofile = {
    experiments: { __resolveType: "split-traffic", a: 50, b: 0 },
  };

  it("sets a share in place, keeping the other names", () => {
    expect(planNamedRuleSet(decofile, "experiments", "a", 20)).toEqual({
      writes: {
        experiments: { __resolveType: "split-traffic", a: 20, b: 0 },
      },
    });
  });

  it("creates the block with the first name", () => {
    expect(
      planNamedRuleSet({}, "campaigns", "bf", {
        start: "2026-11-27T00:00:00Z",
      }),
    ).toEqual({
      writes: {
        campaigns: {
          __resolveType: "date-windows",
          bf: { start: "2026-11-27T00:00:00Z" },
        },
      },
    });
  });

  it("never writes over a block of another type", () => {
    const other = { experiments: { __resolveType: "site/loaders/x.ts" } };
    expect(planNamedRuleSet(other, "experiments", "a", 1)).toBeNull();
    expect(planNamedRuleCreate(other, "experiments", "a", 1)).toEqual({
      problem: "conflict",
    });
    expect(planNamedRuleDelete(other, "experiments", "a")).toBeNull();
  });

  it("refuses a name that is taken, empty or reserved", () => {
    expect(planNamedRuleCreate(decofile, "experiments", "a", 5)).toEqual({
      problem: "taken",
    });
    expect(planNamedRuleCreate(decofile, "experiments", " ", 5)).toEqual({
      problem: "empty",
    });
    expect(
      planNamedRuleCreate(decofile, "experiments", "__resolveType", 5),
    ).toEqual({ problem: "reserved" });
    expect(planNamedRuleCreate(decofile, "experiments", " c ", 5)).toEqual({
      change: {
        writes: {
          experiments: { __resolveType: "split-traffic", a: 50, b: 0, c: 5 },
        },
      },
    });
  });

  it("deletes only the entry", () => {
    expect(planNamedRuleDelete(decofile, "experiments", "a")).toEqual({
      writes: { experiments: { __resolveType: "split-traffic", b: 0 } },
    });
    expect(planNamedRuleDelete(decofile, "experiments", "zzz")).toBeNull();
  });

  it("compares a name with the published site", () => {
    const published = {
      experiments: { __resolveType: "split-traffic", a: 50 },
      campaigns: {
        __resolveType: "date-windows",
        bf: { start: "2026-11-27T03:00:00.000Z" },
      },
    };
    expect(namedRuleEntryState(null, "experiments", "a", 50)).toBeNull();
    expect(namedRuleEntryState(published, "experiments", "a", 50)).toBe(
      "published",
    );
    expect(namedRuleEntryState(published, "experiments", "a", 20)).toBe(
      "changed",
    );
    expect(namedRuleEntryState(published, "experiments", "new", 20)).toBe(
      "new",
    );
    // The same moment written with another offset is the same window.
    expect(
      namedRuleEntryState(published, "campaigns", "bf", {
        start: "2026-11-27T00:00:00-03:00",
      }),
    ).toBe("published");
    expect(
      namedRuleEntryState(published, "campaigns", "bf", {
        start: "2026-11-27T00:00:00-03:00",
        end: "2026-12-01T00:00:00-03:00",
      }),
    ).toBe("changed");
    expect(publishedNamedRuleValue(published, "experiments", "a")).toBe(50);
    expect(
      namedRulesRemovedInDraft(decofile, published, "experiments"),
    ).toEqual([]);
    expect(
      namedRulesRemovedInDraft(
        { experiments: { __resolveType: "split-traffic" } },
        published,
        "experiments",
      ),
    ).toEqual(["a"]);
  });
});

describe("deleting a name that pages use", () => {
  const decofile = {
    experiments: { __resolveType: "split-traffic", used: 50, free: 10 },
    campaigns: {
      __resolveType: "date-windows",
      bf: { start: "2026-11-27T00:00:00Z" },
      spare: {},
    },
    "pages-home": page("Home", "/", experiment("used")),
    "pages-sale": page("Sale", "/sale", campaign("bf")),
    // Reads every test in its own code: never blocks a delete.
    Banner: {
      __resolveType: "site/sections/Banner.tsx",
      tests: { __resolveType: "experiments" },
    },
  };

  it("is refused while a rule names it, and plain when nothing does", () => {
    expect(planNamedRuleDelete(decofile, "experiments", "used")).toBeNull();
    expect(planNamedRuleDelete(decofile, "campaigns", "bf")).toBeNull();
    expect(planNamedRuleDelete(decofile, "experiments", "free")).toEqual({
      writes: {
        experiments: { __resolveType: "split-traffic", used: 50 },
      },
    });
    expect(planNamedRuleDelete(decofile, "campaigns", "spare")).not.toBeNull();
  });

  it("finds a used name removed by any change, but never by a rename", () => {
    expect(
      namedRulesLeftInUse(decofile, {
        writes: { experiments: { __resolveType: "split-traffic" } },
      }),
    ).toEqual([{ kind: "experiments", name: "used" }]);
    expect(
      namedRulesLeftInUse(decofile, { writes: {}, deletes: ["campaigns"] }),
    ).toEqual([{ kind: "campaigns", name: "bf" }]);
    // The page goes in the same change: nothing is left using the test.
    expect(
      namedRulesLeftInUse(decofile, {
        writes: { experiments: { __resolveType: "split-traffic", free: 10 } },
        deletes: ["pages-home"],
      }),
    ).toEqual([]);
    // A test that isn't running can be renamed: every rule moves with it.
    const off = {
      ...decofile,
      experiments: { __resolveType: "split-traffic", used: 0 },
    };
    const rename = planNamedRuleRename(
      off,
      "experiments",
      "used",
      "renamed",
      meta,
    );
    expect(rename).not.toBeNull();
    expect(namedRulesLeftInUse(off, rename!)).toEqual([]);
  });

  it("lists the pages, variants and saved rules that keep it", () => {
    const withSavedRule = {
      ...decofile,
      "Used test": experiment("used"),
      "pages-promo": page("Promo", "/promo", { __resolveType: "Used test" }),
    };
    const uses = namedRuleUses({
      decofile: withSavedRule,
      meta,
      changeCount: 0,
      sides: undefined,
    });
    const rows = namedRuleBlockingRows(
      uses,
      "experiments",
      "used",
      withSavedRule,
      meta,
    );
    expect(rows.map((row) => [row.title, row.path, row.variant])).toEqual([
      ["Home", "/", 1],
      ["Promo", "/promo", 1],
      ["Used test", undefined, undefined],
    ]);
    expect(
      namedRuleBlockingRows(uses, "experiments", "free", withSavedRule, meta),
    ).toEqual([]);
  });

  it("doesn't count a use the draft already removed", () => {
    const draft = {
      ...decofile,
      "pages-home": page("Home", "/", { __resolveType: "always" }),
    };
    const uses = namedRuleUses({
      decofile: draft,
      meta,
      changeCount: 1,
      sides: {
        "pages-home": side(decofile["pages-home"], draft["pages-home"]),
      },
    });
    expect(
      namedRuleUseRows(uses, "experiments", "used", draft, meta).map(
        (row) => row.state,
      ),
    ).toEqual(["removed-in-draft"]);
    expect(
      namedRuleBlockingRows(uses, "experiments", "used", draft, meta),
    ).toEqual([]);
    expect(planNamedRuleDelete(draft, "experiments", "used")).not.toBeNull();
  });
});
