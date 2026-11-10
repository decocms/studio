import { describe, expect, it } from "bun:test";
import { publishedDecofile } from "@/components/sections-editor/use-published-content";
import {
  draftHasUnpublishedTests,
  experimentRows,
  liveExperimentRows,
  removedExperiments,
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

  it("lists running tests first, then everyone, then off, with draft marks", () => {
    const live = publishedDecofile(draft, {
      experiments: {
        kind: "set",
        before: published.experiments,
        after: draft.experiments,
        version: "v2",
        baseVersion: "v1",
      },
    });
    expect(experimentRows(draft, live)).toEqual([
      {
        name: "hero-test",
        share: 20,
        status: "running",
        entryState: "changed",
        publishedShare: 50,
      },
      {
        name: "new-test",
        share: 50,
        status: "running",
        entryState: "new",
      },
      {
        name: "ship-test",
        share: 100,
        status: "everyone",
        entryState: "new",
      },
      {
        name: "old-test",
        share: 0,
        status: "off",
        entryState: "published",
      },
    ]);
    expect(removedExperiments(draft, live)).toEqual(["gone-test"]);
  });

  it("reads the draft alone while the published site isn't known", () => {
    const rows = experimentRows(draft, null);
    expect(rows.map((r) => [r.name, r.entryState])).toEqual([
      ["hero-test", null],
      ["new-test", null],
      ["ship-test", null],
      ["old-test", null],
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

describe("liveExperimentRows", () => {
  it("lists the published tests, all published, running first", () => {
    const published = {
      experiments: { __resolveType: "split-traffic", off: 0, hero: 40 },
    };
    expect(liveExperimentRows(published)).toEqual([
      { name: "hero", share: 40, status: "running", entryState: "published" },
      { name: "off", share: 0, status: "off", entryState: "published" },
    ]);
  });

  it("is empty when nothing is published", () => {
    expect(liveExperimentRows({})).toEqual([]);
  });
});

describe("draftHasUnpublishedTests", () => {
  const tests = (values: Record<string, number>) => ({
    experiments: { __resolveType: "split-traffic", ...values },
  });
  const published = tests({ hero: 40, menu: 10 });

  it("is false when the draft has the published tests", () => {
    expect(
      draftHasUnpublishedTests(tests({ menu: 10, hero: 40 }), published),
    ).toBe(false);
  });

  it("is true when the draft adds, changes or removes a test", () => {
    expect(
      draftHasUnpublishedTests(
        tests({ hero: 40, menu: 10, new: 5 }),
        published,
      ),
    ).toBe(true);
    expect(
      draftHasUnpublishedTests(tests({ hero: 50, menu: 10 }), published),
    ).toBe(true);
    expect(draftHasUnpublishedTests(tests({ hero: 40 }), published)).toBe(true);
  });

  it("is false while the published content isn't known", () => {
    expect(draftHasUnpublishedTests(tests({ hero: 1 }), null)).toBe(false);
  });
});
