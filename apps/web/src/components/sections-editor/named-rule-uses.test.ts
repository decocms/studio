import { describe, expect, it } from "bun:test";
import type { ChangeDetail } from "@decocms/blocks/protocol";
import {
  namedRuleEntryState,
  namedRulesRemovedInDraft,
  planNamedRuleCreate,
  planNamedRuleDelete,
  planNamedRuleSet,
  publishedNamedRuleValue,
} from "./named-rule-edits";
import {
  missingNamedRuleWithin,
  namedRulePickerKinds,
  namedRuleRowState,
  planNamedRulePick,
} from "./named-rule-picker";
import {
  blocksUsingMissingNamedRules,
  missingNamedRuleRowNames,
  missingNamedRuleRows,
  missingNamedRuleUseCounts,
  missingNamedRules,
  namedRuleUseCount,
  namedRuleUseCounts,
  namedRuleUseRows,
  namedRuleUses,
} from "./named-rule-uses";

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

describe("a test or campaign that isn't there", () => {
  const decofile = {
    experiments: { __resolveType: "split-traffic", used: 50, free: 10 },
    campaigns: {
      __resolveType: "date-windows",
      bf: { start: "2026-11-27T00:00:00Z" },
      spare: {},
    },
    "pages-home": page("Home", "/", experiment("used")),
    "pages-sale": page("Sale", "/sale", campaign("bf")),
    // Reads every test in its own code: a missing name just reads false.
    Banner: {
      __resolveType: "site/sections/Banner.tsx",
      tests: { __resolveType: "experiments" },
    },
  };
  const usesOf = (draft: Record<string, unknown>) =>
    namedRuleUses({ decofile: draft, meta, changeCount: 0, sides: undefined });

  it("is deleted even while pages use it", () => {
    expect(planNamedRuleDelete(decofile, "experiments", "used")).toEqual({
      writes: { experiments: { __resolveType: "split-traffic", free: 10 } },
    });
    expect(planNamedRuleDelete(decofile, "campaigns", "bf")).not.toBeNull();
    expect(planNamedRuleDelete(decofile, "experiments", "gone")).toBeNull();
  });

  it("lists the pages whose rules still name it, through saved rules too", () => {
    const draft = {
      ...decofile,
      experiments: { __resolveType: "split-traffic", free: 10 },
      "Used test": experiment("used"),
      "pages-promo": page("Promo", "/promo", { __resolveType: "Used test" }),
    };
    const uses = usesOf(draft);
    expect(missingNamedRules(uses, "experiments", draft)).toEqual(["used"]);
    expect(missingNamedRules(uses, "campaigns", draft)).toEqual([]);
    expect(
      missingNamedRuleRows(uses, "experiments", draft, meta).map((row) => [
        row.title,
        row.path,
        row.variant,
      ]),
    ).toEqual([
      ["Home", "/", 1],
      ["Promo", "/promo", 1],
    ]);
    expect(
      missingNamedRuleRows(usesOf(decofile), "experiments", decofile, meta),
    ).toEqual([]);
  });

  it("doesn't count a use the draft already removed", () => {
    const draft = {
      ...decofile,
      experiments: { __resolveType: "split-traffic", free: 10 },
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
    expect(missingNamedRules(uses, "experiments", draft)).toEqual([]);
    expect(missingNamedRuleRows(uses, "experiments", draft, meta)).toEqual([]);
  });

  it("flags each block that names one, for the kinds the schema has", () => {
    const draft = {
      ...decofile,
      experiments: { __resolveType: "split-traffic", free: 10 },
      campaigns: { __resolveType: "date-windows" },
    };
    const flagged = blocksUsingMissingNamedRules(draft, meta);
    expect([...flagged]).toEqual([
      ["pages-home", ["experiments"]],
      ["pages-sale", ["campaigns"]],
    ]);
    expect(blocksUsingMissingNamedRules(decofile, meta).size).toBe(0);
    // A site whose schema has neither built-in: nothing to flag.
    expect(
      blocksUsingMissingNamedRules(draft, {
        manifest: { blocks: {} },
        schema: {},
      }).size,
    ).toBe(0);
  });
});

describe("one definition of a missing name, everywhere", () => {
  // "hero" holds a share Studio can't read: no view lists it.
  const draft = {
    experiments: { __resolveType: "split-traffic", hero: "fifty", ok: 10 },
    "pages-home": page("Home", "/", experiment("hero")),
  };

  it("the picker row, the tab's list and the Publish review all call it missing", () => {
    const kinds = namedRulePickerKinds(meta, draft);
    expect(kinds[0]!.entries.map((e) => e.name)).toEqual(["ok"]);
    expect(namedRuleRowState(experiment("hero"), kinds)?.missing).toBe(true);
    const uses = namedRuleUses({
      decofile: draft,
      meta,
      changeCount: 0,
      sides: undefined,
    });
    expect(missingNamedRules(uses, "experiments", draft)).toEqual(["hero"]);
    expect(
      missingNamedRuleRows(uses, "experiments", draft, meta).map(
        (r) => r.title,
      ),
    ).toEqual(["Home"]);
    expect([...blocksUsingMissingNamedRules(draft, meta)]).toEqual([
      ["pages-home", ["experiments"]],
    ]);
  });

  it("creating it writes a value Studio can read in its place", () => {
    expect(
      planNamedRulePick(draft, {
        kind: "experiments",
        name: "hero",
        create: { share: 50 },
      }),
    ).toEqual({
      ok: true,
      rule: experiment("hero"),
      blockWrite: {
        blockKey: "experiments",
        block: { __resolveType: "split-traffic", hero: 50, ok: 10 },
      },
    });
    // A readable one created meanwhile is used as it is.
    expect(
      planNamedRulePick(draft, {
        kind: "experiments",
        name: "ok",
        create: { share: 50 },
      }),
    ).toMatchObject({ ok: true, blockWrite: null });
  });
});

describe("a block that holds something else (a clash)", () => {
  // "experiments" is some other block: its names can't be read, so none is
  // called missing; the row says what the picker says instead.
  const draft = {
    experiments: { __resolveType: "hero-banner", title: "x" },
    "pages-home": page("Home", "/", experiment("hero")),
    "pages-sale": page("Sale", "/sale", {
      __resolveType: "multi",
      op: "and",
      matchers: [experiment("hero"), { __resolveType: "always" }],
    }),
  };

  it("the row explains the clash and nothing calls the name missing", () => {
    const kinds = namedRulePickerKinds(meta, draft);
    expect(namedRuleRowState(experiment("hero"), kinds)).toMatchObject({
      missing: false,
      conflict: true,
    });
    expect(
      missingNamedRuleWithin(
        (draft["pages-sale"].sections.variants[0] as { rule: unknown }).rule,
        kinds,
        draft,
      ),
    ).toBeNull();
    const uses = namedRuleUses({
      decofile: draft,
      meta,
      changeCount: 0,
      sides: undefined,
    });
    expect(missingNamedRules(uses, "experiments", draft)).toEqual([]);
    expect(missingNamedRuleRows(uses, "experiments", draft, meta)).toEqual([]);
    expect(blocksUsingMissingNamedRules(draft, meta).size).toBe(0);
    expect(missingNamedRuleUseCounts(draft, meta).size).toBe(0);
  });
});

describe("counting where a name is used", () => {
  const section = (rule: unknown) => ({
    __resolveType: "site/sections/Hero.tsx",
    title: {
      __resolveType: "multivariate",
      variants: [{ rule, value: "B" }],
    },
  });
  const draft = {
    experiments: { __resolveType: "split-traffic", kept: 10 },
    "pages-a": page("A", "/a", experiment("gone")),
    "pages-b": page("B", "/b", experiment("gone")),
    Hero: section(experiment("gone")),
    Other: section(experiment("kept")),
  };

  it("says pages and sections apart", () => {
    expect(missingNamedRuleUseCounts(draft, meta).get("experiments")).toEqual({
      pages: 2,
      sections: 1,
      names: 1,
    });
    expect(namedRuleUseCounts(draft, meta, "experiments", "kept")).toEqual({
      pages: 0,
      sections: 1,
    });
  });
});

describe("how many names are missing, for a test or tests", () => {
  const draft = {
    experiments: { __resolveType: "split-traffic", kept: 10 },
    "pages-a": page("A", "/a", experiment("gone")),
    "pages-b": page("B", "/b", experiment("gone")),
  };
  const usesOf = (decofile: Record<string, unknown>) =>
    namedRuleUses({ decofile, meta, changeCount: 0, sides: undefined });

  it("one name used in several places is one name", () => {
    expect(missingNamedRuleUseCounts(draft, meta).get("experiments")).toEqual({
      pages: 2,
      sections: 0,
      names: 1,
    });
    expect(
      missingNamedRuleRowNames(usesOf(draft), "experiments", draft, meta),
    ).toBe(1);
  });

  it("two names, even on one page, are two", () => {
    const two = {
      ...draft,
      "pages-b": page("B", "/b", experiment("other")),
    };
    expect(missingNamedRuleUseCounts(two, meta).get("experiments")).toEqual({
      pages: 2,
      sections: 0,
      names: 2,
    });
    expect(
      missingNamedRuleRowNames(usesOf(two), "experiments", two, meta),
    ).toBe(2);
    const onePage = {
      experiments: draft.experiments,
      "pages-a": page("A", "/a", {
        __resolveType: "multi",
        op: "and",
        matchers: [experiment("gone"), experiment("other")],
      }),
    };
    expect(missingNamedRuleUseCounts(onePage, meta).get("experiments")).toEqual(
      { pages: 1, sections: 0, names: 2 },
    );
  });
});

describe("the missing-name flags are computed once per draft", () => {
  /** A draft that counts how often something walks its keys. */
  const counted = (value: Record<string, unknown>) => {
    const reads = { count: 0 };
    const proxy = new Proxy(value, {
      ownKeys(target) {
        reads.count++;
        return Reflect.ownKeys(target);
      },
    });
    return { proxy, reads };
  };
  const base = {
    experiments: { __resolveType: "split-traffic", kept: 10 },
    "pages-a": page("A", "/a", experiment("gone")),
  };

  it("reads the same draft and schema once, however many renders ask", () => {
    const { proxy, reads } = counted({ ...base });
    const flags = blocksUsingMissingNamedRules(proxy, meta);
    const counts = missingNamedRuleUseCounts(proxy, meta);
    const after = reads.count;
    expect(after).toBeGreaterThan(0);
    for (let render = 0; render < 5; render++) {
      expect(blocksUsingMissingNamedRules(proxy, meta)).toBe(flags);
      expect(missingNamedRuleUseCounts(proxy, meta)).toBe(counts);
    }
    expect(reads.count).toBe(after);
  });

  it("the tab's rows too, for the same uses", () => {
    const { proxy, reads } = counted({ ...base });
    const input = { decofile: proxy, meta, changeCount: 0, sides: undefined };
    const uses = namedRuleUses(input);
    const rows = missingNamedRuleRows(uses, "experiments", proxy, meta);
    const after = reads.count;
    // A render builds a new input object from the same query data.
    const again = namedRuleUses({ ...input });
    expect(again).toBe(uses);
    expect(missingNamedRuleRows(again, "experiments", proxy, meta)).toBe(rows);
    expect(reads.count).toBe(after);
  });

  it("computes again when the draft changes", () => {
    const first = blocksUsingMissingNamedRules({ ...base }, meta);
    const fixed = {
      ...base,
      experiments: { __resolveType: "split-traffic", kept: 10, gone: 5 },
    };
    const second = blocksUsingMissingNamedRules(fixed, meta);
    expect(first.size).toBe(1);
    expect(second.size).toBe(0);
  });
});
