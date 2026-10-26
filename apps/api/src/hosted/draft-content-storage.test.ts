import { beforeAll, describe, expect, it } from "bun:test";
import { serializeBlock } from "@decocms/blocks/protocol";
import { defineConformanceSuite } from "@decocms/blocks/protocol/conformance";
import { createContentHandler } from "@decocms/blocks/protocol/server";
import { deliveryKeys } from "./delivery-store";
import { gitBlobSha } from "@/decofile/read-decofile";
import {
  applyAttemptToDraft,
  createDraftContentStorage,
  createDraftWriteStorage,
} from "./draft-content-storage";
import { applyOnlyCalls, planDraftSave } from "./draft-save-request";
import {
  createDraftStore,
  type DraftStore,
  type HostedDraftRef,
} from "./draft-store";
import {
  fakeRepo,
  heldPuts,
  memoryDeliveryStore,
  memoryKv,
  otherApiProcess,
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
  it("puts set the block and lift a pending delete", () => {
    const next = applyAttemptToDraft(
      { set: {}, delete: ["Home"] },
      { put: { "Home.json": '{"a":1}' }, delete: [] },
    );
    expect(next).toEqual({ set: { Home: { a: 1 } }, delete: [] });
  });

  it("a delete drops the name from set and records it in delete", () => {
    const next = applyAttemptToDraft(
      { set: { Home: { a: 1 }, New: { b: 2 } }, delete: [] },
      { put: {}, delete: ["Home.json", "New.json"] },
    );
    expect(next).toEqual({ set: {}, delete: ["Home", "New"] });
  });

  it("a put keeps the whole block, even main's own content", () => {
    const next = applyAttemptToDraft(
      { set: { Home: { a: 1 }, Footer: { b: 2 } }, delete: [] },
      { put: { "Home.json": '{"a":0}' }, delete: [] },
    );
    expect(next).toEqual({
      set: { Home: { a: 0 }, Footer: { b: 2 } },
      delete: [],
    });
  });

  it("ignores the shadow-spelling deletes of a written name", () => {
    const next = applyAttemptToDraft(
      { set: {}, delete: [] },
      { put: { "a%20b.json": '{"x":1}' }, delete: ["a%2520b.json"] },
    );
    expect(next).toEqual({ set: { "a b": { x: 1 } }, delete: [] });
  });
});

