/**
 * A v7 site (a `.deco/meta.gen.json`, no `blocksMajor` marker on the
 * project) keeps the v7 editor exactly as before the hosted CMS: it reads and
 * saves through the decofile routes (git), never the hosted CMS
 * (`/api/cms/:site`) or the content protocol, and shows no v8 badge. In both
 * editor modes. (Before the hosted CMS the editor also sent one `schema.get`
 * to main's decofile rpc to tell v7 from v8; the marker decides that now.)
 */
import type { Page } from "@playwright/test";
import {
  createFastPreviewProject,
  inspectStubRepo,
  seedStubRepo,
  uniqueOwner,
} from "../fixtures/fast-preview";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { startPreviewSite } from "../fixtures/preview-site";
import { expect, test } from "../fixtures/test";

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
        properties: { headline: { type: "string", title: "Headline" } },
      },
    },
  },
};

async function openV7Editor(page: Page, orgSlug: string, previewUrl: string) {
  const owner = uniqueOwner();
  const repo = "v7-boundary";
  const project = await createFastPreviewProject(page.request, orgSlug, {
    owner,
    repo,
    connectionUrl: "http://127.0.0.1:1/unused",
    previewServerUrl: previewUrl,
  });
  await seedStubRepo(page.request, {
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
            sections: [
              {
                __resolveType: "site/sections/HeroSlideShow.tsx",
                headline: "Original headline",
              },
            ],
          }),
        },
      },
    },
  });
  const { item: thread } = await callSelfMcpTool<{ item: { id: string } }>(
    page.request,
    orgSlug,
    "COLLECTION_THREADS_CREATE",
    { data: { virtual_mcp_id: project.vmcpId, branch: "main" } },
  );
  // Every request the editor makes to a v8-only surface.
  const v8Requests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/cms/") || /\/decofile\/.+\/rpc$/.test(path)) {
      v8Requests.push(`${request.method()} ${path}`);
    }
  });
  await page.goto(
    `/${orgSlug}/projects/${project.vmcpId}/site-editor?thread=${thread.id}&sidepanel=false`,
  );
  return { owner, repo, project, v8Requests };
}

for (const newBlocksEditor of [false, true]) {
  test.describe(`a v7 site, ${newBlocksEditor ? "new" : "classic"} blocks editor`, () => {
    test.use({ newBlocksEditor });

    test("reads and saves through git, never the hosted CMS", async ({
      authedPage: { page, orgSlug },
    }) => {
      test.setTimeout(120_000);
      const preview = await startPreviewSite();
      try {
        const { owner, repo, v8Requests } = await openV7Editor(
          page,
          orgSlug,
          preview.url,
        );
        const blocks = page.getByTestId("blocks-panel");
        await blocks
          .getByRole("button", { name: /HeroSlideShow/ })
          .first()
          .click({ timeout: 60_000 });
        const headline = blocks.getByRole("textbox", {
          name: "Headline",
          exact: true,
        });
        await expect(headline).toHaveValue("Original headline");
        await expect(page.getByTestId("content-version-badge")).toHaveCount(0);

        const saved = page.waitForResponse(
          (response) =>
            response.request().method() === "PATCH" &&
            /\/api\/[^/]+\/decofile\/[^/]+\/main$/.test(
              new URL(response.url()).pathname,
            ),
          { timeout: 30_000 },
        );
        await headline.fill("Saved through git");
        expect((await saved).status()).toBe(200);
        await expect
          .poll(
            async () =>
              (await inspectStubRepo(page.request, owner, repo)).branches.main
                ?.files[".deco/blocks/home.json"] ?? "",
            { timeout: 30_000 },
          )
          .toContain("Saved through git");
        expect(v8Requests).toEqual([]);
      } finally {
        await preview.close();
      }
    });
  });
}
