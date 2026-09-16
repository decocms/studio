import { expect, test } from "@playwright/experimental-ct-react";
import { BranchPickerHarness } from "../harness/branch-picker-harness.tsx";

test.describe("branch picker draft search", () => {
  test("filters the list by draft name", async ({ mount, page }) => {
    const component = await mount(<BranchPickerHarness count={30} />);
    await component.getByRole("button", { name: "Black Friday hero" }).click();

    const popover = page.getByRole("dialog");
    await popover.getByRole("button", { name: "Search drafts" }).click();
    await popover.getByRole("textbox", { name: "Search drafts" }).fill("natal");

    await expect(
      popover.getByText("Natal 2026", { exact: true }),
    ).toBeVisible();
    await expect(popover.getByText("Draft 3", { exact: true })).toHaveCount(0);
    await expect(
      popover.getByText("Black Friday hero", { exact: true }),
    ).toHaveCount(0);
  });

  test("matches the branch behind a renamed draft", async ({ mount, page }) => {
    const component = await mount(<BranchPickerHarness count={30} />);
    await component.getByRole("button", { name: "Black Friday hero" }).click();

    const popover = page.getByRole("dialog");
    await popover.getByRole("button", { name: "Search drafts" }).click();
    await popover
      .getByRole("textbox", { name: "Search drafts" })
      .fill("draft-2");

    await expect(
      popover.getByText("Natal 2026", { exact: true }),
    ).toBeVisible();
  });

  test("shows an empty state and restores the list on close", async ({
    mount,
    page,
  }) => {
    const component = await mount(<BranchPickerHarness count={30} />);
    await component.getByRole("button", { name: "Black Friday hero" }).click();

    const popover = page.getByRole("dialog");
    await popover.getByRole("button", { name: "Search drafts" }).click();
    const input = popover.getByRole("textbox", { name: "Search drafts" });
    await input.fill("zzzz");
    await expect(popover.getByText("No drafts found.")).toBeVisible();

    await input.press("Escape");
    await expect(popover).toBeVisible();
    await expect(popover.getByText("Draft 3", { exact: true })).toBeVisible();
  });
});
