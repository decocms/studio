import { describe, expect, test } from "bun:test";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import {
  blogCustomFieldsSchema,
  customFieldsSchema,
  KNOWN_CATEGORY_FIELDS,
  KNOWN_POST_FIELDS,
  resolveBlogRecordSchema,
} from "./blog-schema";
import {
  emptyBlogPayload,
  missingCategoryFields,
  missingPostFields,
  type BlogKind,
} from "./blog-data";

/**
 * A meta shaped the way deco emits one: the manifest entry `$ref`s a wrapper
 * def that is `allOf: [props]` plus the `__resolveType` const.
 */
function metaFor(
  resolveType: string,
  props: Record<string, unknown>,
): LiveMeta {
  return {
    manifest: {
      blocks: { loaders: { [resolveType]: { $ref: "#/definitions/Wrapper" } } },
    },
    schema: {
      definitions: {
        Wrapper: {
          allOf: [{ $ref: "#/definitions/Props" }],
          properties: {
            __resolveType: { type: "string", enum: [resolveType] },
          },
        },
        Props: { type: "object", ...props },
      },
    },
  };
}

const AUTHOR_PROPS = {
  properties: {
    author: {
      type: "object",
      properties: {
        name: { type: "string", title: "Name" },
        email: { type: "string", title: "Email" },
      },
    },
  },
};

describe("resolveBlogRecordSchema", () => {
  test("unwraps the loader's wrapper key into the record's own schema", () => {
    const schema = resolveBlogRecordSchema(
      "authors",
      metaFor("blog/loaders/Author.ts", AUTHOR_PROPS),
    );
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual([
      "email",
      "name",
    ]);
  });

  test("picks up a field the site added to the type", () => {
    const meta = metaFor("blog/loaders/Author.ts", {
      properties: {
        author: {
          type: "object",
          properties: {
            name: { type: "string" },
            handle: { type: "string", title: "Handle", description: "@name" },
          },
        },
      },
    });
    const handle = resolveBlogRecordSchema("authors", meta)?.properties?.handle;
    expect(handle?.title).toBe("Handle");
    expect(handle?.description).toBe("@name");
  });

  test("null without meta", () => {
    expect(resolveBlogRecordSchema("authors", undefined)).toBeNull();
  });

  test("null when the loader is absent from the site", () => {
    const meta = metaFor("blog/loaders/Something.ts", AUTHOR_PROPS);
    expect(resolveBlogRecordSchema("authors", meta)).toBeNull();
  });

  /**
   * The guard that matters: a fork whose loader takes query props instead of
   * the record must fall back, never render those inputs as record fields.
   */
  test("null when the props carry no wrapper key", () => {
    const meta = metaFor("blog/loaders/Author.ts", {
      properties: { slug: { type: "string" }, page: { type: "number" } },
    });
    expect(resolveBlogRecordSchema("authors", meta)).toBeNull();
  });

  test("null when the wrapper key is not an object", () => {
    const meta = metaFor("blog/loaders/Author.ts", {
      properties: { author: { type: "string" } },
    });
    expect(resolveBlogRecordSchema("authors", meta)).toBeNull();
  });
});

/**
 * The shape deco actually publishes: because a record type doubles as a
 * referenceable block, the loader's wrapper prop is a union of the record
 * inline and a pointer at a saved record. Taken from content-hub's
 * `/live/_meta`, where reading only `.properties` found nothing.
 */
