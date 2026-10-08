import { beforeAll, describe, expect, it } from "bun:test";
import { serializeBlock } from "@decocms/blocks/protocol";
import { fakeRepo, SCHEMA_HASH, SCHEMA_TEXT } from "./hosted-test-helpers";
import {
  buildRevision,
  InvalidSavedBlock,
  NotV8Site,
  schemaHashOfText,
} from "./release-objects";

beforeAll(() => {
  process.env.FAST_PREVIEW_CACHE_DIR = "";
});

describe("schemaHashOfText", () => {
  it("matches the vector deco content writes into the site", async () => {
    expect(await schemaHashOfText(SCHEMA_TEXT)).toBe(SCHEMA_HASH);
  });

  it("is null for a v7 schema or bad JSON", async () => {
    expect(await schemaHashOfText('{"definitions":{}}')).toBeNull();
    expect(await schemaHashOfText("{")).toBeNull();
  });
});

describe("buildRevision", () => {
  it("reads the saved blocks the way deco content does", async () => {
    const repo = fakeRepo({
      ".deco/schema.gen.json": SCHEMA_TEXT,
      ".deco/blocks/Home.json": serializeBlock({ path: "/", a: 1 }),
      // Two spellings of one name: the page-like entry wins.
      ".deco/blocks/pages%20A.json": serializeBlock({ path: "/a" }),
      ".deco/blocks/pages%2520A.json": serializeBlock({ b: 2 }),
      ".deco/blocks/nested/Skip.json": serializeBlock({ c: 3 }),
    });
    const revision = await buildRevision(repo.client, null, repo.head());
    expect(revision).toEqual({
      revision: repo.head(),
      schemaHash: SCHEMA_HASH,
      blocks: { Home: { path: "/", a: 1 }, "pages A": { path: "/a" } },
    });
  });

  it("refuses a commit without a v8 schema", async () => {
    const repo = fakeRepo({ ".deco/blocks/Home.json": "{}" });
    await expect(buildRevision(repo.client, null, repo.head())).rejects.toThrow(
      NotV8Site,
    );
  });

  it("refuses a block the site's own build would refuse", async () => {
    const repo = fakeRepo({
      ".deco/schema.gen.json": SCHEMA_TEXT,
      ".deco/blocks/Home.json": "[1]",
    });
    await expect(buildRevision(repo.client, null, repo.head())).rejects.toThrow(
      InvalidSavedBlock,
    );
  });

  it("reads under the app root", async () => {
    const repo = fakeRepo({
      "apps/site/.deco/schema.gen.json": SCHEMA_TEXT,
      "apps/site/.deco/blocks/Home.json": serializeBlock({ a: 1 }),
    });
    const revision = await buildRevision(repo.client, "apps/site", repo.head());
    expect(revision.blocks).toEqual({ Home: { a: 1 } });
  });
});
