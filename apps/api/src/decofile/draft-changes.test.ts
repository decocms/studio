import { beforeAll, describe, expect, it } from "bun:test";
import { serializeBlock } from "@decocms/blocks/protocol";
import {
  buildDraftChanges,
  DraftChangesTooLarge,
  MAX_DRAFT_CHANGE_BYTES,
} from "./draft-changes";
import { fakeRepo } from "./draft-changes-test-helpers";
import { gitBlobSha } from "./read-decofile";

beforeAll(() => {
  // No disk blob cache: every body read goes through the fake client.
  process.env.FAST_PREVIEW_CACHE_DIR = "";
});

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
});
