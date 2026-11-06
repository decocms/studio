import { describe, expect, test } from "bun:test";
import {
  applySchemaDefaults,
  unseedSchemaDefaults,
  withDefaultsForNew,
} from "./schema-defaults";
import type { LiveMeta, SchemaProperty } from "./resolve-schema";

const schema = (
  properties: Record<string, SchemaProperty>,
): SchemaProperty => ({
  type: "object",
  properties,
});

const menuItem = schema({
  label: { type: "string" },
  display: { type: "boolean", default: true },
});

describe("applySchemaDefaults", () => {
  test("fills a missing explicit @default", () => {
    expect(
      applySchemaDefaults(
        schema({ display: { type: "boolean", default: true } }),
        { title: "Hi" },
      ),
    ).toEqual({ title: "Hi", display: true });
  });

  test('keeps explicit values, including false, "" and 0', () => {
    const value = { label: "", count: 0, on: false };
    const result = applySchemaDefaults(
      schema({
        label: { type: "string", default: "Hello" },
        count: { type: "number", default: 5 },
        on: { type: "boolean", default: true },
      }),
      value,
    );
    expect(result).toBe(value);
  });

  test("leaves props without a default, or with a null default, missing", () => {
    const value = {};
    const result = applySchemaDefaults(
      schema({
        title: { type: "string" },
        on: { type: "boolean" },
        image: { type: "string", format: "image-uri", default: null },
      }),
      value,
    );
    expect(result).toBe(value);
  });

  test("fills defaults inside existing array items", () => {
    const result = applySchemaDefaults(
      schema({ children: { type: "array", items: menuItem } }),
      {
        children: [{ label: "A" }, { label: "B", display: false }],
      },
    );
    expect(result).toEqual({
      children: [
        { label: "A", display: true },
        { label: "B", display: false },
      ],
    });
  });

  test("fills defaults in arrays nested inside array items", () => {
    const item: SchemaProperty = schema({
      display: { type: "boolean", default: true },
      children: { type: "array", items: menuItem },
    });
    const result = applySchemaDefaults(
      schema({ items: { type: "array", items: item } }),
      { items: [{ children: [{ label: "A" }] }] },
    );
    expect(result).toEqual({
      items: [{ display: true, children: [{ label: "A", display: true }] }],
    });
  });

  test("fills defaults in existing and missing nested objects", () => {
    const style = {
      type: "object",
      properties: {
        visible: { type: "boolean", default: true },
        color: { type: "string" },
      },
    } satisfies SchemaProperty;
    expect(
      applySchemaDefaults(schema({ style }), { style: { color: "red" } }),
    ).toEqual({ style: { color: "red", visible: true } });
    expect(
      applySchemaDefaults(
        schema({
          style,
          empty: { type: "object", properties: { c: { type: "string" } } },
        }),
        {},
      ),
    ).toEqual({ style: { visible: true } });
  });

  test("copies object and array defaults", () => {
    const s = schema({
      tags: { type: "array", default: ["a"] },
      size: { type: "object", default: { w: 1 } },
    });
    const result = applySchemaDefaults(s, {}) as Record<string, unknown>;
    expect(result).toEqual({ tags: ["a"], size: { w: 1 } });
    expect(result.tags).not.toBe(s.properties?.tags?.default);
    expect(result.size).not.toBe(s.properties?.size?.default);
  });

  test("fills nested blocks from their own schema, and leaves saved-block references alone", () => {
    const meta: LiveMeta = {
      manifest: {
        blocks: {
          sections: {
            "site/sections/Banner.tsx": {
              type: "object",
              properties: { show: { type: "boolean", default: true } },
            },
          },
        },
      },
    } as unknown as LiveMeta;
    const savedRef = { __resolveType: "Banner - Home" };
    const result = applySchemaDefaults(
      schema({ sections: { type: "array", items: { type: "block-ref" } } }),
      {
        sections: [{ __resolveType: "site/sections/Banner.tsx" }, savedRef],
      },
      meta,
    ) as { sections: unknown[] };
    expect(result.sections).toEqual([
      { __resolveType: "site/sections/Banner.tsx", show: true },
      savedRef,
    ]);
    expect(result.sections[1]).toBe(savedRef);
  });

  test("fills the inline-union branch selected by its discriminators", () => {
    const union: SchemaProperty = {
      type: "inline-union",
      inlineUnionBranches: [
        {
          title: "Recent orders",
          discriminators: { type: "recent" },
          schema: schema({
            type: { type: "string" },
            months: { type: "number", default: 3 },
          }),
        },
        {
          title: "Any",
          schema: schema({ other: { type: "number", default: 1 } }),
        },
      ],
    };
    expect(applySchemaDefaults(union, { type: "recent" })).toEqual({
      type: "recent",
      months: 3,
    });
    const unmatched = { type: "unknown" };
    expect(applySchemaDefaults(union, unmatched)).toBe(unmatched);
  });

  test("leaves nested blocks alone without meta", () => {
    const value = { banner: { __resolveType: "site/sections/Banner.tsx" } };
    expect(
      applySchemaDefaults(
        schema({
          banner: {
            type: "object",
            properties: { show: { type: "boolean", default: true } },
          },
        }),
        value,
      ),
    ).toBe(value);
  });

  test("is idempotent: a filled value is returned as is", () => {
    const s = schema({
      children: { type: "array", items: menuItem },
      size: {
        type: "object",
        default: {},
        properties: { w: { type: "number", default: 1 } },
      },
    });
    const once = applySchemaDefaults(s, { children: [{}] });
    expect(once).toEqual({ children: [{ display: true }], size: { w: 1 } });
    expect(applySchemaDefaults(s, once)).toBe(once);
  });

  test("ignores __-prefixed and @type schema keys", () => {
    expect(
      applySchemaDefaults(
        schema({
          "@type": { type: "string", default: "X" },
          __hint: { type: "string", default: "Y" },
          real: { type: "string", default: "Z" },
        }),
        {},
      ),
    ).toEqual({ real: "Z" });
  });

  test("returns non-object values and schemas without properties untouched", () => {
    const s = schema({ display: { type: "boolean", default: true } });
    expect(applySchemaDefaults(s, null)).toBeNull();
    const list = [1, 2];
    expect(applySchemaDefaults(s, list)).toBe(list);
    const value = { a: 1 };
    expect(applySchemaDefaults({ type: "object" }, value)).toBe(value);
    expect(applySchemaDefaults(null, value)).toBe(value);
  });
});

