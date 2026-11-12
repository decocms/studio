import { describe, expect, it } from "bun:test";
import { DRAFT_TOMBSTONE_VERSION } from "@decocms/shared/blocks-major";
import {
  copyDraftVersion,
  draftVersionOf,
  cachedProductionVersion,
} from "./draft-version";
import { QueryClient } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import type { ContentIndex } from "@/cms/hosted-content";
import { listingOf } from "@/cms/hosted-content";

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

  it("keeps unknown and not-in-the-draft as listed", async () => {
    expect(await copyDraftVersion(undefined, copy)).toBeUndefined();
    expect(await copyDraftVersion(null, copy)).toBeNull();
  });

  it("refuses a copy deleted since it was read rather than guarding it by the new tombstone", async () => {
    const guarded = await copyDraftVersion(DRAFT_TOMBSTONE_VERSION, copy);
    expect(guarded).toBe(await draftVersionOf(copy));
    expect(guarded).not.toBe(DRAFT_TOMBSTONE_VERSION);
    expect(await copyDraftVersion(DRAFT_TOMBSTONE_VERSION, undefined)).toBe(
      DRAFT_TOMBSTONE_VERSION,
    );
    expect(await copyDraftVersion(DRAFT_TOMBSTONE_VERSION, null)).toBe(
      DRAFT_TOMBSTONE_VERSION,
    );
  });

  it("keeps a null draft guard only for a copy matching current production", async () => {
    const version = await draftVersionOf(copy);
    expect(await copyDraftVersion(null, copy, version)).toBeNull();
    expect(await copyDraftVersion(null, copy, "new-production-version")).toBe(
      version,
    );
    expect(await copyDraftVersion(null, copy, null)).toBe(version);
  });

  it("cannot silently reintroduce a discarded draft copy over production", async () => {
    const production = { ...copy, title: "published" };
    const version = await copyDraftVersion(
      null,
      copy,
      await draftVersionOf(production),
    );
    expect(version).toBe(await draftVersionOf(copy));
    expect(version).not.toBeNull();
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

describe("production version for a copy outside the draft", () => {
  it("distinguishes an unknown index from known missing production", () => {
    const client = new QueryClient();
    expect(cachedProductionVersion(client, "scope", "Hero")).toBeUndefined();
    client.setQueryData<ContentIndex>(KEYS.contentIndex("scope"), {
      revision: "r",
      resolvedRef: null,
      sequence: 1,
      entries: {},
      draft: {},
    });
    expect(cachedProductionVersion(client, "scope", "Hero")).toBeNull();
  });

  it("never mistakes a draft body version for production", () => {
    const client = new QueryClient();
    const index: ContentIndex = {
      revision: "r",
      resolvedRef: null,
      sequence: 1,
      entries: { Hero: { version: "overlay" } },
      draft: { Hero: { operation: "set", version: "overlay", editor: null } },
    };
    client.setQueryData(KEYS.contentIndex("scope"), index);
    expect(cachedProductionVersion(client, "scope", "Hero")).toBeUndefined();
    client.setQueryData(KEYS.contentIndex("scope"), { ...index, draft: {} });
    expect(cachedProductionVersion(client, "scope", "Hero")).toBe("overlay");
  });
});
