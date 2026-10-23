import { describe, expect, it } from "bun:test";
import type { ChangeDetail } from "@decocms/blocks/protocol";
import {
  findRuleReferences,
  findSavedMatcherReferences,
  markReferenceStates,
  planNamedRuleRename,
  publishedDecofile,
  type RuleReference,
} from "./rule-references";
import {
  PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
  SECTION_MULTIVARIATE_RESOLVE_TYPE,
} from "./section-types";

const builtIn = { $ref: "#/definitions/x", namespace: "deco" };
/** A v8 schema's manifest: built-in matchers by their short names. */
const v8Meta = {
  manifest: {
    blocks: {
      matchers: {
        always: builtIn,
        campaign: builtIn,
        experiment: builtIn,
        and: { $ref: "#/definitions/and", namespace: "site" },
        device: { $ref: "#/definitions/device", namespace: "site" },
      },
      loaders: { multivariate: builtIn, lazy: builtIn },
      content: { "split-traffic": builtIn, calendar: builtIn },
      pages: { page: builtIn },
      sections: { hero: { $ref: "#/definitions/hero", namespace: "site" } },
    },
  },
  schema: {},
};

const experiment = (name: string) => ({ __resolveType: "experiment", name });
const campaign = (name: string) => ({ __resolveType: "campaign", name: name });
const lazy = (value: unknown) => ({ __resolveType: "lazy", value });
const always = () => ({ __resolveType: "always" });

/** Names to the blocks using them, as compact strings. */
function summary(refs: Map<string, RuleReference[]>) {
  return Object.fromEntries(
    [...refs].map(([name, list]) => [
      name,
      list
        .map((ref) =>
          [
            ref.blockKey,
            ref.path.join("."),
            ref.variant ? `#${ref.variant.index}` : "-",
            ref.via.length ? `via ${ref.via.join(">")}` : "",
            ref.savedRule ? "saved" : "",
          ]
            .filter(Boolean)
            .join(" "),
        )
        .sort(),
    ]),
  );
}

