/**
 * `GET /api/:org/sandbox/:vmcp/:branch/site-meta`: the CMS's last-resort read
 * of a deployed site's schema, made by Studio so the browser never fetches the
 * site's `/live/_meta`. These pin who may call it and which origins it refuses
 * before any request leaves Studio. A successful read needs a public deco
 * site, which this suite does not run.
 */

import { signUpViaApi } from "../fixtures/auth-api";
import {
  createFastPreviewProject,
  uniqueOwner,
} from "../fixtures/fast-preview";
import { expect, newApiContext, test } from "../fixtures/test";

const siteMetaUrl = (org: string, vmcpId: string) =>
  `/api/${org}/sandbox/${vmcpId}/main/site-meta`;

test.describe("site meta proxy", () => {
  test("only members of the project's org can read it", async ({
    playwright,
  }) => {
    const owner = await newApiContext(playwright);
    const stranger = await newApiContext(playwright);
    const anonymous = await newApiContext(playwright);
    try {
      const user = await signUpViaApi(owner);
      const project = await createFastPreviewProject(owner, user.orgSlug, {
        owner: uniqueOwner(),
        repo: "site",
        previewServerUrl: "http://127.0.0.1:1",
      });
      const url = siteMetaUrl(project.org, project.vmcpId);

      expect((await anonymous.get(url)).status()).toBe(401);

      const other = await signUpViaApi(stranger);
      expect((await stranger.get(url)).ok()).toBe(false);
      const ownOrgUrl = siteMetaUrl(other.orgSlug, project.vmcpId);
      expect((await stranger.get(ownOrgUrl)).status()).toBe(404);
    } finally {
      await Promise.all([
        owner.dispose(),
        stranger.dispose(),
        anonymous.dispose(),
      ]);
    }
  });

  test("refuses a private preview origin without contacting it", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const user = await signUpViaApi(ctx);
      const project = await createFastPreviewProject(ctx, user.orgSlug, {
        owner: uniqueOwner(),
        repo: "site",
        previewServerUrl: "http://127.0.0.1:1",
      });
      const res = await ctx.get(siteMetaUrl(project.org, project.vmcpId));
      expect(res.status()).toBe(403);
      expect(res.headers()["cache-control"]).toContain("no-store");
      expect(((await res.json()) as { error: string }).error).toMatch(
        /private networks/,
      );
    } finally {
      await ctx.dispose();
    }
  });

  test("answers 404 when the project has no site to read", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const user = await signUpViaApi(ctx);
      const project = await createFastPreviewProject(ctx, user.orgSlug, {
        owner: uniqueOwner(),
        repo: "site",
        previewServerUrl: "",
      });
      const res = await ctx.get(siteMetaUrl(project.org, project.vmcpId));
      expect(res.status()).toBe(404);
    } finally {
      await ctx.dispose();
    }
  });
});
