import { expect, test } from "@playwright/experimental-ct-react";
import { FieldHarness } from "../harness/field-harness";
import { SchemaFormHarness } from "../harness/schema-form-harness";
import { readFormValue } from "../harness/ct-utils";
import type {
  LiveMeta,
  SchemaProperty,
} from "@/components/sections-editor/resolve-schema";

// ── (A) module-loader union ────────────────────────────────────────────────
// resolveTypes contain "/" → AnyOfField treats this as a module-loader union:
// no discriminator, value carries __resolveType, and the nested config is
// tucked inside a "Loader configuration" collapsible card.
const moduleLoaderUnion: SchemaProperty = {
  type: "block-ref",
  anyOfRefs: [
    {
      resolveType: "site/loaders/A.ts",
      title: "Loader A",
      schema: {
        type: "object",
        properties: { foo: { type: "string", title: "Foo" } },
      },
    },
    {
      resolveType: "site/loaders/B.ts",
      title: "Loader B",
      schema: {
        type: "object",
        properties: { bar: { type: "number", title: "Bar" } },
      },
    },
  ],
};

// ── (B) type-discriminated union ────────────────────────────────────────────
// Short resolveTypes (no "/") + discriminatorKey "type" → NOT a module loader,
// so nested props render INLINE (no collapsible), and the value carries the
// discriminator field instead of __resolveType.
const typeDiscriminatedUnion: SchemaProperty = {
  type: "block-ref",
  discriminatorKey: "type",
  anyOfRefs: [
    {
      resolveType: "image-card",
      discriminatorValue: "image-card",
      title: "Image Card",
      schema: {
        type: "object",
        properties: { src: { type: "string", title: "Src" } },
      },
    },
    {
      resolveType: "text-card",
      discriminatorValue: "text-card",
      title: "Text Card",
      schema: {
        type: "object",
        properties: { body: { type: "string", title: "Body" } },
      },
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// (A) module-loader union
// ═══════════════════════════════════════════════════════════════════════════

test("module union: combobox renders with both loader options", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <FieldHarness schema={moduleLoaderUnion} label="Source" />,
  );

  const trigger = component.getByRole("combobox");
  await expect(trigger).toBeVisible();

  await trigger.click();
  await expect(page.getByRole("option", { name: "Loader A" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Loader B" })).toBeVisible();
  await expect(page.getByRole("option")).toHaveCount(2);
});

test("module union: default selection is the first ref (Loader A)", async ({
  mount,
}) => {
  const component = await mount(
    <FieldHarness schema={moduleLoaderUnion} label="Source" />,
  );

  await expect(component.getByRole("combobox")).toHaveText("Loader A");
});

test("module union: label renders next to the combobox", async ({ mount }) => {
  const component = await mount(
    <FieldHarness schema={moduleLoaderUnion} label="Source" />,
  );

  await expect(component.getByText("Source")).toBeVisible();
});

test("module union: selecting Loader B sets __resolveType on the value", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <FieldHarness schema={moduleLoaderUnion} label="Source" />,
  );

  await component.getByRole("combobox").click();
  await page.getByRole("option", { name: "Loader B" }).click();

  // The combobox now reflects the new branch...
  await expect(component.getByRole("combobox")).toHaveText("Loader B");

  // ...and the value object carries the loader's __resolveType. Nested
  // defaults (e.g. bar: 0) may also be present, so assert the key only.
  await expect
    .poll(async () => {
      const value = (await readFormValue(component)) as Record<string, unknown>;
      return value?.__resolveType;
    })
    .toBe("site/loaders/B.ts");
});

test("module union: nested config is collapsed by default", async ({
  mount,
}) => {
  const component = await mount(
    <FieldHarness schema={moduleLoaderUnion} label="Source" />,
  );

  const configToggle = component.getByRole("button", {
    name: /loader configuration/i,
  });
  await expect(configToggle).toBeVisible();
  await expect(configToggle).toHaveAttribute("aria-expanded", "false");

  // The nested leaf is not rendered while the collapsible is closed.
  await expect(component.getByLabel("Foo")).toHaveCount(0);
});

test("module union: expanding the config reveals the nested field", async ({
  mount,
}) => {
  const component = await mount(
    <FieldHarness schema={moduleLoaderUnion} label="Source" />,
  );

  const configToggle = component.getByRole("button", {
    name: /loader configuration/i,
  });
  await configToggle.click();

  await expect(configToggle).toHaveAttribute("aria-expanded", "true");
  await expect(component.getByLabel("Foo")).toBeVisible();
});

test("module union: editing the nested leaf updates the value object", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <FieldHarness schema={moduleLoaderUnion} label="Source" />,
  );

  // Switch to Loader B (number leaf "Bar").
  await component.getByRole("combobox").click();
  await page.getByRole("option", { name: "Loader B" }).click();

  await expect
    .poll(async () => {
      const value = (await readFormValue(component)) as Record<string, unknown>;
      return value?.__resolveType;
    })
    .toBe("site/loaders/B.ts");

  // Open the collapsible config card, then edit the nested "Bar" field.
  await component
    .getByRole("button", { name: /loader configuration/i })
    .click();

  const barInput = component.getByLabel("Bar");
  await expect(barInput).toBeVisible();
  // Nested field path == `${path}.bar`; default FieldHarness path is "field".
  await expect(barInput).toHaveAttribute("id", "field.bar");

  await barInput.fill("42");

  await expect
    .poll(async () => {
      const value = (await readFormValue(component)) as Record<string, unknown>;
      return { bar: value?.bar, rt: value?.__resolveType };
    })
    .toEqual({ bar: 42, rt: "site/loaders/B.ts" });
});

