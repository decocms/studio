import { expect, test } from "@playwright/experimental-ct-react";
import { FieldHarness } from "../harness/field-harness";
import { readFormValue } from "../harness/ct-utils";
import type { SchemaProperty } from "@/web/components/sections-editor/resolve-schema";

/**
 * ImageField (format "image-uri"). FieldHarness renders ONE field via
 * renderField; the form VALUE is the field's own string. The FilePickerDialog
 * is stubbed inline (data-testid="file-picker-stub") and its pick button
 * selects "https://cdn.example.com/ct-picked.png".
 */
const IMAGE_SCHEMA: SchemaProperty = {
  type: "string",
  format: "image-uri",
  title: "Hero",
};

test("empty state: drop-zone prompt, empty url input, Browse button", async ({
  mount,
}) => {
  const component = await mount(
    <FieldHarness schema={IMAGE_SCHEMA} label="Hero" />,
  );

  // Empty drop zone prompt visible.
  await expect(
    component.getByText("Drop an image or click to browse"),
  ).toBeVisible();

  // url input present and empty (getByLabel("Hero") -> Input id=path).
  const urlInput = component.getByLabel("Hero");
  await expect(urlInput).toBeVisible();
  await expect(urlInput).toHaveAttribute("type", "url");
  await expect(urlInput).toHaveValue("");

  // Browse button present; Replace / Remove image absent.
  await expect(
    component.getByRole("button", { name: "Browse", exact: true }),
  ).toBeVisible();
  await expect(
    component.getByRole("button", { name: "Replace image" }),
  ).toHaveCount(0);
  await expect(
    component.getByRole("button", { name: "Remove image" }),
  ).toHaveCount(0);
});

test("empty state: initial form value is null", async ({ mount }) => {
  const component = await mount(
    <FieldHarness schema={IMAGE_SCHEMA} label="Hero" />,
  );
  await expect.poll(() => readFormValue(component)).toEqual(null);
});

test("paste URL: round-trips value into form state", async ({ mount }) => {
  const component = await mount(
    <FieldHarness schema={IMAGE_SCHEMA} label="Hero" />,
  );

  await component.getByLabel("Hero").fill("https://x.test/a.png");

  await expect
    .poll(() => readFormValue(component))
    .toEqual("https://x.test/a.png");
});

test("paste URL: shows filename and extension chip", async ({ mount }) => {
  const component = await mount(
    <FieldHarness schema={IMAGE_SCHEMA} label="Hero" />,
  );

  await component.getByLabel("Hero").fill("https://x.test/a.png");

  // Filename derived from the URL pathname.
  await expect(component.getByText("a.png", { exact: true })).toBeVisible();
  // Extension chip. The text node is lowercase ("png"); the uppercase look is
  // CSS text-transform, which does not change textContent — so match lowercase.
  await expect(component.getByText("png", { exact: true })).toBeVisible();
});

test("paste URL: Browse disappears; clickable preview + Remove image appear", async ({
  mount,
}) => {
  const component = await mount(
    <FieldHarness schema={IMAGE_SCHEMA} label="Hero" />,
  );

  await component.getByLabel("Hero").fill("https://x.test/a.png");

  // Replacing is done by clicking the preview now — no separate Replace button.
  await expect(
    component.getByRole("button", { name: "Replace image" }),
  ).toBeVisible();
  await expect(
    component.getByRole("button", { name: "Browse", exact: true }),
  ).toHaveCount(0);
  await expect(
    component.getByRole("button", { name: "Remove image" }),
  ).toBeVisible();
});

test("populated: renders clickable preview + Remove image from initialValue", async ({
  mount,
}) => {
  const component = await mount(
    <FieldHarness
      schema={IMAGE_SCHEMA}
      label="Hero"
      initialValue="https://x.test/a.png"
    />,
  );

  await expect(component.getByLabel("Hero")).toHaveValue(
    "https://x.test/a.png",
  );
  await expect(
    component.getByRole("button", { name: "Replace image" }),
  ).toBeVisible();
  await expect(
    component.getByRole("button", { name: "Remove image" }),
  ).toBeVisible();
  // Empty prompt should not be shown when populated.
  await expect(
    component.getByText("Drop an image or click to browse"),
  ).toHaveCount(0);
});

