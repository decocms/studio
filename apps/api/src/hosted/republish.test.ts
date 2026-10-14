import { beforeAll, describe, expect, it } from "bun:test";
import { serializeBlock } from "@decocms/blocks/protocol";
import { CACHE_REVISION, deliveryKeys, getJson } from "./delivery-store";
import {
  fakeInsights,
  fakeRepo,
  memoryDeliveryStore,
  SCHEMA_TEXT,
} from "./hosted-test-helpers";
import { type HostedRepo, MainMovedError, readLatest } from "./publish";
import { buildRevision } from "./release-objects";
import { listReleases } from "./releases";
import {
  NotPublishedError,
  republishedFrom,
  republishMessage,
  republishRelease,
  republishTitle,
  SchemaMismatchError,
} from "./republish";

beforeAll(() => {
  process.env.FAST_PREVIEW_CACHE_DIR = "";
});

const HOME_V1 = serializeBlock({ path: "/", title: "v1" });
const ANA = { userName: "Ana", userEmail: "ana@acme.com" };

function setup(extra: Record<string, string> = {}) {
  const git = fakeRepo({
    ".deco/schema.gen.json": SCHEMA_TEXT,
    ".deco/index.ts": "export default {};\n",
    ".deco/blocks/Home.json": HOME_V1,
    ".deco/blocks/Footer.json": serializeBlock({ links: 1 }),
    ...extra,
  });
  const delivery = memoryDeliveryStore();
  const repo: HostedRepo = {
    client: git.client,
    packagePath: null,
    mainBranch: "main",
    store: delivery.store,
    purge: delivery.purge,
    site: "acme",
  };
  /** Main's head as a Publish leaves it: a companion release. */
  const release = async () => {
    const sha = git.head();
    await delivery.store.putJson(
      deliveryKeys.revision("acme", sha),
      await buildRevision(git.client, null, sha),
      CACHE_REVISION,
    );
    return sha;
  };
  return { git, delivery, repo, release };
}

async function revisionBlocks(repo: HostedRepo, sha: string) {
  const object = await getJson(repo.store, deliveryKeys.revision("acme", sha));
  return (object?.value as { blocks?: unknown } | undefined)?.blocks;
}

