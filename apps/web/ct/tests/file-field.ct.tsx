import { expect, test } from "@playwright/experimental-ct-react";
import { FieldHarness } from "../harness/field-harness";
import { readFormValue } from "../harness/ct-utils";
import type { SchemaProperty } from "@/components/sections-editor/resolve-schema";

const FILE_SCHEMA: SchemaProperty = {
  type: "string",
  format: "file-uri",
  title: "Doc",
};

const VIDEO_SCHEMA: SchemaProperty = {
  type: "string",
  format: "video-uri",
  title: "Clip",
};

// ── file format ─────────────────────────────────────────────────────────────

test("file: empty state shows the drop/browse prompt", async ({ mount }) => {
  const component = await mount(
    <FieldHarness schema={FILE_SCHEMA} label="Doc" path="doc" />,
  );

  await expect(
    component.getByText("Drop a file or click to browse"),
  ).toBeVisible();
});

test("file: pasting a url into the text input round-trips the value", async ({
  mount,
}) => {
  const component = await mount(
    <FieldHarness schema={FILE_SCHEMA} label="Doc" path="doc" />,
  );

  const input = component.getByLabel("Doc");
  await expect(input).toBeVisible();
  await input.fill("https://x.test/report.pdf");

  await expect
    .poll(() => readFormValue(component))
    .toEqual("https://x.test/report.pdf");
});

test("file: with a value the filename and uppercase ext chip are shown", async ({
  mount,
}) => {
  const component = await mount(
    <FieldHarness
      schema={FILE_SCHEMA}
      label="Doc"
      path="doc"
      initialValue="https://x.test/report.pdf"
    />,
  );

  await expect(
    component.getByText("report.pdf", { exact: true }),
  ).toBeVisible();
  // Lowercase text node; uppercase is CSS text-transform only.
  await expect(component.getByText("pdf", { exact: true })).toBeVisible();
});

test("file: with a value the clickable row + Remove file controls appear", async ({
  mount,
}) => {
  const component = await mount(
    <FieldHarness
      schema={FILE_SCHEMA}
      label="Doc"
      path="doc"
      initialValue="https://x.test/report.pdf"
    />,
  );

  // Replacing is done by clicking the row now — no separate Replace button.
  await expect(
    component.getByRole("button", { name: "Replace file" }),
  ).toBeVisible();
  await expect(
    component.getByRole("button", { name: "Remove file" }),
  ).toBeVisible();
});

test("file: clicking the file row opens the file picker", async ({ mount }) => {
  const component = await mount(
    <FieldHarness
      schema={FILE_SCHEMA}
      label="Doc"
      path="doc"
      initialValue="https://x.test/report.pdf"
    />,
  );

  await expect(component.getByTestId("file-picker-stub")).toHaveCount(0);
  await component.getByRole("button", { name: "Replace file" }).click();

  await expect(component.getByTestId("file-picker-stub")).toBeVisible();
});

test("file: clicking Remove file clears the value to an empty string", async ({
  mount,
}) => {
  const component = await mount(
    <FieldHarness
      schema={FILE_SCHEMA}
      label="Doc"
      path="doc"
      initialValue="https://x.test/report.pdf"
    />,
  );

  await component.getByRole("button", { name: "Remove file" }).click();

  await expect.poll(() => readFormValue(component)).toEqual("");
});

test("file: empty state has no Replace/Remove controls and shows Browse", async ({
  mount,
}) => {
  const component = await mount(
    <FieldHarness schema={FILE_SCHEMA} label="Doc" path="doc" />,
  );

  await expect(
    component.getByRole("button", { name: "Browse", exact: true }),
  ).toBeVisible();
  await expect(
    component.getByRole("button", { name: "Replace", exact: true }),
  ).toHaveCount(0);
  await expect(
    component.getByRole("button", { name: "Remove file" }),
  ).toHaveCount(0);
});

// ── browse + pick ─────────────────────────────────────────────────────────────

test("file: clicking Browse opens the file picker", async ({ mount }) => {
  const component = await mount(
    <FieldHarness schema={FILE_SCHEMA} label="Doc" path="doc" />,
  );

  await expect(component.getByTestId("file-picker-stub")).toHaveCount(0);
  await component.getByRole("button", { name: "Browse", exact: true }).click();

  await expect(component.getByTestId("file-picker-stub")).toBeVisible();
});

test("file: picking a file from the picker sets the value", async ({
  mount,
}) => {
  const component = await mount(
    <FieldHarness schema={FILE_SCHEMA} label="Doc" path="doc" />,
  );

  await component.getByRole("button", { name: "Browse", exact: true }).click();
  await component.getByTestId("file-picker-pick").click();

  await expect
    .poll(() => readFormValue(component))
    .toEqual("https://cdn.example.com/ct-picked.png");
});

// ── video format ─────────────────────────────────────────────────────────────

test("video: empty state shows the video drop/browse prompt", async ({
  mount,
}) => {
  const component = await mount(
    <FieldHarness schema={VIDEO_SCHEMA} label="Clip" path="clip" />,
  );

  await expect(
    component.getByText("Drop a video here or click to browse"),
  ).toBeVisible();
});

test("video: with a value a <video> element and the filename render", async ({
  mount,
}) => {
  const component = await mount(
    <FieldHarness
      schema={VIDEO_SCHEMA}
      label="Clip"
      path="clip"
      initialValue="https://x.test/clip.mp4"
    />,
  );

  await expect(component.locator("video")).toBeVisible();
  await expect(component.getByText("clip.mp4", { exact: true })).toBeVisible();
});

test("video: clicking the preview opens the file picker", async ({ mount }) => {
  const component = await mount(
    <FieldHarness
      schema={VIDEO_SCHEMA}
      label="Clip"
      path="clip"
      initialValue="https://x.test/clip.mp4"
    />,
  );

  await expect(component.getByTestId("file-picker-stub")).toHaveCount(0);
  await component.getByRole("button", { name: "Replace video" }).click();

  await expect(component.getByTestId("file-picker-stub")).toBeVisible();
});

test("video: quality picked via the ⋮ menu writes ?quality= to the value", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <FieldHarness
      schema={VIDEO_SCHEMA}
      label="Clip"
      path="clip"
      initialValue="https://x.test/clip.mp4"
    />,
  );

  await component.getByRole("button", { name: "Media options" }).click();
  // Popover content is portaled to <body>, outside the mounted root.
  await page.getByRole("radio", { name: "medium" }).click();

  await expect
    .poll(() => readFormValue(component))
    .toEqual("https://x.test/clip.mp4?quality=medium");
});

test("video: toggling Muted off writes muted=false to the value", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <FieldHarness
      schema={VIDEO_SCHEMA}
      label="Clip"
      path="clip"
      initialValue="https://x.test/clip.mp4"
    />,
  );

  await component.getByRole("button", { name: "Media options" }).click();
  // Muted (the CDN default) starts on; turning it off records muted=false.
  await page.getByRole("switch", { name: "Muted" }).click();

  await expect
    .poll(() => readFormValue(component))
    .toEqual("https://x.test/clip.mp4?muted=false");
});

test("file: plain (non-video) files expose no ⋮ media-options menu", async ({
  mount,
}) => {
  const component = await mount(
    <FieldHarness
      schema={FILE_SCHEMA}
      label="Doc"
      path="doc"
      initialValue="https://x.test/report.pdf"
    />,
  );

  await expect(
    component.getByRole("button", { name: "Media options" }),
  ).toHaveCount(0);
});
