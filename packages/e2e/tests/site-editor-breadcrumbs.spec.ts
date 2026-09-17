import type { APIRequestContext } from "@playwright/test";
import {
  createFastPreviewProject,
  seedStubRepo,
  uniqueOwner,
} from "../fixtures/fast-preview";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { startPreviewSite } from "../fixtures/preview-site";
import { expect, test } from "../fixtures/test";

// RoutePageHeader renders nothing outside the compact layout, so the whole
// composed trail this file asserts on only exists with the preference on.
test.use({ compactPageLayout: true });

async function createEditor(
  api: APIRequestContext,
  orgSlug: string,
  previewServerUrl: string,
) {
  const owner = uniqueOwner();
  const repo = "breadcrumb-editor";
  const project = await createFastPreviewProject(api, orgSlug, {
    owner,
    repo,
    connectionUrl: "http://127.0.0.1:1/unused",
    previewServerUrl,
  });
  await callSelfMcpTool(api, orgSlug, "COLLECTION_VIRTUAL_MCP_UPDATE", {
    id: project.vmcpId,
    data: { title: "Forma" },
  });
  const hero = {
    __resolveType: "site/sections/HeroSlideShow.tsx",
    headline: "Summer collection",
    slides: [{ title: "First slide", description: "Original description" }],
  };
  await seedStubRepo(api, {
    owner,
    repo,
    defaultBranch: "main",
    branches: {
      main: {
        files: {
          ".deco/meta.gen.json": JSON.stringify({
            manifest: {
              blocks: {
                pages: {
                  "website/pages/Page.tsx": { $ref: "#/definitions/Page" },
                },
                sections: {
                  "site/sections/HeroSlideShow.tsx": {
                    $ref: "#/definitions/HeroSlideShow",
                  },
                },
                loaders: {
                  "site/loaders/Products.ts": {
                    $ref: "#/definitions/Products",
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
                Products: {
                  type: "object",
                  title: "Products",
                  properties: { query: { type: "string", title: "Query" } },
                },
              },
            },
          }),
          ".deco/blocks/home.json": JSON.stringify({
            __resolveType: "website/pages/Page.tsx",
            name: "Home",
            path: "/",
            sections: [hero],
          }),
          ".deco/blocks/catalog.json": JSON.stringify({
            __resolveType: "website/pages/Page.tsx",
            name: "Catalog",
            path: "/catalog",
            sections: [hero],
          }),
          ".deco/blocks/SharedHero.json": JSON.stringify(hero),
          ".deco/blocks/Products.json": JSON.stringify({
            __resolveType: "site/loaders/Products.ts",
            query: "summer",
          }),
        },
      },
    },
  });
  const { item: thread } = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_THREADS_CREATE",
    { data: { virtual_mcp_id: project.vmcpId, branch: "main" } },
  );
  return {
    project,
    path: `/${orgSlug}/projects/${project.vmcpId}/site-editor`,
    search: `thread=${thread.id}&sidepanel=false`,
  };
}

test.describe("Site Editor breadcrumbs", () => {
  test.setTimeout(120_000);

  test("the header appends the selected page and block and selects ancestors without browser navigation", async ({
    authedPage: { page, orgSlug, user },
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const previewSite = await startPreviewSite();
    try {
      const { path, search, project } = await createEditor(
        page.request,
        orgSlug,
        previewSite.url,
      );
      await page.goto(`${path}?${search}`);
      const header = page.getByTestId("page-header");
      const trail = header.getByRole("navigation", { name: "Breadcrumbs" });
      const blocks = page.getByTestId("blocks-panel");
      await expect(
        header.getByRole("heading", { name: "Home", exact: true }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(trail.getByRole("link")).toHaveText([user.orgName, "Forma"]);
      await expect(
        trail.getByRole("button", { name: "Site Editor", exact: true }),
      ).toBeVisible();
      await expect(trail.locator('[aria-current="page"]')).toHaveCount(1);
      await expect(trail.getByRole("listitem")).toHaveText([
        user.orgName,
        "Forma",
        "Site Editor",
        "Home",
      ]);
      await expect(
        trail.getByRole("button", { name: "Show navigation path" }),
      ).toHaveCount(0);
      const selectedUrl = page.url();
      await blocks.getByRole("button", { name: /HeroSlideShow/ }).click();
      await expect(
        header.getByRole("heading", { name: "HeroSlideShow", exact: true }),
      ).toBeVisible();
      await expect(
        trail.getByRole("button", { name: "Home", exact: true }),
      ).toBeVisible();
      await expect(blocks.getByRole("navigation")).toHaveCount(0);
      await expect(
        blocks.getByRole("button", { name: "Back", exact: true }),
      ).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath("site-editor-block-breadcrumb.png"),
        animations: "disabled",
      });

      await expect(trail.locator('[aria-current="page"]')).toHaveCount(1);
      await blocks.getByRole("button", { name: /^First slide/ }).click();
      await expect(
        header.getByRole("heading", { name: "First slide", exact: true }),
      ).toBeVisible();
      await expect(trail.getByRole("listitem")).toHaveText([
        user.orgName,
        "",
        "HeroSlideShow",
        "First slide",
      ]);
      await expect(trail.locator('[aria-current="page"]')).toHaveCount(1);
      await trail.getByRole("button", { name: "Show navigation path" }).click();
      await expect(page.getByRole("menuitem")).toHaveText([
        "Forma",
        "Site Editor",
        "Home",
      ]);
      await expect(
        page.getByRole("menuitem", { name: "Forma", exact: true }),
      ).toHaveAttribute(
        "href",
        `/${orgSlug}/projects/${project.vmcpId}?sidepanel=false`,
      );
      await page.keyboard.press("Escape");
      await blocks
        .getByRole("textbox", { name: "Description", exact: true })
        .fill("Saved through the breadcrumb");
      await trail
        .getByRole("button", { name: "HeroSlideShow", exact: true })
        .click();
      await expect(
        header.getByRole("heading", { name: "HeroSlideShow", exact: true }),
      ).toBeVisible();
      await trail.getByRole("button", { name: "Home", exact: true }).click();
      await expect(
        header.getByRole("heading", { name: "Home", exact: true }),
      ).toBeVisible();
      expect(page.url()).toBe(selectedUrl);
      await expect
        .poll(async () => {
          const response = await page.request.get(
            `/api/${orgSlug}/decofile/${project.vmcpId}/main`,
          );
          return JSON.stringify(await response.json());
        })
        .toContain("Saved through the breadcrumb");
      await blocks.getByRole("button", { name: /HeroSlideShow/ }).click();
      await blocks.getByRole("button", { name: /^First slide/ }).click();
      await expect(
        blocks.getByRole("textbox", { name: "Description", exact: true }),
      ).toHaveValue("Saved through the breadcrumb");

      const picker = page.getByTestId("preview-page-picker");
      await trail.getByRole("button", { name: "Show navigation path" }).click();
      await page
        .getByRole("menuitem", { name: "Site Editor", exact: true })
        .click();
      await expect(
        header.getByRole("heading", { name: "Home", exact: true }),
      ).toBeVisible();
      expect(page.url()).toBe(selectedUrl);
      await expect(trail.locator('[aria-current="page"]')).toHaveCount(1);
      await trail
        .getByRole("button", { name: "Site Editor", exact: true })
        .click();
      await expect(
        blocks.getByRole("button", { name: /HeroSlideShow/ }),
      ).toBeVisible();
      await picker.click();
      await page.getByRole("option", { name: /Catalog/ }).click();
      await expect(
        header.getByRole("heading", { name: "Catalog", exact: true }),
      ).toBeVisible();
      await expect(trail.getByText("Home", { exact: true })).toHaveCount(0);
      await expect(trail.getByText("First slide", { exact: true })).toHaveCount(
        0,
      );
      await blocks
        .getByRole("button", { name: "Edit SEO", exact: true })
        .click();
      await expect(
        header.getByRole("heading", { name: "SEO", exact: true }),
      ).toBeVisible();
      await trail.getByRole("button", { name: "Catalog", exact: true }).click();
      await expect(
        header.getByRole("heading", { name: "Catalog", exact: true }),
      ).toBeVisible();
      await picker.click();
      await page.getByRole("option", { name: /SharedHero/ }).click();
      await expect(
        header.getByRole("heading", { name: "SharedHero", exact: true }),
      ).toBeVisible();
      await expect(blocks.getByText(/This is a global section/)).toBeVisible();
      await expect(trail.getByText("Catalog", { exact: true })).toHaveCount(0);
      await picker.click();
      await page.getByRole("option", { name: /Products/ }).click();
      await expect(
        header.getByRole("heading", { name: "Products", exact: true }),
      ).toBeVisible();
      await expect(
        blocks.getByRole("textbox", { name: "Query", exact: true }),
      ).toHaveValue("summer");
      await expect(blocks.getByRole("navigation")).toHaveCount(0);

      await page.getByRole("button", { name: "Content", exact: true }).click();
      await expect(
        header.getByRole("heading", { name: "Site Editor", exact: true }),
      ).toBeVisible();
      await expect(header.getByText("Products", { exact: true })).toHaveCount(
        0,
      );
      await expect(trail.locator('[aria-current="page"]')).toHaveCount(1);
      await expect(
        trail.getByRole("button", { name: "Show navigation path" }),
      ).toHaveCount(0);
    } finally {
      await previewSite.close();
    }
  });

  test("Content uses the same trail and keeps ancestors selectable on a narrow panel", async ({
    authedPage: { page, orgSlug },
  }, testInfo) => {
    const previewSite = await startPreviewSite();
    try {
      const { path, search, project } = await createEditor(
        page.request,
        orgSlug,
        previewSite.url,
      );
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${path}/content?${search}`);
      const header = page.getByTestId("page-header");
      await page.getByRole("button", { name: "Home /", exact: true }).click();
      await expect(
        header.getByRole("heading", { name: "Home", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: /HeroSlideShow/ }).click();
      await expect(
        header.getByRole("heading", { name: "HeroSlideShow", exact: true }),
      ).toBeVisible();
      await page.setViewportSize({ width: 900, height: 800 });
      await expect(
        header.getByRole("heading", { name: "HeroSlideShow", exact: true }),
      ).toBeInViewport();
      // Five deep renders in full, so the ancestor is a button rather than a
      // menu item. What this test is really about is that it stays selectable
      // at this width and the page still does not scroll sideways.
      await expect(
        header.getByRole("button", {
          name: "Show navigation path",
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        header.getByRole("button", { name: "Site Editor", exact: true }),
      ).toBeVisible();
      await page.screenshot({
        clip: { x: 0, y: 0, width: 900, height: 220 },
        path: testInfo.outputPath("site-editor-breadcrumb-narrow.png"),
        animations: "disabled",
      });
      await header
        .getByRole("button", { name: "Site Editor", exact: true })
        .click();
      await expect(
        header.getByRole("heading", { name: "Site Editor", exact: true }),
      ).toBeVisible();
      await expect(header.locator('[aria-current="page"]')).toHaveCount(1);
      await expect(
        header.getByRole("button", { name: "Home", exact: true }),
      ).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe(`${path}/content`);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(900);
      // Closing Content through the route segment must flush edits still inside
      // the autosave window, then unregister the editor's entire path.
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.getByRole("button", { name: "Home /", exact: true }).click();
      await page
        .getByPlaceholder("Page name", { exact: true })
        .fill("Renamed Home");
      await header
        .getByRole("button", { name: "Site Editor", exact: true })
        .click();
      await expect(
        header.getByRole("heading", { name: "Site Editor", exact: true }),
      ).toBeVisible();
      await expect
        .poll(async () => {
          const response = await page.request.get(
            `/api/${orgSlug}/decofile/${project.vmcpId}/main`,
          );
          return JSON.stringify(await response.json());
        })
        .toContain("Renamed Home");
      await page
        .getByRole("button", { name: "Renamed Home /", exact: true })
        .click();
      await expect(
        header.getByRole("heading", { name: "Renamed Home", exact: true }),
      ).toBeVisible();
      await expect(header.locator('[aria-current="page"]')).toHaveCount(1);
      await header
        .getByRole("button", { name: "Site Editor", exact: true })
        .click();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "Preview", exact: true }).click();
      await expect(
        header.getByRole("heading", { name: "Site Editor", exact: true }),
      ).toBeVisible();
      await expect(header.getByText("Home", { exact: true })).toHaveCount(0);
    } finally {
      await previewSite.close();
    }
  });
});
