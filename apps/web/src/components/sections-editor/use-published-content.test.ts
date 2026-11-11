import { describe, expect, it } from "bun:test";
import type { ChangeDetail } from "@decocms/blocks/protocol";
import {
  livePublishedDecofile,
  publishedDecofile,
} from "./use-published-content";

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

describe("one block as it is live (never the draft's copy)", () => {
  const draft = {
    experiments: { __resolveType: "split-traffic", hero: 90, fresh: 10 },
    home: { __resolveType: "page" },
  };
  const live = { __resolveType: "split-traffic", hero: 40 };
  const changed = { experiments: { kind: "set" } };
  const detail = (
    over: Partial<ChangeDetail>,
  ): Record<string, ChangeDetail> => ({
    experiments: {
      kind: "set",
      before: live,
      after: draft.experiments,
      version: "v2",
      baseVersion: "b1",
      ...over,
    },
  });

  it("is the draft's when the draft didn't change it", () => {
    expect(
      livePublishedDecofile(draft, { home: {} }, undefined, "experiments"),
    ).toBe(draft);
  });

  it("is the published side when it was read", () => {
    expect(
      livePublishedDecofile(draft, changed, detail({}), "experiments"),
    ).toEqual({ ...draft, experiments: live });
  });

  it("is absent when the draft added it", () => {
    expect(
      livePublishedDecofile(
        draft,
        changed,
        detail({ before: null, baseVersion: null }),
        "experiments",
      ),
    ).toEqual({ home: draft.home });
  });

  it("is unknown when its published side wasn't read", () => {
    expect(livePublishedDecofile(draft, changed, {}, "experiments")).toBe(
      "unknown",
    );
    expect(
      livePublishedDecofile(draft, changed, undefined, "experiments"),
    ).toBe("unknown");
  });

  it("is unknown when the base has it but its side couldn't be read", () => {
    expect(
      livePublishedDecofile(
        draft,
        changed,
        detail({ before: null }),
        "experiments",
      ),
    ).toBe("unknown");
  });
});