describe("republishRelease", () => {
  it("commits the release's blocks on main and makes that new release live", async () => {
    const { git, delivery, repo, release } = setup();
    const first = await release();
    // Later releases: Home changed, Promo added, Footer deleted.
    git.pushDirect(
      {
        ".deco/blocks/Home.json": serializeBlock({ path: "/", title: "v2" }),
        ".deco/blocks/Promo.json": serializeBlock({ on: true }),
        ".deco/blocks/Footer.json": null,
      },
      "Summer sale",
    );
    await release();
    const before = git.head();

    const result = await republishRelease(repo, first, {
      confirm: false,
      coAuthor: ANA,
    });

    const sha = git.head();
    expect(sha).not.toBe(before);
    expect(result).toEqual({ result: "merged", sha, release: "current" });
    const files = git.filesAt(sha);
    expect(files[".deco/blocks/Home.json"]).toBe(HOME_V1);
    expect(files[".deco/blocks/Footer.json"]).toBe(
      serializeBlock({ links: 1 }),
    );
    expect(files[".deco/blocks/Promo.json"]).toBeUndefined();
    // The new release has exactly the old one's content, and is live.
    expect(await revisionBlocks(repo, sha)).toEqual(
      await revisionBlocks(repo, first),
    );
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(sha);
    expect(delivery.log.slice(-2)).toEqual([
      `put ${deliveryKeys.latest("acme")}`,
      `purge ${deliveryKeys.latest("acme")}`,
    ]);
    // History is linear: the old release is still where it was.
    expect(git.history.map((c) => c.sha).slice(0, 2)).toEqual([sha, before]);
  });

  it("touches only the files that differ, never the code's (schema, index.ts)", async () => {
    const { git, repo, release } = setup();
    const first = await release();
    git.pushDirect(
      {
        ".deco/blocks/Home.json": serializeBlock({ path: "/", title: "v2" }),
        ".deco/index.ts": "export default { v: 2 };\n",
        ".deco/schema.gen.json": SCHEMA_TEXT.replace(
          '"root": {}',
          '"root": {}, "x": 1',
        ),
      },
      "dev push",
    );
    const commitFiles = repo.client.commitFiles;
    const written: string[] = [];
    repo.client.commitFiles = async (params) => {
      written.push(...params.changes.map((c) => c.path));
      return commitFiles(params);
    };
    await republishRelease(repo, first, { confirm: true });
    expect(written).toEqual([".deco/blocks/Home.json"]);
    const files = git.filesAt(git.head());
    expect(files[".deco/index.ts"]).toBe("export default { v: 2 };\n");
    expect(files[".deco/schema.gen.json"]).toContain('"x": 1');
  });

  it("commits nothing when main already holds that content", async () => {
    const { git, delivery, repo, release } = setup();
    const first = await release();
    git.pushDirect({ ".deco/blocks/Home.json": serializeBlock({ t: 2 }) });
    await release();
    git.pushDirect({ ".deco/blocks/Home.json": HOME_V1 }, "back by hand");
    const head = git.head();
    delivery.log.length = 0;
    expect(await republishRelease(repo, first, { confirm: false })).toEqual({
      result: "up-to-date",
    });
    expect(git.head()).toBe(head);
    expect(delivery.log).toEqual([]);
  });

  it("fails when main moved, committing nothing (as Publish)", async () => {
    const { git, delivery, repo, release } = setup();
    const first = await release();
    git.pushDirect({ ".deco/blocks/Home.json": serializeBlock({ t: 2 }) });
    const commitFiles = repo.client.commitFiles;
    repo.client.commitFiles = async (params) => {
      git.pushDirect({ ".deco/blocks/Other.json": "{}\n" }, "someone else");
      return commitFiles(params);
    };
    const moved = git.head();
    delivery.log.length = 0;
    await expect(
      republishRelease(repo, first, { confirm: false }),
    ).rejects.toThrow(MainMovedError);
    expect(git.history[0]?.message).toBe("someone else");
    expect(git.history[1]?.sha).toBe(moved);
    expect(delivery.log).toEqual([]);
  });

  it("refuses a commit without a release, or not a commit at all", async () => {
    const { git, repo } = setup();
    await expect(
      republishRelease(repo, git.head(), { confirm: false }),
    ).rejects.toThrow(NotPublishedError);
    await expect(
      republishRelease(repo, "main", { confirm: false }),
    ).rejects.toThrow(NotPublishedError);
  });

  it("asks before republishing a release made for another schema; goes live once confirmed", async () => {
    const { git, delivery, repo, release } = setup();
    const first = await release();
    git.pushDirect({
      ".deco/schema.gen.json": SCHEMA_TEXT.replace("next.7", "next.8"),
      ".deco/blocks/Home.json": serializeBlock({ t: 2 }),
    });
    const head = git.head();
    await expect(
      republishRelease(repo, first, { confirm: false }),
    ).rejects.toThrow(SchemaMismatchError);
    expect(git.head()).toBe(head);
    const result = await republishRelease(repo, first, { confirm: true });
    expect(result).toMatchObject({ result: "merged", release: "current" });
    // It carries main's schema (the code's), so the site does take it.
    const live = await readLatest(delivery.store, "acme");
    expect(live?.revision).toBe(git.head());
    expect(git.filesAt(git.head())[".deco/schema.gen.json"]).toContain(
      "next.8",
    );
  });

  it("regenerates a tracked blocks.gen.json from the restored blocks", async () => {
    const { git, repo, release } = setup({ ".deco/blocks.gen.json": "{}\n" });
    const first = await release();
    git.pushDirect({
      ".deco/blocks/Home.json": serializeBlock({ path: "/", title: "v2" }),
    });
    await republishRelease(repo, first, { confirm: false });
    const gen = JSON.parse(git.filesAt(git.head())[".deco/blocks.gen.json"]!);
    expect(gen.Home).toEqual({ path: "/", title: "v1" });
  });

  it("writes the Republish message, and Releases links the new row to the original", async () => {
    const { git, repo, release } = setup();
    git.pushDirect(
      { ".deco/blocks/Home.json": serializeBlock({ t: 1 }) },
      "Black Friday banner\n\nCo-authored-by: Bo <bo@acme.com>",
    );
    const original = await release();
    git.pushDirect({ ".deco/blocks/Home.json": serializeBlock({ t: 2 }) });
    await release();
    await republishRelease(repo, original, { confirm: false, coAuthor: ANA });
    expect(git.history[0]?.message).toBe(
      `Republish: Black Friday banner\n\nRepublished-From: ${original}\nCo-authored-by: Ana <ana@acme.com>`,
    );
    const page = await listReleases(
      repo,
      fakeInsights(git.history).client,
      null,
    );
    expect(page.commits[0]).toMatchObject({
      message: "Republish: Black Friday banner",
      hasRelease: true,
      republishOf: { sha: original },
    });
  });

  it("lets a later edit sit on the restored content", async () => {
    const { git, repo, release } = setup();
    const first = await release();
    git.pushDirect({ ".deco/blocks/Home.json": serializeBlock({ t: 2 }) });
    await republishRelease(repo, first, { confirm: false });
    const restored = git.head();
    git.pushDirect({ ".deco/blocks/Promo.json": serializeBlock({ p: 1 }) });
    const files = git.filesAt(git.head());
    expect(files[".deco/blocks/Home.json"]).toBe(HOME_V1);
    expect(files[".deco/blocks/Promo.json"]).toBeDefined();
    expect(git.history[1]?.sha).toBe(restored);
  });
});

