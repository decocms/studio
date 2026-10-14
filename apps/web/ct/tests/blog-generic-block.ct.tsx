import { expect, test } from "@playwright/experimental-ct-react";
import { BlogGenericBlockHarness } from "../harness/blog-generic-block-harness";

const PROMO = "site/sections/Blog/Post/Promo.tsx";

/**
 * A `/live/_meta` for one site-defined blog block. `Block` carries the
 * block-level annotations (`@title`, `@description`, `@icon`); `Props` carries
 * the field ones — the same split deco emits for a section.
 */
function blockMeta(
  props: Record<string, unknown>,
  blockMetadata: Record<string, unknown> = {},
) {
  return {
    manifest: {
      blocks: { sections: { [PROMO]: { $ref: "#/definitions/Block" } } },
    },
    schema: {
      definitions: {
        Block: {
          type: "object",
          allOf: [{ $ref: "#/definitions/Props" }],
          properties: { __resolveType: { type: "string", enum: [PROMO] } },
          ...blockMetadata,
        },
        Props: { type: "object", properties: props },
      },
    },
  };
}

/**
 * `__resolveType` is hidden from the form, so without a header the fields are
 * unattributed and there is no way to tell which block is being edited.
 */
test("names the block being edited from its schema", async ({ mount }) => {
  const component = await mount(
    <BlogGenericBlockHarness
      meta={blockMeta(
        { headline: { type: "string", title: "Headline" } },
        {
          title: "Promo banner",
          description: "A banner with a call to action",
        },
      )}
      block={{ __resolveType: PROMO }}
    />,
  );

  await expect(
    component.getByText("Promo banner", { exact: true }),
  ).toBeVisible();
  await expect(
    component.getByText("A banner with a call to action", { exact: true }),
  ).toBeVisible();
});

test("falls back to the humanized component name when the schema is unnamed", async ({
  mount,
}) => {
  const component = await mount(
    <BlogGenericBlockHarness
      meta={blockMeta({ headline: { type: "string", title: "Headline" } })}
      block={{ __resolveType: PROMO }}
    />,
  );

  await expect(component.getByText("Promo", { exact: true })).toBeVisible();
});

test("a field's @title and @description come from the schema", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <BlogGenericBlockHarness
      meta={blockMeta({
        headline: {
          type: "string",
          title: "Headline",
          description: "Shown above the image",
        },
      })}
      block={{ __resolveType: PROMO }}
    />,
  );

  // The sandbox renders descriptions as tooltips on the label.
  await component.getByText("Headline", { exact: true }).hover();
  await expect(page.getByRole("tooltip")).toContainText(
    "Shown above the image",
  );

  await component.getByLabel("Headline").fill("Hi");

  await expect(component.getByTestId("block-value")).toHaveText(
    JSON.stringify({ __resolveType: PROMO, headline: "Hi" }),
  );
});

/**
 * The widget a `@format` selects needs the sandbox context to work at all —
 * without it `ImageWidget` degrades to a bare text input with no upload or
 * picker.
 */
test("@format image-uri renders the image widget, not a text input", async ({
  mount,
}) => {
  const component = await mount(
    <BlogGenericBlockHarness
      meta={blockMeta({
        image: { type: "string", title: "Image", format: "image-uri" },
      })}
      block={{ __resolveType: PROMO }}
    />,
  );

  await expect(
    component.getByRole("button", { name: "Browse", exact: true }),
  ).toBeVisible();
});

/**
 * Drilling into an array item replaces the form with the item's own fields, so
 * without the breadcrumb pair there is no way back out — and the item row is
 * labelled by `@titleBy`, which only resolves when the item schema does.
 */
test("an array item can be opened and navigated back out of", async ({
  mount,
}) => {
  const component = await mount(
    <BlogGenericBlockHarness
      meta={blockMeta({
        cards: {
          type: "array",
          title: "Cards",
          items: {
            type: "object",
            title: "{{{label}}}",
            properties: { label: { type: "string", title: "Label" } },
          },
        },
      })}
      block={{ __resolveType: PROMO, cards: [{ label: "first" }] }}
    />,
  );

  await component.getByRole("button", { name: /^first\b/ }).click();

  await expect(component.getByLabel("Label")).toBeVisible();
  const trail = component.getByRole("navigation", { name: "Field trail" });
  await expect(trail).toBeVisible();

  await trail.getByTitle("Back to the field list").click();

  await expect(component.getByLabel("Label")).toHaveCount(0);
  await expect(
    component.getByRole("button", { name: /^first\b/ }),
  ).toBeVisible();
});

/**
 * The post autosave stamps `dateModified`, so seeding `@default`s on mount
 * would silently re-date every post holding a block whose schema declares one.
 */
test("mounting never writes, even when a field declares a default", async ({
  mount,
}) => {
  const component = await mount(
    <BlogGenericBlockHarness
      meta={blockMeta({
        headline: { type: "string", title: "Headline", default: "Hello" },
      })}
      block={{ __resolveType: PROMO }}
    />,
  );

  await expect(component.getByLabel("Headline")).toBeVisible();
  await expect(component.getByTestId("write-count")).toHaveText("0");
  await expect(component.getByTestId("block-value")).toHaveText(
    JSON.stringify({ __resolveType: PROMO }),
  );
});