test("module union: pre-populated value selects the matching branch and edits in place", async ({
  mount,
}) => {
  const component = await mount(
    <FieldHarness
      schema={moduleLoaderUnion}
      label="Source"
      initialValue={{ __resolveType: "site/loaders/A.ts", foo: "hello" }}
    />,
  );

  // The inferred branch matches the value's __resolveType (Loader A).
  await expect(component.getByRole("combobox")).toHaveText("Loader A");

  // With existing data the collapsible config is open from the start.
  const fooInput = component.getByLabel("Foo");
  await expect(fooInput).toBeVisible();
  await expect(fooInput).toHaveValue("hello");

  await fooInput.fill("world");

  await expect
    .poll(async () => {
      const value = (await readFormValue(component)) as Record<string, unknown>;
      return { foo: value?.foo, rt: value?.__resolveType };
    })
    .toEqual({ foo: "world", rt: "site/loaders/A.ts" });
});

// ═══════════════════════════════════════════════════════════════════════════
// (B) type-discriminated union
// ═══════════════════════════════════════════════════════════════════════════

test("type union: combobox renders with both discriminated options", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <FieldHarness schema={typeDiscriminatedUnion} label="Card" />,
  );

  await component.getByRole("combobox").click();
  await expect(page.getByRole("option", { name: "Image Card" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Text Card" })).toBeVisible();
  await expect(page.getByRole("option")).toHaveCount(2);
});

test("type union: default selection is the first branch (Image Card)", async ({
  mount,
}) => {
  const component = await mount(
    <FieldHarness schema={typeDiscriminatedUnion} label="Card" />,
  );

  await expect(component.getByRole("combobox")).toHaveText("Image Card");
});

test("type union: nested props render INLINE (no collapsible card)", async ({
  mount,
}) => {
  const component = await mount(
    <FieldHarness schema={typeDiscriminatedUnion} label="Card" />,
  );

  // No "Configuration"/"Loader configuration" collapsible for type unions.
  await expect(
    component.getByRole("button", { name: /configuration/i }),
  ).toHaveCount(0);

  // The first branch's leaf ("Src") is visible inline immediately.
  await expect(component.getByLabel("Src")).toBeVisible();
});

test("type union: selecting Text Card writes the discriminator into the value", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <FieldHarness schema={typeDiscriminatedUnion} label="Card" />,
  );

  await component.getByRole("combobox").click();
  await page.getByRole("option", { name: "Text Card" }).click();

  await expect(component.getByRole("combobox")).toHaveText("Text Card");

  await expect
    .poll(async () => {
      const value = (await readFormValue(component)) as Record<string, unknown>;
      return value?.type;
    })
    .toBe("text-card");
});

test("type union: Text Card's nested Body field renders inline and is editable", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <FieldHarness schema={typeDiscriminatedUnion} label="Card" />,
  );

  await component.getByRole("combobox").click();
  await page.getByRole("option", { name: "Text Card" }).click();

  // The discriminator must land before we touch the nested field.
  await expect
    .poll(async () => {
      const value = (await readFormValue(component)) as Record<string, unknown>;
      return value?.type;
    })
    .toBe("text-card");

  const bodyInput = component.getByLabel("Body");
  await expect(bodyInput).toBeVisible();
  await expect(bodyInput).toHaveAttribute("id", "field.body");

  await bodyInput.fill("Hello there");

  await expect
    .poll(async () => {
      const value = (await readFormValue(component)) as Record<string, unknown>;
      return { type: value?.type, body: value?.body };
    })
    .toEqual({ type: "text-card", body: "Hello there" });
});

test("type union: the active branch's discriminator field is hidden from nested form", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <FieldHarness schema={typeDiscriminatedUnion} label="Card" />,
  );

  await component.getByRole("combobox").click();
  await page.getByRole("option", { name: "Text Card" }).click();

  // "Body" is editable, but the "type" discriminator leaf is stripped — there
  // is no "Type" labelled field for the user to edit directly.
  await expect(component.getByLabel("Body")).toBeVisible();
  await expect(component.getByLabel("Type")).toHaveCount(0);
});

