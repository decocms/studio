import { describe, expect, it } from "bun:test";
import { namedRuleUses } from "@/components/sections-editor/named-rule-uses";
import {
  experimentRows,
  removedExperiments,
  contentSearchForUse,
} from "./experiments-v8-model";

const lazy = (value: unknown) => ({ __resolveType: "lazy", value });
const pageUsing = (name: string) => ({
  __resolveType: "page",
  name: "Home",
  path: "/",
  sections: {
    __resolveType: "multivariate",
    variants: [
      { rule: { __resolveType: "experiment", name }, value: lazy([]) },
      { rule: { __resolveType: "always" }, value: lazy([]) },
    ],
  },
});

describe("experimentRows", () => {
  const published = {
    experiments: {
      __resolveType: "split-traffic",
      "hero-test": 50,
      "old-test": 0,
      "gone-test": 30,
    },
    "pages-home-1": pageUsing("hero-test"),
  };
  const draft = {
    ...published,
    experiments: {
      __resolveType: "split-traffic",
      "old-test": 0,
      "hero-test": 20,
      "ship-test": 100,
      "new-test": 50,
    },
  };

  it("lists running tests first, then everyone, then off, with uses and draft marks", () => {
    const uses = namedRuleUses({
      decofile: draft,
      changeCount: 1,
      sides: {
        experiments: {
          kind: "set",
          before: published.experiments,
          after: draft.experiments,
          version: "v2",
          baseVersion: "v1",
        },
      },
    });
    expect(experimentRows(draft, uses)).toEqual([
      {
        name: "hero-test",
        share: 20,
        status: "running",
        uses: 1,
        entryState: "changed",
        publishedShare: 50,
      },
      {
        name: "new-test",
        share: 50,
        status: "running",
        uses: 0,
        entryState: "new",
      },
      {
        name: "ship-test",
        share: 100,
        status: "everyone",
        uses: 0,
        entryState: "new",
      },
      {
        name: "old-test",
        share: 0,
        status: "off",
        uses: 0,
        entryState: "published",
      },
    ]);
    expect(removedExperiments(draft, uses)).toEqual(["gone-test"]);
  });

  it("reads the draft alone while the published site isn't known", () => {
    const rows = experimentRows(draft, null);
    expect(rows.map((r) => [r.name, r.entryState, r.uses])).toEqual([
      ["hero-test", null, 0],
      ["new-test", null, 0],
      ["ship-test", null, 0],
      ["old-test", null, 0],
    ]);
    expect(removedExperiments(draft, null)).toEqual([]);
  });

  it("has no rows for a missing block or one of another type", () => {
    expect(experimentRows({}, null)).toEqual([]);
    expect(
      experimentRows({ experiments: { __resolveType: "site/x.ts" } }, null),
    ).toEqual([]);
  });

  it("leaves out a share that isn't a whole number from 0 to 100", () => {
    const rows = experimentRows(
      {
        experiments: {
          __resolveType: "split-traffic",
          ok: 10,
          half: 10.5,
          big: 120,
        },
      },
      null,
    );
    expect(rows.map((r) => r.name)).toEqual(["ok"]);
  });
});

describe("contentSearchForUse", () => {
  it("opens a page by its key and anything else in Sections", () => {
    expect(
      contentSearchForUse({ blockKey: "pages-home-1", blockKind: "page" }),
    ).toStrictEqual({
      contentPageId: "pages-home-1",
      contentCollection: undefined,
      contentItem: undefined,
      contentPageVariant: undefined,
      contentSection: undefined,
      contentVariant: undefined,
    });
    expect(
      contentSearchForUse({ blockKey: "banner", blockKind: "section" }),
    ).toStrictEqual({
      contentPageId: undefined,
      contentCollection: "sections",
      contentItem: "banner",
      contentPageVariant: undefined,
      contentSection: undefined,
      contentVariant: undefined,
    });
  });

  it("opens on the variant that uses the name", () => {
    expect(
      contentSearchForUse({
        blockKey: "pages-home-1",
        blockKind: "page",
        focus: { pageVariant: 1, section: 2, variant: 0 },
      }),
    ).toMatchObject({
      contentPageId: "pages-home-1",
      contentPageVariant: 1,
      contentSection: 2,
      contentVariant: 0,
    });
    expect(
      contentSearchForUse({
        blockKey: "banner",
        blockKind: "section",
        focus: { variant: 3 },
      }),
    ).toMatchObject({ contentItem: "banner", contentVariant: 3 });
  });

  it("clears a place an earlier Open left in the URL", () => {
    const earlier = {
      contentPageId: "pages-home-1",
      contentSection: 4,
      contentVariant: 2,
    };
    expect({
      ...earlier,
      ...contentSearchForUse({
        blockKey: "pages-sale-1",
        blockKind: "page",
        focus: {},
      }),
    }).toMatchObject({
      contentPageId: "pages-sale-1",
      contentSection: undefined,
      contentVariant: undefined,
    });
  });
});
