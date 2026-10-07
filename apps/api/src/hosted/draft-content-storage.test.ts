import { beforeAll, describe, expect, it } from "bun:test";
import { serializeBlock } from "@decocms/blocks/protocol";
import { deliveryKeys } from "./delivery-store";
import {
  applyAttemptToDraft,
  createDraftContentStorage,
} from "./draft-content-storage";
import { createDraftStore, type HostedDraftRef } from "./draft-store";
import {
  fakeRepo,
  memoryDeliveryStore,
  memoryKv,
  SCHEMA_TEXT,
} from "./hosted-test-helpers";

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
  const repo = fakeRepo({
    ".deco/schema.gen.json": SCHEMA_TEXT,
    ".deco/blocks/Home.json": serializeBlock({ path: "/", title: "main" }),
    ".deco/blocks/Footer.json": serializeBlock({ links: [] }),
  });
  const delivery = memoryDeliveryStore();
  const drafts = createDraftStore({ kv: memoryKv(), store: delivery.store });
  const storage = createDraftContentStorage({
    client: repo.client,
    packagePath: null,
    mainBranch: "main",
    drafts,
    ref: REF,
  });
  return { repo, delivery, drafts, storage };
}

describe("applyAttemptToDraft", () => {
  const main = new Set(["Home", "Footer"]);

  it("puts set the block and lift a pending delete", () => {
    const next = applyAttemptToDraft(
      { set: {}, delete: ["Home"] },
      { put: { "Home.json": '{"a":1}' }, delete: [] },
      main,
    );
    expect(next).toEqual({ set: { Home: { a: 1 } }, delete: [] });
  });

  it("deleting a main block moves it to delete; a draft-only one just goes", () => {
    const next = applyAttemptToDraft(
      { set: { Home: { a: 1 }, New: { b: 2 } }, delete: [] },
      { put: {}, delete: ["Home.json", "New.json"] },
      main,
    );
    expect(next).toEqual({ set: {}, delete: ["Home"] });
  });

  it("ignores the shadow-spelling deletes of a written name", () => {
    const next = applyAttemptToDraft(
      { set: {}, delete: [] },
      { put: { "a%20b.json": '{"x":1}' }, delete: ["a%2520b.json"] },
      new Set(["a b"]),
    );
    expect(next).toEqual({ set: { "a b": { x: 1 } }, delete: [] });
  });
});

describe("createDraftContentStorage", () => {
  it("reads main with no draft, at revision <head>~none", async () => {
    const { repo, storage } = setup();
    const snap = await storage.snapshot();
    expect(snap.revision).toBe(`${repo.head()}~none`);
    expect(snap.files.map((f) => f.file).sort()).toEqual([
      "Footer.json",
      "Home.json",
    ]);
  });

  it("saves into the CDN draft, never into git, and reads it back layered", async () => {
    const { repo, delivery, storage } = setup();
    const before = repo.head();
    const snap = await storage.snapshot();
    const result = await storage.commit({
      base: snap,
      put: { "Home.json": serializeBlock({ path: "/", title: "draft" }) },
      delete: ["Footer.json"],
      expected: {},
    });
    expect(result.status).toBe("committed");
    expect(repo.head()).toBe(before);
    const [key] = await delivery.store.listKeys("sites/acme/drafts/");
    const saved = delivery.objects.get(key!)!;
    expect(JSON.parse(saved.text)).toEqual({
      set: { Home: { path: "/", title: "draft" } },
      delete: ["Footer"],
    });
    expect(saved.cacheControl).toBe("no-cache, max-age=0, must-revalidate");

    const next = await storage.snapshot();
    expect(next.revision).toBe(`${before}~${saved.etag.replaceAll('"', "")}`);
    expect(result).toMatchObject({ revision: next.revision });
    expect(next.files.map((f) => f.file)).toEqual(["Home.json"]);
    const read = await storage.readFiles(next, ["Home.json"]);
    expect(JSON.parse(read["Home.json"]!.text)).toEqual({
      path: "/",
      title: "draft",
    });
  });

  it("the last writer wins: a save over another's base still lands", async () => {
    const { storage } = setup();
    const stale = await storage.snapshot();
    await storage.commit({
      base: stale,
      put: { "A.json": "{}" },
      delete: [],
      expected: {},
    });
    const result = await storage.commit({
      base: stale,
      put: { "B.json": "{}" },
      delete: [],
      expected: { "B.json": null },
    });
    expect(result.status).toBe("committed");
    const files = (await storage.snapshot()).files.map((f) => f.file).sort();
    expect(files).toEqual(["A.json", "B.json", "Footer.json", "Home.json"]);
  });

  it("is stale when main's schema changed under the save", async () => {
    const { storage } = setup();
    const result = await storage.commit({
      base: await storage.snapshot(),
      put: { "A.json": "{}" },
      delete: [],
      expected: {},
      expectedSchemaVersion: "another",
    });
    expect(result).toEqual({ status: "stale" });
  });

  it("refuses to write a site whose main isn't v8", async () => {
    const repo = fakeRepo({ ".deco/blocks/Home.json": "{}" });
    const delivery = memoryDeliveryStore();
    const storage = createDraftContentStorage({
      client: repo.client,
      packagePath: null,
      mainBranch: "main",
      drafts: createDraftStore({ kv: memoryKv(), store: delivery.store }),
      ref: REF,
    });
    await expect(
      storage.commit({
        base: await storage.snapshot(),
        put: { "A.json": "{}" },
        delete: [],
        expected: {},
      }),
    ).rejects.toThrow();
    expect(delivery.objects.size).toBe(0);
  });
});

describe("createDraftStore", () => {
  it("keeps one slug per (project, branch) until the draft is removed", async () => {
    const delivery = memoryDeliveryStore();
    const drafts = createDraftStore({ kv: memoryKv(), store: delivery.store });
    expect(await drafts.load(REF)).toBeNull();
    const first = await drafts.update(REF, () => ({
      set: { A: {} },
      delete: [],
    }));
    const second = await drafts.update(REF, (b) => ({ ...b, delete: ["B"] }));
    expect(second.slug).toBe(first.slug);
    expect((await drafts.load(REF))?.body).toEqual({
      set: { A: {} },
      delete: ["B"],
    });
    const other = await drafts.update({ ...REF, branch: "thread-2" }, (b) => b);
    expect(other.slug).not.toBe(first.slug);
    await drafts.remove(REF);
    expect(await drafts.load(REF)).toBeNull();
    expect(delivery.objects.has(deliveryKeys.draft("acme", first.slug))).toBe(
      false,
    );
  });

  it("serializes concurrent saves of one draft in this process", async () => {
    const delivery = memoryDeliveryStore();
    const drafts = createDraftStore({ kv: memoryKv(), store: delivery.store });
    await Promise.all(
      ["A", "B", "C"].map((name) =>
        drafts.update(REF, (b) => ({ ...b, set: { ...b.set, [name]: {} } })),
      ),
    );
    expect(Object.keys((await drafts.load(REF))!.body.set).sort()).toEqual([
      "A",
      "B",
      "C",
    ]);
  });
});
