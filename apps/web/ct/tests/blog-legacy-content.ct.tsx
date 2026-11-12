import {
  expect,
  type MountResult,
  test,
} from "@playwright/experimental-ct-react";
import { LegacyContentEditorHarness } from "../harness/legacy-content-editor-harness";

const BODY =
  '<h2>Section</h2><p style="text-align: justify;"><span style="font-size: 12pt;">Intro text</span></p>';
const SECTIONS = [{ __resolveType: "rt/Paragraph", html: "<p>block</p>" }];

async function readPost(component: MountResult) {
  return JSON.parse(
    (await component.getByTestId("record-value").textContent()) ?? "{}",
  ) as Record<string, unknown>;
}

test("shows the stored HTML formatted, and opening it never writes", async ({
  mount,
}) => {
  const component = await mount(
    <LegacyContentEditorHarness initialPost={{ content: BODY }} />,
  );

  await expect(
    component.getByRole("heading", { level: 2, name: "Section" }),
  ).toBeVisible();
  await expect(
    component.getByText("Intro text", { exact: true }),
  ).toBeVisible();
  await expect(component.getByTestId("write-count")).toHaveText("0");
});

test("an edit stores HTML in content and keeps the post's blocks", async ({
  mount,
}) => {
  const component = await mount(
    <LegacyContentEditorHarness
      initialPost={{ title: "T", content: "", sections: SECTIONS }}
    />,
  );

  const editor = component.locator('[contenteditable="true"]');
  await editor.fill("Hello body");

  await expect
    .poll(() => readPost(component))
    .toEqual({ title: "T", content: "<p>Hello body</p>", sections: SECTIONS });
});

test("clearing the body stores an empty string", async ({ mount }) => {
  const component = await mount(
    <LegacyContentEditorHarness initialPost={{ content: "<p>x</p>" }} />,
  );

  const editor = component.locator('[contenteditable="true"]');
  await editor.fill("");

  await expect.poll(() => readPost(component)).toEqual({ content: "" });
});

test("the font size steps in pt, like the admin wrote it", async ({
  mount,
}) => {
  const component = await mount(
    <LegacyContentEditorHarness initialPost={{ content: "<p>size me</p>" }} />,
  );

  const editor = component.locator('[contenteditable="true"]');
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await component.getByRole("button", { name: "Increase font size" }).click();

  await expect
    .poll(async () => (await readPost(component)).content)
    .toBe('<p><span style="font-size: 13pt;">size me</span></p>');
});

test("an image from a URL is inserted inline, once", async ({ mount }) => {
  const component = await mount(
    <LegacyContentEditorHarness initialPost={{ content: "<p>text</p>" }} />,
  );

  await component.locator('[contenteditable="true"]').click();
  await component
    .getByRole("button", { name: "Insert image from a URL" })
    .click();
  const input = component.getByRole("textbox", {
    name: "Insert image from a URL",
  });
  await input.fill("https://cdn.example.com/photo.jpg");
  await input.press("Enter");

  await expect
    .poll(async () => (await readPost(component)).content)
    .toBe('<p>text<img src="https://cdn.example.com/photo.jpg"></p>');
});

test("an address that must not reach a src is refused", async ({ mount }) => {
  const component = await mount(
    <LegacyContentEditorHarness initialPost={{ content: "<p>text</p>" }} />,
  );

  await component
    .getByRole("button", { name: "Insert image from a URL" })
    .click();
  const input = component.getByRole("textbox", {
    name: "Insert image from a URL",
  });
  await input.fill("javascript:alert(1)");
  await input.press("Enter");

  await expect(component.getByRole("alert")).toBeVisible();
  await expect(component.getByTestId("write-count")).toHaveText("0");
});

test("an image from the library is inserted", async ({ mount }) => {
  const component = await mount(
    <LegacyContentEditorHarness initialPost={{ content: "<p>text</p>" }} />,
  );

  await component.locator('[contenteditable="true"]').click();
  await component
    .getByRole("button", { name: "Insert image from the library" })
    .click();
  await component.getByTestId("file-picker-pick").click();

  await expect
    .poll(async () => (await readPost(component)).content)
    .toContain('<img src="https://cdn.example.com/ct-picked.png">');
});
