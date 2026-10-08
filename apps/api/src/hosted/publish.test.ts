import { beforeAll, describe, expect, it } from "bun:test";
import { serializeBlock } from "@decocms/blocks/protocol";
import { createDeliveryPurge } from "./delivery-purge";
import { deliveryKeys } from "./delivery-store";
import { createDraftStore, type HostedDraftRef } from "./draft-store";
import {
  fakeRepo,
  memoryDeliveryStore,
  memoryKv,
  SCHEMA_HASH,
  SCHEMA_TEXT,
} from "./hosted-test-helpers";
import {
  type HostedRepo,
  MainMovedError,
  publishDraft,
  readLatest,
} from "./publish";

beforeAll(() => {
  process.env.FAST_PREVIEW_CACHE_DIR = "";
});

const REF: HostedDraftRef = {
  organizationId: "org",
  virtualMcpId: "vmcp",
  branch: "thread-1",
  site: "acme",
};

function setup() {
  const git = fakeRepo({
    ".deco/schema.gen.json": SCHEMA_TEXT,
    ".deco/blocks/Home.json": serializeBlock({ path: "/", title: "v1" }),
    ".deco/blocks/Old.json": serializeBlock({ x: 1 }),
  });
  const delivery = memoryDeliveryStore();
  const drafts = createDraftStore({ kv: memoryKv(), store: delivery.store });
  const repo: HostedRepo = {
    client: git.client,
    packagePath: null,
    mainBranch: "main",
    store: delivery.store,
    purge: delivery.purge,
    site: "acme",
  };
  return { git, delivery, drafts, repo };
}

