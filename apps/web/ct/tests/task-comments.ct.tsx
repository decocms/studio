import type { Locator, Page } from "@playwright/test";
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

const uploadUrl = (path: string) =>
  `/api/acme/fs/uploads/read?path=${encodeURIComponent(path)}`;

test("the paperclip attaches a file as a chip, posted as a link", async ({
  mount,
}) => {
  const component = await mount(<TaskCommentsHarness />);
  const composer = component.getByRole("textbox", {
    name: "Leave a comment...",
  });

  await expect(
    component.getByRole("button", { name: "Attach file" }),
  ).toBeVisible();
  await component.locator('input[type="file"]').setInputFiles({
    name: "spec.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4"),
  });
  await expect(
    component.getByRole("link", { name: "Download spec.pdf" }),
  ).toBeVisible();

  await composer.press("Enter");
  await expect(component.getByTestId("posted")).toHaveText(
    JSON.stringify([`[spec.pdf](${uploadUrl("editor-files/spec.pdf")})`]),
  );
  await expect(
    component.getByRole("link", { name: "Download spec.pdf" }),
  ).toHaveCount(0);
});

test("files are posted in the order they were attached, image first", async ({
  mount,
}) => {
  const component = await mount(<TaskCommentsHarness />);
  const picker = component.locator('input[type="file"]');

  await picker.setInputFiles({
    name: "shot.png",
    mimeType: "image/png",
    buffer: Buffer.from("png"),
  });
  await expect(component.getByRole("img", { name: "shot.png" })).toBeVisible();
  await picker.setInputFiles({
    name: "spec.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4"),
  });
  await expect(
    component.getByRole("link", { name: "Download spec.pdf" }),
  ).toBeVisible();

  await component.getByLabel("Send").last().click();
  await expect(component.getByTestId("posted")).toHaveText(
    JSON.stringify([
      `![shot.png](${uploadUrl("editor-images/shot.png")})\n\n[spec.pdf](${uploadUrl("editor-files/spec.pdf")})`,
    ]),
  );
});

test("an image on its own is a comment you can send", async ({ mount }) => {
  const component = await mount(<TaskCommentsHarness />);
  const send = component.getByLabel("Send").last();

  await expect(send).toBeDisabled();
  await component.locator('input[type="file"]').setInputFiles({
    name: "shot.png",
    mimeType: "image/png",
    buffer: Buffer.from("png"),
  });
  await expect(component.getByRole("img", { name: "shot.png" })).toBeVisible();
  await expect(send).toBeEnabled();

  await send.click();
  await expect(component.getByTestId("posted")).toHaveText(
    JSON.stringify([`![shot.png](${uploadUrl("editor-images/shot.png")})`]),
  );
});

test("a file dropped on the card, outside the text, is attached", async ({
  mount,
  page,
}) => {
  const component = await mount(<TaskCommentsHarness />);
  const card = component.getByTestId("new-comment-composer");
  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(["notes"], "notes.txt", { type: "text/plain" }),
    );
    return transfer;
  });

  await card.dispatchEvent("dragenter", { dataTransfer });
  await expect(component.getByText("Drop to attach")).toBeVisible();
  await card.dispatchEvent("dragover", { dataTransfer });
  await card.dispatchEvent("drop", { dataTransfer });

  await expect(component.getByText("Drop to attach")).toHaveCount(0);
  await expect(
    component.getByRole("link", { name: "Download notes.txt" }),
  ).toBeVisible();
});

/** Dispatches a real paste on the field, carrying what a copy put on the clipboard. */
async function paste(
  field: Locator,
  clip: { text?: string; html?: string; file?: boolean },
) {
  await field.click();
  await field.evaluate((el, { text, html, file }) => {
    const data = new DataTransfer();
    if (text) data.setData("text/plain", text);
    if (html) data.setData("text/html", html);
    if (file) {
      data.items.add(new File(["png"], "image.png", { type: "image/png" }));
    }
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, clip);
}

test("a spreadsheet copy pastes its text, not the picture beside it", async ({
  mount,
}) => {
  const component = await mount(<TaskCommentsHarness />);
  const composer = component.getByRole("textbox", {
    name: "Leave a comment...",
  });

  await paste(composer, {
    text: "Q3\t1200",
    html: "<table><tr><td>Q3</td><td>1200</td></tr></table>",
    file: true,
  });
  await expect(composer).toContainText("Q3");
  await expect(composer).toContainText("1200");
  await expect(component.locator('img[alt="image.png"]')).toHaveCount(0);
  await expect(component.getByRole("status")).toHaveCount(0);
});

test("a pasted screenshot, with no text beside it, is attached", async ({
  mount,
}) => {
  const component = await mount(<TaskCommentsHarness />);
  const composer = component.getByRole("textbox", {
    name: "Leave a comment...",
  });

  await paste(composer, { file: true });
  await expect(component.getByRole("img", { name: "image.png" })).toBeVisible();
});

test("a posted attachment reads as a chip, while other links stay links", async ({
  mount,
}) => {
  const component = await mount(
    <TaskCommentsHarness
      rootBody={`Spec: [spec.pdf](${uploadUrl("editor-files/spec.pdf")}) and [the docs](https://example.com/spec.pdf)`}
    />,
  );

  const download = component.getByRole("link", { name: "Download spec.pdf" });
  await expect(download).toBeVisible();
  await expect(download).toHaveAttribute("download", "spec.pdf");
  await expect(
    component.getByRole("link", { name: "spec.pdf", exact: true }),
  ).toHaveCount(0);
  await expect(
    component.getByRole("link", { name: "the docs" }),
  ).toHaveAttribute("href", "https://example.com/spec.pdf");
});

/** Serves each editor image as an SVG of the size in its name, e.g. `tall-1200x1800.png`. */
async function serveSizedImages(page: Page) {
  await page.route(/\/api\/acme\/fs\/uploads\/read\?/, (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    const [, width, height] = /(\d+)x(\d+)/.exec(path ?? "") ?? [];
    return route.fulfill({
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#9c9"/></svg>`,
    });
  });
}

/** The image's laid-out box, once its bytes have arrived and given it a size. */
async function loadedBox(image: Locator) {
  await expect
    .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);
  return (await image.boundingBox())!;
}

