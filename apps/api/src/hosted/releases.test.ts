import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  setSystemTime,
} from "bun:test";
import { deliveryKeys } from "./delivery-store";
import {
  fakeInsights,
  fakeRepo,
  memoryDeliveryStore,
  SCHEMA_HASH,
  SCHEMA_TEXT,
} from "./hosted-test-helpers";
import {
  type HostedRepo,
  LatestUpdateError,
  RolledBackError,
  readLatest,
} from "./publish";
import {
  listReleases,
  makeCurrent,
  NotPublishedError,
  releaseState,
  releaseStatus,
  resync,
  SchemaMismatchError,
} from "./releases";

beforeAll(() => {
  process.env.FAST_PREVIEW_CACHE_DIR = "";
});

// Git dates have whole seconds: each step moves the clock 2 s on.
let clock = Date.UTC(2026, 9, 1);
const tick = () => setSystemTime(new Date((clock += 2_000)));
afterEach(() => setSystemTime());

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
  return { git, delivery, repo, insights };
}

const sha = (c: string) => c.repeat(40);

describe("releaseState", () => {
  const pointer = (revision: string, publishedAt: string) => ({
    revision,
    schemaHash: "s",
    publishedAt,
  });
  const head = sha("h");
  const at = "2026-10-01T12:00:00Z";

  it("is failed without latest.json", () => {
    expect(releaseState(null, head, at)).toBe("failed");
  });

  it("is live when latest.json names main's head", () => {
    expect(releaseState(pointer(head, at), head, at)).toBe("live");
  });

  it("is failed when main's head was committed after latest.json was written", () => {
    expect(
      releaseState(pointer(sha("a"), "2026-10-01T11:59:00Z"), head, at),
    ).toBe("failed");
  });

  it("is rolled back when an older release was made current after the head", () => {
    expect(
      releaseState(pointer(sha("a"), "2026-10-01T12:05:00Z"), head, at),
    ).toBe("rolled-back");
  });

  it("compares whole seconds and is failed when the head's date is unknown", () => {
    expect(
      releaseState(pointer(sha("a"), "2026-10-01T12:00:00.900Z"), head, at),
    ).toBe("failed");
    expect(
      releaseState(pointer(sha("a"), "2026-10-01T12:05:00Z"), head, null),
    ).toBe("failed");
  });
});

