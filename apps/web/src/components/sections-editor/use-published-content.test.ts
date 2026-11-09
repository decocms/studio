import { describe, expect, it } from "bun:test";
import type { ChangeDetail } from "@decocms/blocks/protocol";
import { publishedDecofile } from "./use-published-content";

const experiment = (name: string) => ({ __resolveType: "experiment", name });
const campaign = (name: string) => ({ __resolveType: "campaign", name: name });
const lazy = (value: unknown) => ({ __resolveType: "lazy", value });

describe("the published content", () => {
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
});