const editorImage = (name: string, size: string) =>
  `![${name}](${uploadUrl(`editor-images/${name.replace(".png", `-${size}.png`)}`)})`;

test("a tall posted image is a thumbnail, and opens whole", async ({
  mount,
  page,
}) => {
  await serveSizedImages(page);
  const component = await mount(
    <TaskCommentsHarness rootBody={editorImage("tall.png", "1200x1800")} />,
  );

  const thumbnail = component.getByRole("img", { name: "tall.png" });
  const box = await loadedBox(thumbnail);
  expect(box.height).toBeLessThanOrEqual(320);
  // Scaled down, not cropped.
  expect(box.width / box.height).toBeCloseTo(1200 / 1800, 1);

  await thumbnail.click();
  const full = page.getByRole("dialog").getByRole("img", { name: "tall.png" });
  expect((await loadedBox(full)).height).toBeGreaterThan(box.height);
});

test("a wide posted image fits the comment's width", async ({
  mount,
  page,
}) => {
  await serveSizedImages(page);
  const component = await mount(
    <TaskCommentsHarness rootBody={editorImage("pano.png", "4000x500")} />,
  );

  const box = await loadedBox(component.getByRole("img", { name: "pano.png" }));
  const comment = (await component
    .getByTestId("task-message")
    .first()
    .boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(comment.x + comment.width);
  expect(box.width / box.height).toBeCloseTo(4000 / 500, 0);
});

test("images posted together wrap side by side, and text stays below them", async ({
  mount,
  page,
}) => {
  await serveSizedImages(page);
  const component = await mount(
    <TaskCommentsHarness
      rootBody={[
        editorImage("a.png", "1200x1800"),
        editorImage("b.png", "1200x1800"),
        editorImage("c.png", "1200x1800"),
        "after the images",
      ].join("\n\n")}
    />,
  );

  const [a, b, c] = await Promise.all(
    ["a.png", "b.png", "c.png"].map((name) =>
      loadedBox(component.getByRole("img", { name })),
    ),
  );
  // Two thumbnails fit the 640px harness; the third wraps under the first.
  expect(b!.y).toBe(a!.y);
  expect(b!.x).toBeGreaterThan(a!.x + a!.width);
  expect(c!.x).toBe(a!.x);
  expect(c!.y).toBeGreaterThan(a!.y + a!.height);
  const text = (await component.getByText("after the images").boundingBox())!;
  expect(text.y).toBeGreaterThan(c!.y + c!.height);
});

test("a comment can't be sent while its attachment is still uploading", async ({
  mount,
  page,
}) => {
  const component = await mount(<TaskCommentsHarness />);
  const composer = component.getByRole("textbox", {
    name: "Leave a comment...",
  });
  const send = component.getByLabel("Send").last();

  await composer.fill("see attached");
  await component.locator('input[type="file"]').setInputFiles({
    name: "hold-deck.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4"),
  });
  await expect(component.getByRole("status")).toHaveText("Uploading file…");
  await expect(send).toBeDisabled();

  // Enter is the other way to send, and it has to wait too.
  await composer.press("Enter");
  await expect(component.getByTestId("posted")).toHaveText("[]");

  await page.evaluate(() =>
    window.dispatchEvent(new Event("ct:release-uploads")),
  );
  await expect(component.getByRole("status")).toHaveCount(0);
  await expect(send).toBeEnabled();
  await send.click();
  // The chip lands at the caret, set off from the typed text by a space.
  await expect(component.getByTestId("posted")).toHaveText(
    JSON.stringify([
      `see attached [hold-deck.pdf](${uploadUrl("editor-files/hold-deck.pdf")})`,
    ]),
  );
});

test("clearing the text mid-batch still lets the rest of it land, and send", async ({
  mount,
  page,
}) => {
  const component = await mount(<TaskCommentsHarness />);
  const composer = component.getByRole("textbox", {
    name: "Leave a comment...",
  });
  const send = component.getByLabel("Send").last();
  const file = (name: string) => ({
    name,
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4"),
  });

  await composer.fill("a line long enough to leave a stale caret behind");
  await component
    .locator('input[type="file"]')
    .setInputFiles([file("hold-a.pdf"), file("b.pdf"), file("c.pdf")]);
  await expect(component.getByRole("status")).toHaveText("Uploading 3 files…");

  // The caret the batch started from is now past the end of the document.
  await composer.press("ControlOrMeta+a");
  await composer.press("Backspace");
  await page.evaluate(() =>
    window.dispatchEvent(new Event("ct:release-uploads")),
  );

  await expect(component.getByRole("status")).toHaveCount(0);
  await expect(send).toBeEnabled();
  for (const name of ["hold-a.pdf", "b.pdf", "c.pdf"]) {
    await expect(
      component.getByRole("link", { name: `Download ${name}` }),
    ).toBeVisible();
  }
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
