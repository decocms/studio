/**
 * E2E: GET /api/:org/monitor/:site/site/data (the Blocks v8 Monitor) answers
 * only for a site the org owns, through the same guard as the CDN views.
 *
 * The e2e stack has no analytics warehouse (`CLICKHOUSE_ANALYTICS_*` unset),
 * so an owned site answers `{ available: false }`: the page shows its
 * "unavailable" state instead of an error. The queries and their tenant
 * scope are covered by `apps/api/src/api/routes/monitor-site.test.ts` and
 * were checked against the real warehouse.
 */

import { signUpViaApi } from "../fixtures/auth-api";
import {
  createFastPreviewProject,
  uniqueOwner,
} from "../fixtures/fast-preview";
import { expect, newApiContext, test } from "../fixtures/test";

test.describe("v8 Monitor site data — tenancy", () => {
  test("answers the owning org, and nobody else", async ({ playwright }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const site = uniqueOwner();
    await createFastPreviewProject(ownerCtx, owner.orgSlug, {
      owner: site,
      repo: "site",
      siteSlug: site,
      connectionUrl: "http://127.0.0.1:1/unused",
    });

    const path = (org: string, slug: string) =>
      `/api/${org}/monitor/${slug}/site/data?view=summary&range=1h`;

    const own = await ownerCtx.get(path(owner.orgSlug, site));
    expect(own.status()).toBe(200);
    expect(await own.json()).toMatchObject({ available: false });

    // A slug the org doesn't own looks like one that doesn't exist.
    const unowned = await ownerCtx.get(path(owner.orgSlug, uniqueOwner()));
    expect(unowned.status()).toBe(404);

    // Another org can't read this site through its own path.
    const otherCtx = await newApiContext(playwright);
    const other = await signUpViaApi(otherCtx);
    const crossOrg = await otherCtx.get(path(other.orgSlug, site));
    expect(crossOrg.status()).toBe(404);

    // Nor through the owner's path, which it isn't a member of.
    const foreign = await otherCtx.get(path(owner.orgSlug, site));
    expect(foreign.status()).toBe(403);

    // Signed out: nothing.
    const anonCtx = await newApiContext(playwright);
    const anon = await anonCtx.get(path(owner.orgSlug, site));
    expect(anon.status()).toBe(401);

    await Promise.all([
      ownerCtx.dispose(),
      otherCtx.dispose(),
      anonCtx.dispose(),
    ]);
  });
});
