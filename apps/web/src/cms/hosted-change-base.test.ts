import { describe, expect, test } from "bun:test";
import { hostedChangeBase } from "./hosted-change-base";
import type { ContentIndex } from "./hosted-content";
import type { ContentChanges } from "./content-changes";

const published: ContentIndex = {
  revision: "r1",
  resolvedRef: "production-1",
  sequence: 1,
  entries: { home: { version: "published-home" } },
  draft: {},
};
const emptyChanges: ContentChanges = {
  revision: "r1",
  base: { revision: "production-1", resolvedRef: "production-1" },
  changes: {},
};

describe("the published base of a hosted change", () => {
  test("deleting an unopened production page retains a publishable deletion", () => {
    expect(hostedChangeBase("home", published, emptyChanges, {})).toBe(
      "published-home",
    );
  });

  test("the authoritative index wins over a stale or optimistic body version", () => {
    expect(
      hostedChangeBase("home", published, emptyChanges, { home: "old-body" }),
    ).toBe("published-home");
    expect(
      hostedChangeBase("new", published, emptyChanges, {
        new: "optimistic-body",
      }),
    ).toBeNull();
  });

  test("an existing draft change keeps its original production base", () => {
    const index = {
      ...published,
      entries: { home: { version: "draft-home" } },
      draft: {
        home: {
          operation: "set" as const,
          version: "draft-home",
          editor: null,
        },
      },
    };
    expect(
      hostedChangeBase(
        "home",
        index,
        {
          ...emptyChanges,
          changes: {
            home: {
              kind: "set",
              version: "draft-home",
              baseVersion: "published-home",
            },
          },
        },
        { home: "draft-home" },
      ),
    ).toBe("published-home");
    expect(
      hostedChangeBase(
        "home",
        index,
        {
          ...emptyChanges,
          changes: {
            home: { kind: "set", version: "draft-home", baseVersion: null },
          },
        },
        { home: "draft-home" },
      ),
    ).toBeNull();
  });

  test("index spellings and existing changes follow the protocol name spelling", () => {
    const index = {
      ...published,
      entries: { "a b": { version: "published-body" } },
    };
    expect(hostedChangeBase("a%20b", index, emptyChanges, {})).toBe(
      "published-body",
    );
  });

  test("a backend without the hosted index keeps the loaded-version fallback", () => {
    expect(
      hostedChangeBase("home", undefined, emptyChanges, {
        home: "published-home",
      }),
    ).toBe("published-home");
  });
});