describe("listReleases / makeCurrent", () => {
  it("marks the commits that have a revision; Make current rolls back, Resync makes the head live", async () => {
    const { git, delivery, repo, insights } = setup();
    tick();
    await resync(repo, insights.client, { confirm: false });
    const first = git.head();
    tick();
    git.pushDirect({ ".deco/blocks/Home.json": '{"a":1}\n' }, "direct edit");
    tick();
    await resync(repo, insights.client, { confirm: false });
    const second = git.head();
    tick();
    git.pushDirect({ ".deco/blocks/Home.json": '{"a":2}\n' }, "not published");

    const page = await listReleases(repo, insights.client, null);
    expect(page.commits.map((c) => [c.message, c.published])).toEqual([
      ["not published", false],
      ["direct edit", true],
      ["initial", true],
    ]);
    expect(page.current?.revision).toBe(second);
    // The newest release isn't the one latest.json names: Failed · Resync.
    expect(page.state).toBe("failed");

    tick();
    await makeCurrent(repo, first, { confirm: false });
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(first);
    expect(git.head()).not.toBe(first);
    expect((await listReleases(repo, insights.client, null)).state).toBe(
      "rolled-back",
    );

    tick();
    await resync(repo, insights.client, { confirm: true });
    const live = await listReleases(repo, insights.client, null);
    expect(live.state).toBe("live");
    expect(live.current?.revision).toBe(git.head());
  });

  it("is failed when latest.json is missing", async () => {
    const { repo, insights } = setup();
    const status = await releaseStatus(repo, insights.client);
    expect(status).toMatchObject({ current: null, state: "failed" });
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

  it("refuses a commit the CMS never published", async () => {
    const { git, repo } = setup();
    await expect(
      makeCurrent(repo, git.head(), { confirm: false }),
    ).rejects.toThrow(NotPublishedError);
  });

  it("warns when the target's schema differs from main's, unless confirmed", async () => {
    const { git, delivery, repo, insights } = setup();
    await resync(repo, insights.client, { confirm: false });
    const old = git.head();
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

describe("resync", () => {
  it("releases main's head when nothing is published yet", async () => {
    const { git, delivery, repo, insights } = setup();
    expect(await resync(repo, insights.client, { confirm: false })).toEqual({
      sha: git.head(),
      cdn: "live",
    });
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(
      git.head(),
    );
  });

  it("publishes a developer push without asking (the screen says Failed)", async () => {
    const { git, delivery, repo, insights } = setup();
    await resync(repo, insights.client, { confirm: false });
    git.pushDirect({ ".deco/blocks/Home.json": "{}\n" });
    await resync(repo, insights.client, { confirm: false });
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(
      git.head(),
    );
  });

  it("asks for confirmation before overriding a rollback", async () => {
    const { git, delivery, repo, insights } = setup();
    tick();
    await resync(repo, insights.client, { confirm: false });
    const rolledTo = git.head();
    tick();
    git.pushDirect({ ".deco/blocks/Home.json": '{"b":1}\n' });
    await resync(repo, insights.client, { confirm: false });
    tick();
    await makeCurrent(repo, rolledTo, { confirm: false });
    await expect(
      resync(repo, insights.client, { confirm: false }),
    ).rejects.toThrow(RolledBackError);
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(rolledTo);
    await resync(repo, insights.client, { confirm: true });
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(
      git.head(),
    );
  });

  it("repoints to an existing revision without rewriting it", async () => {
    const { git, delivery, repo, insights } = setup();
    await resync(repo, insights.client, { confirm: false });
    const head = git.head();
    await makeCurrent(repo, head, { confirm: false });
    delivery.log.length = 0;
    await resync(repo, insights.client, { confirm: true });
    expect(delivery.log).toEqual([
      `put ${deliveryKeys.latest("acme")}`,
      `purge ${deliveryKeys.latest("acme")}`,
    ]);
    expect((await readLatest(delivery.store, "acme"))?.schemaHash).toBe(
      SCHEMA_HASH,
    );
  });
});

describe("purge", () => {
  it("follows every latest.json write: Resync and Make current", async () => {
    const { git, delivery, repo, insights } = setup();
    await resync(repo, insights.client, { confirm: false });
    const first = git.head();
    expect(delivery.log.slice(-2)).toEqual([
      `put ${deliveryKeys.latest("acme")}`,
      `purge ${deliveryKeys.latest("acme")}`,
    ]);
    git.pushDirect({ ".deco/blocks/Home.json": '{"b":1}\n' });
    await resync(repo, insights.client, { confirm: false });
    delivery.log.length = 0;
    await makeCurrent(repo, first, { confirm: false });
    expect(delivery.log).toEqual([
      `put ${deliveryKeys.latest("acme")}`,
      `purge ${deliveryKeys.latest("acme")}`,
    ]);
  });

  it("Resync fails fast on a failed purge: one purge call, no restore; retrying from Studio succeeds", async () => {
    const { git, delivery, repo, insights } = setup();
    delivery.failPurge(true);
    await expect(
      resync(repo, insights.client, { confirm: false }),
    ).rejects.toThrow(LatestUpdateError);
    expect(delivery.log.filter((l) => l.startsWith("purge "))).toHaveLength(1);
    expect(delivery.log.at(-1)).toBe(`purge ${deliveryKeys.latest("acme")}`);
    // The user retries from Studio.
    delivery.failPurge(false);
    delivery.log.length = 0;
    expect(await resync(repo, insights.client, { confirm: false })).toEqual({
      sha: git.head(),
      cdn: "live",
    });
    expect(delivery.log).toEqual([
      `put ${deliveryKeys.latest("acme")}`,
      `purge ${deliveryKeys.latest("acme")}`,
    ]);
  });

  it("Make current fails fast on a failed purge with a retry message, no restore", async () => {
    const { git, delivery, repo, insights } = setup();
    await resync(repo, insights.client, { confirm: false });
    const first = git.head();
    git.pushDirect({ ".deco/blocks/Home.json": '{"b":1}\n' });
    await resync(repo, insights.client, { confirm: false });
    delivery.failPurge(true);
    delivery.log.length = 0;
    const error = await makeCurrent(repo, first, { confirm: false }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(LatestUpdateError);
    expect((error as Error).message).toContain("Try again");
    expect(delivery.log).toEqual([
      `put ${deliveryKeys.latest("acme")}`,
      `purge ${deliveryKeys.latest("acme")}`,
    ]);
    // No restore: the written pointer stays.
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(first);
  });

  it("does not purge when the latest.json write fails", async () => {
    const { delivery, repo, insights } = setup();
    const put = delivery.store.putJson;
    delivery.store.putJson = async (key, value, cache) => {
      if (key === deliveryKeys.latest("acme")) throw new Error("R2 down");
      return put(key, value, cache);
    };
    await expect(
      resync(repo, insights.client, { confirm: false }),
    ).rejects.toThrow(LatestUpdateError);
    expect(delivery.log.some((l) => l.startsWith("purge "))).toBe(false);
  });
});

describe("publishedAt", () => {
  it("is stamped now on every latest.json write", async () => {
    const { git, delivery, repo, insights } = setup();
    const stamps: string[] = [];
    const stamp = async () => {
      const latest = await readLatest(delivery.store, "acme");
      stamps.push(latest!.publishedAt);
      await Bun.sleep(2);
    };
    await resync(repo, insights.client, { confirm: false });
    await stamp();
    const first = git.head();
    await makeCurrent(repo, first, { confirm: false });
    await stamp();
    await resync(repo, insights.client, { confirm: true });
    await stamp();
    expect(new Set(stamps).size).toBe(3);
    const now = Date.now();
    for (const s of stamps) {
      expect(now - Date.parse(s)).toBeLessThan(5_000);
    }
  });
});
