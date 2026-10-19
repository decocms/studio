/**
 * E2E: an open section form must not revert another editor's change.
 *
 * Every autosave writes the whole block, built from the copy the form loaded.
 * When another editor changes the same block in the meantime (a draft
 * published to the branch, a sync moved it), saving that copy silently put
 * the old values back. The save now names the version it was made against;
 * the server refuses a stale one, and the editor applies the form's edits on
 * top of the stored version: edits to different values are both kept, values
 * both changed wait for the user to choose whose version to keep (a dialog,
 * value by value), a section pushed to another position is followed there,
 * and a page save outside the form is replayed on the fresh page.
 *
 * Wire-contract strings (labels, toast copy) are inlined on purpose — this
 * suite owns its contract (see ban-e2e-app-imports).
 */

import type { APIRequestContext, Page } from "@playwright/test";
import {
  createFastPreviewProject,
  seedStubRepo,
  uniqueOwner,
} from "../fixtures/fast-preview";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { startPreviewSite } from "../fixtures/preview-site";
import { expect, test } from "../fixtures/test";

test.use({ newBlocksEditor: true });

const MERGED = "This block was updated while you were editing";

/** The dialog that asks whose version to keep for values both changed. */
// An alert dialog: it must be answered (no close button, Escape or click
// outside).
const conflictDialog = (page: Page) =>
  page.getByRole("alertdialog", {
    name: "Someone else changed this while you were editing",
  });

const hero = {
  __resolveType: "site/sections/HeroSlideShow.tsx",
  headline: "Original headline",
  subtitle: "Original subtitle",
  slides: [{ title: "First slide", description: "Original description" }],
};

const meta = {
  manifest: {
    blocks: {
      pages: { "website/pages/Page.tsx": { $ref: "#/definitions/Page" } },
      sections: {
        "site/sections/HeroSlideShow.tsx": {
          $ref: "#/definitions/HeroSlideShow",
        },
      },
    },
  },
  schema: {
    definitions: {
      Page: { type: "object", properties: {} },
      HeroSlideShow: {
        type: "object",
        title: "HeroSlideShow",
        properties: {
          headline: { type: "string", title: "Headline" },
          subtitle: { type: "string", title: "Subtitle" },
          slides: {
            type: "array",
            title: "Slides",
            items: {
              type: "object",
              properties: {
                title: { type: "string", title: "Title" },
                description: { type: "string", title: "Description" },
              },
            },
          },
        },
      },
    },
  },
};

/** Seed a project whose Home page holds `homeSection`, and open the Site Editor on `branch`. */
async function loadEditor(
  page: Page,
  orgSlug: string,
  previewServerUrl: string,
  homeSection: unknown,
  branch = "main",
) {
  const api = page.request;
  const owner = uniqueOwner();
  const repo = "stale-form";
  const project = await createFastPreviewProject(api, orgSlug, {
    owner,
    repo,
    connectionUrl: "http://127.0.0.1:1/unused",
    previewServerUrl,
  });
  await seedStubRepo(api, {
    owner,
    repo,
    defaultBranch: "main",
    branches: {
      main: {
        files: {
          ".deco/meta.gen.json": JSON.stringify(meta),
          ".deco/blocks/home.json": JSON.stringify({
            __resolveType: "website/pages/Page.tsx",
            name: "Home",
            path: "/",
            sections: [homeSection],
          }),
          ".deco/blocks/SharedHero.json": JSON.stringify(hero),
        },
      },
      // No files: the draft starts at main's head, with nothing of its own.
      ...(branch === "main" ? {} : { [branch]: null }),
    },
  });
  const { item: thread } = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_THREADS_CREATE",
    { data: { virtual_mcp_id: project.vmcpId, branch } },
  );
  await page.goto(
    `/${orgSlug}/projects/${project.vmcpId}/site-editor?thread=${thread.id}&sidepanel=false`,
  );
  const blocks = page.getByTestId("blocks-panel");
  const url = `/api/${orgSlug}/decofile/${project.vmcpId}/${branch}`;
  return { blocks, url, vmcpId: project.vmcpId };
}

