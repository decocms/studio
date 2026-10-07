import { beforeAll, describe, expect, it } from "bun:test";
import type { RepoInsightsClient } from "@/git-providers";
import {
  fakeRepo,
  memoryDeliveryStore,
  SCHEMA_TEXT,
} from "./hosted-test-helpers";
import { type HostedRepo, readLatest, resync } from "./publish";
import {
  listReleases,
  makeCurrent,
  NotPublishedError,
  releaseState,
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
    site: "acme",
  };
  const insights = {
    listCommits: async () => ({
      items: git.history.map((c, i) => ({
        sha: c.sha,
        date: new Date(2026, 0, 30 - i).toISOString(),
        message: c.message,
        author: { name: "Ana", email: null, login: null },
      })),
      nextCursor: null,
    }),
  } as unknown as RepoInsightsClient;
  return { git, delivery, repo, insights };
}

describe("releaseState", () => {
  const head = "h".repeat(40);
  const pointer = (revision: string) => ({
    revision,
    schemaHash: "s",
    publishedAt: "t",
  });
  it("is pending without latest.json, live at head, rolled back elsewhere", () => {
    expect(releaseState(null, head, new Set())).toBe("pending");
    expect(releaseState(pointer(head), head, new Set([head]))).toBe("live");
    expect(releaseState(pointer("c"), head, new Set(["c"]))).toBe(
      "rolled-back",
    );
  });
});

describe("listReleases / makeCurrent", () => {
  it("marks the commits that have a revision and rolls back to one", async () => {
    const { git, delivery, repo, insights } = setup();
    await resync(repo, { confirm: false });
    const first = git.head();
    git.pushDirect({ ".deco/blocks/Home.json": '{"a":1}\n' }, "direct edit");
    // A direct commit already reads as rolled back (the literal rule).
    await resync(repo, { confirm: true });
    const second = git.head();
    git.pushDirect({ ".deco/blocks/Home.json": '{"a":2}\n' }, "not published");

    const page = await listReleases(repo, insights, null);
    expect(page.commits.map((c) => [c.message, c.published])).toEqual([
      ["not published", false],
      ["direct edit", true],
      ["initial", true],
    ]);
    expect(page.current?.revision).toBe(second);
    // Literal rule: latest != head and that revision exists.
    expect(page.state).toBe("rolled-back");

    await makeCurrent(repo, first, { confirm: false });
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(first);
    expect(git.head()).not.toBe(first);
  });

  it("refuses a commit the CMS never published", async () => {
    const { git, repo } = setup();
    await expect(
      makeCurrent(repo, git.head(), { confirm: false }),
    ).rejects.toThrow(NotPublishedError);
  });

  it("warns when the target's schema differs from main's, unless confirmed", async () => {
    const { git, delivery, repo } = setup();
    await resync(repo, { confirm: false });
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
