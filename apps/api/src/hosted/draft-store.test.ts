import { describe, expect, test } from "bun:test";
import { memoryDeliveryStore, memoryKv } from "./hosted-test-helpers";
import { deliveryKeys, newDraftSlug } from "./delivery-store";
import {
  createDraftStore,
  heldDraftEdits,
  stampDraftEdits,
} from "./draft-store";

const T0 = "2026-10-16T12:00:00.000Z";
const T1 = "2026-10-16T12:05:00.000Z";

describe("stampDraftEdits", () => {
  test("a changed name is stamped; an untouched one keeps its stamp", () => {
    expect(
      stampDraftEdits(
        { home: { userId: "ana", at: T0 }, header: { userId: "ana", at: T0 } },
        { set: { home: { a: 1 }, header: { b: 1 } }, delete: [] },
        { set: { home: { a: 2 }, header: { b: 1 } }, delete: [] },
        "bob",
        T1,
      ),
    ).toEqual({
      home: { userId: "bob", at: T1 },
      header: { userId: "ana", at: T0 },
    });
  });

  test("a new deletion is stamped; a dropped name loses its stamp", () => {
    expect(
      stampDraftEdits(
        { home: { userId: "ana", at: T0 } },
        { set: { home: {} }, delete: [] },
        { set: {}, delete: ["footer"] },
        "bob",
        T1,
      ),
    ).toEqual({ footer: { userId: "bob", at: T1 } });
  });

  test("a change by nobody known drops the old stamp instead of keeping a wrong one", () => {
    expect(
      stampDraftEdits(
        { home: { userId: "ana", at: T0 } },
        { set: { home: { a: 1 } }, delete: [] },
        { set: { home: { a: 2 } }, delete: [] },
        null,
        T1,
      ),
    ).toEqual({});
  });

  test("a name like __proto__ stays an entry", () => {
    const edits = stampDraftEdits(
      {},
      { set: {}, delete: [] },
      JSON.parse('{"set":{"__proto__":{"a":1}},"delete":[]}'),
      "bob",
      T1,
    );
    expect(Object.keys(edits)).toEqual(["__proto__"]);
  });
});

describe("heldDraftEdits", () => {
  test("every name the draft holds, null when not recorded; nothing it doesn't hold", () => {
    expect(
      heldDraftEdits(
        { set: { home: {}, header: {} }, delete: ["footer"] },
        {
          home: { userId: "ana", at: T0 },
          gone: { userId: "bob", at: T1 },
        },
      ),
    ).toEqual({ home: { userId: "ana", at: T0 }, header: null, footer: null });
    expect(heldDraftEdits(null, {})).toEqual({});
  });
});

describe("createDraftStore edits", () => {
  const ref = {
    organizationId: "org",
    virtualMcpId: "p1",
    branch: "main",
    site: "acme",
  };

  test("each save records who changed which names next to the draft, never in it", async () => {
    const kv = memoryKv();
    const delivery = memoryDeliveryStore();
    const drafts = createDraftStore({ kv, store: delivery.store });
    await drafts.update({ ...ref, editor: "ana" }, (body) => ({
      ...body,
      set: { ...body.set, home: { title: "A" }, header: { x: 1 } },
    }));
    const saved = await drafts.update({ ...ref, editor: "bob" }, (body) => ({
      ...body,
      set: { ...body.set, home: { title: "B" } },
    }));
    const edits = await drafts.edits(ref);
    expect(edits.home?.userId).toBe("bob");
    expect(edits.header?.userId).toBe("ana");
    // The draft the SDK reads stays exactly { set, delete }.
    const draft = delivery.objects.get(deliveryKeys.draft("acme", saved.slug));
    expect(JSON.parse(draft!.text)).toEqual({
      set: { home: { title: "B" }, header: { x: 1 } },
      delete: [],
    });
    // Ids and times only, public next to it.
    const side = delivery.objects.get(
      deliveryKeys.draftEdits("acme", saved.slug),
    );
    expect(JSON.parse(side!.text)).toEqual({ edits });
    expect(Object.keys(edits.home!).sort()).toEqual(["at", "userId"]);
    // Publishing (remove) takes both away.
    await drafts.remove(ref);
    expect(delivery.objects.size).toBe(0);
    expect(await drafts.edits(ref)).toEqual({});
  });

  test("a draft saved before edits were kept loads with none", async () => {
    const kv = memoryKv();
    const delivery = memoryDeliveryStore();
    const slug = newDraftSlug();
    await kv.set("org", "v8-draft:p1:main", { slug });
    await delivery.store.putJson(
      deliveryKeys.draft("acme", slug),
      { set: { home: {} }, delete: [] },
      "no-store",
    );
    const drafts = createDraftStore({ kv, store: delivery.store });
    expect(await drafts.edits(ref)).toEqual({});
  });
});
