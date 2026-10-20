import { describe, expect, test } from "bun:test";
import { deliveryKeys } from "./delivery-store";
import { DRAFT_EDITORS_META } from "./draft-editors";
import { createDraftStore } from "./draft-store";
import { memoryDeliveryStore, memoryKv } from "./hosted-test-helpers";

const ref = {
  organizationId: "org",
  virtualMcpId: "p1",
  branch: "main",
  site: "acme",
};

describe("createDraftStore: who changed what, in the object's metadata", () => {
  test("each save carries the editors forward in the draft object's metadata, never in its JSON", async () => {
    const delivery = memoryDeliveryStore();
    const drafts = createDraftStore({ kv: memoryKv(), store: delivery.store });
    await drafts.update({ ...ref, editor: "ana" }, (body) => ({
      ...body,
      set: { ...body.set, home: { title: "A" }, header: { x: 1 } },
    }));
    const saved = await drafts.update({ ...ref, editor: "bob" }, (body) => ({
      ...body,
      set: { ...body.set, home: { title: "B" } },
    }));
    const loaded = await drafts.load(ref);
    expect(loaded?.editors.home?.userId).toBe("bob");
    expect(loaded?.editors.header?.userId).toBe("ana");
    expect(saved.editors).toEqual(loaded!.editors);

    // One object: exactly { set, delete } as JSON, the editors as metadata.
    expect([...delivery.objects.keys()]).toEqual([
      deliveryKeys.draft("acme", saved.slug),
    ]);
    const object = delivery.objects.get(
      deliveryKeys.draft("acme", saved.slug),
    )!;
    expect(JSON.parse(object.text)).toEqual({
      set: { home: { title: "B" }, header: { x: 1 } },
      delete: [],
    });
    expect(object.text).not.toMatch(/ana|bob|__meta|edited/);
    expect(Object.keys(object.metadata ?? {})).toEqual([DRAFT_EDITORS_META]);
    // Only puts and deletes are logged: two saves, two puts, nothing else.
    expect(delivery.log).toEqual([
      `put ${deliveryKeys.draft("acme", saved.slug)}`,
      `put ${deliveryKeys.draft("acme", saved.slug)}`,
    ]);
  });

  test("a discard drops the discarded name's editor; publishing removes the object", async () => {
    const delivery = memoryDeliveryStore();
    const drafts = createDraftStore({ kv: memoryKv(), store: delivery.store });
    await drafts.update({ ...ref, editor: "ana" }, () => ({
      set: { home: { a: 1 }, header: { b: 1 } },
      delete: [],
    }));
    await drafts.update({ ...ref, editor: "bob" }, (body) => ({
      set: { home: body.set.home },
      delete: [],
    }));
    expect(Object.keys((await drafts.load(ref))!.editors)).toEqual(["home"]);
    expect((await drafts.load(ref))!.editors.home?.userId).toBe("ana");
    await drafts.remove(ref);
    expect(delivery.objects.size).toBe(0);
  });

  test("a draft written without metadata loads with no editors", async () => {
    const delivery = memoryDeliveryStore();
    const kv = memoryKv();
    const drafts = createDraftStore({ kv, store: delivery.store });
    const { slug } = await drafts.update(ref, () => ({
      set: { a: {} },
      delete: [],
    }));
    await delivery.store.putJson(
      deliveryKeys.draft("acme", slug),
      { set: { a: {} }, delete: [] },
      "no-cache",
    );
    expect((await drafts.load(ref))?.editors).toEqual({});
  });
});
