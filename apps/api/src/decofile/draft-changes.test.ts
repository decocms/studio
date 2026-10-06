import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { serializeBlock } from "@decocms/blocks/protocol";
import {
  buildDraftChanges,
  clearDraftChangesCache,
  DraftChangesInvalidBlock,
  DraftChangesTooLarge,
  MAX_DRAFT_CHANGE_BYTES,
} from "./draft-changes";
import { fakeRepo } from "./draft-changes-test-helpers";
import { gitBlobSha } from "./read-decofile";

beforeAll(() => {
  // No disk blob cache: every body read goes through the fake client.
  process.env.FAST_PREVIEW_CACHE_DIR = "";
});

beforeEach(() => clearDraftChangesCache());

const block = (value: unknown) => serializeBlock(value);

describe("buildDraftChanges", () => {
  it("is the cumulative file-level difference from the merge base", async () => {
    const { client } = fakeRepo({
      mergeBase: "base",
      commits: {
        base: {
          "Header.json": block({ title: "old" }),
          "Footer.json": block({ links: 1 }),
          "OldPromotion.json": block({ on: true }),
        },
        draft: {
          "Header.json": block({ title: "new" }),
          "Footer.json": block({ links: 1 }),
          "Added.json": block({ fresh: true }),
        },
      },
    });
    expect(await buildDraftChanges(client, null, "draft")).toEqual({
      format: 1,
      set: { Added: { fresh: true }, Header: { title: "new" } },
      delete: ["OldPromotion"],
    });
  });

  it("never carries production changes the draft didn't make", async () => {
    // Production edited Footer after the draft branched: the draft's copy is
    // still the merge base's, so it inherits production, not the stale copy.
    const { client } = fakeRepo({
      mergeBase: "base",
      commits: {
        base: { "Footer.json": block({ v: 1 }) },
        draft: { "Footer.json": block({ v: 1 }) },
      },
    });
    expect(await buildDraftChanges(client, null, "draft")).toEqual({
      format: 1,
      set: {},
      delete: [],
    });
  });

  it("changed nothing while the branch doesn't exist yet", async () => {
    const { client } = fakeRepo({ mergeBase: "base", commits: { base: {} } });
    expect(await buildDraftChanges(client, null, "missing")).toEqual({
      format: 1,
      set: {},
      delete: [],
    });
  });

  it("reads only changed bodies", async () => {
    const { client, reads } = fakeRepo({
      mergeBase: "base",
      commits: {
        base: {
          "A.json": block({ a: 1 }),
          "B.json": block({ b: 1 }),
          "C.json": block({ c: 1 }),
        },
        draft: {
          "A.json": block({ a: 2 }),
          "B.json": block({ b: 1 }),
          "C.json": block({ c: 1 }),
        },
      },
    });
    await buildDraftChanges(client, null, "draft");
    expect(reads).toEqual([gitBlobSha(block({ a: 2 }))]);
  });

  it("treats a respelled file of one name as a replacement, not a deletion", async () => {
    const { client } = fakeRepo({
      mergeBase: "base",
      commits: {
        base: { "pages%2Fhome.json": block({ path: "/", v: 1 }) },
        draft: { "pages%2fhome.json": block({ path: "/", v: 2 }) },
      },
    });
    const changes = await buildDraftChanges(client, null, "draft");
    expect(Object.keys(changes.set)).toEqual(["pages/home"]);
    expect(changes.delete).toEqual([]);
  });

  it("keeps an entry named __proto__ as an entry", async () => {
    const { client } = fakeRepo({
      mergeBase: "base",
      commits: { base: {}, draft: { "__proto__.json": block({ x: 1 }) } },
    });
    const changes = await buildDraftChanges(client, null, "draft");
    expect(Object.hasOwn(changes.set, "__proto__")).toBe(true);
  });

  it("reads the app root's saved blocks in a monorepo", async () => {
    const { client } = fakeRepo({
      packagePath: "apps/store",
      mergeBase: "base",
      commits: { base: {}, draft: { "Hero.json": block({ x: 1 }) } },
    });
    const changes = await buildDraftChanges(client, "apps/store", "draft");
    expect(Object.keys(changes.set)).toEqual(["Hero"]);
  });

  it("refuses changes larger than the limit", async () => {
    const big = "x".repeat(MAX_DRAFT_CHANGE_BYTES / 2 + 1);
    const { client } = fakeRepo({
      mergeBase: "base",
      commits: {
        base: {},
        draft: { "A.json": block({ big }), "B.json": block({ big }) },
      },
    });
    await expect(buildDraftChanges(client, null, "draft")).rejects.toThrow(
      DraftChangesTooLarge,
    );
  });
  it("tombstones what a delete-only branch removed", async () => {
    const { client } = fakeRepo({
      mergeBase: "base",
      commits: {
        base: { "Keep.json": block({ k: 1 }), "Gone.json": block({ g: 1 }) },
        draft: { "Keep.json": block({ k: 1 }) },
      },
    });
    expect(await buildDraftChanges(client, null, "draft")).toEqual({
      format: 1,
      set: {},
      delete: ["Gone"],
    });
  });

  it("answers a rename as a delete plus a set", async () => {
    const { client } = fakeRepo({
      mergeBase: "base",
      commits: {
        base: { "Old.json": block({ x: 1 }) },
        draft: { "New.json": block({ x: 1 }) },
      },
    });
    expect(await buildDraftChanges(client, null, "draft")).toEqual({
      format: 1,
      set: { New: { x: 1 } },
      delete: ["Old"],
    });
  });

  it("sets the other spelling when the draft deletes the winning one", async () => {
    // Two spellings of one name: the page-like one wins. Deleting it leaves
    // the other as the name's entry, so the name is set, not deleted.
    const { client } = fakeRepo({
      mergeBase: "base",
      commits: {
        base: {
          "pages%2Fhome.json": block({ path: "/", v: 1 }),
          "pages%2fhome.json": block({ v: 2 }),
        },
        draft: { "pages%2fhome.json": block({ v: 2 }) },
      },
    });
    expect(await buildDraftChanges(client, null, "draft")).toEqual({
      format: 1,
      set: { "pages/home": { v: 2 } },
      delete: [],
    });
  });

  it("names the file of a saved block that isn't valid JSON", async () => {
    const { client } = fakeRepo({
      mergeBase: "base",
      commits: { base: {}, draft: { "Broken.json": "{ not json" } },
    });
    const error = await buildDraftChanges(client, null, "draft").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DraftChangesInvalidBlock);
    expect((error as DraftChangesInvalidBlock).file).toBe("Broken.json");
  });

  it("reuses a result for the same branch head", async () => {
    const { client, reads } = fakeRepo({
      mergeBase: "base",
      commits: { base: {}, draft: { "A.json": block({ a: 1 }) } },
    });
    const first = await buildDraftChanges(client, null, "draft");
    const again = await buildDraftChanges(client, null, "draft");
    expect(again).toEqual(first);
    expect(reads).toHaveLength(1);
  });
});
