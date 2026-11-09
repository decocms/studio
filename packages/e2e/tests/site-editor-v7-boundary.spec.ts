/**
 * A v7 site (a `.deco/meta.gen.json`, its "Blocks v8 site" switch off) keeps
 * the v7 editor exactly as before the hosted CMS: it reads and saves through
 * the decofile routes (git), never the hosted CMS (`/api/cms/:site`) or the
 * content protocol, and shows no v8 badge. In both editor modes. (Before the
 * hosted CMS the editor also sent one `schema.get` to main's decofile rpc to
 * tell v7 from v8; the switch decides that now.) A project an admin turned
 * v8 and back off is that same v7 site, and so is one with a stale v8 marker
 * an earlier Studio wrote (`blocksMajor: 8`), which is not the switch.
 * The session edits a draft branch: a v7 site's production (the default
 * branch) is read-only.
 */
import type { Page } from "@playwright/test";
import {
  createFastPreviewProject,
  inspectStubRepo,
  seedStubRepo,
  setBlocksV8Site,
  uniqueOwner,
} from "../fixtures/fast-preview";
import { connectDevDb } from "../fixtures/db";
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

/** Leaves the `blocksMajor: 8` an earlier Studio wrote on the project. */
async function leaveStaleMarker(vmcpId: string) {
  const db = await connectDevDb();
  try {
    const marked = await db.query(
      `UPDATE connections
          SET metadata = (COALESCE(metadata::jsonb, '{}'::jsonb) || $2::jsonb)::text
        WHERE id = $1`,
      [vmcpId, JSON.stringify({ blocksMajor: 8 })],
    );
    expect(marked.rowCount).toBe(1);
  } finally {
    await db.end();
  }
}

/** How the project got to be v7. */
type V7History = "never-v8" | "turned-off";

async function openV7Editor(
  page: Page,
  orgSlug: string,
  previewUrl: string,
  history: V7History,
) {
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
      draft: null,
    },
  });
  if (history === "turned-off") {
    // An admin made it a Blocks v8 site, then turned that off again; a stale
    // marker from an earlier Studio is left on it too.
    await setBlocksV8Site(page.request, orgSlug, project.vmcpId, true);
    await setBlocksV8Site(page.request, orgSlug, project.vmcpId, false);
    await leaveStaleMarker(project.vmcpId);
  }
  const { item: thread } = await callSelfMcpTool<{ item: { id: string } }>(
    page.request,
    orgSlug,
    "COLLECTION_THREADS_CREATE",
    { data: { virtual_mcp_id: project.vmcpId, branch: "draft" } },
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

    for (const history of ["never-v8", "turned-off"] as const) {
      test(`reads and saves through git, never the hosted CMS${history === "turned-off" ? " (Blocks v8 site turned off, a stale v8 marker)" : ""}`, async ({
        authedPage: { page, orgSlug },
      }) => {
        test.setTimeout(120_000);
        const preview = await startPreviewSite();
        try {
          const { owner, repo, v8Requests } = await openV7Editor(
            page,
            orgSlug,
            preview.url,
            history,
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
          await expect(page.getByTestId("content-version-badge")).toHaveCount(
            0,
          );

          const saved = page.waitForResponse(
            (response) =>
              response.request().method() === "PATCH" &&
              /\/api\/[^/]+\/decofile\/[^/]+\/draft$/.test(
                new URL(response.url()).pathname,
              ),
            { timeout: 30_000 },
          );
          await headline.fill("Saved through git");
          expect((await saved).status()).toBe(200);
          await expect
            .poll(
              async () =>
                (await inspectStubRepo(page.request, owner, repo)).branches
                  .draft?.files[".deco/blocks/home.json"] ?? "",
              { timeout: 30_000 },
            )
            .toContain("Saved through git");
          expect(v8Requests).toEqual([]);
        } finally {
          await preview.close();
        }
      });
    }
  });
}
