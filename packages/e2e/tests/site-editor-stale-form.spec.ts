/**
 * E2E: an open section form must not revert another editor's change.
 *
 * Every autosave writes the whole block, built from the copy the form loaded.
 * When another editor changes the same block in the meantime (a draft
 * published to the branch, a sync moved it), saving that copy silently put
 * the old values back. The save now names the version it was made against;
 * the server refuses a stale one, and the editor applies the form's edits on
 * top of the stored version, so both editors' changes are kept.
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

const hero = {
  __resolveType: "site/sections/HeroSlideShow.tsx",
  headline: "Original headline",
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

async function openEditor(
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
    vmcpId: project.vmcpId,
    url: `/api/${orgSlug}/decofile/${project.vmcpId}/${branch}`,
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
      await expect(page.getByText(MERGED)).toBeVisible();
      await expect
        .poll(() => storedBlock(page.request, url, "SharedHero"))
        .toEqual({ ...published, headline: "Draft headline" });
      await expect(headline).toHaveValue("Draft headline");

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
      await expect(page.getByText(MERGED)).toBeVisible();
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
      await expect(page.getByText(MERGED)).toBeVisible();
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
});