describe("createDraftContentStorage", () => {
  it("a save of main's own content stays in the draft: the save is the block, whole", async () => {
    const { storage, drafts } = setup();
    await storage.commit({
      base: await storage.snapshot(),
      put: { "Home.json": JSON.stringify({ title: "main", path: "/" }) },
      delete: [],
      expected: {},
    });
    expect((await drafts.load(REF))?.body).toEqual({
      set: { Home: { path: "/", title: "main" } },
      delete: [],
    });
  });

  it("a discard (changes.discard) removes the entry: the read is main as it is now, and follows main when it moves", async () => {
    const { repo, drafts, storage } = setup();
    await storage.commit({
      base: await storage.snapshot(),
      put: { "Home.json": serializeBlock({ path: "/", title: "draft" }) },
      delete: [],
      expected: {},
    });
    const edited = await storage.snapshot();
    const etag = (await drafts.load(REF))?.etag;

    const discarded = await call(storage, "changes.discard", {
      names: ["Home"],
    });
    expect(discarded.error).toBeUndefined();
    const draft = await drafts.load(REF);
    expect(draft?.body).toEqual({ set: {}, delete: [] });
    // A new draft object: a new ETag, so a new pointer and revision.
    expect(draft?.etag).not.toBe(etag);
    const after = await storage.snapshot();
    expect(after.revision).not.toBe(edited.revision);
    expect(discarded.result.revision).toBe(after.revision);
    const read = async () =>
      JSON.parse(
        (await storage.readFiles(await storage.snapshot(), ["Home.json"]))[
          "Home.json"
        ]!.text,
      );
    expect(await read()).toEqual({ path: "/", title: "main" });

    // main moves after the discard (a publish from elsewhere).
    repo.pushDirect({
      ".deco/blocks/Home.json": serializeBlock({ path: "/", title: "main v2" }),
    });
    expect(await read()).toEqual({ path: "/", title: "main v2" });
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
});

describe("createDraftStore", () => {
  it("keeps one slug per (project, branch), emptied or not", async () => {
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
    const emptied = await drafts.empty(REF, second.etag);
    expect(emptied?.slug).toBe(first.slug);
    expect((await drafts.load(REF))?.body).toEqual({ set: {}, delete: [] });
    expect(delivery.objects.has(deliveryKeys.draft("acme", first.slug))).toBe(
      true,
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
  it("lists the draft's names: sets, deletes, and a set equal to main too", async () => {
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
    // Main's own content back: still the draft's, so still listed.
    await call(storage, "blocks.apply", {
      set: { Home: { path: "/", title: "main" } },
    });
    expect(
      Object.keys((await call(storage, "changes.list")).result.changes),
    ).toEqual(["Footer", "Home", "New"]);
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

  it("Discard all empties the draft and keeps its slug (the preview's pointer keeps its address)", async () => {
    const { storage, drafts } = setup();
    await call(storage, "blocks.apply", {
      set: { Home: { path: "/", title: "draft" }, New: { v: 1 } },
      delete: ["Footer"],
    });
    const before = (await drafts.load(REF))!;
    const discarded = await call(storage, "changes.discard", {
      names: ["Home", "New", "Footer"],
    });
    expect(discarded.error).toBeUndefined();
    const after = (await drafts.load(REF))!;
    expect(after.slug).toBe(before.slug);
    expect(after.etag).not.toBe(before.etag);
    expect(after.body).toEqual({ set: {}, delete: [] });
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

describe("hosted draft storage: saves from several API processes", () => {
  /** One project's draft served by two API processes, as in production. */
  async function twoProcesses() {
    const { repo, delivery } = setup();
    const kv = memoryKv();
    const one = createDraftContentStorage({
      client: repo.client,
      packagePath: null,
      mainBranch: "main",
      drafts: createDraftStore({ kv, store: delivery.store }),
      ref: REF,
    });
    const held = heldPuts(delivery.store);
    const { createDraftStore: createOther } = await otherApiProcess();
    const two = createDraftContentStorage({
      client: repo.client,
      packagePath: null,
      mainBranch: "main",
      drafts: createOther({ kv, store: held.store }),
      ref: REF,
    });
    // The draft exists, as an editor session creates it.
    await call(one, "blocks.apply", { set: { Home: { path: "/", t: 0 } } });
    const listed = await call(one, "blocks.list");
    return { one, two, held, versions: listed.result.versions };
  }

  it("two guarded saves of different blocks at once both land", async () => {
    const { one, two, held, versions } = await twoProcesses();
    held.hold();
    const campaigns = call(two, "blocks.apply", {
      set: { campaigns: { start: "2027" } },
      ifMatch: { campaigns: null },
    });
    await held.atPut;
    const experiments = await call(one, "blocks.apply", {
      set: { Home: { path: "/", t: 1 } },
      ifMatch: { Home: versions.Home },
    });
    held.release();
    expect(experiments.error).toBeUndefined();
    expect((await campaigns).error).toBeUndefined();
    const after = (await call(one, "blocks.list")).result;
    expect(after.blocks.Home).toEqual({ path: "/", t: 1 });
    expect(after.blocks.campaigns).toEqual({ start: "2027" });
    expect(after.versions.campaigns).toBe(
      (await campaigns).result.versions.campaigns,
    );
  });

  it("a guarded save that raced a save of the same block on another process is a Conflict, never an overwrite", async () => {
    const { one, two, held, versions } = await twoProcesses();
    held.hold();
    const stale = call(two, "blocks.apply", {
      set: { Home: { path: "/", t: "mine" } },
      ifMatch: { Home: versions.Home },
    });
    await held.atPut;
    const theirs = await call(one, "blocks.apply", {
      set: { Home: { path: "/", t: "theirs" } },
      ifMatch: { Home: versions.Home },
    });
    held.release();
    expect(theirs.error).toBeUndefined();
    expect((await stale).error).toMatchObject({
      data: {
        entries: {
          Home: {
            expected: versions.Home,
            actual: theirs.result.versions.Home,
          },
        },
      },
    });
    const after = (await call(one, "blocks.list")).result;
    expect(after.blocks.Home).toEqual({ path: "/", t: "theirs" });
  });
});

/** A save as the route serves it: the draft alone (`serveDraftSave`). */
async function save(
  drafts: DraftStore,
  params: Record<string, unknown>,
  ref: HostedDraftRef = REF,
) {
  const body = { jsonrpc: "2.0", id: 1, method: "blocks.apply", params };
  const loaded = await drafts.load(ref);
  const plan = planDraftSave(
    body,
    applyOnlyCalls(body)!,
    loaded?.body ?? { set: {}, delete: [] },
  );
  const res = await createContentHandler(
    createDraftWriteStorage({
      packagePath: null,
      drafts,
      ref,
      loaded,
      deletes: plan.deletes,
    }),
    { server: { name: "studio-github", version: "1" }, bodyCacheBytes: 0 },
  )(
    new Request("http://studio.test/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(plan.body),
    }),
  );
  // biome-ignore lint/suspicious/noExplicitAny: protocol results are asserted per test
  return (await res.json()) as { result?: any; error?: any };
}

describe("hosted draft saves: the draft alone", () => {
  it("writes the whole block into the draft, over what the draft had", async () => {
    const { drafts } = setup();
    await save(drafts, { set: { Home: { path: "/", title: "a", x: 1 } } });
    const saved = await save(drafts, {
      set: { Home: { path: "/", title: "b" } },
    });
    expect(saved.error).toBeUndefined();
    expect((await drafts.load(REF))?.body).toEqual({
      set: { Home: { path: "/", title: "b" } },
      delete: [],
    });
    // The version is the block's as the draft holds it; the revision's main
    // part is empty: a save never reads main.
    expect(saved.result.versions.Home).toBe(
      gitBlobSha(serializeBlock({ path: "/", title: "b" })),
    );
    const etag = (await drafts.load(REF))!.etag!.replaceAll('"', "");
    expect(saved.result.revision).toBe(`~${etag}`);
  });

  it("a block the draft doesn't hold is guarded by null, even when main has it", async () => {
    const { drafts } = setup();
    // Home is on main, not in the draft: "must not exist in the draft yet".
    const first = await save(drafts, {
      set: { Home: { path: "/", title: "draft" } },
      ifMatch: { Home: null },
    });
    expect(first.error).toBeUndefined();
    // Now it is in the draft: a second "must not exist" is a Conflict...
    const stale = await save(drafts, {
      set: { Home: { path: "/", title: "other" } },
      ifMatch: { Home: null },
    });
    expect(stale.error).toMatchObject({
      data: {
        entries: {
          Home: { expected: null, actual: first.result.versions.Home },
        },
      },
    });
    // ...and the draft's version is the guard that holds.
    const next = await save(drafts, {
      set: { Home: { path: "/", title: "mine" } },
      ifMatch: { Home: first.result.versions.Home },
    });
    expect(next.error).toBeUndefined();
    expect((await drafts.load(REF))?.body.set.Home).toEqual({
      path: "/",
      title: "mine",
    });
  });

  it("a version the draft doesn't hold is a Conflict (someone published or discarded it)", async () => {
    const { drafts } = setup();
    const saved = await save(drafts, {
      set: { Footer: { links: [] } },
      ifMatch: { Footer: "an-old-version" },
    });
    expect(saved.error).toMatchObject({
      data: {
        entries: { Footer: { expected: "an-old-version", actual: null } },
      },
    });
    expect(await drafts.load(REF)).toBeNull();
  });

  it("deletes a block only main has, guarded or not, into the draft's delete", async () => {
    const { drafts } = setup();
    const guarded = await save(drafts, {
      delete: ["Footer"],
      ifMatch: { Footer: null },
    });
    expect(guarded.error).toBeUndefined();
    expect(guarded.result.versions).toEqual({ Footer: null });
    expect((await drafts.load(REF))?.body).toEqual({
      set: {},
      delete: ["Footer"],
    });
    await save(drafts, { delete: ["Home"] });
    expect((await drafts.load(REF))?.body.delete).toEqual(["Footer", "Home"]);
    // A delete guarded by a version the draft doesn't hold writes nothing.
    const stale = await save(drafts, {
      delete: ["Other"],
      ifMatch: { Other: "v1" },
    });
    expect(stale.error?.data?.entries?.Other).toEqual({
      expected: "v1",
      actual: null,
    });
    expect((await drafts.load(REF))?.body.delete).toEqual(["Footer", "Home"]);
  });

  it("a rename (set the new name, delete the old) lands in one write", async () => {
    const { drafts } = setup();
    const saved = await save(drafts, {
      set: { Bottom: { links: [] } },
      delete: ["Footer"],
      ifMatch: { Bottom: null, Footer: null },
    });
    expect(saved.error).toBeUndefined();
    expect((await drafts.load(REF))?.body).toEqual({
      set: { Bottom: { links: [] } },
      delete: ["Footer"],
    });
  });

  it("reads nothing but the draft: no repository at all", async () => {
    const delivery = memoryDeliveryStore();
    const drafts = createDraftStore({ kv: memoryKv(), store: delivery.store });
    const saved = await save(drafts, { set: { A: { v: 1 } } });
    expect(saved.error).toBeUndefined();
    expect(delivery.log).toEqual([
      expect.stringMatching(/^put sites\/acme\/drafts\//),
    ]);
  });

  it("two saves of different blocks on two API processes at once both land", async () => {
    const { delivery } = setup();
    const kv = memoryKv();
    const one = createDraftStore({ kv, store: delivery.store });
    await save(one, { set: { Home: { path: "/", t: 0 } } });
    const held = heldPuts(delivery.store);
    const { createDraftStore: createOther } = await otherApiProcess();
    const two = createOther({ kv, store: held.store });
    held.hold();
    const campaigns = save(two, {
      set: { campaigns: { start: "2027" } },
      ifMatch: { campaigns: null },
    });
    await held.atPut;
    const home = await save(one, { set: { Home: { path: "/", t: 1 } } });
    held.release();
    expect(home.error).toBeUndefined();
    expect((await campaigns).error).toBeUndefined();
    expect((await one.load(REF))?.body.set).toEqual({
      Home: { path: "/", t: 1 },
      campaigns: { start: "2027" },
    });
  });

  it("the same block from two processes at once: a guarded one is a Conflict, never an overwrite", async () => {
    const { delivery } = setup();
    const kv = memoryKv();
    const one = createDraftStore({ kv, store: delivery.store });
    const first = await save(one, { set: { Home: { path: "/", t: 0 } } });
    const held = heldPuts(delivery.store);
    const { createDraftStore: createOther } = await otherApiProcess();
    const two = createOther({ kv, store: held.store });
    held.hold();
    const mine = save(two, {
      set: { Home: { path: "/", t: "mine" } },
      ifMatch: { Home: first.result.versions.Home },
    });
    await held.atPut;
    const theirs = await save(one, {
      set: { Home: { path: "/", t: "theirs" } },
      ifMatch: { Home: first.result.versions.Home },
    });
    held.release();
    expect(theirs.error).toBeUndefined();
    expect((await mine).error?.data?.entries?.Home).toEqual({
      expected: first.result.versions.Home,
      actual: theirs.result.versions.Home,
    });
    expect((await one.load(REF))?.body.set.Home).toEqual({
      path: "/",
      t: "theirs",
    });
  });

  it("the layered read lists every draft name, main's content or not", async () => {
    const { drafts, storage } = setup();
    await save(drafts, {
      set: { Home: { path: "/", title: "main" }, New: { v: 1 } },
      delete: ["Footer", "Gone"],
    });
    const listed = await call(storage, "changes.list");
    // Gone isn't on main: its delete hides nothing.
    expect(Object.keys(listed.result.changes)).toEqual([
      "Footer",
      "Home",
      "New",
    ]);
    expect(listed.result.changes.Home.version).toBe(
      listed.result.changes.Home.baseVersion,
    );
  });
});