/** {@link loadEditor}, then open the Home page's hero section form. */
async function openEditor(
  page: Page,
  orgSlug: string,
  previewServerUrl: string,
  homeSection: unknown,
  branch = "main",
) {
  const { blocks, url, vmcpId } = await loadEditor(
    page,
    orgSlug,
    previewServerUrl,
    homeSection,
    branch,
  );
  await blocks
    .getByRole("button", { name: /HeroSlideShow|SharedHero/ })
    .first()
    .click({ timeout: 60_000 });
  const headline = blocks.getByRole("textbox", {
    name: "Headline",
    exact: true,
  });
  await expect(headline).toHaveValue("Original headline");
  return {
    blocks,
    headline,
    vmcpId,
    url,
  };
}

/** Another editor's whole-block write, made against what is stored. */
async function writeElsewhere(
  api: APIRequestContext,
  url: string,
  key: string,
  value: unknown,
) {
  const res = await api.patch(url, { data: { set: { [key]: value } } });
  expect(res.ok()).toBe(true);
}

/**
 * Counts the toasts containing `text` from now on, as they appear: one shown
 * twice counts twice, and one that expired still counts.
 */
async function countToasts(page: Page, text: string) {
  await page.evaluate((needle) => {
    const seen = new WeakSet<Element>();
    const w = window as unknown as { __toastCounts?: Record<string, number> };
    w.__toastCounts = { ...w.__toastCounts, [needle]: 0 };
    new MutationObserver(() => {
      for (const el of document.querySelectorAll("[data-sonner-toast]")) {
        if (seen.has(el) || !(el.textContent ?? "").includes(needle)) continue;
        seen.add(el);
        const counts = w.__toastCounts ?? {};
        counts[needle] = (counts[needle] ?? 0) + 1;
      }
    }).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }, text);
  return () =>
    page.evaluate(
      (needle) =>
        (window as unknown as { __toastCounts?: Record<string, number> })
          .__toastCounts?.[needle] ?? 0,
      text,
    );
}

async function storedBlock(api: APIRequestContext, url: string, key: string) {
  const res = await api.get(url);
  const body = (await res.json()) as { decofile: Record<string, unknown> };
  return body.decofile[key];
}

