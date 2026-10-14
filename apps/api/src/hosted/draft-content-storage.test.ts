import { beforeAll, describe, expect, it } from "bun:test";
import { serializeBlock } from "@decocms/blocks/protocol";
import { defineConformanceSuite } from "@decocms/blocks/protocol/conformance";
import { createContentHandler } from "@decocms/blocks/protocol/server";
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

  it("a put of main's own content drops the name from the draft", () => {
    const next = applyAttemptToDraft(
      { set: { Home: { a: 1 }, Footer: { b: 2 } }, delete: [] },
      { put: { "Home.json": '{"a":0}' }, delete: [] },
      main,
      new Set(["Home"]),
    );
    expect(next).toEqual({ set: { Footer: { b: 2 } }, delete: [] });
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
  it("a save of main's own content leaves no draft entry", async () => {
    const { storage, drafts } = setup();
    const snap = await storage.snapshot();
    await storage.commit({
      base: snap,
      put: {
        "Home.json": serializeBlock({ path: "/", title: "draft" }),
        "Footer.json": serializeBlock({ links: ["x"] }),
      },
      delete: [],
      expected: {},
    });
    const edited = await storage.snapshot();
    // Key order differs from main's file: still main's content.
    await storage.commit({
      base: edited,
      put: { "Home.json": JSON.stringify({ title: "main", path: "/" }) },
      delete: [],
      expected: {},
    });
    expect((await drafts.load(REF))?.body).toEqual({
      set: { Footer: { links: ["x"] } },
      delete: [],
    });
    await storage.commit({
      base: await storage.snapshot(),
      put: { "Footer.json": serializeBlock({ links: [] }) },
      delete: [],
      expected: {},
    });
    expect((await drafts.load(REF))?.body).toEqual({ set: {}, delete: [] });
  });

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

/** bun:test treats a test function that declares a parameter as callback-style. */
const runner = {
  describe,
  it: (name: string, body: () => Promise<void>, timeout?: number) =>
    it(name, () => body(), timeout),
};

/** A JSON-RPC call to the content handler over this storage. */
async function call(
  storage: ReturnType<typeof setup>["storage"],
  method: string,
  params?: unknown,
) {
  const handler = createContentHandler(storage, {
    server: { name: "studio-github", version: "1" },
    bodyCacheBytes: 0,
  });
  const res = await handler(
    new Request("http://studio.test/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  // biome-ignore lint/suspicious/noExplicitAny: protocol results are asserted per test
  return (await res.json()) as { result?: any; error?: any };
}

describe("hosted draft storage: conformance, main as the base", () => {
  // One project for the whole suite, as an editor session is.
  const repo = fakeRepo({
    ".deco/schema.gen.json": SCHEMA_TEXT,
    ".deco/blocks/hero-home.json": serializeBlock({
      __resolveType: "hero",
      title: "on main",
    }),
  });
  const delivery = memoryDeliveryStore();
  const drafts = createDraftStore({ kv: memoryKv(), store: delivery.store });
  defineConformanceSuite(
    runner,
    () => ({
      endpoint: "http://studio.test/rpc",
      // Per request, as the route builds it.
      fetch: async (request: Request) =>
        createContentHandler(
          createDraftContentStorage({
            client: repo.client,
            packagePath: null,
            mainBranch: "main",
            drafts,
            ref: REF,
          }),
          {
            server: { name: "studio-github", version: "1" },
            bodyCacheBytes: 0,
          },
        )(request),
      baseEntry: { name: "hero-home" },
    }),
    "content protocol conformance (hosted draft over main)",
  );
});

describe("hosted draft storage: changes against main", () => {
  it("lists the draft's names: sets, deletes, and a set equal to main is no change", async () => {
    const { repo, storage } = setup();
    await call(storage, "blocks.apply", {
      set: { Home: { path: "/", title: "draft" }, New: { v: 1 } },
      delete: ["Footer"],
    });
    const listed = await call(storage, "changes.list");
    expect(listed.result.base).toEqual({
      revision: repo.head(),
      resolvedRef: "main",
    });
    expect(listed.result.changes).toEqual({
      Footer: {
        kind: "delete",
        version: null,
        baseVersion: expect.any(String),
      },
      Home: {
        kind: "set",
        version: expect.any(String),
        baseVersion: expect.any(String),
      },
      New: { kind: "set", version: expect.any(String), baseVersion: null },
    });
    const sides = await call(storage, "changes.get", {
      names: ["Home", "Footer"],
    });
    expect(sides.result.entries.Home).toMatchObject({
      before: { path: "/", title: "main" },
      after: { path: "/", title: "draft" },
    });
    expect(sides.result.entries.Footer).toMatchObject({
      before: { links: [] },
      after: null,
    });
    // Main's own content back: not a change, and gone from the draft.
    await call(storage, "blocks.apply", {
      set: { Home: { path: "/", title: "main" } },
    });
    expect(
      Object.keys((await call(storage, "changes.list")).result.changes),
    ).toEqual(["Footer", "New"]);
  });

  it("discards back to main, dropping the names from the draft", async () => {
    const { storage, drafts } = setup();
    const saved = await call(storage, "blocks.apply", {
      set: { Home: { path: "/", title: "draft" }, New: { v: 1 } },
      delete: ["Footer"],
    });
    const discarded = await call(storage, "changes.discard", {
      names: ["Home", "New", "Footer"],
      ifMatch: { Home: saved.result.versions.Home, Footer: null },
    });
    expect(discarded.error).toBeUndefined();
    expect(discarded.result.versions).toEqual({
      Home: expect.any(String),
      New: null,
      Footer: expect.any(String),
    });
    expect((await drafts.load(REF))?.body).toEqual({ set: {}, delete: [] });
    expect((await call(storage, "changes.list")).result.changes).toEqual({});
    const listed = await call(storage, "blocks.list");
    expect(listed.result.versions.Home).toBe(discarded.result.versions.Home);
  });

  it("restores a main file that isn't valid JSON, byte for byte", async () => {
    const repo = fakeRepo({
      ".deco/schema.gen.json": SCHEMA_TEXT,
      ".deco/blocks/Broken.json": '{"v": 1,,}',
    });
    const drafts = createDraftStore({
      kv: memoryKv(),
      store: memoryDeliveryStore().store,
    });
    const storage = createDraftContentStorage({
      client: repo.client,
      packagePath: null,
      mainBranch: "main",
      drafts,
      ref: REF,
    });
    await call(storage, "blocks.apply", { set: { Broken: { v: 2 } } });
    const sides = await call(storage, "changes.get", { names: ["Broken"] });
    expect(sides.result.entries.Broken).toMatchObject({
      before: null,
      after: { v: 2 },
    });
    expect(sides.result.diagnostics).toMatchObject([
      { file: "Broken.json", kind: "invalid-json", side: "before" },
    ]);
    const discarded = await call(storage, "changes.discard", {
      names: ["Broken"],
    });
    expect(discarded.error).toBeUndefined();
    expect((await drafts.load(REF))?.body).toEqual({ set: {}, delete: [] });
    expect((await call(storage, "changes.list")).result.changes).toEqual({});
  });

  it("an entry main holds under two spellings leaves the list once discarded", async () => {
    const repo = fakeRepo({
      ".deco/schema.gen.json": SCHEMA_TEXT,
      ".deco/blocks/a%20b.json": serializeBlock({ v: "encoded" }),
      ".deco/blocks/a%2520b.json": serializeBlock({ v: "double" }),
    });
    const drafts = createDraftStore({
      kv: memoryKv(),
      store: memoryDeliveryStore().store,
    });
    const storage = createDraftContentStorage({
      client: repo.client,
      packagePath: null,
      mainBranch: "main",
      drafts,
      ref: REF,
    });
    expect((await call(storage, "changes.list")).result.changes).toEqual({});
    await call(storage, "blocks.apply", { set: { "a b": { v: "draft" } } });
    // The draft hides both of main's spellings: one change.
    expect(
      Object.keys((await call(storage, "changes.list")).result.changes),
    ).toEqual(["a b"]);
    const before = await call(storage, "blocks.list");
    await call(storage, "changes.discard", { names: ["a b"] });
    expect((await call(storage, "changes.list")).result.changes).toEqual({});
    expect((await drafts.load(REF))?.body).toEqual({ set: {}, delete: [] });
    const after = await call(storage, "blocks.list");
    expect(after.result.blocks["a b"]).not.toEqual(before.result.blocks["a b"]);
  });

  it("a discard computed from an older main is stale; one guarded by a moved version too", async () => {
    const { repo, storage } = setup();
    await call(storage, "blocks.apply", {
      set: { Home: { path: "/", title: "draft" } },
    });
    const base = await storage.base();
    const snap = await storage.snapshot();
    repo.pushDirect({ ".deco/blocks/Other.json": serializeBlock({ v: 1 }) });
    expect(
      await storage.commit({
        base: snap,
        put: { "Home.json": serializeBlock({ path: "/", title: "main" }) },
        delete: [],
        expected: {},
        expectedBase: base.revision,
        reason: "discard",
      }),
    ).toEqual({ status: "stale" });
    const moved = await storage.snapshot();
    expect(
      await storage.commit({
        base: moved,
        put: { "Home.json": serializeBlock({ path: "/", title: "main" }) },
        delete: [],
        expected: { "Home.json": "not-the-version" },
        expectedBase: repo.head(),
        reason: "discard",
      }),
    ).toEqual({ status: "stale" });
    expect(
      Object.keys((await call(storage, "changes.list")).result.changes),
    ).toEqual(["Home"]);
  });
});
