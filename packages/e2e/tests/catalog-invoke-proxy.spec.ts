/**
 * `POST /api/:org/sandbox/:vmcp/:branch/catalog-invoke` on a sandbox-less
 * project: Studio invokes a catalog loader on the project's preview server.
 * That origin is project metadata any editor can set, so these pin that a
 * private one is refused before any request leaves Studio.
 */

import { signUpViaApi } from "../fixtures/auth-api";
import {
  createFastPreviewProject,
  uniqueOwner,
} from "../fixtures/fast-preview";
import { expect, newApiContext, test } from "../fixtures/test";

const catalogInvokeUrl = (org: string, vmcpId: string) =>
  `/api/${org}/sandbox/${vmcpId}/main/catalog-invoke`;

const catalogLoaderBody = {
  __resolveType: "vtex/loaders/categories/tree.ts",
};

test.describe("catalog invoke proxy", () => {
  for (const previewServerUrl of [
    "http://127.0.0.1:1",
    "http://169.254.169.254",
    "http://localhost:1",
  ]) {
    test(`refuses the private preview origin ${previewServerUrl}`, async ({
      playwright,
    }) => {
      const ctx = await newApiContext(playwright);
      try {
        const user = await signUpViaApi(ctx);
        const project = await createFastPreviewProject(ctx, user.orgSlug, {
          owner: uniqueOwner(),
          repo: "site",
          previewServerUrl,
        });
        const res = await ctx.post(
          catalogInvokeUrl(project.org, project.vmcpId),
          { data: catalogLoaderBody },
        );
        expect(res.status()).toBe(403);
        expect(((await res.json()) as { error: string }).error).toMatch(
          /private networks/,
        );
      } finally {
        await ctx.dispose();
      }
    });
  }
});
