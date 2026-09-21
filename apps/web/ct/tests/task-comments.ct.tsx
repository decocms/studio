import { expect, test } from "@playwright/experimental-ct-react";
import {
  TaskCommentsDialogHarness,
  TaskCommentsHarness,
} from "../harness/task-comments-harness";

test("renders a thread as one card with its replies", async ({ mount }) => {
  const component = await mount(<TaskCommentsHarness />);

  await expect(component.getByText("valls")).toBeVisible();
  await expect(component.getByText("Super Agent").first()).toBeVisible();
  await expect(
    component.getByRole("textbox", { name: "Leave a reply..." }),
  ).toHaveCount(0);
  await expect(
    component.getByRole("textbox", { name: "Leave a comment..." }),
  ).toBeVisible();
});

test("Enter posts a comment, Shift+Enter breaks the line", async ({
  mount,
}) => {
  const component = await mount(<TaskCommentsHarness />);
  const composer = component.getByRole("textbox", {
    name: "Leave a comment...",
  });

  await composer.fill("first line");
  await composer.press("Shift+Enter");
  await composer.pressSequentially("second line");
  await expect(composer).toHaveText("first linesecond line");

  await composer.press("Enter");
  // Two trailing spaces: the line break is a markdown hard break now, not the
  // bare newline the textarea produced — which only rendered as a break
  // because the parser was told to treat one that way.
  await expect(component.getByTestId("posted")).toHaveText(
    JSON.stringify(["first line  \nsecond line"]),
  );
  await expect(composer).toHaveText("");
});

test("an empty composer cannot be submitted", async ({ mount }) => {
  const component = await mount(<TaskCommentsHarness />);

  await expect(component.getByLabel("Send").last()).toBeDisabled();
  await component
    .getByRole("textbox", { name: "Leave a comment..." })
    .fill("ship it");
  await expect(component.getByLabel("Send").last()).toBeEnabled();
});

test("existing agent replies share the single task composer", async ({
  mount,
}) => {
  const component = await mount(<TaskCommentsHarness />);
  await expect(component.getByRole("textbox")).toHaveCount(1);
  await expect(component.getByText(/^On it\./)).toBeVisible();
});

test("the composer offers no attach control until attachments exist", async ({
  mount,
}) => {
  const component = await mount(<TaskCommentsHarness />);

  await expect(component.getByLabel("Attach")).toHaveCount(0);
});

test("the send button still submits, despite the card-wide focus click", async ({
  mount,
}) => {
  const component = await mount(<TaskCommentsHarness />);

  await component
    .getByRole("textbox", { name: "Leave a comment..." })
    .fill("via the button");
  await component.getByLabel("Send").last().click();
  await expect(component.getByTestId("posted")).toHaveText(
    JSON.stringify(["via the button"]),
  );
});

test("clicking anywhere in the comment card focuses the input", async ({
  mount,
}) => {
  const component = await mount(<TaskCommentsHarness />);
  const composer = component.getByRole("textbox", {
    name: "Leave a comment...",
  });
  const card = component.getByTestId("new-comment-composer");

  // Bottom-left of the card: empty space well below the one-line input.
  const box = (await card.boundingBox())!;
  await card.click({ position: { x: 12, y: box.height - 6 } });
  await expect(composer).toBeFocused();
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
  await expect(
    component.getByRole("textbox", { name: "Leave a reply..." }),
  ).toHaveCount(0);
  // The task-level composer is not part of the thread, so it survives.
  await expect(
    component.getByRole("textbox", { name: "Leave a comment..." }),
  ).toBeVisible();
});

for (const conversation of [false, true]) {
  for (const resolved of [false, true]) {
    test(`comments stay visible without resolve controls (conversation=${conversation}, resolved=${resolved})`, async ({
      mount,
      page,
    }) => {
      const component = await mount(
        <TaskCommentsHarness conversation={conversation} resolved={resolved} />,
      );
      await expect(
        component.getByText("Can you take this one and open a PR?"),
      ).toBeVisible();
      await expect(component.getByText(/^On it/)).toBeVisible();
      await expect(
        component.getByRole("button", { name: "Collapse", exact: true }),
      ).toHaveCount(0);
      for (const entry of [0, 1]) {
        await component.getByLabel("Comment actions").nth(entry).click();
        await expect(
          page.getByRole("menuitem", { name: "Delete", exact: true }),
        ).toBeVisible();
        await expect(page.getByRole("menuitem")).toHaveCount(1);
        await expect(
          page.getByRole("menuitem", { name: /resolve/i }),
        ).toHaveCount(0);
        await page.keyboard.press("Escape");
      }
    });
  }
}

