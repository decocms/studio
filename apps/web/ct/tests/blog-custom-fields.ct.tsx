import { expect, test } from "@playwright/experimental-ct-react";
import { BlogCustomFieldsHarness } from "../harness/blog-custom-fields-harness";

const POST_RESOLVE_TYPE = "blog/loaders/Blogpost.ts";

/** A `/live/_meta` for a blog whose BlogPost type carries `post` props. */
function blogMeta(postProperties: Record<string, unknown>) {
  return {
    manifest: {
      blocks: {
        loaders: {
          [POST_RESOLVE_TYPE]: { $ref: "#/definitions/Wrapper" },
        },
      },
    },
    schema: {
      definitions: {
        Wrapper: {
          allOf: [{ $ref: "#/definitions/Props" }],
          properties: {
            __resolveType: { type: "string", enum: [POST_RESOLVE_TYPE] },
          },
        },
        Props: {
          type: "object",
          properties: {
            post: { type: "object", properties: postProperties },
          },
        },
      },
    },
  };
}

test("a field the site added to BlogPost renders and round-trips", async ({
  mount,
}) => {
  const component = await mount(
    <BlogCustomFieldsHarness
      meta={blogMeta({
        title: { type: "string", title: "Title" },
        sponsor: { type: "string", title: "Sponsor" },
      })}
    />,
  );

  await component.getByRole("button", { name: "Other fields" }).click();
  await component.getByLabel("Sponsor").fill("Acme");

  await expect(component.getByTestId("record-value")).toHaveText(
    JSON.stringify({ sponsor: "Acme" }),
  );
});

/**
 * The panel edits a slice of the record but is handed the WHOLE payload, so a
 * custom-field edit must not drop the fields the bespoke UI owns — above all
 * `sections`, the post body.
 */
test("editing a custom field preserves the fields the editor owns", async ({
  mount,
}) => {
  const component = await mount(
    <BlogCustomFieldsHarness
      meta={blogMeta({
        title: { type: "string", title: "Title" },
        sponsor: { type: "string", title: "Sponsor" },
      })}
      initialValue={{
        title: "Hello",
        slug: "hello",
        sections: [{ __resolveType: "blog/sections/blocks/Paragraph.tsx" }],
      }}
    />,
  );

  await component.getByRole("button", { name: "Other fields" }).click();
  await component.getByLabel("Sponsor").fill("Acme");

  const value = JSON.parse(
    (await component.getByTestId("record-value").textContent()) ?? "{}",
  );
  expect(value.title).toBe("Hello");
  expect(value.slug).toBe("hello");
  expect(value.sections).toHaveLength(1);
  expect(value.sponsor).toBe("Acme");
});

test("renders nothing when every field already has bespoke UI", async ({
  mount,
}) => {
  const component = await mount(
    <BlogCustomFieldsHarness
      meta={blogMeta({
        title: { type: "string", title: "Title" },
        slug: { type: "string", title: "Slug" },
        sections: { type: "array", items: { type: "object" } },
      })}
    />,
  );

  await expect(
    component.getByRole("button", { name: "Other fields" }),
  ).toHaveCount(0);
});

/**
 * Opening a record must never write. The post autosave stamps `dateModified`,
 * so a defaults write-back on mount would silently re-date every post the
 * moment the site's type declares a `@default`.
 */
test("mounting never writes, even when a custom field declares a default", async ({
  mount,
}) => {
  const component = await mount(
    <BlogCustomFieldsHarness
      meta={blogMeta({
        title: { type: "string", title: "Title" },
        sponsor: { type: "string", title: "Sponsor", default: "Acme" },
      })}
      initialValue={{ title: "Hello" }}
    />,
  );

  await expect(
    component.getByRole("button", { name: "Other fields" }),
  ).toBeVisible();
  await expect(component.getByTestId("write-count")).toHaveText("0");
  await expect(component.getByTestId("record-value")).toHaveText(
    JSON.stringify({ title: "Hello" }),
  );
});

/**
 * Drilling into an array item replaces the field list with the item's own
 * form, so without a trail there is no way back out.
 */
test("an array item can be opened and navigated back out of", async ({
  mount,
}) => {
  const component = await mount(
    <BlogCustomFieldsHarness
      meta={blogMeta({
        carousel: {
          type: "object",
          title: "Carousel",
          properties: {
            banners: {
              type: "array",
              title: "Banners",
              items: {
                type: "object",
                title: "Banner",
                properties: { alt: { type: "string", title: "Alt" } },
              },
            },
          },
        },
      })}
      initialValue={{ carousel: { banners: [{ alt: "first" }] } }}
    />,
  );

  await component.getByRole("button", { name: "Other fields" }).click();
  await component.getByRole("button", { name: "Carousel" }).click();
  // The row is labelled by the item's own value, not the item type.
  await component.getByRole("button", { name: /^first\b/ }).click();

  // Inside the item: its own field, and a trail to get back.
  await expect(component.getByLabel("Alt")).toBeVisible();
  const trail = component.getByRole("navigation", { name: "Field trail" });
  await expect(trail).toBeVisible();

  await trail.getByTitle("Back to the field list").click();

  await expect(component.getByLabel("Alt")).toHaveCount(0);
  await expect(
    component.getByRole("button", { name: "Carousel" }),
  ).toBeVisible();
});
