/**
 * `ORGANIZATION_LIST` and `ORGANIZATION_GET` for an MCP OAuth bearer, the
 * credential `decocms auth login` and MCP clients hold. Better Auth has no
 * session for that token, so these tools used to fail with "Invalid API key".
 * Black-box: real signups, real OAuth tokens, a cookie-free context per call.
 */

import type { APIRequestContext } from "@playwright/test";
import { signUpViaApi } from "../fixtures/auth-api";
import { mintMcpAccessToken } from "../fixtures/mcp-oauth";
import { expect, newApiContext, test } from "../fixtures/test";

interface OrgSummary {
  slug: string;
}

async function callTool(
  ctx: APIRequestContext,
  token: string,
  orgSlug: string,
  tool: string,
) {
  return ctx.post(`/api/${orgSlug}/tools/${tool}`, {
    data: {},
    headers: { authorization: `Bearer ${token}` },
  });
}

test.describe("organization tools with an MCP OAuth bearer", () => {
  test("list and get answer for the token's user and only their orgs", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const { accessToken: ownerToken } = await mintMcpAccessToken(ownerCtx);

    const outsiderCtx = await newApiContext(playwright);
    const outsider = await signUpViaApi(outsiderCtx);
    const { accessToken: outsiderToken } =
      await mintMcpAccessToken(outsiderCtx);

    // No cookies: the bearer is the only credential.
    const bearerCtx = await newApiContext(playwright);

    const list = await callTool(
      bearerCtx,
      ownerToken,
      owner.orgSlug,
      "ORGANIZATION_LIST",
    );
    expect(list.status(), await list.text()).toBe(200);
    const { organizations } = (await list.json()) as {
      organizations: OrgSummary[];
    };
    expect(organizations.map((o) => o.slug)).toEqual([owner.orgSlug]);

    const get = await callTool(
      bearerCtx,
      ownerToken,
      owner.orgSlug,
      "ORGANIZATION_GET",
    );
    expect(get.status(), await get.text()).toBe(200);
    const org = (await get.json()) as {
      slug: string;
      members: { user: { email: string } }[];
    };
    expect(org.slug).toBe(owner.orgSlug);
    expect(org.members.map((m) => m.user.email)).toEqual([owner.email]);

    const outsiderList = await callTool(
      bearerCtx,
      outsiderToken,
      outsider.orgSlug,
      "ORGANIZATION_LIST",
    );
    expect(outsiderList.status()).toBe(200);
    const outsiderOrgs = (
      (await outsiderList.json()) as { organizations: OrgSummary[] }
    ).organizations.map((o) => o.slug);
    expect(outsiderOrgs).toEqual([outsider.orgSlug]);

    const crossOrg = await callTool(
      bearerCtx,
      outsiderToken,
      owner.orgSlug,
      "ORGANIZATION_GET",
    );
    expect(crossOrg.status()).toBe(403);
    expect(await crossOrg.text()).not.toContain(owner.email);

    await bearerCtx.dispose();
    await outsiderCtx.dispose();
    await ownerCtx.dispose();
  });

  test("get answers a bearer exactly as it answers the browser session", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const { accessToken } = await mintMcpAccessToken(ownerCtx);

    // Stored metadata is where the two read paths could diverge.
    const orgId = (
      (await (
        await ownerCtx.post(`/api/${owner.orgSlug}/tools/ORGANIZATION_GET`, {
          data: {},
        })
      ).json()) as { id: string }
    ).id;
    const update = await ownerCtx.post(
      `/api/${owner.orgSlug}/tools/ORGANIZATION_UPDATE`,
      { data: { id: orgId, description: "parity check" } },
    );
    expect(update.status(), await update.text()).toBe(200);

    const viaSession = await ownerCtx.post(
      `/api/${owner.orgSlug}/tools/ORGANIZATION_GET`,
      { data: {} },
    );
    expect(viaSession.status()).toBe(200);

    const bearerCtx = await newApiContext(playwright);
    const viaBearer = await callTool(
      bearerCtx,
      accessToken,
      owner.orgSlug,
      "ORGANIZATION_GET",
    );
    expect(viaBearer.status(), await viaBearer.text()).toBe(200);

    const sessionOrg = await viaSession.json();
    expect(JSON.stringify(sessionOrg.metadata)).toContain("parity check");
    expect(await viaBearer.json()).toEqual(sessionOrg);

    await bearerCtx.dispose();
    await ownerCtx.dispose();
  });
});