describe("republish message", () => {
  const date = "2026-10-01T09:30:12Z";

  it("is `Republish: <note>`", () => {
    expect(republishTitle({ message: "Summer sale\n\nbody", date })).toBe(
      "Republish: Summer sale",
    );
  });

  it("never chains: a republish of a republish keeps one prefix", () => {
    expect(republishTitle({ message: "Republish: Summer sale", date })).toBe(
      "Republish: Summer sale",
    );
  });

  it("names a release without a note by its date", () => {
    expect(
      republishTitle({ message: "chore(decofile): update Home", date }),
    ).toBe("Republish: release from 2026-10-01 09:30 UTC");
    expect(republishTitle({ message: "", date })).toBe(
      "Republish: release from 2026-10-01 09:30 UTC",
    );
    expect(republishTitle({ message: "", date: "nope" })).toBe(
      "Republish: earlier release",
    );
    // …and keeps that name when republished again.
    expect(
      republishTitle({
        message: "Republish: release from 2026-10-01 09:30 UTC",
        date: "2026-10-05T00:00:00Z",
      }),
    ).toBe("Republish: release from 2026-10-01 09:30 UTC");
  });

  it("ends with the Republished-From trailer, co-author in the same block", () => {
    const sha = "a".repeat(40);
    expect(republishMessage({ message: "Hi", date }, sha)).toBe(
      `Republish: Hi\n\nRepublished-From: ${sha}`,
    );
    expect(republishMessage({ message: "Hi", date }, sha, ANA)).toBe(
      `Republish: Hi\n\nRepublished-From: ${sha}\nCo-authored-by: Ana <ana@acme.com>`,
    );
    expect(
      republishedFrom(republishMessage({ message: "Hi", date }, sha)),
    ).toBe(sha);
    expect(republishedFrom("plain")).toBeNull();
    expect(republishedFrom(undefined)).toBeNull();
  });
});