const bannerMeta = {
  manifest: {
    blocks: {
      sections: {
        "site/sections/Banner.tsx": {
          type: "object",
          properties: {
            title: { type: "string" },
            show: { type: "boolean", default: true },
          },
        },
      },
    },
  },
} as unknown as LiveMeta;

type Loose = Record<string, unknown>;

/** What the form emits after `change` edits the value it was built from. */
function formEdit<T extends Record<string, unknown>>(
  s: SchemaProperty,
  value: T,
  change: (seeded: T) => T,
  meta?: LiveMeta,
) {
  const seeded = applySchemaDefaults(s, value, meta) as T;
  return {
    seeded,
    result: unseedSchemaDefaults(s, value, seeded, change(seeded), meta),
  };
}

describe("unseedSchemaDefaults", () => {
  const card = schema({
    title: { type: "string", default: "Hello" },
    subtitle: { type: "string" },
    show: { type: "boolean", default: true },
  });

  test("gives the stored value back when the form emitted what it showed", () => {
    const value = { subtitle: "Old" };
    const seeded = applySchemaDefaults(card, value);
    expect(unseedSchemaDefaults(card, value, seeded, seeded)).toBe(value);
    expect(
      unseedSchemaDefaults(card, value, seeded, structuredClone(seeded)),
    ).toBe(value);
  });

  test("editing one field writes only that field, never the shown defaults", () => {
    const { result } = formEdit(card, { subtitle: "Old" }, (s) => ({
      ...s,
      subtitle: "New",
    }));
    expect(result).toEqual({ subtitle: "New" });
  });

  test("a defaulted field the user changes is written", () => {
    const { result } = formEdit(card, { subtitle: "Old" }, (s) => ({
      ...s,
      title: "Hi",
    }));
    expect(result).toEqual({ subtitle: "Old", title: "Hi" });
  });

  test("a stored value equal to its default stays", () => {
    const { result } = formEdit(card, { show: true, subtitle: "Old" }, (s) => ({
      ...s,
      subtitle: "New",
    }));
    expect(result).toEqual({ show: true, subtitle: "New" });
  });

  test("an object materialized for its defaulted children stays absent; editing inside it creates it with its defaults", () => {
    const s = schema({
      title: { type: "string" },
      cta: schema({
        label: { type: "string" },
        target: { type: "string", default: "_self" },
      }),
    });
    expect(
      formEdit(s, {}, (seeded) => ({ ...seeded, title: "T" })).result,
    ).toEqual({ title: "T" });
    expect(
      formEdit<Loose>(s, {}, (seeded) => ({
        ...seeded,
        cta: { ...(seeded.cta as object), label: "Go" },
      })).result,
    ).toEqual({ cta: { label: "Go", target: "_self" } });
  });

  test("a default literal the user changes is written whole", () => {
    const s = schema({ size: { type: "object", default: { w: 1, h: 2 } } });
    const { result } = formEdit<Loose>(s, {}, (seeded) => ({
      ...seeded,
      size: { ...(seeded.size as object), w: 3 },
    }));
    expect(result).toEqual({ size: { w: 3, h: 2 } });
  });

  describe("arrays", () => {
    const list = schema({ children: { type: "array", items: menuItem } });
    type List = { children: Array<Record<string, unknown>> };
    const value: List = { children: [{ label: "A" }, { label: "B" }] };

    test("editing an item leaves the others as stored", () => {
      const { result } = formEdit(list, value, (s) => ({
        children: s.children.map((item, i) =>
          i === 1 ? { ...item, label: "B2" } : item,
        ),
      }));
      expect(result).toEqual({ children: [{ label: "A" }, { label: "B2" }] });
    });

    test("a reorder or a removal keeps the stored items", () => {
      expect(
        formEdit(list, value, (s) => ({
          children: [s.children[1]!, s.children[0]!],
        })).result,
      ).toEqual({ children: [{ label: "B" }, { label: "A" }] });
      expect(
        formEdit(list, value, (s) => ({ children: s.children.slice(1) }))
          .result,
      ).toEqual({ children: [{ label: "B" }] });
    });

    test("a new item keeps the defaults it was created with", () => {
      const { result } = formEdit(list, value, (s) => ({
        children: [...s.children, { label: "C", display: true }],
      }));
      expect(result).toEqual({
        children: [
          { label: "A" },
          { label: "B" },
          { label: "C", display: true },
        ],
      });
    });
  });

  test("a nested block keeps its stored props, and an edit inside it writes only that edit", () => {
    const s = schema({
      heading: { type: "string" },
      sections: { type: "array", items: { type: "block-ref" } },
    });
    const value = {
      heading: "Old",
      sections: [{ __resolveType: "site/sections/Banner.tsx" }],
    };
    expect(
      formEdit(
        s,
        value,
        (seeded) => ({ ...seeded, heading: "New" }),
        bannerMeta,
      ).result,
    ).toEqual({ ...value, heading: "New" });
    expect(
      formEdit<Loose>(
        s,
        value,
        (seeded) => ({
          ...seeded,
          sections: [
            { ...((seeded.sections as unknown[])[0] as object), title: "Hi" },
          ],
        }),
        bannerMeta,
      ).result,
    ).toEqual({
      heading: "Old",
      sections: [{ __resolveType: "site/sections/Banner.tsx", title: "Hi" }],
    });
  });

  test("a switched block is kept as the form built it", () => {
    const s = schema({ link: { type: "block-ref" } });
    const { result } = formEdit<Loose>(
      s,
      { link: { __resolveType: "site/sections/Old.tsx", a: 1 } },
      (seeded) => ({
        ...seeded,
        link: { __resolveType: "site/sections/Banner.tsx", show: true },
      }),
      bannerMeta,
    );
    expect(result).toEqual({
      link: { __resolveType: "site/sections/Banner.tsx", show: true },
    });
  });
});

describe("withDefaultsForNew", () => {
  test("fills a new block from its own schema, and leaves saved references alone", () => {
    expect(
      withDefaultsForNew(
        { type: "block-ref" },
        { __resolveType: "site/sections/Banner.tsx" },
        bannerMeta,
      ),
    ).toEqual({ __resolveType: "site/sections/Banner.tsx", show: true });
    const savedRef = { __resolveType: "Banner - Home" };
    expect(
      withDefaultsForNew({ type: "block-ref" }, savedRef, bannerMeta),
    ).toBe(savedRef);
  });

  test("fills a new object item from the item schema", () => {
    expect(withDefaultsForNew(menuItem, {})).toEqual({ display: true });
  });
});
