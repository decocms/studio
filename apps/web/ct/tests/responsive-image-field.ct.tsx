import type { MountResult } from "@playwright/experimental-ct-react";
import { expect, test } from "@playwright/experimental-ct-react";
import { ResponsiveImageHarness } from "../harness/responsive-image-harness";

/**
 * The post cover's use of the shared field: desktop + mobile over one
 * preview, with no block-only width/priority buttons.
 */
const value = (component: MountResult) =>
  component
    .getByTestId("cover-value")
    .textContent()
    .then((text) => JSON.parse(text ?? "{}") as Record<string, unknown>);

const showToolbar = (component: MountResult) =>
  component.getByRole("button", { name: "Replace image" }).hover();

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

test("a cover gets no width or priority buttons", async ({ mount }) => {
  const component = await mount(
    <ResponsiveImageHarness initial={{ image: PNG }} />,
  );
  await showToolbar(component);

  await expect(component.getByRole("button", { name: "full" })).toHaveCount(0);
  await expect(component.getByRole("button", { name: "Priority" })).toHaveCount(
    0,
  );
  await expect(
    component.getByRole("button", { name: "Desktop image" }),
  ).toBeVisible();
});

test("mobile shares the one preview and writes mobileImage", async ({
  mount,
}) => {
  const component = await mount(
    <ResponsiveImageHarness initial={{ image: PNG }} />,
  );
  await showToolbar(component);
  await expect(component.locator("img")).toHaveCount(1);

  await component
    .getByRole("button", { name: "Mobile image (below 768px)" })
    .click();
  await expect(component.locator("img")).toHaveCount(0);

  await component.getByRole("button", { name: "Mobile URL" }).click();
  await component.getByPlaceholder("https://...").fill("https://x.test/m.png");

  await expect
    .poll(() => value(component))
    .toMatchObject({ image: PNG, mobileImage: "https://x.test/m.png" });
});

test("clearing the mobile URL drops the key instead of storing an empty string", async ({
  mount,
}) => {
  const component = await mount(
    <ResponsiveImageHarness
      initial={{ image: PNG, mobileImage: "https://x.test/m.png" }}
    />,
  );
  await showToolbar(component);

  await component
    .getByRole("button", { name: "Mobile image (below 768px)" })
    .click();
  await component.getByRole("button", { name: "Mobile URL" }).click();
  await component.getByPlaceholder("https://...").fill("");

  await expect.poll(() => value(component)).toMatchObject({ image: PNG });
  await expect.poll(() => value(component)).not.toHaveProperty("mobileImage");
});
