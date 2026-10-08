import { beforeAll, describe, expect, it } from "bun:test";
import { CACHE_REVISION, deliveryKeys } from "./delivery-store";
import {
  fakeInsights,
  fakeRepo,
  memoryDeliveryStore,
  SCHEMA_HASH,
  SCHEMA_TEXT,
} from "./hosted-test-helpers";
import { type HostedRepo, LatestUpdateError, readLatest } from "./publish";
import { buildRevision } from "./release-objects";
import {
  listReleases,
  makeCurrent,
  NotPublishedError,
  SchemaMismatchError,
} from "./releases";

beforeAll(() => {
  process.env.FAST_PREVIEW_CACHE_DIR = "";
});

function setup() {
  const git = fakeRepo({
    ".deco/schema.gen.json": SCHEMA_TEXT,
    ".deco/blocks/Home.json": "{}\n",
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
  const insights = fakeInsights(git.history);
  /** Writes main head's companion release, as a Publish does. */
  const release = async () => {
    const sha = git.head();
    await delivery.store.putJson(
      deliveryKeys.revision("acme", sha),
      await buildRevision(git.client, null, sha),
      CACHE_REVISION,
    );
    return sha;
  };
  return { git, delivery, repo, insights, release };
}

const LATEST = deliveryKeys.latest("acme");

describe("listReleases", () => {
  it("lists main's commits newest first, marking the ones with a companion release", async () => {
    const { git, repo, insights, release } = setup();
    await release();
    git.pushDirect({ ".deco/blocks/Home.json": '{"a":1}\n' }, "published");
    await release();
    git.pushDirect({ ".deco/blocks/Home.json": '{"a":2}\n' }, "developer push");

    const page = await listReleases(repo, insights.client, null);
    expect(page.commits.map((c) => [c.message, c.hasRelease])).toEqual([
      ["developer push", false],
      ["published", true],
      ["initial", true],
    ]);
  });

  it("finds companions with one listing of the revisions/ prefix, not one request per commit", async () => {
    const { git, delivery, repo, insights, release } = setup();
    await release();
    for (let i = 0; i < 5; i++) {
      git.pushDirect({ ".deco/blocks/Home.json": `{"i":${i}}\n` });
    }
    const listed: string[] = [];
    const reads: string[] = [];
    const { listKeys, get } = delivery.store;
    delivery.store.listKeys = async (prefix) => {
      listed.push(prefix);
      return listKeys(prefix);
    };
    delivery.store.get = async (key) => {
      reads.push(key);
      return get(key);
    };
    await listReleases(repo, insights.client, null);
    expect(listed).toEqual([deliveryKeys.revisions("acme")]);
    expect(reads).toEqual([LATEST]);
  });

  it("says Current is exactly the commit latest.json names", async () => {
    const { git, repo, insights, release } = setup();
    const first = await release();
    git.pushDirect({ ".deco/blocks/Home.json": '{"a":1}\n' });
    await release();
    await makeCurrent(repo, first, { confirm: false });
    // Not main's head, and not inferred from it: what latest.json says.
    const page = await listReleases(repo, insights.client, null);
    expect(page.current?.revision).toBe(first);
  });

  it("has no Current when latest.json is missing", async () => {
    const { repo, insights, release } = setup();
    await release();
    const page = await listReleases(repo, insights.client, null);
    expect(page.current).toBeNull();
    expect(page.commits[0]?.hasRelease).toBe(true);
  });

  it("reads one page of 50 commits", async () => {
    const { git, repo, insights } = setup();
    for (let i = 0; i < 60; i++) {
      git.pushDirect({ ".deco/blocks/Home.json": `{"i":${i}}\n` }, `dev ${i}`);
    }
    insights.calls.length = 0;
    const page = await listReleases(repo, insights.client, null);
    expect(insights.calls).toEqual([{ cursor: null, limit: 50 }]);
    expect(page.commits).toHaveLength(50);
    expect(page.nextCursor).toBe("50");
  });
});

describe("makeCurrent", () => {
  it("writes latest.json for the companion, then purges it", async () => {
    const { git, delivery, repo, release } = setup();
    const first = await release();
    git.pushDirect({ ".deco/blocks/Home.json": '{"a":1}\n' });
    delivery.log.length = 0;
    const pointer = await makeCurrent(repo, first, { confirm: false });
    expect(pointer).toMatchObject({ revision: first, schemaHash: SCHEMA_HASH });
    expect(Date.now() - Date.parse(pointer.publishedAt)).toBeLessThan(5_000);
    expect(delivery.log).toEqual([`put ${LATEST}`, `purge ${LATEST}`]);
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(first);
  });

  it("refuses a commit without a companion release", async () => {
    const { git, delivery, repo } = setup();
    await expect(
      makeCurrent(repo, git.head(), { confirm: false }),
    ).rejects.toThrow(NotPublishedError);
    expect(delivery.log).toEqual([]);
  });

  it("fails fast on a failed purge: one purge call, no restore", async () => {
    const { git, delivery, repo, release } = setup();
    const first = await release();
    git.pushDirect({ ".deco/blocks/Home.json": '{"b":1}\n' });
    const second = await release();
    await makeCurrent(repo, second, { confirm: false });
    delivery.failPurge(true);
    delivery.log.length = 0;
    const error = await makeCurrent(repo, first, { confirm: false }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(LatestUpdateError);
    expect((error as Error).message).toContain("Try again");
    expect(delivery.log).toEqual([`put ${LATEST}`, `purge ${LATEST}`]);
    // No restore: the written pointer stays, and the screen reads it back.
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(first);
  });

  it("fails without purging when the latest.json write fails; Current stays put", async () => {
    const { git, delivery, repo, release } = setup();
    const first = await release();
    await makeCurrent(repo, first, { confirm: false });
    git.pushDirect({ ".deco/blocks/Home.json": '{"b":1}\n' });
    const second = await release();
    const put = delivery.store.putJson;
    delivery.store.putJson = async (key, value, cache) => {
      if (key === LATEST) throw new Error("R2 down");
      return put(key, value, cache);
    };
    delivery.log.length = 0;
    await expect(makeCurrent(repo, second, { confirm: false })).rejects.toThrow(
      LatestUpdateError,
    );
    expect(delivery.log).toEqual([]);
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(first);
  });

  it("warns when the target's schema differs from main's, unless confirmed", async () => {
    const { git, delivery, repo, release } = setup();
    const old = await release();
    git.pushDirect({
      ".deco/schema.gen.json": SCHEMA_TEXT.replace("next.7", "next.8"),
    });
    await expect(makeCurrent(repo, old, { confirm: false })).rejects.toThrow(
      SchemaMismatchError,
    );
    await makeCurrent(repo, old, { confirm: true });
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(old);
  });
});