test("typing @ opens the member picker, and picking one inserts a chip", async ({
  mount,
  page,
}) => {
  const component = await mount(<TaskCommentsHarness />);
  const composer = component.getByRole("textbox", {
    name: "Leave a comment...",
  });

  await composer.click();
  await composer.pressSequentially("ping @");
  // The menu portals to the body, so it lives on `page`, not the mount root.
  const menu = page.getByTestId("mention-menu");
  await expect(menu).toBeVisible();

  // Opening moves focus into the menu's own search field — the picker is a
  // real combobox, not a list that reads the document behind it.
  const search = menu.getByPlaceholder("Search members...");
  await expect(search).toBeFocused();

  await search.fill("an");
  await expect(menu.getByText("Ana Silva")).toBeVisible();
  await expect(menu.getByText("Bruno")).toHaveCount(0);

  // Email matches too, so you can find someone whose display name you can't
  // spell.
  await search.fill("bruno@deco.cx");
  await expect(menu.getByText("Bruno")).toBeVisible();

  await search.fill("ana");
  await search.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(component.getByTestId("mention-chip")).toHaveText("@Ana Silva");

  // The id is what goes on the wire, not the name that was typed.
  await composer.press("Enter");
  await expect(component.getByTestId("posted")).toHaveText(
    JSON.stringify(["ping [@Ana Silva](mention:u2)"]),
  );
});

test("the picker's list scrolls rather than clipping its members", async ({
  mount,
  page,
}) => {
  const component = await mount(<TaskCommentsHarness />);
  const composer = component.getByRole("textbox", {
    name: "Leave a comment...",
  });

  await composer.click();
  await composer.pressSequentially("@");
  const list = page.getByTestId("mention-menu").locator("[cmdk-list]");
  await expect(list).toBeVisible();

  // The list is its own scroll container, and the wrapper never clips it
  // shorter than that: a clipped list hides members instead of scrolling to
  // them, which is exactly what the first cut of this menu did.
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(
    true,
  );
  await list.evaluate((el) => el.scrollBy(0, 40));
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  // The last member is reachable — the point of scrolling.
  const last = page.getByTestId("mention-menu").getByText("Coworker 25");
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeVisible();
});

test("Escape dismisses the picker and leaves the typed text alone", async ({
  mount,
  page,
}) => {
  const component = await mount(<TaskCommentsHarness />);
  const composer = component.getByRole("textbox", {
    name: "Leave a comment...",
  });

  await composer.click();
  await composer.pressSequentially("hey @");
  const menu = page.getByTestId("mention-menu");
  await expect(menu).toBeVisible();

  await menu.getByPlaceholder("Search members...").press("Escape");
  await expect(menu).toHaveCount(0);
  // Escape hands the caret back, and what was typed is untouched.
  await expect(composer).toHaveText("hey @");
  await expect(composer).toBeFocused();

  // Enter now sends, because the picker no longer owns it.
  await composer.press("Enter");
  await expect(component.getByTestId("posted")).toHaveText(
    JSON.stringify(["hey @"]),
  );
});

test("clicking away dismisses the picker without stealing the caret back", async ({
  mount,
  page,
}) => {
  const component = await mount(<TaskCommentsHarness />);
  const composer = component.getByRole("textbox", {
    name: "Leave a comment...",
  });

  await composer.click();
  await composer.pressSequentially("@");
  await expect(page.getByTestId("mention-menu")).toBeVisible();

  await component.getByTestId("posted").click();
  await expect(page.getByTestId("mention-menu")).toHaveCount(0);
  // The click chose where focus goes; the dismissal must not undo that.
  await expect(component.getByTestId("posted")).toBeFocused();
});

test("inside a modal dialog the picker is still clickable, typable and scrollable", async ({
  mount,
  page,
}) => {
  // Addressed through `page`, not the mount root: Radix portals the dialog's
  // content out of it, so none of this is under the harness's own element.
  await mount(<TaskCommentsDialogHarness />);
  const dialog = page.getByRole("dialog");
  const composer = dialog.getByRole("textbox", { name: "Leave a comment..." });

  await composer.click();
  await composer.pressSequentially("@");
  const menu = page.getByTestId("mention-menu");
  await expect(menu).toBeVisible();

  // Rendering is not the bar. A modal Radix dialog covers everything in an
  // overlay and puts `pointer-events: none` on the body, so a menu that lands
  // outside the dialog — or spills outside its clipping box — is inert:
  // unclickable, with the wheel going to whatever is behind it.
  const search = menu.getByPlaceholder("Search members...");
  await search.click();
  await expect(search).toBeFocused();
  await search.pressSequentially("ana");
  await expect(search).toHaveValue("ana");
  await expect(menu.getByText("Ana Silva")).toBeVisible();

  // The menu has to sit INSIDE the dialog that clips it — a taller-than-the-
  // gap menu flips its top edge out of the dialog, and the overlay is then
  // what the pointer finds there.
  const box = (await menu.boundingBox())!;
  const dialogBox = (await dialog.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(dialogBox.y);
  expect(box.y + box.height).toBeLessThanOrEqual(
    dialogBox.y + dialogBox.height,
  );

  // And the wheel belongs to the list, not to whatever sits behind it.
  await search.fill("");
  const list = menu.locator("[cmdk-list]");
  const scroller = dialog.locator(".overflow-y-auto").first();
  const before = await scroller.evaluate((el) => el.scrollTop);
  await list.hover();
  await page.mouse.wheel(0, 120);
  await expect
    .poll(() => list.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(before);

  // It still does its job from in here.
  await menu.getByText("Ana Silva").click();
  await expect(page.getByTestId("mention-chip")).toHaveText("@Ana Silva");
});
