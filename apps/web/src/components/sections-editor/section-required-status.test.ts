import { describe, expect, test } from "bun:test";
import { hasMissingRequiredField } from "./section-required-status";
import { hideArrayItem } from "./array-item-hidden";
import type { SchemaProperty } from "./resolve-schema";

const obj = (
  properties: Record<string, SchemaProperty>,
  required?: string[],
): SchemaProperty => ({ type: "object", properties, required });

describe("hasMissingRequiredField", () => {
  test("no schema or no properties → false", () => {
    expect(hasMissingRequiredField(null, {})).toBe(false);
    expect(hasMissingRequiredField({ type: "string" }, "x")).toBe(false);
  });

  test("required leaf empty → true, filled → false", () => {
    const schema = obj({ title: { type: "string" } }, ["title"]);
    expect(hasMissingRequiredField(schema, {})).toBe(true);
    expect(hasMissingRequiredField(schema, { title: "" })).toBe(true);
    expect(hasMissingRequiredField(schema, { title: "  " })).toBe(true);
    expect(hasMissingRequiredField(schema, { title: "hi" })).toBe(false);
  });

  test("optional empty prop → false", () => {
    const schema = obj({ subtitle: { type: "string" } });
    expect(hasMissingRequiredField(schema, {})).toBe(false);
  });

  test("falsy-but-valid required values are not missing", () => {
    const schema = obj(
      { count: { type: "number" }, flag: { type: "boolean" } },
      ["count", "flag"],
    );
    expect(hasMissingRequiredField(schema, { count: 0, flag: false })).toBe(
      false,
    );
  });

  test("hidden or internal required props are ignored", () => {
    const schema = obj(
      {
        __resolveType: { type: "string" },
        secret: { type: "string", hidden: true },
      },
      ["__resolveType", "secret"],
    );
    expect(hasMissingRequiredField(schema, {})).toBe(false);
  });

  test("recurses into a present nested object with an empty required child", () => {
    const schema = obj({
      cta: obj({ href: { type: "string" } }, ["href"]),
    });
    expect(hasMissingRequiredField(schema, { cta: {} })).toBe(true);
    expect(hasMissingRequiredField(schema, { cta: { href: "/x" } })).toBe(
      false,
    );
  });

  test("recurses into plain-object array items with an empty required field", () => {
    const schema = obj({
      items: {
        type: "array",
        items: obj({ label: { type: "string" } }, ["label"]),
      },
    });
    expect(hasMissingRequiredField(schema, { items: [{ label: "ok" }] })).toBe(
      false,
    );
    expect(hasMissingRequiredField(schema, { items: [{}] })).toBe(true);
    expect(
      hasMissingRequiredField(schema, {
        items: [{ label: "ok" }, { label: "" }],
      }),
    ).toBe(true);
  });

  test("a hidden array item is validated by its unwrapped inner value", () => {
    const schema = obj({
      tabs: {
        type: "array",
        items: obj({ source: { type: "string" } }, ["source"]),
      },
    });
    // Complete inner value: the wrapper's {__resolveType, variants} shape must not read as an empty required `source`.
    expect(
      hasMissingRequiredField(schema, {
        tabs: [hideArrayItem({ source: "x" })],
      }),
    ).toBe(false);
    // Genuinely-incomplete inner value is still flagged, like the per-row marker on hidden rows.
    expect(hasMissingRequiredField(schema, { tabs: [hideArrayItem({})] })).toBe(
      true,
    );
  });

  test("skips array items that are still block wrappers after unwrap", () => {
    const schema = obj({
      tabs: {
        type: "array",
        items: obj({ source: { type: "string" } }, ["source"]),
      },
    });
    expect(
      hasMissingRequiredField(schema, {
        tabs: [{ __resolveType: "site/loaders/Tab.ts" }],
      }),
    ).toBe(false);
  });

  test("skips block-ref/section arrays whose items have no plain properties", () => {
    const schema = obj({
      sections: {
        type: "array",
        items: { type: "block-ref", anyOfRefs: [] },
      },
    });
    expect(
      hasMissingRequiredField(schema, {
        sections: [{ __resolveType: "site/sections/Foo.tsx" }],
      }),
    ).toBe(false);
  });
});
