import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  BaseCollectionEntitySchema,
  createCollectionBindings,
} from "../src/well-known/collections";

const EntitySchema = BaseCollectionEntitySchema.extend({
  email: z.string(),
});

describe("createCollectionBindings", () => {
  it("includes all five CRUD tools by default, uppercased and namespaced", () => {
    const bindings = createCollectionBindings("users", EntitySchema);

    expect(bindings.map((b) => b.name)).toEqual([
      "COLLECTION_USERS_LIST",
      "COLLECTION_USERS_GET",
      "COLLECTION_USERS_CREATE",
      "COLLECTION_USERS_UPDATE",
      "COLLECTION_USERS_DELETE",
    ]);
  });

  it("marks mutation tools as optional but not LIST/GET", () => {
    const bindings = createCollectionBindings("users", EntitySchema);
    const byName = Object.fromEntries(bindings.map((b) => [b.name, b]));

    expect(byName.COLLECTION_USERS_LIST).not.toHaveProperty("opt");
    expect(byName.COLLECTION_USERS_GET).not.toHaveProperty("opt");
    expect(byName.COLLECTION_USERS_CREATE).toHaveProperty("opt", true);
    expect(byName.COLLECTION_USERS_UPDATE).toHaveProperty("opt", true);
    expect(byName.COLLECTION_USERS_DELETE).toHaveProperty("opt", true);
  });

  it("excludes mutation tools when readOnly is set", () => {
    const bindings = createCollectionBindings("products", EntitySchema, {
      readOnly: true,
    });

    expect(bindings.map((b) => b.name)).toEqual([
      "COLLECTION_PRODUCTS_LIST",
      "COLLECTION_PRODUCTS_GET",
    ]);
  });

  it("uppercases mixed-case collection names in tool names", () => {
    const bindings = createCollectionBindings("orderItems", EntitySchema);
    expect(bindings[0].name).toBe("COLLECTION_ORDERITEMS_LIST");
  });
});
