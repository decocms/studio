import { expect, test } from "@playwright/experimental-ct-react";
import { VariantRenameDialogHarness } from "../harness/variant-harnesses";
import { readEvents } from "../harness/ct-utils";

/**
 * VariantRenameDialog — a controlled Radix dialog (portaled → queried via
 * `page`). Submitting fires onSubmit with the trimmed name; Cancel / dismiss
 * fires onOpenChange(false). The name input is prefilled with initialName and
 * uses autoLabel as its placeholder.
 */

test("renders prefilled with initialName and autoLabel placeholder", async ({
  mount,
  page,
}) => {
  await mount(
    <VariantRenameDialogHarness initialName="Holiday" autoLabel="Mobile" />,
  );
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("Rename variant")).toBeVisible();
  const input = page.getByLabel("Name", { exact: true });
  await expect(input).toHaveValue("Holiday");
});

test("empty initialName falls back to autoLabel as placeholder", async ({
  mount,
  page,
}) => {
  await mount(
    <VariantRenameDialogHarness initialName="" autoLabel="Mobile users" />,
  );
  const input = page.getByLabel("Name", { exact: true });
  await expect(input).toHaveValue("");
  await expect(input).toHaveAttribute("placeholder", "Mobile users");
});

test("typing a name and Save fires onSubmit", async ({ mount, page }) => {
  const component = await mount(
    <VariantRenameDialogHarness initialName="" autoLabel="Mobile" />,
  );
  await page.getByLabel("Name", { exact: true }).fill("Spring sale");
  await page.getByRole("button", { name: "Save" }).click();
  await expect
    .poll(() => readEvents(component))
    .toEqual([{ type: "submit", name: "Spring sale" }]);
});

test("Save trims surrounding whitespace from the name", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <VariantRenameDialogHarness initialName="" autoLabel="Mobile" />,
  );
  await page.getByLabel("Name", { exact: true }).fill("   Padded   ");
  await page.getByRole("button", { name: "Save" }).click();
  await expect
    .poll(() => readEvents(component))
    .toEqual([{ type: "submit", name: "Padded" }]);
});

test("Cancel fires onOpenChange(false)", async ({ mount, page }) => {
  const component = await mount(
    <VariantRenameDialogHarness initialName="Holiday" autoLabel="Mobile" />,
  );
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect
    .poll(() => readEvents(component))
    .toContainEqual({ type: "openChange", open: false });
});
