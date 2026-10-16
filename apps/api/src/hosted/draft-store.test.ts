import { describe, expect, test } from "bun:test";
import { memoryDeliveryStore, memoryKv } from "./hosted-test-helpers";
import { deliveryKeys, newDraftSlug } from "./delivery-store";
import { createDraftStore, stampDraftEdits } from "./draft-store";

const T0 = "2026-10-16T12:00:00.000Z";
const T1 = "2026-10-16T12:05:00.000Z";

describe("stampDraftEdits", () => {
  test("a changed name is stamped; an untouched one keeps its stamp", () => {
    expect(
      stampDraftEdits(
        { home: { by: "ana", at: T0 }, header: { by: "ana", at: T0 } },
        { set: { home: { a: 1 }, header: { b: 1 } }, delete: [] },
        { set: { home: { a: 2 }, header: { b: 1 } }, delete: [] },
        "bob",
        T1,
      ),
    ).toEqual({ home: { by: "bob", at: T1 }, header: { by: "ana", at: T0 } });
  });

  test("a new deletion is stamped; a dropped name loses its stamp", () => {
    expect(
      stampDraftEdits(
        { home: { by: "ana", at: T0 } },
        { set: { home: {} }, delete: [] },
        { set: {}, delete: ["footer"] },
        "bob",
        T1,
      ),
    ).toEqual({ footer: { by: "bob", at: T1 } });
  });

  test("a change by nobody known drops the old stamp instead of keeping a wrong one", () => {
    expect(
      stampDraftEdits(
        { home: { by: "ana", at: T0 } },
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

describe("createDraftStore edits", () => {
  const ref = {
    organizationId: "org",
    virtualMcpId: "p1",
    branch: "main",
    site: "acme",
  };

  test("each save records who changed which names, in the KV, not in the draft object", async () => {
    const kv = memoryKv();
    const delivery = memoryDeliveryStore();
    const drafts = createDraftStore({ kv, store: delivery.store });
    await drafts.update({ ...ref, editor: "ana" }, (body) => ({
      ...body,
      set: { ...body.set, home: { title: "A" }, header: { x: 1 } },
    }));
    await drafts.update({ ...ref, editor: "bob" }, (body) => ({
      ...body,
      set: { ...body.set, home: { title: "B" } },
    }));
    const loaded = await drafts.load(ref);
    expect(loaded?.edits.home?.by).toBe("bob");
    expect(loaded?.edits.header?.by).toBe("ana");
    const [object] = [...delivery.objects.values()];
    expect(JSON.parse(object!.text)).toEqual({
      set: { home: { title: "B" }, header: { x: 1 } },
      delete: [],
    });
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
    expect((await drafts.load(ref))?.edits).toEqual({});
  });
});
