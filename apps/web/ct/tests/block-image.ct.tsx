import type { MountResult } from "@playwright/experimental-ct-react";
import { expect, test } from "@playwright/experimental-ct-react";
import { BlockImageHarness } from "../harness/block-image-harness";

/**
 * The blog post's inline image block. The block's props are the blog app's
 * (`url`, `mobileUrl`, `alt`, `caption`, `size`, `highPriority`), so these
 * assert the serialized block, not the markup — the CMS writes it straight
 * into the decofile and the app reads it back.
 */
const value = (component: MountResult) =>
  component
    .getByTestId("block-value")
    .textContent()
    .then((text) => JSON.parse(text ?? "{}") as Record<string, unknown>);

/** A real 1x1 PNG: the block only renders an <img> for a source that loads. */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** The toolbar is inert until the block is hovered or focused. */
const showToolbar = (component: MountResult) =>
  component.getByRole("button", { name: "Replace image" }).hover();

test("the toolbar sets width and fetch priority", async ({ mount }) => {
  const component = await mount(<BlockImageHarness initial={{ url: PNG }} />);
  await showToolbar(component);

  await component.getByRole("button", { name: "full" }).click();
  await expect.poll(() => value(component)).toMatchObject({ size: "full" });

  const priority = component.getByRole("button", { name: "Priority" });
  await priority.click();
  await expect
    .poll(() => value(component))
    .toMatchObject({ highPriority: true });

  await priority.click();
  await expect.poll(() => value(component)).not.toHaveProperty("highPriority");
});

test("alt and caption stay on the surface and round-trip", async ({
  mount,
}) => {
  const component = await mount(<BlockImageHarness initial={{ url: PNG }} />);
  await showToolbar(component);

  await component.getByPlaceholder("Alt text (accessibility)").fill("A chair");
  await component.getByPlaceholder("Add a caption…").fill("Our best seller");

  await expect
    .poll(() => value(component))
    .toMatchObject({ alt: "A chair", caption: "Our best seller" });
});

test("the mobile slot reuses the one preview instead of stacking a second", async ({
  mount,
}) => {
  const component = await mount(<BlockImageHarness initial={{ url: PNG }} />);
  await showToolbar(component);
  await expect(component.locator("img")).toHaveCount(1);

  await component
    .getByRole("button", { name: "Mobile image (below 768px)" })
    .click();
  // The desktop URL must not leak into the empty mobile slot.
  await expect(component.locator("img")).toHaveCount(0);
  await expect(
    component.getByText("Drop the mobile image or click to browse"),
  ).toBeVisible();

  await component.getByRole("button", { name: "Mobile URL" }).click();
  await component.getByPlaceholder("https://...").fill("https://x.test/m.png");
  await expect
    .poll(() => value(component))
    .toMatchObject({ url: PNG, mobileUrl: "https://x.test/m.png" });
});

test("the toolbar's URL field edits the active slot, and clearing it drops only that one", async ({
  mount,
}) => {
  const component = await mount(
    <BlockImageHarness
      initial={{ url: PNG, mobileUrl: "https://x.test/m.png" }}
    />,
  );
  await showToolbar(component);

  await component
    .getByRole("button", { name: "Mobile image (below 768px)" })
    .click();
  await component.getByRole("button", { name: "Mobile URL" }).click();
  await component.getByPlaceholder("https://...").fill("");

  await expect.poll(() => value(component)).toMatchObject({ url: PNG });
  await expect.poll(() => value(component)).not.toHaveProperty("mobileUrl");
});

test("quality writes ?quality= on the active slot's URL and clears on re-click", async ({
  mount,
}) => {
  const component = await mount(
    <BlockImageHarness initial={{ url: "https://x.test/a.png" }} />,
  );
  await showToolbar(component);
  const high = component.getByRole("button", { name: "high" });

  await high.click();
  await expect
    .poll(() => value(component))
    .toMatchObject({ url: "https://x.test/a.png?quality=high" });

  await high.click();
  await expect
    .poll(() => value(component))
    .toMatchObject({ url: "https://x.test/a.png" });
});

test("changing quality keeps the same <img>, so the frame never drops", async ({
  mount,
  page,
}) => {
  // Routed, not a data: URL — ?quality= has to still load.
  const served = "https://cdn.ct.test/a.png";
  await page.route("https://cdn.ct.test/**", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(PNG.split(",")[1]!, "base64"),
    }),
  );

  const component = await mount(
    <BlockImageHarness initial={{ url: served }} />,
  );
  await showToolbar(component);
  const img = component.locator("img");
  await expect(img).toHaveCount(1);
  await img.evaluate((el) => {
    (el as HTMLImageElement).dataset.ctMarker = "same-node";
  });

  await component.getByRole("button", { name: "high" }).click();
  await expect
    .poll(() => value(component))
    .toMatchObject({ url: `${served}?quality=high` });

  // A remount would wipe the marker, and with it the painted frame.
  await expect(img).toHaveAttribute("data-ct-marker", "same-node");
});

test("quality is hidden while the active slot has no image", async ({
  mount,
}) => {
  const component = await mount(<BlockImageHarness />);
  await expect(component.getByRole("button", { name: "high" })).toHaveCount(0);
});