test("type union: switching back to Image Card swaps the active discriminator", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <FieldHarness schema={typeDiscriminatedUnion} label="Card" />,
  );

  // Image Card -> Text Card -> Image Card, verifying the discriminator each time.
  await component.getByRole("combobox").click();
  await page.getByRole("option", { name: "Text Card" }).click();
  await expect
    .poll(async () => {
      const value = (await readFormValue(component)) as Record<string, unknown>;
      return value?.type;
    })
    .toBe("text-card");

  await component.getByRole("combobox").click();
  await page.getByRole("option", { name: "Image Card" }).click();
  await expect(component.getByRole("combobox")).toHaveText("Image Card");
  await expect
    .poll(async () => {
      const value = (await readFormValue(component)) as Record<string, unknown>;
      return value?.type;
    })
    .toBe("image-card");

  await expect(component.getByLabel("Src")).toBeVisible();
});

// ── (C) block-config-wrapped inline union (VTEX userSegment matcher) ─────────
// The REAL deco shape driven through the production path (raw LiveMeta →
// resolveSchema → SchemaForm). deco wraps the config as
// `{ allOf:[{$ref:Props}], properties:{__resolveType} }` where `Props` is a
// `$ref` ALIAS to the `{ anyOf:[branches] }` union; each branch's discriminant
// `segment` is a `const` marked `@hide true` (emitted as the string "true").
const USER_SEGMENT_RT = "vtex/matchers/userSegment.ts";
const seg = (
  title: string,
  value: string,
  extra: Record<string, unknown> = {},
) => ({
  type: "object",
  title,
  required: ["segment"],
  properties: {
    segment: {
      type: "string",
      const: value,
      default: value,
      hide: "true",
      title: "Segment",
    },
    ...extra,
  },
});
const userSegmentMeta = {
  manifest: {
    blocks: {
      matchers: { [USER_SEGMENT_RT]: { $ref: "#/definitions/Wrapper" } },
    },
  },
  schema: {
    definitions: {
      Wrapper: {
        type: "object",
        allOf: [{ $ref: "#/definitions/Props" }],
        required: ["__resolveType"],
        properties: {
          __resolveType: {
            type: "string",
            enum: [USER_SEGMENT_RT],
            default: USER_SEGMENT_RT,
          },
        },
      },
      // `@Props` is a bare `$ref` alias to the union def.
      Props: { $ref: "#/definitions/Union", title: "…@Props" },
      Union: {
        // machine name — must NOT leak in as the field label
        title: "AnonymousWithoutCart|LoggedIn|LoggedInWithRecentOrders",
        anyOf: [
          { $ref: "#/definitions/AnonymousWithoutCart" },
          { $ref: "#/definitions/LoggedIn" },
          { $ref: "#/definitions/LoggedInWithRecentOrders" },
        ],
      },
      AnonymousWithoutCart: seg(
        "Anonymous without cart",
        "anonymous-without-cart",
      ),
      LoggedIn: seg("Logged in", "logged-in"),
      LoggedInWithRecentOrders: seg(
        "Logged in with recent orders",
        "logged-in-with-recent-orders",
        { months: { type: "number", title: "Months", default: 3 } },
      ),
    },
  },
} as unknown as LiveMeta;

test("segment union: root renders a branch selector with no machine-name label", async ({
  mount,
}) => {
  const component = await mount(
    <SchemaFormHarness
      meta={userSegmentMeta}
      resolveType={USER_SEGMENT_RT}
      initialValue={{ __resolveType: USER_SEGMENT_RT }}
    />,
  );

  // The union renders as a selector defaulting to the first branch...
  await expect(component.getByRole("combobox")).toHaveText(
    "Anonymous without cart",
  );
  // ...and the machine union name ("A|B|C") never leaks in as a label.
  await expect(component.getByText(/\|/)).toHaveCount(0);
});

test("segment union: selecting a branch writes segment AND preserves __resolveType", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <SchemaFormHarness
      meta={userSegmentMeta}
      resolveType={USER_SEGMENT_RT}
      initialValue={{ __resolveType: USER_SEGMENT_RT }}
    />,
  );

  await component.getByRole("combobox").click();
  await page
    .getByRole("option", { name: "Logged in with recent orders" })
    .click();

  await expect
    .poll(async () => {
      const value = (await readFormValue(component)) as Record<string, unknown>;
      return { segment: value?.segment, rt: value?.__resolveType };
    })
    .toEqual({
      segment: "logged-in-with-recent-orders",
      rt: USER_SEGMENT_RT,
    });

  // The recent-orders branch's Months field renders inline and round-trips.
  await component.getByLabel("Months").fill("6");
  await expect
    .poll(async () => {
      const value = (await readFormValue(component)) as Record<string, unknown>;
      return value?.months;
    })
    .toBe(6);
});

test("segment union: a discriminator-only branch shows just the selector", async ({
  mount,
}) => {
  const component = await mount(
    <SchemaFormHarness
      meta={userSegmentMeta}
      resolveType={USER_SEGMENT_RT}
      initialValue={{
        __resolveType: USER_SEGMENT_RT,
        segment: "logged-in",
      }}
    />,
  );

  // "Logged in" has no extra field — selector only, no editable inputs, and no
  // "Segment" discriminant field leaking through.
  await expect(component.getByRole("combobox")).toHaveText("Logged in");
  await expect(component.getByRole("textbox")).toHaveCount(0);
  await expect(component.getByLabel("Months")).toHaveCount(0);
});