describe("findRuleReferences on v8 content", () => {
  it("finds a page variant's rule, with the variant and the block's experiment", () => {
    const decofile = {
      home: {
        __resolveType: "page",
        path: "/",
        sections: {
          __resolveType: "multivariate",
          experiment: "hero-headline",
          variants: [
            { rule: experiment("hero-headline"), value: lazy([]) },
            { rule: always(), value: lazy([]) },
          ],
        },
      },
    };
    const refs = findRuleReferences(decofile, v8Meta);
    expect(summary(refs.experiments.byName)).toEqual({
      "hero-headline": ["home sections.variants.0.rule #0"],
    });
    const [ref] = refs.experiments.byName.get("hero-headline")!;
    expect(ref!.variant).toEqual({
      containerPath: ["sections"],
      containerType: "multivariate",
      index: 0,
      experiment: "hero-headline",
    });
    expect(refs.campaigns.byName.size).toBe(0);
  });

  it("finds a section variant inside a page variant's lazy list, and a rule inside a multi", () => {
    const decofile = {
      home: {
        __resolveType: "page",
        sections: {
          __resolveType: "multivariate",
          variants: [
            {
              rule: {
                __resolveType: "website/matchers/multi.ts",
                op: "AND",
                matchers: [campaign("Black Friday"), experiment("bf-hero")],
              },
              value: lazy([
                { __resolveType: "hero" },
                {
                  __resolveType: "multivariate",
                  variants: [
                    {
                      rule: experiment("bf-hero"),
                      value: lazy({ title: "A" }),
                    },
                    { rule: always(), value: lazy({ title: "B" }) },
                  ],
                },
              ]),
            },
          ],
        },
      },
    };
    const refs = findRuleReferences(decofile, v8Meta);
    expect(summary(refs.experiments.byName)).toEqual({
      "bf-hero": [
        "home sections.variants.0.rule.matchers.1 #0",
        "home sections.variants.0.value.value.1.variants.0.rule #0",
      ],
    });
    expect(summary(refs.campaigns.byName)).toEqual({
      "Black Friday": ["home sections.variants.0.rule.matchers.0 #0"],
    });
  });

  it("finds a field-level variant in a saved section", () => {
    const decofile = {
      "Home Hero": {
        __resolveType: "hero",
        title: {
          __resolveType: "multivariate",
          variants: [
            { rule: campaign("Summer"), value: lazy("Summer starts here") },
            { rule: always(), value: lazy("New collection") },
          ],
        },
      },
    };
    expect(
      summary(findRuleReferences(decofile, v8Meta).campaigns.byName),
    ).toEqual({
      Summer: ["Home Hero title.variants.0.rule #0"],
    });
  });

  it("follows saved rules to the blocks that use them, at any depth", () => {
    const decofile = {
      "Hero test": experiment("hero"),
      "Hero test on mobile": {
        __resolveType: "and",
        rules: [{ __resolveType: "Hero test" }, { __resolveType: "device" }],
      },
      home: {
        __resolveType: "page",
        sections: {
          __resolveType: "multivariate",
          variants: [
            { rule: { __resolveType: "Hero test" }, value: lazy([]) },
            { rule: { __resolveType: "Hero test on mobile" }, value: lazy([]) },
          ],
        },
      },
    };
    const refs = findRuleReferences(decofile, v8Meta);
    expect(summary(refs.experiments.byName)).toEqual({
      hero: [
        "Hero test - saved",
        "Hero test on mobile rules.0 - via Hero test saved",
        "home sections.variants.0.rule #0 via Hero test",
        "home sections.variants.1.rule #1 via Hero test on mobile>Hero test",
      ],
    });
  });

  it("stops at a cycle of saved rules", () => {
    const decofile = {
      A: {
        __resolveType: "and",
        rules: [experiment("t"), { __resolveType: "B" }],
      },
      B: { __resolveType: "and", rules: [{ __resolveType: "A" }] },
    };
    const refs = findRuleReferences(decofile, v8Meta);
    expect(summary(refs.experiments.byName)).toEqual({
      t: ["A rules.0 - saved", "B rules.0 - via A saved"],
    });
  });

  it("lists a name the experiments block doesn't have, and an unfinished empty name", () => {
    const decofile = {
      experiments: { __resolveType: "split-traffic", other: 10 },
      Banner: {
        __resolveType: "multivariate",
        variants: [
          { rule: experiment("gone"), value: lazy(1) },
          { rule: experiment(""), value: lazy(2) },
        ],
      },
    };
    const refs = findRuleReferences(decofile, v8Meta);
    expect([...refs.experiments.byName.keys()].sort()).toEqual(["", "gone"]);
    expect(refs.experiments.byName.has("other")).toBe(false);
  });

  it("terminates on cyclic and malformed content", () => {
    const loop: Record<string, unknown> = {
      __resolveType: "multivariate",
      variants: [{ rule: campaign("s"), value: null }],
    };
    loop.self = loop;
    const decofile = {
      Loop: loop,
      nothing: null,
      text: "date",
      list: [[[campaign("deep")]]],
    };
    const refs = findRuleReferences(decofile, v8Meta);
    expect(summary(refs.campaigns.byName)).toEqual({
      s: ["Loop variants.0.rule #0"],
      deep: ["list 0.0.0 -"],
    });
  });
});

describe("findRuleReferences on v7-shaped variants", () => {
  it("finds rules in the v7 page and section flags, which a v8 site still resolves", () => {
    const decofile = {
      home: {
        __resolveType: "website/pages/Page.tsx",
        sections: {
          __resolveType: PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
          variants: [
            { rule: campaign("Sale"), value: [] },
            {
              rule: { __resolveType: "website/matchers/always.ts" },
              value: [
                {
                  __resolveType: SECTION_MULTIVARIATE_RESOLVE_TYPE,
                  variants: [
                    { rule: experiment("t"), value: { __resolveType: "hero" } },
                  ],
                },
              ],
            },
          ],
        },
      },
    };
    const refs = findRuleReferences(decofile, v8Meta);
    expect(summary(refs.campaigns.byName)).toEqual({
      Sale: ["home sections.variants.0.rule #0"],
    });
    const [ref] = refs.experiments.byName.get("t")!;
    expect(ref!.variant).toEqual({
      containerPath: ["sections", "variants", 1, "value", 0],
      containerType: SECTION_MULTIVARIATE_RESOLVE_TYPE,
      index: 0,
    });
  });

  it("finds nothing in a v7 site's content, which has no named rules", () => {
    const decofile = {
      "Hero Test": {
        __resolveType: "website/matchers/random.ts",
        traffic: 0.5,
      },
      home: {
        __resolveType: "website/pages/Page.tsx",
        sections: {
          __resolveType: PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
          variants: [{ rule: { __resolveType: "Hero Test" }, value: [] }],
        },
      },
    };
    const refs = findRuleReferences(decofile);
    expect(refs.experiments.byName.size).toBe(0);
    expect(refs.campaigns.byName.size).toBe(0);
  });
});