test.describe("Site Editor stale section form", () => {
  test.setTimeout(120_000);

  test("a saved block's form keeps another editor's change and its own edit", async ({
    authedPage: { page, orgSlug },
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const previewSite = await startPreviewSite();
    try {
      const { blocks, headline, url } = await openEditor(
        page,
        orgSlug,
        previewSite.url,
        { __resolveType: "SharedHero" },
      );
      const published = {
        ...hero,
        slides: [{ title: "First slide", description: "Published elsewhere" }],
      };
      await writeElsewhere(page.request, url, "SharedHero", published);

      // The form still holds the copy it loaded; its edit lands on top of
      // the other editor's change instead of reverting it.
      await headline.fill("Draft headline");
      await expect(page.getByText(MERGED)).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(() => storedBlock(page.request, url, "SharedHero"))
        .toEqual({ ...published, headline: "Draft headline" });
      await expect(headline).toHaveValue("Draft headline");
      // Different fields: merged without asking.
      await expect(conflictDialog(page)).toHaveCount(0);

      // The form now shows the merged block, so a further edit keeps it too.
      await headline.fill("Second edit");
      await expect
        .poll(() => storedBlock(page.request, url, "SharedHero"))
        .toEqual({ ...published, headline: "Second edit" });
      await blocks.getByRole("button", { name: /^First slide/ }).click();
      await expect(
        blocks.getByRole("textbox", { name: "Description", exact: true }),
      ).toHaveValue("Published elsewhere");
    } finally {
      await previewSite.close();
    }
  });

  test("an inline section's form keeps another editor's change and its own edit", async ({
    authedPage: { page, orgSlug },
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const previewSite = await startPreviewSite();
    try {
      const { headline, url } = await openEditor(
        page,
        orgSlug,
        previewSite.url,
        hero,
      );
      const page1 = (await storedBlock(page.request, url, "home")) as Record<
        string,
        unknown
      >;
      const published = {
        ...page1,
        sections: [
          {
            ...hero,
            slides: [
              { title: "First slide", description: "Published elsewhere" },
            ],
          },
        ],
      };
      await writeElsewhere(page.request, url, "home", published);

      await headline.fill("Draft headline");
      await expect(page.getByText(MERGED)).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(() => storedBlock(page.request, url, "home"))
        .toEqual({
          ...published,
          sections: [
            {
              ...(published.sections[0] as Record<string, unknown>),
              headline: "Draft headline",
            },
          ],
        });
    } finally {
      await previewSite.close();
    }
  });
  test("a form that saves again while its refused save is on the wire keeps both edits", async ({
    authedPage: { page, orgSlug },
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const previewSite = await startPreviewSite();
    try {
      const { headline, url } = await openEditor(
        page,
        orgSlug,
        previewSite.url,
        hero,
      );
      const page1 = (await storedBlock(page.request, url, "home")) as Record<
        string,
        unknown
      >;
      const published = {
        ...page1,
        sections: [
          {
            ...hero,
            slides: [
              { title: "First slide", description: "Published elsewhere" },
            ],
          },
        ],
      };
      await writeElsewhere(page.request, url, "home", published);

      // A slow network: the form's first save is still on its way (and will
      // be refused as stale) when the user's next keystrokes save again.
      let held = false;
      await page.route(
        (u) => u.pathname === url,
        async (route) => {
          if (route.request().method() === "PATCH" && !held) {
            held = true;
            await new Promise((resolve) => setTimeout(resolve, 3_000));
          }
          await route.continue();
        },
      );
      const mergedToasts = await countToasts(page, MERGED);
      await headline.fill("Draft one");
      await expect.poll(() => held).toBe(true);
      await headline.fill("Draft two");

      // Both kept: the other editor's description and the user's last edit.
      await expect
        .poll(() => storedBlock(page.request, url, "home"), {
          timeout: 30_000,
        })
        .toEqual({
          ...published,
          sections: [
            {
              ...(published.sections[0] as Record<string, unknown>),
              headline: "Draft two",
            },
          ],
        });
      await expect(headline).toHaveValue("Draft two");
      // Counted as they appear: under load the toast can expire before here.
      expect(await mergedToasts()).toBe(1);
      await expect(conflictDialog(page)).toHaveCount(0);
    } finally {
      await previewSite.close();
    }
  });
  test("a form left open while a sync brings in another draft's publish merges without a refused save", async ({
    authedPage: { page, orgSlug },
  }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const previewSite = await startPreviewSite();
    try {
      const { headline, url, vmcpId } = await openEditor(
        page,
        orgSlug,
        previewSite.url,
        { __resolveType: "SharedHero" },
        "draft",
      );
      const published = {
        ...hero,
        slides: [{ title: "First slide", description: "Published elsewhere" }],
      };
      // Another draft publishes a change to the same block...
      await writeElsewhere(
        page.request,
        `/api/${orgSlug}/decofile/${vmcpId}/main`,
        "SharedHero",
        published,
      );
      // ...and "get latest" fast-forwards this draft, which has nothing of
      // its own yet, onto that publish.
      const sync = await page.request.post(
        `/api/${orgSlug}/sandbox/${vmcpId}/draft/git/rebase`,
        { data: { base: "main" } },
      );
      expect(sync.status()).toBe(200);
      expect(await storedBlock(page.request, url, "SharedHero")).toEqual(
        published,
      );

      // The editor re-reads the draft once its copy is stale (here, on
      // refocus); the open form still holds the copy it loaded.
      const reread = page.waitForResponse(
        (r) =>
          r.request().method() === "GET" &&
          new URL(r.url()).pathname ===
            `/api/${orgSlug}/decofile/${vmcpId}/draft` &&
          r.ok(),
        { timeout: 60_000 },
      );
      await page.waitForTimeout(31_000);
      await page.evaluate(() => {
        window.dispatchEvent(new Event("visibilitychange"));
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
      });
      await reread;

      const saves: number[] = [];
      page.on("response", (r) => {
        if (
          r.request().method() === "PATCH" &&
          r.url().includes("/decofile/")
        ) {
          saves.push(r.status());
        }
      });
      await headline.fill("Draft headline");
      await expect(page.getByText(MERGED)).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(() => storedBlock(page.request, url, "SharedHero"))
        .toEqual({ ...published, headline: "Draft headline" });
      // Caught by the editor before writing: no save had to be refused.
      expect(saves.length).toBeGreaterThan(0);
      expect(saves).not.toContain(409);
    } finally {
      await previewSite.close();
    }
  });
  test("an edit to a value someone else also changed asks which to keep; it can't be dismissed, and one click saves yours", async ({
    authedPage: { page, orgSlug },
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const previewSite = await startPreviewSite();
    try {
      const { headline, url } = await openEditor(
        page,
        orgSlug,
        previewSite.url,
        { __resolveType: "SharedHero" },
      );
      const published = { ...hero, headline: "Published headline" };
      await writeElsewhere(page.request, url, "SharedHero", published);
      const oldToasts = await countToasts(
        page,
        "Changed while you were editing",
      );

      await headline.fill("Draft headline");
      const dialog = conflictDialog(page);
      await expect(dialog).toBeVisible({ timeout: 20_000 });
      // Both versions, under the field's label; nothing written meanwhile.
      const field = dialog.getByRole("radiogroup", { name: "Headline" });
      await expect(field.getByTestId("conflict-mine")).toHaveText(
        "Draft headline",
      );
      await expect(field.getByTestId("conflict-theirs")).toHaveText(
        "Published headline",
      );
      expect(await storedBlock(page.request, url, "SharedHero")).toEqual(
        published,
      );
      // Modal: typing goes nowhere near the form behind it. The form is
      // aria-hidden while the dialog is open, so it is found with
      // includeHidden.
      await page.keyboard.type("xyz");
      await expect(
        page.getByTestId("blocks-panel").getByRole("textbox", {
          name: "Headline",
          exact: true,
          includeHidden: true,
        }),
      ).toHaveValue("Draft headline");

      // It must be answered: no close button, and neither Escape nor a
      // click outside closes it.
      await expect(dialog.getByRole("button", { name: /close/i })).toHaveCount(
        0,
      );
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await page.mouse.click(8, 8);
      await expect(dialog).toBeVisible();
      expect(await storedBlock(page.request, url, "SharedHero")).toEqual(
        published,
      );

      // Every field starts on yours: one click saves the user's version.
      await expect(
        field.getByRole("radio", { name: "Keep yours" }),
      ).toBeChecked();
      await dialog
        .getByRole("button", { name: "Save selected versions" })
        .click();
      await expect(dialog).toBeHidden();
      await expect
        .poll(() => storedBlock(page.request, url, "SharedHero"), {
          timeout: 20_000,
        })
        .toEqual({ ...published, headline: "Draft headline" });
      await expect(headline).toHaveValue("Draft headline");

      // The form goes on from the saved choice.
      await headline.fill("Later edit");
      await expect
        .poll(() => storedBlock(page.request, url, "SharedHero"), {
          timeout: 20_000,
        })
        .toEqual({ ...published, headline: "Later edit" });
      await expect(dialog).toHaveCount(0);
      expect(await oldToasts()).toBe(0);
    } finally {
      await previewSite.close();
    }
  });

  test("Use theirs keeps their version in every field and loads it into the form", async ({
    authedPage: { page, orgSlug },
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const previewSite = await startPreviewSite();
    try {
      const { blocks, headline, url } = await openEditor(
        page,
        orgSlug,
        previewSite.url,
        { __resolveType: "SharedHero" },
      );
      const published = { ...hero, headline: "Published headline" };
      await writeElsewhere(page.request, url, "SharedHero", published);

      await headline.fill("Draft headline");
      const dialog = conflictDialog(page);
      await expect(dialog).toBeVisible({ timeout: 20_000 });
      const field = dialog.getByRole("radiogroup", { name: "Headline" });
      await dialog.getByRole("button", { name: "Use theirs" }).click();
      await expect(
        field.getByRole("radio", { name: "Use theirs" }),
      ).toBeChecked();
      await dialog
        .getByRole("button", { name: "Save selected versions" })
        .click();
      await expect(dialog).toBeHidden();
      await expect(headline).toHaveValue("Published headline");
      await page.waitForTimeout(3_000);
      expect(await storedBlock(page.request, url, "SharedHero")).toEqual(
        published,
      );
      // Saves go on as usual afterwards.
      await blocks.getByRole("button", { name: /^First slide/ }).click();
      await blocks
        .getByRole("textbox", { name: "Description", exact: true })
        .fill("After the choice");
      await expect
        .poll(() => storedBlock(page.request, url, "SharedHero"), {
          timeout: 20_000,
        })
        .toEqual({
          ...published,
          slides: [{ title: "First slide", description: "After the choice" }],
        });
    } finally {
      await previewSite.close();
    }
  });

  test("each field keeps the version chosen for it, and fields only one side changed merge on their own", async ({
    authedPage: { page, orgSlug },
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const previewSite = await startPreviewSite();
    try {
      const { blocks, headline, url } = await openEditor(
        page,
        orgSlug,
        previewSite.url,
        { __resolveType: "SharedHero" },
      );
      const published = {
        ...hero,
        headline: "Published headline",
        subtitle: "Published subtitle",
        slides: [{ title: "First slide", description: "Published elsewhere" }],
      };
      await writeElsewhere(page.request, url, "SharedHero", published);

      // Two fields both changed, within one autosave; the slide only they
      // changed merges without asking.
      const subtitle = blocks.getByRole("textbox", {
        name: "Subtitle",
        exact: true,
      });
      await headline.fill("Draft headline");
      await subtitle.fill("Draft subtitle");
      const dialog = conflictDialog(page);
      await expect(dialog).toBeVisible({ timeout: 20_000 });
      await expect(dialog.getByRole("radiogroup")).toHaveCount(2);
      // Headline stays on yours (the default); Subtitle switches to theirs.
      await expect(
        dialog
          .getByRole("radiogroup", { name: "Headline" })
          .getByRole("radio", { name: "Keep yours" }),
      ).toBeChecked();
      await dialog
        .getByRole("radiogroup", { name: "Subtitle" })
        .getByRole("radio", { name: "Use theirs" })
        .click();
      await dialog
        .getByRole("button", { name: "Save selected versions" })
        .click();
      await expect(dialog).toBeHidden();

      const chosen = { ...published, headline: "Draft headline" };
      await expect
        .poll(() => storedBlock(page.request, url, "SharedHero"), {
          timeout: 20_000,
        })
        .toEqual(chosen);
      await expect(headline).toHaveValue("Draft headline");
      await expect(subtitle).toHaveValue("Published subtitle");
    } finally {
      await previewSite.close();
    }
  });

  test("another change while the dialog is open asks again with the newer version", async ({
    authedPage: { page, orgSlug },
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const previewSite = await startPreviewSite();
    try {
      const { headline, url } = await openEditor(
        page,
        orgSlug,
        previewSite.url,
        { __resolveType: "SharedHero" },
      );
      const published = { ...hero, headline: "Published headline" };
      await writeElsewhere(page.request, url, "SharedHero", published);

      await headline.fill("Draft headline");
      const dialog = conflictDialog(page);
      await expect(dialog).toBeVisible({ timeout: 20_000 });
      const field = dialog.getByRole("radiogroup", { name: "Headline" });
      await expect(field.getByTestId("conflict-theirs")).toHaveText(
        "Published headline",
      );

      // A third editor saves while the user decides.
      const third = { ...hero, headline: "Third headline" };
      await writeElsewhere(page.request, url, "SharedHero", third);
      await dialog
        .getByRole("button", { name: "Save selected versions" })
        .click();

      // That save expected the version the dialog showed: it is refused, and
      // the same choice is asked with the newer version. Nothing is written
      // over it without the user's word.
      await expect(
        dialog.getByText("Their version changed again while this was open."),
      ).toBeVisible({ timeout: 20_000 });
      await expect(field.getByTestId("conflict-theirs")).toHaveText(
        "Third headline",
      );
      await expect(field.getByTestId("conflict-mine")).toHaveText(
        "Draft headline",
      );
      expect(await storedBlock(page.request, url, "SharedHero")).toEqual(third);

      await expect(
        field.getByRole("radio", { name: "Keep yours" }),
      ).toBeChecked();
      await dialog
        .getByRole("button", { name: "Save selected versions" })
        .click();
      await expect(dialog).toBeHidden();
      await expect
        .poll(() => storedBlock(page.request, url, "SharedHero"), {
          timeout: 20_000,
        })
        .toEqual({ ...third, headline: "Draft headline" });
    } finally {
      await previewSite.close();
    }
  });

  test("the open dialog shows a newer version of theirs in place, with no click", async ({
    authedPage: { page, orgSlug },
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const previewSite = await startPreviewSite();
    try {
      const { headline, url } = await openEditor(
        page,
        orgSlug,
        previewSite.url,
        { __resolveType: "SharedHero" },
      );
      const published = { ...hero, headline: "Published headline" };
      await writeElsewhere(page.request, url, "SharedHero", published);

      await headline.fill("Draft headline");
      const dialog = conflictDialog(page);
      await expect(dialog).toBeVisible({ timeout: 20_000 });
      const field = dialog.getByRole("radiogroup", { name: "Headline" });
      await expect(field.getByTestId("conflict-theirs")).toHaveText(
        "Published headline",
      );

      // A third editor saves while the user decides: the dialog reads the
      // stored block again while it is open and shows the newer version.
      const third = { ...hero, headline: "Third headline" };
      await writeElsewhere(page.request, url, "SharedHero", third);
      await expect(
        dialog.getByText("Their version changed again while this was open."),
      ).toBeVisible({ timeout: 15_000 });
      await expect(field.getByTestId("conflict-theirs")).toHaveText(
        "Third headline",
      );
      await expect(field.getByTestId("conflict-mine")).toHaveText(
        "Draft headline",
      );
      await expect(
        field.getByRole("radio", { name: "Keep yours" }),
      ).toBeChecked();
      expect(await storedBlock(page.request, url, "SharedHero")).toEqual(third);

      await dialog
        .getByRole("button", { name: "Save selected versions" })
        .click();
      await expect(dialog).toBeHidden();
      await expect
        .poll(() => storedBlock(page.request, url, "SharedHero"), {
          timeout: 20_000,
        })
        .toEqual({ ...third, headline: "Draft headline" });
    } finally {
      await previewSite.close();
    }
  });

  test("a form follows its section when one is inserted above it", async ({
    authedPage: { page, orgSlug },
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const previewSite = await startPreviewSite();
    try {
      const { headline, url } = await openEditor(
        page,
        orgSlug,
        previewSite.url,
        hero,
      );
      const home = (await storedBlock(page.request, url, "home")) as Record<
        string,
        unknown
      >;
      const inserted = { ...hero, headline: "Inserted above" };
      await writeElsewhere(page.request, url, "home", {
        ...home,
        sections: [inserted, hero],
      });

      await headline.fill("Draft headline");
      // The edit lands on the section the form opened, not on the one that
      // now sits at its old position.
      await expect
        // The refused save's merged retry waits out main's backoff (#8000).
        .poll(() => storedBlock(page.request, url, "home"), {
          timeout: 20_000,
        })
        .toEqual({
          ...home,
          sections: [inserted, { ...hero, headline: "Draft headline" }],
        });
      await expect(headline).toHaveValue("Draft headline");
    } finally {
      await previewSite.close();
    }
  });
  test("with identical twin sections, an edit to the open one stays on it", async ({
    authedPage: { page, orgSlug },
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const previewSite = await startPreviewSite();
    try {
      const { headline, url } = await openEditor(
        page,
        orgSlug,
        previewSite.url,
        hero,
      );
      const home = (await storedBlock(page.request, url, "home")) as Record<
        string,
        unknown
      >;
      // Seed a twin below the open section, the way a page repeats a spacer.
      await writeElsewhere(page.request, url, "home", {
        ...home,
        sections: [hero, hero],
      });
      await page.reload();
      const blocks = page.getByTestId("blocks-panel");
      await blocks
        .getByRole("button", { name: /HeroSlideShow/ })
        .first()
        .click({ timeout: 60_000 });
      await expect(headline).toHaveValue("Original headline");

      // Someone else edits the open (first) twin in place.
      const editedTwin = {
        ...hero,
        slides: [{ title: "First slide", description: "Published elsewhere" }],
      };
      await writeElsewhere(page.request, url, "home", {
        ...home,
        sections: [editedTwin, hero],
      });

      await headline.fill("Draft headline");
      await expect
        // The refused save's merged retry waits out main's backoff (#8000).
        .poll(() => storedBlock(page.request, url, "home"), {
          timeout: 20_000,
        })
        .toEqual({
          ...home,
          sections: [{ ...editedTwin, headline: "Draft headline" }, hero],
        });
    } finally {
      await previewSite.close();
    }
  });
  test("an old copy of the editor's own saves coming back from a read does not revert them", async ({
    authedPage: { page, orgSlug },
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const previewSite = await startPreviewSite();
    try {
      const { headline, url } = await openEditor(
        page,
        orgSlug,
        previewSite.url,
        { __resolveType: "SharedHero" },
      );
      // What the editor read when it opened the block.
      const opened = await (await page.request.get(url)).text();

      await headline.fill("First edit");
      await expect
        .poll(() => storedBlock(page.request, url, "SharedHero"))
        .toEqual({ ...hero, headline: "First edit" });

      // Right after a save, the provider can still answer with the branch's
      // previous head for a moment: one save is refused as stale and the
      // re-read that follows returns the block as it was when the form opened.
      let refuseNext = true;
      let serveOld = false;
      await page.route("**/decofile/**", async (route) => {
        const method = route.request().method();
        if (method === "PATCH" && refuseNext) {
          refuseNext = false;
          serveOld = true;
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({
              error: "Blocks changed since they were loaded: SharedHero",
              code: "block-conflict",
              blocks: ["SharedHero"],
            }),
          });
          return;
        }
        if (
          method === "GET" &&
          serveOld &&
          /\/main$/.test(new URL(route.request().url()).pathname)
        ) {
          serveOld = false;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: opened,
          });
          return;
        }
        await route.continue();
      });

      await headline.fill("Second edit");
      await expect
        .poll(() => storedBlock(page.request, url, "SharedHero"), {
          timeout: 20_000,
        })
        .toEqual({ ...hero, headline: "Second edit" });
      await expect(headline).toHaveValue("Second edit");
      await expect(conflictDialog(page)).toHaveCount(0);
    } finally {
      await previewSite.close();
    }
  });
});

test.describe("Site Editor stale page fields", () => {
  test.use({ newBlocksEditor: false });
  test.setTimeout(120_000);

  test("renaming a page someone else changed keeps their change", async ({
    authedPage: { page, orgSlug },
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const previewSite = await startPreviewSite();
    try {
      const { blocks, url } = await loadEditor(
        page,
        orgSlug,
        previewSite.url,
        hero,
      );
      const pageName = blocks.getByPlaceholder("Page name", { exact: true });
      await expect(pageName).toHaveValue("Home", { timeout: 60_000 });
      const home = (await storedBlock(page.request, url, "home")) as Record<
        string,
        unknown
      >;
      const published = {
        ...home,
        sections: [{ ...hero, headline: "Published headline" }],
      };
      await writeElsewhere(page.request, url, "home", published);

      const saves: number[] = [];
      page.on("response", (r) => {
        if (
          r.request().method() === "PATCH" &&
          r.url().includes("/decofile/")
        ) {
          saves.push(r.status());
        }
      });
      await pageName.fill("Home page");
      await expect
        .poll(() => storedBlock(page.request, url, "home"))
        .toEqual({ ...published, name: "Home page" });
      // The stale save was refused once, then replayed on the fresh page.
      expect(saves).toEqual([409, 200]);
      await expect(page.getByText("Not saved")).toHaveCount(0);
    } finally {
      await previewSite.close();
    }
  });
});
