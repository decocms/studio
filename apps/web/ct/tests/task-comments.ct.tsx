import { expect, test } from "@playwright/experimental-ct-react";
import { TaskCommentsHarness } from "../harness/task-comments-harness";

test("renders a thread as one card with its replies", async ({ mount }) => {
  const component = await mount(<TaskCommentsHarness />);

  await expect(component.getByText("valls")).toBeVisible();
  await expect(component.getByText("Super Agent").first()).toBeVisible();
  await expect(component.getByPlaceholder("Leave a reply...")).toBeVisible();
  await expect(component.getByPlaceholder("Leave a comment...")).toBeVisible();
});

test("Enter posts a comment, Shift+Enter breaks the line", async ({
  mount,
}) => {
  const component = await mount(<TaskCommentsHarness />);
  const composer = component.getByPlaceholder("Leave a comment...");

  await composer.fill("first line");
  await composer.press("Shift+Enter");
  await composer.type("second line");
  await expect(composer).toHaveValue("first line\nsecond line");

  await composer.press("Enter");
  await expect(component.getByTestId("posted")).toHaveText(
    JSON.stringify(["first line\nsecond line"]),
  );
  await expect(composer).toHaveValue("");
});

test("an empty composer cannot be submitted", async ({ mount }) => {
  const component = await mount(<TaskCommentsHarness />);

  await expect(component.getByLabel("Send").last()).toBeDisabled();
  await component.getByPlaceholder("Leave a comment...").fill("ship it");
  await expect(component.getByLabel("Send").last()).toBeEnabled();
});

test("typing @ opens the mention menu, grouped by users and tasks", async ({
  mount,
}) => {
  const component = await mount(<TaskCommentsHarness />);
  const composer = component.getByPlaceholder("Leave a comment...");

  await composer.fill("");
  await composer.type("@");
  await expect(component.getByText("Users")).toBeVisible();
  await expect(component.getByText("Tasks")).toBeVisible();
  await expect(component.getByText("Agent", { exact: true })).toBeVisible();
  await expect(component.getByText("Error screens")).toBeVisible();
});

test("a mention filters, then completes the label into the comment", async ({
  mount,
}) => {
  const component = await mount(<TaskCommentsHarness />);
  const composer = component.getByPlaceholder("Leave a comment...");

  await composer.type("cc @bea");
  await expect(component.getByText("Tasks")).toHaveCount(0);
  await component.getByRole("button", { name: "beatriz.ramos" }).click();
  await expect(composer).toHaveValue("cc @beatriz.ramos ");
});

test("Escape closes the mention menu without completing", async ({ mount }) => {
  const component = await mount(<TaskCommentsHarness />);
  const composer = component.getByPlaceholder("Leave a comment...");

  await composer.type("@bea");
  await expect(component.getByText("Users")).toBeVisible();
  await composer.press("Escape");
  await expect(component.getByText("Users")).toHaveCount(0);
  await expect(composer).toHaveValue("@bea");
});

test("the reply composer appends to the thread it belongs to", async ({
  mount,
}) => {
  const component = await mount(<TaskCommentsHarness />);
  const reply = component.getByPlaceholder("Leave a reply...");

  await reply.fill("thanks, reviewing now");
  await reply.press("Enter");
  await expect(component.getByText("thanks, reviewing now")).toBeVisible();
});

test("the composer offers no attach control until attachments exist", async ({
  mount,
}) => {
  const component = await mount(<TaskCommentsHarness />);

  await expect(component.getByLabel("Attach")).toHaveCount(0);
});

test("deleting a reply leaves the rest of the thread", async ({
  mount,
  page,
}) => {
  const component = await mount(<TaskCommentsHarness />);

  // The dropdown portals outside the mount root, so its items live on `page`.
  await component.getByLabel("Comment actions").last().click();
  await page.getByRole("menuitem", { name: "Delete" }).click();

  await expect(component.getByText(/^On it\./)).toHaveCount(0);
  await expect(
    component.getByText("can you take this one and open a PR?"),
  ).toBeVisible();
});

test("deleting the root comment takes the whole thread with it", async ({
  mount,
  page,
}) => {
  const component = await mount(<TaskCommentsHarness />);

  await component.getByLabel("Comment actions").first().click();
  await page.getByRole("menuitem", { name: "Delete" }).click();

  await expect(component.getByText(/^On it\./)).toHaveCount(0);
  await expect(component.getByPlaceholder("Leave a reply...")).toHaveCount(0);
  // The task-level composer is not part of the thread, so it survives.
  await expect(component.getByPlaceholder("Leave a comment...")).toBeVisible();
});

test("only the root comment can resolve the thread", async ({
  mount,
  page,
}) => {
  const component = await mount(<TaskCommentsHarness />);

  await component.getByLabel("Comment actions").last().click();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Resolve thread" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");

  await component.getByLabel("Comment actions").first().click();
  await expect(
    page.getByRole("menuitem", { name: "Resolve thread" }),
  ).toBeVisible();
});

test("a resolved thread collapses to a summary and reopens on click", async ({
  mount,
  page,
}) => {
  const component = await mount(<TaskCommentsHarness />);

  await component.getByLabel("Comment actions").first().click();
  await page.getByRole("menuitem", { name: "Resolve thread" }).click();

  const summary = component.getByText(
    "2 resolved comments from valls and Super Agent",
  );
  await expect(summary).toBeVisible();
  await expect(component.getByPlaceholder("Leave a reply...")).toHaveCount(0);

  await summary.click();
  await expect(component.getByText(/^On it\./)).toBeVisible();
  await expect(component.getByPlaceholder("Leave a reply...")).toBeVisible();

  // Expanded again, the menu offers the way back out.
  await component.getByLabel("Comment actions").first().click();
  await expect(
    page.getByRole("menuitem", { name: "Unresolve thread" }),
  ).toBeVisible();
});

test("an expanded resolved thread collapses from its header", async ({
  mount,
  page,
}) => {
  const component = await mount(<TaskCommentsHarness />);

  await component.getByLabel("Comment actions").first().click();
  await page.getByRole("menuitem", { name: "Resolve thread" }).click();
  await component.getByText("2 resolved comments from valls").click();

  await component.getByRole("button", { name: "Collapse" }).click();
  await expect(component.getByText(/^On it\./)).toHaveCount(0);
  await expect(
    component.getByText("2 resolved comments from valls and Super Agent"),
  ).toBeVisible();
});
