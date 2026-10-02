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

const PNG = {
  name: "shot.png",
  mimeType: "image/png",
  buffer: Buffer.from("png"),
};
const PDF = {
  name: "spec.pdf",
  mimeType: "application/pdf",
  buffer: Buffer.from("pdf"),
};
const link = (name: string) =>
  `/api/acme/fs/uploads/read?path=${encodeURIComponent(`task-comments/tbi_1/${name}`)}`;

test("the paperclip attaches picked files as previews", async ({
  mount,
  page,
}) => {
  const component = await mount(<TaskCommentsHarness />);

  const chooser = page.waitForEvent("filechooser");
  await component.getByRole("button", { name: "Attach file" }).click();
  await (await chooser).setFiles([PNG, PDF]);

  const attachments = component.getByRole("list", { name: "Attachments" });
  await expect(
    attachments.getByRole("img", { name: "shot.png" }),
  ).toBeVisible();
  await expect(attachments.getByText("spec.pdf")).toBeVisible();
});

test("a comment can be only attachments", async ({ mount, page }) => {
  const component = await mount(<TaskCommentsHarness />);

  const chooser = page.waitForEvent("filechooser");
  await component.getByRole("button", { name: "Attach file" }).click();
  await (await chooser).setFiles([PDF]);
  await component.getByLabel("Send").last().click();

  await expect(component.getByTestId("posted")).toHaveText(
    JSON.stringify([`[spec.pdf](${link("spec.pdf")})`]),
  );
  // The draft is spent: its files go with the comment.
  await expect(
    component.getByRole("list", { name: "Attachments" }),
  ).toHaveCount(0);
});

test("Enter posts the text with its attachments after it", async ({
  mount,
  page,
}) => {
  const component = await mount(<TaskCommentsHarness />);
  const composer = component.getByRole("textbox", {
    name: "Leave a comment...",
  });

  const chooser = page.waitForEvent("filechooser");
  await component.getByRole("button", { name: "Attach file" }).click();
  await (await chooser).setFiles([PNG]);
  await composer.fill("the checkout breaks");
  await composer.press("Enter");

  await expect(component.getByTestId("posted")).toHaveText(
    JSON.stringify([`the checkout breaks\n\n![shot.png](${link("shot.png")})`]),
  );
});

test("dropping files on the composer attaches them", async ({
  mount,
  page,
}) => {
  const component = await mount(<TaskCommentsHarness />);
  const card = component.getByTestId("new-comment-composer");

  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["notes"], "notes.txt", { type: "text/plain" }));
    return dt;
  });
  await card.dispatchEvent("dragenter", { dataTransfer });
  await card.dispatchEvent("dragover", { dataTransfer });
  await card.dispatchEvent("drop", { dataTransfer });

  await expect(
    component.getByRole("list", { name: "Attachments" }).getByText("notes.txt"),
  ).toBeVisible();
});

test("pasting a screenshot attaches it, but text that carries a picture pastes as text", async ({
  mount,
}) => {
  const component = await mount(<TaskCommentsHarness />);
  const composer = component.getByRole("textbox", {
    name: "Leave a comment...",
  });

  // A spreadsheet's copy carries a picture of the cells next to their text.
  await composer.evaluate((el) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "Q3 numbers");
    dt.items.add(new File(["png"], "image.png", { type: "image/png" }));
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(composer).toHaveText("Q3 numbers");
  await expect(
    component.getByRole("list", { name: "Attachments" }),
  ).toHaveCount(0);

  // A screenshot is only the picture.
  await composer.evaluate((el) => {
    const dt = new DataTransfer();
    dt.items.add(new File(["png"], "image.png", { type: "image/png" }));
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(
    component
      .getByRole("list", { name: "Attachments" })
      .getByRole("img", { name: "image.png" }),
  ).toBeVisible();
});

test("an SVG is attached as a file, never shown or posted as an image", async ({
  mount,
  page,
}) => {
  const component = await mount(<TaskCommentsHarness />);

  const chooser = page.waitForEvent("filechooser");
  await component.getByRole("button", { name: "Attach file" }).click();
  await (await chooser).setFiles([
    {
      name: "logo.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
    },
  ]);
  const attachments = component.getByRole("list", { name: "Attachments" });
  await expect(attachments.getByText("logo.svg")).toBeVisible();
  await expect(attachments.getByRole("img")).toHaveCount(0);

  await component.getByLabel("Send").last().click();
  await expect(component.getByTestId("posted")).toHaveText(
    JSON.stringify([`[logo.svg](${link("logo.svg")})`]),
  );
});

test("a removed preview is not posted", async ({ mount, page }) => {
  const component = await mount(<TaskCommentsHarness />);

  const chooser = page.waitForEvent("filechooser");
  await component.getByRole("button", { name: "Attach file" }).click();
  await (await chooser).setFiles([PNG, PDF]);
  await component.getByRole("button", { name: "Remove shot.png" }).click();
  await component.getByLabel("Send").last().click();

  await expect(component.getByTestId("posted")).toHaveText(
    JSON.stringify([`[spec.pdf](${link("spec.pdf")})`]),
  );
});

test("a file over the size limit, or past ten, is turned away", async ({
  mount,
  page,
}) => {
  const component = await mount(<TaskCommentsHarness />);
  const attach = component.getByRole("button", { name: "Attach file" });

  let chooser = page.waitForEvent("filechooser");
  await attach.click();
  await (await chooser).setFiles([
    {
      name: "huge.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
    },
  ]);
  await expect(
    component.getByRole("list", { name: "Attachments" }),
  ).toHaveCount(0);

  chooser = page.waitForEvent("filechooser");
  await attach.click();
  await (await chooser).setFiles(
    Array.from({ length: 11 }, (_, i) => ({
      name: `note-${i}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from("x"),
    })),
  );
  await expect(
    component.getByRole("list", { name: "Attachments" }).getByRole("listitem"),
  ).toHaveCount(10);
});

test("a failed upload keeps the draft for another try", async ({
  mount,
  page,
}) => {
  const component = await mount(<TaskCommentsHarness />);
  const composer = component.getByRole("textbox", {
    name: "Leave a comment...",
  });

  const chooser = page.waitForEvent("filechooser");
  await component.getByRole("button", { name: "Attach file" }).click();
  await (await chooser).setFiles([{ ...PDF, name: "fail-spec.pdf" }]);
  await composer.fill("see attached");
  await composer.press("Enter");

  await expect(component.getByTestId("posted")).toHaveText("[]");
  await expect(composer).toHaveText("see attached");
  await expect(
    component
      .getByRole("list", { name: "Attachments" })
      .getByText("fail-spec.pdf"),
  ).toBeVisible();
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

for (const resolved of [false, true]) {
  test(`comments stay visible without resolve controls (resolved=${resolved})`, async ({
    mount,
    page,
  }) => {
    const component = await mount(<TaskCommentsHarness resolved={resolved} />);
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