describe("findSavedMatcherReferences", () => {
  it("lists each use with its variant, skipping the block's own body", () => {
    const decofile = {
      Mobile: { __resolveType: "and", rules: [{ __resolveType: "Mobile" }] },
      home: {
        __resolveType: "page",
        sections: {
          __resolveType: "multivariate",
          variants: [{ rule: { __resolveType: "Mobile" }, value: lazy([]) }],
        },
      },
    };
    expect(findSavedMatcherReferences(decofile, "Mobile", v8Meta)).toEqual([
      {
        blockKey: "home",
        path: ["sections", "variants", 0, "rule"],
        variant: {
          containerPath: ["sections"],
          containerType: "multivariate",
          index: 0,
        },
      },
    ]);
    expect(findSavedMatcherReferences(decofile, "", v8Meta)).toEqual([]);
  });
});

describe("draft and published references", () => {
  const page = (rules: unknown[]) => ({
    __resolveType: "page",
    sections: {
      __resolveType: "multivariate",
      variants: rules.map((rule) => ({ rule, value: lazy([]) })),
    },
  });
  const side = (
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
    baseVersion: string | null = before ? "b1" : null,
  ): ChangeDetail => ({
    kind: after ? "set" : "delete",
    before,
    after,
    version: after ? "v2" : null,
    baseVersion,
  });

  it("rebuilds the published content from the changes' before sides", () => {
    const draft = {
      home: page([experiment("new")]),
      about: page([]),
      shop: page([]),
    };
    const published = publishedDecofile(draft, {
      home: side(page([experiment("old")]), draft.home),
      about: side(null, draft.about),
      gone: side(page([campaign("x")]), null),
      // The base has it, but its published side couldn't be read.
      shop: side(null, draft.shop, "b9"),
      same: {
        kind: null,
        before: null,
        after: null,
        version: "v",
        baseVersion: "v",
      },
    });
    expect(published).toEqual({
      home: page([experiment("old")]),
      gone: page([campaign("x")]),
      shop: draft.shop,
    });
  });

  it("marks draft-only uses, published ones, and uses the draft removed", () => {
    const publishedContent = {
      home: page([experiment("t")]),
      about: page([experiment("t")]),
      rule: experiment("t"),
    };
    const draftContent = {
      home: page([always(), experiment("t")]),
      shop: page([experiment("t")]),
      rule: experiment("t"),
      landing: page([{ __resolveType: "rule" }]),
    };
    const marked = markReferenceStates(
      findRuleReferences(draftContent, v8Meta),
      findRuleReferences(publishedContent, v8Meta),
    );
    const states = Object.fromEntries(
      marked.experiments.byName
        .get("t")!
        .map((ref) => [[ref.blockKey, ...ref.via].join("<"), ref.state]),
    );
    expect(states).toEqual({
      // Moved to another variant: still the same block using it.
      home: "published",
      shop: "draft-only",
      rule: "published",
      "landing<rule": "draft-only",
      about: "removed-in-draft",
    });
  });

  it("lists a name only the published content uses", () => {
    const marked = markReferenceStates(
      findRuleReferences({}, v8Meta),
      findRuleReferences({ home: page([campaign("Old sale")]) }, v8Meta),
    );
    expect(
      marked.campaigns.byName.get("Old sale")!.map((ref) => ref.state),
    ).toEqual(["removed-in-draft"]);
  });
});

