import { beforeAll, describe, expect, it } from "bun:test";
import { serializeBlock } from "@decocms/blocks/protocol";
import { createDeliveryPurge } from "./delivery-purge";
import { CACHE_DRAFT, deliveryKeys } from "./delivery-store";
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
import { releaseMainHead } from "./releases";

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
    previewHosts: ["acme.deco.site", "www.acme.com"],
  };
  return { git, delivery, drafts, repo };
}

/** The draft after a publish: same slug (same pointer address), a new ETag, nothing in it. */
async function expectEmptied(
  drafts: ReturnType<typeof createDraftStore>,
  saved: { slug: string; etag: string | null },
) {
  const after = await drafts.load(REF);
  expect(after?.slug).toBe(saved.slug);
  expect(after?.etag).not.toBeNull();
  expect(after?.etag).not.toBe(saved.etag);
  expect(after?.body).toEqual({ set: {}, delete: [] });
  expect(after?.editors).toEqual({});
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
    expect(result).toMatchObject({ result: "merged", release: "current" });
    const kept = await drafts.load(REF);
    expect(kept?.slug).toBe(slug);
    expect(Object.keys(kept!.body.set).sort()).toEqual(["Home", "Late"]);
  });

  it("commits to main, writes the revision and latest.json (purged), then empties the draft: same slug, new etag (Merged · Current on the CDN)", async () => {
    const { git, delivery, drafts, repo } = setup();
    const saved = await drafts.update({ ...REF, editor: "ana" }, () => ({
      set: { Home: { path: "/", title: "v2" } },
      delete: ["Old"],
    }));
    const { slug } = saved;
    const before = git.head();
    delivery.log.length = 0;

    const result = await publishDraft(repo, drafts, REF, {
      message: "Update home",
      coAuthor: null,
    });

    const sha = git.head();
    expect(sha).not.toBe(before);
    expect(result).toEqual({ result: "merged", sha, release: "current" });
    expect(git.history[0]!.message).toBe("Update home");
    expect(git.filesAt(sha)).toEqual({
      ".deco/schema.gen.json": SCHEMA_TEXT,
      ".deco/blocks/Home.json": serializeBlock({ path: "/", title: "v2" }),
    });
    // The order: the release is current before the draft is emptied, so any
    // render of the emptied draft sees the new release.
    expect(delivery.log).toEqual([
      `put ${deliveryKeys.revision("acme", sha)}`,
      `put ${deliveryKeys.latest("acme")}`,
      `purge ${deliveryKeys.latest("acme")}`,
      `put ${deliveryKeys.draft("acme", slug)}`,
    ]);
    const emptied = delivery.objects.get(deliveryKeys.draft("acme", slug))!;
    expect(JSON.parse(emptied.text)).toEqual({ set: {}, delete: [] });
    expect(emptied.cacheControl).toBe(CACHE_DRAFT);
    expect(emptied.metadata ?? {}).toEqual({});
    const revision = delivery.objects.get(deliveryKeys.revision("acme", sha))!;
    expect(JSON.parse(revision.text)).toEqual({
      revision: sha,
      schemaHash: SCHEMA_HASH,
      blocks: { Home: { path: "/", title: "v2" } },
      previewHosts: ["acme.deco.site", "www.acme.com"],
    });
    expect(revision.cacheControl).toBe("public, max-age=31536000, immutable");
    const latest = delivery.objects.get(deliveryKeys.latest("acme"))!;
    expect(Object.keys(JSON.parse(latest.text)).sort()).toEqual([
      "previewHosts",
      "publishedAt",
      "revision",
      "schemaHash",
    ]);
    // The site shows drafts only on the hosts Studio knows for it.
    expect(JSON.parse(latest.text).previewHosts).toEqual([
      "acme.deco.site",
      "www.acme.com",
    ]);
    expect(latest.cacheControl).toBe(
      "public, max-age=0, s-maxage=3600, must-revalidate",
    );
    await expectEmptied(drafts, saved);
  });

  it("is Merged · release created, not current, when main moved after the commit: no latest.json, draft kept for Try again", async () => {
    const { git, delivery, drafts, repo } = setup();
    const saved = await drafts.update(REF, () => ({
      set: { New: { a: 1 } },
      delete: [],
    }));
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
    expect(result).toMatchObject({
      result: "merged",
      release: "created",
      draftEtag: saved.etag ?? undefined,
    });
    expect(await readLatest(delivery.store, "acme")).toBeNull();
    // Not live yet: the preview keeps showing the changes.
    expect(await drafts.load(REF)).toEqual(saved);
  });

  it("fails and keeps the draft when main moved under the commit", async () => {
    const { git, delivery, drafts, repo } = setup();
    const saved = await drafts.update(REF, () => ({
      set: { New: { a: 1 } },
      delete: [],
    }));
    const commitFiles = git.client.commitFiles;
    git.client.commitFiles = async (params) => {
      git.pushDirect({ ".deco/blocks/Race.json": "{}\n" });
      return commitFiles(params);
    };
    await expect(
      publishDraft(repo, drafts, REF, { message: "", coAuthor: null }),
    ).rejects.toThrow(MainMovedError);
    expect(await drafts.load(REF)).toEqual(saved);
    expect(await readLatest(delivery.store, "acme")).toBeNull();
  });

  it("is Merged · no release created when the companion write fails: latest.json untouched, draft kept", async () => {
    const { drafts, repo, delivery } = setup();
    const saved = await drafts.update(REF, () => ({
      set: { New: { a: 1 } },
      delete: [],
    }));
    const put = delivery.store.putJson;
    delivery.store.putJson = async (key, value, cache) => {
      if (key.includes("/revisions/")) throw new Error("R2 down");
      return put(key, value, cache);
    };
    const result = await publishDraft(repo, drafts, REF, {
      message: "",
      coAuthor: null,
    });
    expect(result).toMatchObject({
      result: "merged",
      release: "none",
      draftEtag: saved.etag,
    });
    expect(delivery.log.some((l) => l.includes("latest.json"))).toBe(false);
    expect(await drafts.load(REF)).toEqual(saved);
  });

  it("fails fast when the purge fails: one purge call, no restore, Merged · release created, draft kept", async () => {
    const { git, delivery, drafts, repo } = setup();
    const saved = await drafts.update(REF, () => ({
      set: { New: { a: 1 } },
      delete: [],
    }));
    delivery.log.length = 0;
    delivery.failPurge(true);
    const result = await publishDraft(repo, drafts, REF, {
      message: "",
      coAuthor: null,
    });
    expect(result).toEqual({
      result: "merged",
      sha: git.head(),
      release: "created",
      draftEtag: saved.etag ?? undefined,
    });
    // One purge call (its single retry is inside it) and one pointer write:
    // no restore.
    expect(delivery.log).toEqual([
      `put ${deliveryKeys.revision("acme", git.head())}`,
      `put ${deliveryKeys.latest("acme")}`,
      `purge ${deliveryKeys.latest("acme")}`,
    ]);
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(
      git.head(),
    );
    expect(await drafts.load(REF)).toEqual(saved);
  });

  it("is Merged · release created when both purge attempts fail (exactly two calls)", async () => {
    const { git, delivery, drafts, repo } = setup();
    const saved = await drafts.update(REF, () => ({
      set: { New: { a: 1 } },
      delete: [],
    }));
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
      release: "created",
      draftEtag: saved.etag ?? undefined,
    });
    expect(calls).toBe(2);
    // No restore: the pointer written once stays.
    expect(delivery.log).toEqual([
      `put ${deliveryKeys.revision("acme", git.head())}`,
      `put ${deliveryKeys.latest("acme")}`,
    ]);
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(
      git.head(),
    );
    expect(await drafts.load(REF)).toEqual(saved);
  });

  it("publishes and empties the draft when the purge retry succeeds", async () => {
    const { git, drafts, repo } = setup();
    const saved = await drafts.update(REF, () => ({
      set: { New: { a: 1 } },
      delete: [],
    }));
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
    expect(result).toEqual({
      result: "merged",
      sha: git.head(),
      release: "current",
    });
    expect(calls).toBe(2);
    await expectEmptied(drafts, saved);
  });

  it("does not purge when the latest.json write fails (Merged · release created, draft kept)", async () => {
    const { git, delivery, drafts, repo } = setup();
    const saved = await drafts.update(REF, () => ({
      set: { New: { a: 1 } },
      delete: [],
    }));
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
      release: "created",
      draftEtag: saved.etag ?? undefined,
    });
    expect(delivery.log).toEqual([
      `put ${deliveryKeys.revision("acme", git.head())}`,
    ]);
    expect(await drafts.load(REF)).toEqual(saved);
  });

  it("still succeeds when emptying the draft fails: the draft then equals main", async () => {
    const { git, delivery, drafts, repo } = setup();
    const saved = await drafts.update(REF, () => ({
      set: { New: { a: 1 } },
      delete: [],
    }));
    const put = delivery.store.putJson;
    delivery.store.putJson = async (key, value, cache, metadata) => {
      if (key === deliveryKeys.draft("acme", saved.slug)) {
        throw new Error("R2 down");
      }
      return put(key, value, cache, metadata);
    };
    const result = await publishDraft(repo, drafts, REF, {
      message: "",
      coAuthor: null,
    });
    expect(result).toEqual({
      result: "merged",
      sha: git.head(),
      release: "current",
    });
    expect(await drafts.load(REF)).toEqual(saved);
  });

  it("keeps the draft and fails when the commit fails", async () => {
    const { delivery, drafts, repo } = setup();
    const saved = await drafts.update(REF, () => ({
      set: { New: { a: 1 } },
      delete: [],
    }));
    delivery.log.length = 0;
    repo.client.commitFiles = async () => {
      throw new Error("GitHub down");
    };
    await expect(
      publishDraft(repo, drafts, REF, { message: "", coAuthor: null }),
    ).rejects.toThrow("GitHub down");
    expect(await drafts.load(REF)).toEqual(saved);
    expect(delivery.log).toEqual([]);
  });

  it("leaves latest.json alone and empties the draft (same slug) when the draft commits nothing and main's head is current", async () => {
    const { git, delivery, drafts, repo } = setup();
    await releaseMainHead(repo);
    // Same content as main: nothing to commit.
    const saved = await drafts.update(REF, () => ({
      set: { Home: { path: "/", title: "v1" } },
      delete: [],
    }));
    const before = git.head();
    delivery.log.length = 0;
    expect(
      await publishDraft(repo, drafts, REF, { message: "", coAuthor: null }),
    ).toEqual({ result: "up-to-date" });
    expect(git.head()).toBe(before);
    expect(delivery.log).toEqual([
      `put ${deliveryKeys.draft("acme", saved.slug)}`,
    ]);
    await expectEmptied(drafts, saved);
  });

  it("Publish again after a failed release (Try again lost) releases main's head and only then empties the draft", async () => {
    const { git, delivery, drafts, repo } = setup();
    const saved = await drafts.update(REF, () => ({
      set: { New: { a: 1 } },
      delete: [],
    }));
    const put = delivery.store.putJson;
    let down = true;
    delivery.store.putJson = async (key, value, cache, metadata) => {
      if (down && key === deliveryKeys.latest("acme")) {
        throw new Error("R2 down");
      }
      return put(key, value, cache, metadata);
    };
    expect(
      await publishDraft(repo, drafts, REF, { message: "", coAuthor: null }),
    ).toMatchObject({ result: "merged", release: "created" });
    const head = git.head();
    // Publish again while the CDN is still down: nothing new to commit, main's
    // head released again, which fails again: the draft is kept for Try again.
    expect(
      await publishDraft(repo, drafts, REF, { message: "", coAuthor: null }),
    ).toEqual({
      result: "merged",
      sha: head,
      release: "created",
      draftEtag: saved.etag ?? undefined,
    });
    expect(git.head()).toBe(head);
    expect(await drafts.load(REF)).toEqual(saved);
    expect(await readLatest(delivery.store, "acme")).toBeNull();
    // Publish again once the CDN is back: main's head goes live, then the
    // draft is emptied (same slug).
    down = false;
    expect(
      await publishDraft(repo, drafts, REF, { message: "", coAuthor: null }),
    ).toEqual({ result: "merged", sha: head, release: "current" });
    expect(git.head()).toBe(head);
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(head);
    await expectEmptied(drafts, saved);
  });

  it("Publish again after a failed release keeps a save made during it", async () => {
    const { git, delivery, drafts, repo } = setup();
    await drafts.update(REF, () => ({ set: { New: { a: 1 } }, delete: [] }));
    const put = delivery.store.putJson;
    let down = true;
    delivery.store.putJson = async (key, value, cache, metadata) => {
      if (down && key === deliveryKeys.latest("acme")) {
        throw new Error("R2 down");
      }
      return put(key, value, cache, metadata);
    };
    await publishDraft(repo, drafts, REF, { message: "", coAuthor: null });
    down = false;
    let later: Awaited<ReturnType<typeof drafts.update>> | null = null;
    const result = await publishDraft(
      repo,
      drafts,
      REF,
      { message: "", coAuthor: null },
      {
        beforePointerWrite: async () => {
          later = await drafts.update(REF, (d) => ({
            set: { ...d.set, Other: { b: 2 } },
            delete: d.delete,
          }));
        },
      },
    );
    expect(result).toMatchObject({ result: "merged", release: "current" });
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(
      git.head(),
    );
    expect(await drafts.load(REF)).toEqual(later);
  });

  it("answers up-to-date for an empty draft and keeps it as it is (same slug, same etag)", async () => {
    const { delivery, drafts, repo } = setup();
    const saved = await drafts.update(REF, () => ({ set: {}, delete: [] }));
    delivery.log.length = 0;
    expect(
      await publishDraft(repo, drafts, REF, { message: "", coAuthor: null }),
    ).toEqual({ result: "up-to-date" });
    expect(delivery.log.some((l) => l.includes("latest.json"))).toBe(false);
    expect(await drafts.load(REF)).toEqual(saved);
  });

  it("answers up-to-date without a draft", async () => {
    const { drafts, repo } = setup();
    expect(
      await publishDraft(repo, drafts, REF, { message: "", coAuthor: null }),
    ).toEqual({ result: "up-to-date" });
  });
});
