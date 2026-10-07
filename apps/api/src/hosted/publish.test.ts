import { beforeAll, describe, expect, it } from "bun:test";
import { serializeBlock } from "@decocms/blocks/protocol";
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
  RolledBackError,
  readLatest,
  resync,
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
    site: "acme",
  };
  return { git, delivery, drafts, repo };
}

describe("publishDraft", () => {
  it("commits to main, writes the revision, then latest.json, then deletes the draft", async () => {
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
    expect(result).toEqual({ result: "published", sha });
    expect(git.history[0]!.message).toBe("Update home");
    expect(git.filesAt(sha)).toEqual({
      ".deco/schema.gen.json": SCHEMA_TEXT,
      ".deco/blocks/Home.json": serializeBlock({ path: "/", title: "v2" }),
    });
    expect(delivery.log).toEqual([
      `put ${deliveryKeys.revision("acme", sha)}`,
      `put ${deliveryKeys.latest("acme")}`,
      `delete ${deliveryKeys.draft("acme", slug)}`,
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
    expect(latest.cacheControl).toBe("public, max-age=10, must-revalidate");
    expect(await drafts.load(REF)).toBeNull();
  });

  it("does not write latest.json when main moved after the commit (pending)", async () => {
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
    expect(result.result).toBe("pending");
    expect(await readLatest(delivery.store, "acme")).toBeNull();
    expect(await drafts.load(REF)).toBeNull();
  });

  it("stops before anything is published when main moved under the commit", async () => {
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

  it("is pending when the delivery write fails after git, and drops the draft", async () => {
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
    expect(result.result).toBe("pending");
    expect(await drafts.load(REF)).toBeNull();
  });

  it("answers up-to-date without a draft", async () => {
    const { drafts, repo } = setup();
    expect(
      await publishDraft(repo, drafts, REF, { message: "", coAuthor: null }),
    ).toEqual({ result: "up-to-date" });
  });
});

describe("resync", () => {
  it("releases main's head when nothing is published yet", async () => {
    const { git, delivery, repo } = setup();
    expect(await resync(repo, { confirm: false })).toEqual({
      result: "published",
      sha: git.head(),
    });
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(
      git.head(),
    );
  });

  it("asks for confirmation before overriding a rollback", async () => {
    const { git, delivery, repo } = setup();
    await resync(repo, { confirm: false });
    const rolledTo = git.head();
    git.pushDirect({ ".deco/blocks/Home.json": "{}\n" });
    await expect(resync(repo, { confirm: false })).rejects.toThrow(
      RolledBackError,
    );
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(rolledTo);
    await resync(repo, { confirm: true });
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(
      git.head(),
    );
  });
});
