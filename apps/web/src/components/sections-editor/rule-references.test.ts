import { describe, expect, it } from "bun:test";
import type { ChangeDetail } from "@decocms/blocks/protocol";
import {
  findRuleReferences,
  findSavedMatcherReferences,
  markReferenceStates,
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
        date: builtIn,
        experiment: builtIn,
        schedule: builtIn,
        and: { $ref: "#/definitions/and", namespace: "site" },
        device: { $ref: "#/definitions/device", namespace: "site" },
      },
      loaders: { multivariate: builtIn, lazy: builtIn },
      content: { experiments: builtIn, schedules: builtIn },
      pages: { page: builtIn },
      sections: { hero: { $ref: "#/definitions/hero", namespace: "site" } },
    },
  },
  schema: {},
};

const experiment = (name: string) => ({ __resolveType: "experiment", name });
const schedule = (name: string) => ({ __resolveType: "schedule", name });
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
    expect(summary(refs.experiments)).toEqual({
      "hero-headline": ["home sections.variants.0.rule #0"],
    });
    const [ref] = refs.experiments.get("hero-headline")!;
    expect(ref!.variant).toEqual({
      containerPath: ["sections"],
      containerType: "multivariate",
      index: 0,
      experiment: "hero-headline",
    });
    expect(refs.schedules.size).toBe(0);
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
                matchers: [schedule("Black Friday"), experiment("bf-hero")],
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
      "bf-hero": [
        "home sections.variants.0.rule.matchers.1 #0",
        "home sections.variants.0.value.value.1.variants.0.rule #0",
      ],
    });
    expect(summary(refs.schedules)).toEqual({
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
            { rule: schedule("Summer"), value: lazy("Summer starts here") },
            { rule: always(), value: lazy("New collection") },
          ],
        },
      },
    };
    expect(summary(findRuleReferences(decofile, v8Meta).schedules)).toEqual({
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
    expect(summary(refs.experiments)).toEqual({
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
    expect(summary(refs.experiments)).toEqual({
      t: ["A rules.0 - saved", "B rules.0 - via A saved"],
    });
  });

  it("lists a name the Experiments block doesn't have, and an unfinished empty name", () => {
    const decofile = {
      Experiments: { __resolveType: "experiments", other: 10 },
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
      variants: [{ rule: schedule("s"), value: null }],
    };
    loop.self = loop;
    const decofile = {
      Loop: loop,
      nothing: null,
      text: "schedule",
      list: [[[schedule("deep")]]],
    };
    const refs = findRuleReferences(decofile, v8Meta);
    expect(summary(refs.schedules)).toEqual({
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
            { rule: schedule("Sale"), value: [] },
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
    expect(summary(refs.schedules)).toEqual({
      Sale: ["home sections.variants.0.rule #0"],
    });
    const [ref] = refs.experiments.get("t")!;
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
    expect(refs.experiments.size).toBe(0);
    expect(refs.schedules.size).toBe(0);
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
      gone: side(page([schedule("x")]), null),
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
      gone: page([schedule("x")]),
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
      marked.experiments
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
      findRuleReferences({ home: page([schedule("Old sale")]) }, v8Meta),
    );
    expect(marked.schedules.get("Old sale")!.map((ref) => ref.state)).toEqual([
      "removed-in-draft",
    ]);
  });
});