describe("resolveBlogRecordSchema — record published as a block-ref union", () => {
  const RT = "blog/loaders/Author.ts";
  const meta = {
    manifest: {
      blocks: { loaders: { [RT]: { $ref: "#/definitions/Wrapper" } } },
    },
    schema: {
      definitions: {
        Wrapper: {
          allOf: [{ $ref: "#/definitions/Props" }],
          properties: { __resolveType: { type: "string", enum: [RT] } },
        },
        Props: {
          type: "object",
          properties: { author: { $ref: "#/definitions/Author" } },
        },
        Author: {
          anyOf: [
            {
              type: "object",
              title: "Author",
              required: ["name"],
              properties: {
                name: { type: "string", title: "Name" },
                test: { type: ["string", "null"], title: "Test" },
              },
            },
            {
              type: "object",
              title: "Author",
              required: ["__resolveType"],
              properties: { __resolveType: { type: "string", enum: [RT] } },
            },
          ],
        },
      },
    },
  } as unknown as LiveMeta;

  test("reads the inline branch, not the saved-record pointer", () => {
    const schema = resolveBlogRecordSchema("authors", meta);
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual([
      "name",
      "test",
    ]);
  });

  test("a field the site added to the type comes through", () => {
    const rest = customFieldsSchema(
      resolveBlogRecordSchema("authors", meta),
      new Set(["name"]),
    );
    expect(Object.keys(rest?.properties ?? {})).toEqual(["test"]);
  });
});

describe("customFieldsSchema", () => {
  const schema = {
    type: "object",
    required: ["name", "handle"],
    properties: {
      name: { type: "string" },
      handle: { type: "string", title: "Handle" },
      __resolveType: { type: "string" },
      secret: { type: "string", hidden: true },
    },
  };

  test("keeps only what no bespoke field owns", () => {
    const rest = customFieldsSchema(schema, new Set(["name"]));
    expect(Object.keys(rest?.properties ?? {})).toEqual(["handle"]);
  });

  test("drops required outright — a forked field never blocks a record", () => {
    expect(
      customFieldsSchema(schema, new Set(["name"]))?.required,
    ).toBeUndefined();
  });

  test("null when every field is already covered", () => {
    expect(customFieldsSchema(schema, new Set(["name", "handle"]))).toBeNull();
  });

  test("null for a schema with no properties", () => {
    expect(customFieldsSchema(null, new Set())).toBeNull();
    expect(customFieldsSchema({ type: "string" }, new Set())).toBeNull();
  });
});

describe("blogCustomFieldsSchema", () => {
  test("surfaces a forked field and hides the known ones", () => {
    const meta = metaFor("blog/loaders/Category.ts", {
      properties: {
        category: {
          type: "object",
          properties: {
            name: { type: "string" },
            slug: { type: "string" },
            hero: { type: "string", title: "Hero" },
          },
        },
      },
    });
    const rest = blogCustomFieldsSchema(
      "categories",
      meta,
      KNOWN_CATEGORY_FIELDS,
    );
    expect(Object.keys(rest?.properties ?? {})).toEqual(["hero"]);
  });

  test("null when the schema is unusable, so the static list stands", () => {
    expect(
      blogCustomFieldsSchema("categories", undefined, KNOWN_CATEGORY_FIELDS),
    ).toBeNull();
  });
});

/**
 * Drift guards. A field Studio gives a default to, or validates, is a field
 * Studio owns — it must be in the known set, or it would render twice.
 */
describe("known-field coverage", () => {
  const known: Record<BlogKind, ReadonlySet<string>> = {
    posts: KNOWN_POST_FIELDS,
    categories: KNOWN_CATEGORY_FIELDS,
    authors: new Set(),
  };

  for (const kind of ["posts", "categories"] as const) {
    test(`every ${kind} default field is a known field`, () => {
      const unlisted = Object.keys(emptyBlogPayload(kind)).filter(
        (key) => !known[kind].has(key),
      );
      expect(unlisted).toEqual([]);
    });
  }

  test("the post body never leaks into the generic form", () => {
    expect(KNOWN_POST_FIELDS.has("sections")).toBe(true);
    expect(KNOWN_CATEGORY_FIELDS.has("sections")).toBe(true);
  });

  test("validated post fields are known fields", () => {
    expect(missingPostFields({})).not.toEqual([]);
    for (const key of ["title", "slug", "categories", "excerpt", "image"]) {
      expect(KNOWN_POST_FIELDS.has(key)).toBe(true);
    }
  });

  test("validated category fields are known fields", () => {
    expect(missingCategoryFields({})).not.toEqual([]);
    for (const key of ["name", "slug"]) {
      expect(KNOWN_CATEGORY_FIELDS.has(key)).toBe(true);
    }
  });
});
