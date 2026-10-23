import { beforeAll, describe, expect, it } from "bun:test";
import { CACHE_REVISION, deliveryKeys } from "./delivery-store";
import {
  fakeInsights,
  fakeRepo,
  memoryDeliveryStore,
  SCHEMA_HASH,
  SCHEMA_TEXT,
} from "./hosted-test-helpers";
import { type HostedRepo, readLatest, writeLatest } from "./publish";
import { buildRevision } from "./release-objects";
import { listReleases, releaseMainHead } from "./releases";

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
    previewHosts: ["acme.deco.site", "www.acme.com"],
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
    await writeLatest(repo, {
      revision: first,
      schemaHash: SCHEMA_HASH,
      publishedAt: new Date().toISOString(),
    });
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

describe("listReleases: reapplied versions", () => {
  it("links a reapplied version to the one it reapplied (its trailer)", async () => {
    const { git, repo, insights, release } = setup();
    const first = await release();
    git.pushDirect(
      { ".deco/blocks/Home.json": '{"a":1}\n' },
      `Reapply: Summer\n\nReapplied-From: ${first}\nCo-authored-by: Ana <ana@x.com>`,
    );
    const page = await listReleases(repo, insights.client, null);
    expect(page.commits[0]).toMatchObject({
      message: "Reapply: Summer",
      reapplyOf: { sha: first },
    });
    expect(page.commits[0]?.reapplyOf?.date).toBe(page.commits[1]?.date);
    expect(page.commits[1]?.reapplyOf).toBeNull();
  });

  it("dates an original that sits on an older page", async () => {
    const { git, repo, release } = setup();
    const first = await release();
    git.pushDirect(
      { ".deco/blocks/Home.json": '{"a":1}\n' },
      `Reapply: Summer\n\nReapplied-From: ${first}`,
    );
    const onlyNewest = fakeInsights(git.history.slice(0, 1)).client;
    const page = await listReleases(repo, onlyNewest, null);
    expect(page.commits).toHaveLength(1);
    expect(page.commits[0]?.reapplyOf).toEqual({
      sha: first,
      date: git.history[1]?.date ?? null,
    });
  });
});

describe("releaseMainHead (Publish's Try again)", () => {
  it("writes main head's missing companion release, then makes it latest", async () => {
    const { git, delivery, repo } = setup();
    // A Publish committed but its release write failed: no companion.
    git.pushDirect({ ".deco/blocks/Home.json": '{"a":1}\n' }, "published");
    const head = git.head();
    delivery.log.length = 0;
    const pointer = await releaseMainHead(repo);
    expect(pointer).toMatchObject({ revision: head, schemaHash: SCHEMA_HASH });
    expect(delivery.log).toEqual([
      `put ${deliveryKeys.revision("acme", head)}`,
      `put ${LATEST}`,
      `purge ${LATEST}`,
    ]);
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(head);
  });

  it("reuses an existing companion (latest.json write had failed)", async () => {
    const { delivery, repo, release } = setup();
    const head = await release();
    delivery.log.length = 0;
    await releaseMainHead(repo);
    expect(delivery.log).toEqual([`put ${LATEST}`, `purge ${LATEST}`]);
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(head);
  });

  it("releases main's newest commit, never an older one", async () => {
    const { git, delivery, repo, release } = setup();
    await release();
    // Another Publish landed after the one being retried.
    git.pushDirect({ ".deco/blocks/Home.json": '{"b":1}\n' }, "newer");
    const newer = git.head();
    await releaseMainHead(repo);
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(newer);
  });
});