describe("publishDraft", () => {
  it("keeps a draft saved during the publish (only the published save goes)", async () => {
    const { drafts, repo } = setup();
    const { slug } = await drafts.update(REF, () => ({
      set: { Home: { path: "/", title: "v2" } },
      delete: [],
    }));
    const commitFiles = repo.client.commitFiles;
    repo.client.commitFiles = async (params) => {
      await drafts.update(REF, (body) => ({
        ...body,
        set: { ...body.set, Late: { x: 2 } },
      }));
      return commitFiles(params);
    };
    const result = await publishDraft(repo, drafts, REF, {
      message: "Update home",
      coAuthor: null,
    });
    expect(result).toMatchObject({ result: "merged", cdn: "live" });
    const kept = await drafts.load(REF);
    expect(kept?.slug).toBe(slug);
    expect(Object.keys(kept!.body.set).sort()).toEqual(["Home", "Late"]);
  });

  it("commits to main, deletes the draft, then writes the revision and latest.json (Merged · Live)", async () => {
    const { git, delivery, drafts, repo } = setup();
    const { slug } = await drafts.update(REF, () => ({
      set: { Home: { path: "/", title: "v2" } },
      delete: ["Old"],
    }));
    const before = git.head();
    delivery.log.length = 0;

    const result = await publishDraft(repo, drafts, REF, {
      message: "Update home",
      coAuthor: null,
    });

    const sha = git.head();
    expect(sha).not.toBe(before);
    expect(result).toEqual({ result: "merged", sha, cdn: "live" });
    expect(git.history[0]!.message).toBe("Update home");
    expect(git.filesAt(sha)).toEqual({
      ".deco/schema.gen.json": SCHEMA_TEXT,
      ".deco/blocks/Home.json": serializeBlock({ path: "/", title: "v2" }),
    });
    expect(delivery.log).toEqual([
      `delete ${deliveryKeys.draft("acme", slug)}`,
      `put ${deliveryKeys.revision("acme", sha)}`,
      `put ${deliveryKeys.latest("acme")}`,
      `purge ${deliveryKeys.latest("acme")}`,
    ]);
    const revision = delivery.objects.get(deliveryKeys.revision("acme", sha))!;
    expect(JSON.parse(revision.text)).toEqual({
      revision: sha,
      schemaHash: SCHEMA_HASH,
      blocks: { Home: { path: "/", title: "v2" } },
    });
    expect(revision.cacheControl).toBe("public, max-age=31536000, immutable");
    const latest = delivery.objects.get(deliveryKeys.latest("acme"))!;
    expect(Object.keys(JSON.parse(latest.text)).sort()).toEqual([
      "publishedAt",
      "revision",
      "schemaHash",
    ]);
    expect(latest.cacheControl).toBe(
      "public, max-age=0, s-maxage=3600, must-revalidate",
    );
    expect(await drafts.load(REF)).toBeNull();
  });

  it("is Merged · CDN failed when main moved after the commit: no latest.json, draft deleted", async () => {
    const { git, delivery, drafts, repo } = setup();
    await drafts.update(REF, () => ({ set: { New: { a: 1 } }, delete: [] }));
    const result = await publishDraft(
      repo,
      drafts,
      REF,
      { message: "", coAuthor: null },
      {
        beforePointerWrite: async () => {
          git.pushDirect({ ".deco/blocks/Other.json": "{}\n" });
        },
      },
    );
    expect(result).toMatchObject({ result: "merged", cdn: "failed" });
    expect(await readLatest(delivery.store, "acme")).toBeNull();
    // Publish is done once the commit is on main.
    expect(await drafts.load(REF)).toBeNull();
  });

  it("fails and keeps the draft when main moved under the commit", async () => {
    const { git, delivery, drafts, repo } = setup();
    await drafts.update(REF, () => ({ set: { New: { a: 1 } }, delete: [] }));
    const commitFiles = git.client.commitFiles;
    git.client.commitFiles = async (params) => {
      git.pushDirect({ ".deco/blocks/Race.json": "{}\n" });
      return commitFiles(params);
    };
    await expect(
      publishDraft(repo, drafts, REF, { message: "", coAuthor: null }),
    ).rejects.toThrow(MainMovedError);
    expect(await drafts.load(REF)).not.toBeNull();
    expect(await readLatest(delivery.store, "acme")).toBeNull();
  });

  it("is Merged · CDN failed when the revision write fails, and deletes the draft", async () => {
    const { drafts, repo, delivery } = setup();
    await drafts.update(REF, () => ({ set: { New: { a: 1 } }, delete: [] }));
    const put = delivery.store.putJson;
    delivery.store.putJson = async (key, value, cache) => {
      if (key.includes("/revisions/")) throw new Error("R2 down");
      return put(key, value, cache);
    };
    const result = await publishDraft(repo, drafts, REF, {
      message: "",
      coAuthor: null,
    });
    expect(result).toMatchObject({ result: "merged", cdn: "failed" });
    expect(await drafts.load(REF)).toBeNull();
  });

  it("fails fast when the purge fails: one purge call, no restore, Merged · CDN failed, draft deleted", async () => {
    const { git, delivery, drafts, repo } = setup();
    await drafts.update(REF, () => ({ set: { New: { a: 1 } }, delete: [] }));
    delivery.log.length = 0;
    delivery.failPurge(true);
    const result = await publishDraft(repo, drafts, REF, {
      message: "",
      coAuthor: null,
    });
    expect(result).toEqual({
      result: "merged",
      sha: git.head(),
      cdn: "failed",
    });
    // One purge call (its single retry is inside it) and one pointer write:
    // no restore.
    expect(delivery.log.slice(1)).toEqual([
      `put ${deliveryKeys.revision("acme", git.head())}`,
      `put ${deliveryKeys.latest("acme")}`,
      `purge ${deliveryKeys.latest("acme")}`,
    ]);
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(
      git.head(),
    );
    expect(await drafts.load(REF)).toBeNull();
  });

  it("is Merged · CDN failed when both purge attempts fail (exactly two calls)", async () => {
    const { git, delivery, drafts, repo } = setup();
    await drafts.update(REF, () => ({ set: { New: { a: 1 } }, delete: [] }));
    let calls = 0;
    repo.purge = createDeliveryPurge({
      zoneId: "z",
      apiToken: "t",
      fetch: (async () => {
        calls++;
        return new Response(JSON.stringify({ success: false }), {
          status: 503,
        });
      }) as unknown as typeof fetch,
    });
    delivery.log.length = 0;
    const result = await publishDraft(repo, drafts, REF, {
      message: "",
      coAuthor: null,
    });
    expect(result).toEqual({
      result: "merged",
      sha: git.head(),
      cdn: "failed",
    });
    expect(calls).toBe(2);
    // No restore: the pointer written once stays.
    expect(delivery.log.slice(1)).toEqual([
      `put ${deliveryKeys.revision("acme", git.head())}`,
      `put ${deliveryKeys.latest("acme")}`,
    ]);
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(
      git.head(),
    );
    expect(await drafts.load(REF)).toBeNull();
  });

  it("publishes and deletes the draft when the purge retry succeeds", async () => {
    const { git, drafts, repo } = setup();
    await drafts.update(REF, () => ({ set: { New: { a: 1 } }, delete: [] }));
    let calls = 0;
    repo.purge = createDeliveryPurge({
      zoneId: "z",
      apiToken: "t",
      fetch: (async () => {
        calls++;
        return new Response(JSON.stringify({ success: calls > 1 }), {
          status: calls > 1 ? 200 : 503,
        });
      }) as unknown as typeof fetch,
    });
    const result = await publishDraft(repo, drafts, REF, {
      message: "",
      coAuthor: null,
    });
    expect(result).toEqual({ result: "merged", sha: git.head(), cdn: "live" });
    expect(calls).toBe(2);
    expect(await drafts.load(REF)).toBeNull();
  });

  it("does not purge when the latest.json write fails (Merged · CDN failed)", async () => {
    const { git, delivery, drafts, repo } = setup();
    await drafts.update(REF, () => ({ set: { New: { a: 1 } }, delete: [] }));
    delivery.log.length = 0;
    const put = delivery.store.putJson;
    delivery.store.putJson = async (key, value, cache) => {
      if (key === deliveryKeys.latest("acme")) throw new Error("R2 down");
      return put(key, value, cache);
    };
    const result = await publishDraft(repo, drafts, REF, {
      message: "",
      coAuthor: null,
    });
    expect(result).toEqual({
      result: "merged",
      sha: git.head(),
      cdn: "failed",
    });
    expect(delivery.log.slice(1)).toEqual([
      `put ${deliveryKeys.revision("acme", git.head())}`,
    ]);
    expect(await drafts.load(REF)).toBeNull();
  });

  it("keeps the draft and fails when the commit fails", async () => {
    const { delivery, drafts, repo } = setup();
    await drafts.update(REF, () => ({ set: { New: { a: 1 } }, delete: [] }));
    delivery.log.length = 0;
    repo.client.commitFiles = async () => {
      throw new Error("GitHub down");
    };
    await expect(
      publishDraft(repo, drafts, REF, { message: "", coAuthor: null }),
    ).rejects.toThrow("GitHub down");
    expect(await drafts.load(REF)).not.toBeNull();
    expect(delivery.log).toEqual([]);
  });

  it("answers up-to-date without a draft", async () => {
    const { drafts, repo } = setup();
    expect(
      await publishDraft(repo, drafts, REF, { message: "", coAuthor: null }),
    ).toEqual({ result: "up-to-date" });
  });
});
