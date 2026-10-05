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
  const mobileField = component.getByPlaceholder("https://...");
  await mobileField.fill("https://x.test/m.png");
  await mobileField.press("Enter");

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
  const clearField = component.getByPlaceholder("https://...");
  await clearField.fill("");
  await clearField.press("Enter");

  await expect.poll(() => value(component)).toMatchObject({ image: PNG });
  await expect.poll(() => value(component)).not.toHaveProperty("mobileImage");
});

test("an unsafe scheme is refused at the field, never stored", async ({
  mount,
}) => {
  const component = await mount(
    <ResponsiveImageHarness initial={{ image: PNG }} />,
  );
  await showToolbar(component);
  await component.getByRole("button", { name: "URL", exact: true }).click();

  const field = component.getByPlaceholder("https://...");
  await field.fill("javascript:alert(1)");
  // While the draft is live: binding it straight to `src` is the bug this
  // guards, and only an assertion BEFORE the commit can catch it.
  await expect(component.locator("img")).toHaveAttribute("src", PNG);

  await field.press("Enter");

  await expect(
    component.getByText("That address can't be used as an image source."),
  ).toBeVisible();
  // Refused, so the previously-good image is still what is stored and shown.
  await expect.poll(() => value(component)).toMatchObject({ image: PNG });
  await expect(component.locator("img")).toHaveCount(1);
});

test("a safe URL commits on Enter", async ({ mount }) => {
  const component = await mount(<ResponsiveImageHarness />);
  await showToolbar(component);
  await component.getByRole("button", { name: "URL", exact: true }).click();

  const field = component.getByPlaceholder("https://...");
  await field.fill("https://cdn.example.com/a.png");
  await field.press("Enter");

  await expect
    .poll(() => value(component))
    .toMatchObject({ image: "https://cdn.example.com/a.png" });
});

test("an inline image payload still renders", async ({ mount }) => {
  const component = await mount(
    <ResponsiveImageHarness initial={{ image: PNG }} />,
  );
  await expect(component.locator("img")).toHaveCount(1);
});

test("an unsafe value already in the payload never reaches the src", async ({
  mount,
}) => {
  const component = await mount(
    <ResponsiveImageHarness initial={{ image: "javascript:alert(1)" }} />,
  );

  // A hand-edited decofile never went through the field's commit path.
  await expect(component.locator("img")).toHaveCount(0);
  await expect(component.getByText("Preview unavailable")).toBeVisible();
});

test("closing the URL panel with its own button keeps the typed address", async ({
  mount,
}) => {
  const component = await mount(
    <ResponsiveImageHarness initial={{ image: PNG }} />,
  );
  await showToolbar(component);

  // The toolbar button swallows mousedown to hold the editor's selection, so
  // the blur that normally commits never fires — the panel has to commit on
  // its way out or the button discards what it was opened to collect.
  await component.getByRole("button", { name: "URL", exact: true }).click();
  await component
    .getByPlaceholder("https://...")
    .fill("https://x.test/typed.png");
  await component.getByRole("button", { name: "URL", exact: true }).click();

  await expect
    .poll(() => value(component))
    .toMatchObject({ image: "https://x.test/typed.png" });
});

test("switching slot stores the address typed for the one being left", async ({
  mount,
}) => {
  const component = await mount(
    <ResponsiveImageHarness initial={{ image: PNG }} />,
  );
  await showToolbar(component);

  await component.getByRole("button", { name: "URL", exact: true }).click();
  await component
    .getByPlaceholder("https://...")
    .fill("https://x.test/desktop.png");
  await component
    .getByRole("button", { name: "Mobile image (below 768px)" })
    .click();

  await expect
    .poll(() => value(component))
    .toMatchObject({ image: "https://x.test/desktop.png" });
  // The panel followed the switch and shows the empty mobile slot.
  await expect(component.getByPlaceholder("https://...")).toHaveValue("");
});

test("a quality change is not undone by the open URL panel", async ({
  mount,
}) => {
  const component = await mount(
    <ResponsiveImageHarness initial={{ image: "https://x.test/a.png" }} />,
  );
  await showToolbar(component);

  // Both controls write the same slot, and neither blurs the other — the
  // panel's draft has to follow, or closing it replays the pre-quality URL.
  await component.getByRole("button", { name: "URL", exact: true }).click();
  await component.getByRole("button", { name: "high" }).click();
  await component.getByRole("button", { name: "URL", exact: true }).click();

  await expect
    .poll(() => value(component))
    .toMatchObject({ image: "https://x.test/a.png?quality=high" });
});

test("switching slot does not carry the edit onto a twin address", async ({
  mount,
}) => {
  // Both slots start on the same URL, so a draft tracked by value alone sees
  // no change across the switch and stays aimed at the slot being left.
  const SAME = "https://x.test/same.png";
  const component = await mount(
    <ResponsiveImageHarness initial={{ image: SAME, mobileImage: SAME }} />,
  );
  await showToolbar(component);

  await component.getByRole("button", { name: "URL", exact: true }).click();
  await component
    .getByPlaceholder("https://...")
    .fill("https://x.test/desktop-only.png");
  await component
    .getByRole("button", { name: "Mobile image (below 768px)" })
    .click();

  await expect(component.getByPlaceholder("https://...")).toHaveValue(SAME);

  await component
    .getByRole("button", { name: "Mobile URL", exact: true })
    .click();
  await expect
    .poll(() => value(component))
    .toEqual({
      image: "https://x.test/desktop-only.png",
      mobileImage: SAME,
    });
});