test("remove: clicking Remove image clears the value to empty string", async ({
  mount,
}) => {
  const component = await mount(
    <FieldHarness
      schema={IMAGE_SCHEMA}
      label="Hero"
      initialValue="https://x.test/a.png"
    />,
  );

  await component.getByRole("button", { name: "Remove image" }).click();

  await expect.poll(() => readFormValue(component)).toEqual("");
});

test("remove: empty drop-zone returns and url input is empty after remove", async ({
  mount,
}) => {
  const component = await mount(
    <FieldHarness
      schema={IMAGE_SCHEMA}
      label="Hero"
      initialValue="https://x.test/a.png"
    />,
  );

  await component.getByRole("button", { name: "Remove image" }).click();

  await expect(
    component.getByText("Drop an image or click to browse"),
  ).toBeVisible();
  await expect(component.getByLabel("Hero")).toHaveValue("");
  await expect(
    component.getByRole("button", { name: "Browse", exact: true }),
  ).toBeVisible();
});

test("browse: clicking Browse opens the stubbed file picker", async ({
  mount,
}) => {
  const component = await mount(
    <FieldHarness schema={IMAGE_SCHEMA} label="Hero" />,
  );

  await expect(component.getByTestId("file-picker-stub")).toHaveCount(0);

  await component.getByRole("button", { name: "Browse", exact: true }).click();

  const stub = component.getByTestId("file-picker-stub");
  await expect(stub).toBeVisible();
  // ImageField opens the picker in "image" mode.
  await expect(stub).toHaveAttribute("data-mode", "image");
});

test("browse + pick: selecting a file sets the picked URL as value", async ({
  mount,
}) => {
  const component = await mount(
    <FieldHarness schema={IMAGE_SCHEMA} label="Hero" />,
  );

  await component.getByRole("button", { name: "Browse", exact: true }).click();
  await component.getByTestId("file-picker-pick").click();

  await expect
    .poll(() => readFormValue(component))
    .toEqual("https://cdn.example.com/ct-picked.png");
});

test("browse + pick: picker closes after selecting a file", async ({
  mount,
}) => {
  const component = await mount(
    <FieldHarness schema={IMAGE_SCHEMA} label="Hero" />,
  );

  await component.getByRole("button", { name: "Browse", exact: true }).click();
  await expect(component.getByTestId("file-picker-stub")).toBeVisible();

  await component.getByTestId("file-picker-pick").click();

  await expect(component.getByTestId("file-picker-stub")).toHaveCount(0);
});

test("preview: clicking the image opens the picker in image mode", async ({
  mount,
}) => {
  const component = await mount(
    <FieldHarness
      schema={IMAGE_SCHEMA}
      label="Hero"
      initialValue="https://x.test/a.png"
    />,
  );

  await expect(component.getByTestId("file-picker-stub")).toHaveCount(0);

  await component.getByRole("button", { name: "Replace image" }).click();

  const stub = component.getByTestId("file-picker-stub");
  await expect(stub).toBeVisible();
  await expect(stub).toHaveAttribute("data-mode", "image");
});

test("quality: picking a level via the ⋮ menu writes ?quality= to the value", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <FieldHarness
      schema={IMAGE_SCHEMA}
      label="Hero"
      initialValue="https://x.test/a.png"
    />,
  );

  await component.getByRole("button", { name: "Media options" }).click();
  // The popover content is portaled to <body>, outside the mounted root.
  await page.getByRole("radio", { name: "high" }).click();

  await expect
    .poll(() => readFormValue(component))
    .toEqual("https://x.test/a.png?quality=high");
});

test("quality: toggling the active level off clears ?quality= from the value", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <FieldHarness
      schema={IMAGE_SCHEMA}
      label="Hero"
      initialValue="https://x.test/a.png?quality=high"
    />,
  );

  await component.getByRole("button", { name: "Media options" }).click();
  // Radix single-select emits "" on toggle-off → the param is removed.
  await page.getByRole("radio", { name: "high" }).click();

  await expect
    .poll(() => readFormValue(component))
    .toEqual("https://x.test/a.png");
});

test("image ⋮ menu has no Muted switch (muted is video-only)", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <FieldHarness
      schema={IMAGE_SCHEMA}
      label="Hero"
      initialValue="https://x.test/a.png"
    />,
  );

  await component.getByRole("button", { name: "Media options" }).click();
  await expect(page.getByRole("radio", { name: "high" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Muted" })).toHaveCount(0);
});
