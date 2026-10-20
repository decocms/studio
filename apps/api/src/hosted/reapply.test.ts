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
  reappliedFrom,
  reapplyMessage,
  reapplySchemaChanged,
  reapplyTitle,
  reapplyVersion,
} from "./reapply";

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

describe("reapplyVersion", () => {
  it("commits the version's blocks on main and releases that new version", async () => {
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

    const result = await reapplyVersion(repo, first, { coAuthor: ANA });

    const sha = git.head();
    expect(sha).not.toBe(before);
    expect(result).toEqual({
      result: "merged",
      sha,
      release: "current",
      schemaChanged: false,
    });
    const files = git.filesAt(sha);
    expect(files[".deco/blocks/Home.json"]).toBe(HOME_V1);
    expect(files[".deco/blocks/Footer.json"]).toBe(
      serializeBlock({ links: 1 }),
    );
    expect(files[".deco/blocks/Promo.json"]).toBeUndefined();
    // The new release has exactly the old one's content, and is latest.
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
    await reapplyVersion(repo, first);
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
    expect(await reapplyVersion(repo, first)).toEqual({
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
    await expect(reapplyVersion(repo, first)).rejects.toThrow(MainMovedError);
    expect(git.history[0]?.message).toBe("someone else");
    expect(git.history[1]?.sha).toBe(moved);
    expect(delivery.log).toEqual([]);
  });

  it("refuses a commit without a release, or not a commit at all", async () => {
    const { git, repo } = setup();
    await expect(reapplyVersion(repo, git.head())).rejects.toThrow(
      NotPublishedError,
    );
    await expect(reapplyVersion(repo, "main")).rejects.toThrow(
      NotPublishedError,
    );
  });

  it("reapplies a version made for another schema all the same, and says so", async () => {
    const { git, delivery, repo, release } = setup();
    const first = await release();
    git.pushDirect({
      ".deco/schema.gen.json": SCHEMA_TEXT.replace("next.7", "next.8"),
      ".deco/blocks/Home.json": serializeBlock({ t: 2 }),
    });
    expect(await reapplySchemaChanged(repo, first)).toBe(true);
    const result = await reapplyVersion(repo, first);
    expect(result).toMatchObject({
      result: "merged",
      release: "current",
      schemaChanged: true,
    });
    // It carries main's schema (the code's), so the site does take it.
    const latest = await readLatest(delivery.store, "acme");
    expect(latest?.revision).toBe(git.head());
    expect(git.filesAt(git.head())[".deco/schema.gen.json"]).toContain(
      "next.8",
    );
  });

  it("reports no schema change for the same schema, or a formatting-only change", async () => {
    const { git, repo, release } = setup();
    const first = await release();
    git.pushDirect({ ".deco/blocks/Home.json": serializeBlock({ t: 2 }) });
    expect(await reapplySchemaChanged(repo, first)).toBe(false);
    git.pushDirect({
      ".deco/schema.gen.json": JSON.stringify(JSON.parse(SCHEMA_TEXT), null, 4),
    });
    expect(await reapplySchemaChanged(repo, first)).toBe(false);
    expect(await reapplyVersion(repo, first)).toMatchObject({
      result: "merged",
      schemaChanged: false,
    });
    git.pushDirect({ ".deco/blocks/Home.json": serializeBlock({ t: 3 }) });
    await expect(reapplySchemaChanged(repo, git.head())).rejects.toThrow(
      NotPublishedError,
    );
  });

  it("regenerates a tracked blocks.gen.json from the restored blocks", async () => {
    const { git, repo, release } = setup({ ".deco/blocks.gen.json": "{}\n" });
    const first = await release();
    git.pushDirect({
      ".deco/blocks/Home.json": serializeBlock({ path: "/", title: "v2" }),
    });
    await reapplyVersion(repo, first);
    const gen = JSON.parse(git.filesAt(git.head())[".deco/blocks.gen.json"]!);
    expect(gen.Home).toEqual({ path: "/", title: "v1" });
  });

  it("writes the Reapply message, and Releases links the new row to the original", async () => {
    const { git, repo, release } = setup();
    git.pushDirect(
      { ".deco/blocks/Home.json": serializeBlock({ t: 1 }) },
      "Black Friday banner\n\nCo-authored-by: Bo <bo@acme.com>",
    );
    const original = await release();
    git.pushDirect({ ".deco/blocks/Home.json": serializeBlock({ t: 2 }) });
    await release();
    await reapplyVersion(repo, original, { coAuthor: ANA });
    // Ana authors it, so the trailer naming her again is dropped.
    expect(git.history[0]?.message).toBe(
      `Reapply: Black Friday banner\n\nReapplied-From: ${original}`,
    );
    expect(git.history[0]?.author).toEqual({
      name: "Ana",
      email: "ana@acme.com",
    });
    const page = await listReleases(
      repo,
      fakeInsights(git.history).client,
      null,
    );
    expect(page.commits[0]).toMatchObject({
      message: "Reapply: Black Friday banner",
      hasRelease: true,
      reapplyOf: { sha: original },
    });
  });

  it("lets a later edit sit on the restored content", async () => {
    const { git, repo, release } = setup();
    const first = await release();
    git.pushDirect({ ".deco/blocks/Home.json": serializeBlock({ t: 2 }) });
    await reapplyVersion(repo, first);
    const restored = git.head();
    git.pushDirect({ ".deco/blocks/Promo.json": serializeBlock({ p: 1 }) });
    const files = git.filesAt(git.head());
    expect(files[".deco/blocks/Home.json"]).toBe(HOME_V1);
    expect(files[".deco/blocks/Promo.json"]).toBeDefined();
    expect(git.history[1]?.sha).toBe(restored);
  });
});

describe("reapply message", () => {
  const date = "2026-10-01T09:30:12Z";

  it("is `Reapply: <note>`", () => {
    expect(reapplyTitle({ message: "Summer sale\n\nbody", date })).toBe(
      "Reapply: Summer sale",
    );
  });

  it("never chains: reapplying a reapplied version keeps one prefix", () => {
    expect(reapplyTitle({ message: "Reapply: Summer sale", date })).toBe(
      "Reapply: Summer sale",
    );
  });

  it("names a release without a note by its date", () => {
    expect(
      reapplyTitle({ message: "chore(decofile): update Home", date }),
    ).toBe("Reapply: release from 2026-10-01 09:30 UTC");
    expect(reapplyTitle({ message: "", date })).toBe(
      "Reapply: release from 2026-10-01 09:30 UTC",
    );
    expect(reapplyTitle({ message: "", date: "nope" })).toBe(
      "Reapply: earlier release",
    );
    // …and keeps that name when reapplied again.
    expect(
      reapplyTitle({
        message: "Reapply: release from 2026-10-01 09:30 UTC",
        date: "2026-10-05T00:00:00Z",
      }),
    ).toBe("Reapply: release from 2026-10-01 09:30 UTC");
  });

  it("ends with the Reapplied-From trailer, co-author in the same block", () => {
    const sha = "a".repeat(40);
    expect(reapplyMessage({ message: "Hi", date }, sha)).toBe(
      `Reapply: Hi\n\nReapplied-From: ${sha}`,
    );
    expect(reapplyMessage({ message: "Hi", date }, sha, ANA)).toBe(
      `Reapply: Hi\n\nReapplied-From: ${sha}\nCo-authored-by: Ana <ana@acme.com>`,
    );
    expect(reappliedFrom(reapplyMessage({ message: "Hi", date }, sha))).toBe(
      sha,
    );
    expect(reappliedFrom("plain")).toBeNull();
    expect(reappliedFrom(undefined)).toBeNull();
  });
});