describe("whole-block uses: a section that decides in its own code", () => {
  const hero = () => ({
    __resolveType: "hero",
    experiments: { __resolveType: "experiments" },
    campaigns: { __resolveType: "campaigns" },
  });

  it("lists a section prop that takes the experiments or campaigns map", () => {
    const decofile = {
      experiments: { __resolveType: "split-traffic", "hero-test": 50 },
      home: {
        __resolveType: "page",
        sections: [hero(), lazy({ ...hero(), campaigns: undefined })],
      },
    };
    const refs = findRuleReferences(decofile, v8Meta);
    expect(
      refs.experiments.wholeBlock.map(
        (r) => `${r.blockKey} ${r.path.join(".")}`,
      ),
    ).toEqual([
      "home sections.1.value.experiments",
      "home sections.0.experiments",
    ]);
    // Not saved yet: still a use, the first change creates the block.
    expect(refs.campaigns.wholeBlock).toEqual([
      {
        kind: "campaigns",
        blockKey: "home",
        path: ["sections", 0, "campaigns"],
      },
    ]);
    // The block itself isn't a use of itself, and uses by name stay apart.
    expect(refs.experiments.byName.size).toBe(0);
  });

  it("isn't a use when the block under that name has another type", () => {
    const decofile = {
      campaigns: { __resolveType: "site/loaders/campaigns.ts" },
      home: { __resolveType: "page", sections: [hero()] },
    };
    const refs = findRuleReferences(decofile, v8Meta);
    expect(refs.campaigns.wholeBlock).toEqual([]);
    expect(refs.experiments.wholeBlock).toHaveLength(1);
  });

  it("marks a prop added in the draft, and one the draft removed", () => {
    const marked = markReferenceStates(
      findRuleReferences({
        home: { __resolveType: "page", sections: [hero()] },
      }),
      findRuleReferences({
        about: { __resolveType: "page", sections: [hero()] },
      }),
    );
    expect(
      marked.campaigns.wholeBlock.map((r) => `${r.blockKey}:${r.state}`),
    ).toEqual(["home:draft-only", "about:removed-in-draft"]);
  });
});

describe("date rules that name no campaign", () => {
  it("doesn't list a date rule written inline, or v7's date matchers", () => {
    const decofile = {
      home: {
        __resolveType: "page",
        sections: {
          __resolveType: "multivariate",
          variants: [
            {
              rule: {
                __resolveType: "date",
                start: "2026-11-27T00:00:00-03:00",
                end: "2026-12-01T00:00:00-03:00",
              },
              value: lazy([]),
            },
            {
              rule: {
                __resolveType: "website/matchers/date.ts",
                start: "2026-11-27T00:00:00-03:00",
                campaign: "not a v8 rule",
              },
              value: lazy([]),
            },
            { rule: campaign("black-friday"), value: lazy([]) },
          ],
        },
      },
    };
    const refs = findRuleReferences(decofile, v8Meta);
    expect([...refs.campaigns.byName.keys()]).toEqual(["black-friday"]);
  });
});

describe("v7 content stays as it is", () => {
  it("finds no uses in a v7 site, even with blocks named like the kinds", () => {
    const decofile = {
      // A v7 site's own blocks that happen to have these names.
      experiments: { __resolveType: "site/loaders/experiments.ts" },
      campaigns: { __resolveType: "site/loaders/campaigns.ts" },
      "Black Friday": {
        __resolveType: "website/matchers/date.ts",
        start: "2026-11-27T00:00:00-03:00",
      },
      home: {
        __resolveType: "website/pages/Page.tsx",
        sections: {
          __resolveType: PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
          variants: [
            { rule: { __resolveType: "Black Friday" }, value: [] },
            {
              rule: {
                __resolveType: "$live/matchers/MatchRandom.ts",
                traffic: 0.5,
              },
              value: [
                {
                  __resolveType: "site/sections/Promo.tsx",
                  flags: { __resolveType: "experiments" },
                  dates: { __resolveType: "campaigns" },
                },
              ],
            },
          ],
        },
      },
    };
    const refs = findRuleReferences(decofile);
    for (const kind of ["experiments", "campaigns"] as const) {
      expect(refs[kind].byName.size).toBe(0);
      expect(refs[kind].wholeBlock).toEqual([]);
    }
    // The saved v7 rule is still found where it is used.
    expect(
      findSavedMatcherReferences(decofile, "Black Friday").map(
        (r) => r.blockKey,
      ),
    ).toEqual(["home"]);
  });
});

