import { beforeAll, describe, expect, it } from "bun:test";
import { CACHE_REVISION, deliveryKeys } from "./delivery-store";
import {
  fakeInsights,
  fakeRepo,
  memoryDeliveryStore,
  SCHEMA_HASH,
  SCHEMA_TEXT,
} from "./hosted-test-helpers";
import { computeContentRevision } from "@decocms/blocks/protocol";
import { type HostedRepo, readLatest, writeLatest } from "./publish";
import { buildRevision } from "./release-objects";
import { listReleases, makeHeadCurrent } from "./releases";
import type { ServedLabel } from "./serving";

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

describe("listReleases: republishes", () => {
  it("links a republish to the release it republished (its trailer)", async () => {
    const { git, repo, insights, release } = setup();
    const first = await release();
    git.pushDirect(
      { ".deco/blocks/Home.json": '{"a":1}\n' },
      `Republish: Summer\n\nRepublished-From: ${first}\nCo-authored-by: Ana <ana@x.com>`,
    );
    const page = await listReleases(repo, insights.client, null);
    expect(page.commits[0]).toMatchObject({
      message: "Republish: Summer",
      republishOf: { sha: first },
    });
    expect(page.commits[1]?.republishOf).toBeNull();
  });
});

describe("listReleases: what the site serves", () => {
  const reader =
    (labels: ServedLabel[] | null | Error) =>
    async (): Promise<ServedLabel[] | null> => {
      if (labels instanceof Error) throw labels;
      return labels;
    };
  const at = (minutesAgo: number) =>
    new Date(Date.now() - minutesAgo * 60_000).toISOString();

  it("has no signal without a reader, or when the site reported nothing", async () => {
    const { repo, insights, release } = setup();
    await release();
    expect((await listReleases(repo, insights.client, null)).serving).toEqual({
      source: "none",
    });
    const empty = await listReleases(repo, insights.client, null, reader([]));
    expect(empty.serving).toEqual({ source: "none" });
    const failed = await listReleases(
      repo,
      insights.client,
      null,
      reader(new Error("ACCESS_DENIED")),
    );
    expect(failed.serving).toEqual({ source: "none" });
  });

  it("names the newest release the site reported (a CDN release is its commit)", async () => {
    const { git, repo, insights, release } = setup();
    const first = await release();
    git.pushDirect({ ".deco/blocks/Home.json": '{"a":1}\n' });
    const second = await release();
    // An isolate still on the first one reported last: the site moves forward.
    const now = at(0);
    const page = await listReleases(
      repo,
      insights.client,
      null,
      reader([
        { label: first, lastSeen: now },
        { label: second, lastSeen: at(1) },
      ]),
    );
    expect(page.serving).toEqual({
      source: "site",
      revision: second,
      lastSeen: now,
    });
  });

  it("matches a bundled snapshot's content revision to the newest release with that content", async () => {
    const { git, repo, insights, release } = setup();
    const first = await release();
    git.pushDirect({ ".deco/blocks/Home.json": '{"a":1}\n' });
    await release();
    // A republish of `first`: same content, newer commit.
    git.pushDirect({ ".deco/blocks/Home.json": "{}\n" }, "Republish: initial");
    const again = await release();
    const label = await computeContentRevision(
      (await buildRevision(git.client, null, first)).blocks,
    );
    const page = await listReleases(
      repo,
      insights.client,
      null,
      reader([{ label, lastSeen: at(0) }]),
    );
    expect(page.serving).toMatchObject({ source: "site", revision: again });
  });

  it("says the site reports something Studio can't match", async () => {
    const { repo, insights, release } = setup();
    await release();
    const page = await listReleases(
      repo,
      insights.client,
      null,
      reader([{ label: "f".repeat(64), lastSeen: at(0) }]),
    );
    expect(page.serving).toMatchObject({ source: "site", revision: null });
  });

  it("reads it on the first page only", async () => {
    const { repo, insights, release } = setup();
    const first = await release();
    const page = await listReleases(
      repo,
      insights.client,
      "0",
      reader([{ label: first, lastSeen: at(0) }]),
    );
    expect(page.serving).toBeNull();
  });
});

describe("makeHeadCurrent (Publish's Try again)", () => {
  it("writes main head's missing companion release, then makes it current", async () => {
    const { git, delivery, repo } = setup();
    // A Publish committed but its release write failed: no companion.
    git.pushDirect({ ".deco/blocks/Home.json": '{"a":1}\n' }, "published");
    const head = git.head();
    delivery.log.length = 0;
    const pointer = await makeHeadCurrent(repo);
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
    await makeHeadCurrent(repo);
    expect(delivery.log).toEqual([`put ${LATEST}`, `purge ${LATEST}`]);
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(head);
  });

  it("makes main's newest commit live, never an older one", async () => {
    const { git, delivery, repo, release } = setup();
    await release();
    // Another Publish landed after the one being retried.
    git.pushDirect({ ".deco/blocks/Home.json": '{"b":1}\n' }, "newer");
    const newer = git.head();
    await makeHeadCurrent(repo);
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(newer);
  });
});
