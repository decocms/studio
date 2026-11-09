import { describe, expect, it } from "bun:test";
import { DRAFT_TOMBSTONE_VERSION } from "@decocms/shared/blocks-major";
import { copyDraftVersion, draftVersionOf } from "./draft-version";
import { listingOf } from "./hosted-content";

/**
 * The contract's §1.3 vectors: the hosted CMS's `blockVersion`, the same
 * table the API's `revision-id.test.ts` checks the server against.
 */
describe("draftVersionOf (a hosted draft block's version, from the block)", () => {
  it.each([
    [{}, "RBNvo1WzZ4oRRq0W9-hkng"],
    [{ b: 1, a: [true, null, "x"] }, "VKZUFa03AiiFGh2ksxtv1A"],
    [
      {
        __resolveType: "site/sections/Hero.tsx",
        title: "Olá — ünïcode 😀",
        n: -0,
        f: 1.5e-7,
        big: 1e21,
        int: 10,
      },
      "cvNhsZmxtnrgaCwRg73Kxw",
    ],
    [{ é: 1, Z: 2, a: 3, aa: 4, "": 0 }, "psFj7dEx0yLDzHd3f9mabQ"],
    [
      {
        nested: {
          z: { y: [1, { b: 2, a: 1 }] },
          a: 'line\nbreak "q" \\ \u0001',
        },
      },
      "-F2yA3CkzEaGhmts3kOA3w",
    ],
  ])("%j", async (input, expected) => {
    expect(await draftVersionOf(input)).toBe(expected);
  });

  it("changes with any value of the block", async () => {
    expect(await draftVersionOf({ title: "a" })).not.toBe(
      await draftVersionOf({ title: "b" }),
    );
  });
});

describe("copyDraftVersion (a hosted save's guard, from the copy it was built on)", () => {
  const copy = { __resolveType: "site/sections/Hero.tsx", title: "mine" };

  it("is the copy's own hash while the draft holds the block, not the listed version", async () => {
    expect(await copyDraftVersion("theirs-listed-version", copy)).toBe(
      await draftVersionOf(copy),
    );
  });

  it("keeps unknown, not-in-the-draft and deleted as listed", async () => {
    expect(await copyDraftVersion(undefined, copy)).toBeUndefined();
    expect(await copyDraftVersion(null, copy)).toBeNull();
    expect(await copyDraftVersion(DRAFT_TOMBSTONE_VERSION, copy)).toBe(
      DRAFT_TOMBSTONE_VERSION,
    );
  });

  it("keeps the listed version without a loaded copy", async () => {
    const stub = listingOf(
      {
        revision: "r",
        resolvedRef: null,
        sequence: 1,
        entries: { hero: { version: "v", meta: { type: "Hero" } } },
        draft: {},
      },
      {},
    ).hero;
    expect(await copyDraftVersion("listed", undefined)).toBe("listed");
    expect(await copyDraftVersion("listed", stub)).toBe("listed");
  });
});