describe("planNamedRuleRename", () => {
  const window = { start: "2026-11-27T00:00:00-03:00" };
  const decofile = {
    campaigns: {
      __resolveType: "calendar",
      "black-friday": window,
      launch: {},
    },
    "BF on mobile": {
      __resolveType: "and",
      rules: [campaign("black-friday"), { __resolveType: "device" }],
    },
    home: {
      __resolveType: "page",
      sections: {
        __resolveType: "multivariate",
        variants: [
          {
            rule: {
              __resolveType: "website/matchers/multi.ts",
              op: "OR",
              matchers: [campaign("black-friday"), campaign("launch")],
            },
            value: lazy([]),
          },
          { rule: campaign("black-friday"), value: lazy([]) },
          { rule: { __resolveType: "BF on mobile" }, value: lazy([]) },
        ],
      },
    },
    about: { __resolveType: "page", sections: [] },
  };

  it("renames the entry in place and rewrites every rule that names it, in one change", () => {
    const plan = planNamedRuleRename(
      decofile,
      "campaigns",
      "black-friday",
      "Black Friday",
      v8Meta,
    );
    expect(Object.keys(plan!.writes).sort()).toEqual([
      "BF on mobile",
      "campaigns",
      "home",
    ]);
    expect(Object.keys(plan!.writes.campaigns!)).toEqual([
      "__resolveType",
      "Black Friday",
      "launch",
    ]);
    const home = plan!.writes.home as typeof decofile.home;
    expect(home.sections.variants[0]!.rule).toEqual({
      __resolveType: "website/matchers/multi.ts",
      op: "OR",
      matchers: [campaign("Black Friday"), campaign("launch")],
    });
    expect(home.sections.variants[1]!.rule).toEqual(campaign("Black Friday"));
    // The page that uses the saved rule keeps its reference.
    expect(home.sections.variants[2]!.rule).toEqual({
      __resolveType: "BF on mobile",
    });
    expect(plan!.writes["BF on mobile"]).toEqual({
      __resolveType: "and",
      rules: [campaign("Black Friday"), { __resolveType: "device" }],
    });
    // The draft as read is untouched.
    expect(decofile.home.sections.variants[1]!.rule).toEqual(
      campaign("black-friday"),
    );
  });

  it("renames an A/B test the same way", () => {
    const plan = planNamedRuleRename(
      {
        experiments: { __resolveType: "split-traffic", hero: 0 },
        home: { __resolveType: "page", sections: { rule: experiment("hero") } },
      },
      "experiments",
      "hero",
      "hero-2",
    );
    expect(plan!.writes).toEqual({
      experiments: { __resolveType: "split-traffic", "hero-2": 0 },
      home: { __resolveType: "page", sections: { rule: experiment("hero-2") } },
    });
  });

  it("is null when there is nothing to rename or the new name is taken", () => {
    expect(
      planNamedRuleRename(decofile, "campaigns", "black-friday", "launch"),
    ).toBeNull();
    expect(
      planNamedRuleRename(decofile, "campaigns", "black-friday", " "),
    ).toBeNull();
    expect(planNamedRuleRename(decofile, "campaigns", "gone", "x")).toBeNull();
    expect(planNamedRuleRename({}, "experiments", "a", "b")).toBeNull();
    // A running test's name is locked.
    expect(
      planNamedRuleRename(
        { experiments: { __resolveType: "split-traffic", hero: 50 } },
        "experiments",
        "hero",
        "hero-2",
      ),
    ).toBeNull();
    expect(
      planNamedRuleRename(
        { campaigns: { __resolveType: "other", a: {} } },
        "campaigns",
        "a",
        "b",
      ),
    ).toBeNull();
  });
});
