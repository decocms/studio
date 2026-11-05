import { describe, expect, it } from "bun:test";
import {
  findRuleReferences,
  findSavedMatcherReferences,
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
  it("finds a page variant's rule", () => {
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
    expect(summary(refs.experiments)).toEqual({
      "hero-headline": ["home"],
    });
    expect(refs.campaigns.size).toBe(0);
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
    expect(summary(refs.experiments)).toEqual({
      "bf-hero": ["home", "home"],
    });
    expect(summary(refs.campaigns)).toEqual({
      "Black Friday": ["home"],
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
    expect(summary(findRuleReferences(decofile, v8Meta).campaigns)).toEqual({
      Summer: ["Home Hero"],
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
    expect(summary(refs.experiments)).toEqual({
      hero: [
        "Hero test on mobile via Hero test saved",
        "Hero test saved",
        "home via Hero test",
        "home via Hero test on mobile>Hero test",
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
    expect(summary(refs.experiments)).toEqual({
      t: ["A saved", "B via A saved"],
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
    expect([...refs.experiments.keys()].sort()).toEqual(["", "gone"]);
    expect(refs.experiments.has("other")).toBe(false);
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
    expect(summary(refs.campaigns)).toEqual({
      s: ["Loop"],
      deep: ["list"],
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
    expect(summary(refs.campaigns)).toEqual({
      Sale: ["home"],
    });
    expect(summary(refs.experiments)).toEqual({ t: ["home"] });
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
    expect(refs.experiments.size).toBe(0);
    expect(refs.campaigns.size).toBe(0);
  });
});

describe("findSavedMatcherReferences", () => {
  it("lists each use, skipping the block's own body", () => {
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
      { blockKey: "home", path: ["sections", "variants", 0, "rule"] },
    ]);
    expect(findSavedMatcherReferences(decofile, "", v8Meta)).toEqual([]);
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
    expect([...refs.campaigns.keys()]).toEqual(["black-friday"]);
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
      expect(refs[kind].size).toBe(0);
    }
    // The saved v7 rule is still found where it is used.
    expect(
      findSavedMatcherReferences(decofile, "Black Friday").map(
        (r) => r.blockKey,
      ),
    ).toEqual(["home"]);
  });
});
