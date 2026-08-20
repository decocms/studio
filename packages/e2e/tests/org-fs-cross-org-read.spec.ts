/**
 * Cross-org read boundary for `GET /api/:org/fs/:volume/read`.
 *
 * That route is the ONE org-scoped endpoint `resolveOrgFromPath` lets a
 * non-member reach (its public-share carve-out, so a shared file streams to
 * anyone). This spec pins the other half of that contract: everything NOT
 * shared stays member-gated, so a signed-in non-member — and an anonymous
 * caller — can never read another org's private `home` files (agent/user
 * memory lives there).
 *
 * Written in response to an external report claiming the route has no
 * membership check at all. Black-box: two real signups, real Better Auth,
 * real middleware, assertions only on HTTP status + bytes.
 */

import { signUpViaApi } from "../fixtures/auth-api";
import { mintMcpAccessToken } from "../fixtures/mcp-oauth";
import { expect, newApiContext, test } from "../fixtures/test";

const PRIVATE_PATH = "memory/private-note.md";
const PRIVATE_BODY = "org-a-private-memory-canary";

const readUrl = (orgSlug: string, path: string, presign = false) =>
  `/api/${orgSlug}/fs/home/read?path=${encodeURIComponent(path)}${
    presign ? "&presign=1" : ""
  }`;

test.describe("org-fs cross-org read boundary", () => {
  test("a signed-in non-member cannot read another org's private home file", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);

    // Org A seeds a private file in `home` (never shared).
    const put = await ownerCtx.put(
      `/api/${owner.orgSlug}/fs/home/file?path=${encodeURIComponent(PRIVATE_PATH)}`,
      { data: PRIVATE_BODY, headers: { "content-type": "text/markdown" } },
    );
    expect(put.status(), await put.text().catch(() => "")).toBe(200);

    // Sanity: a 403 below must not pass because the file is simply missing.
    const ownerRead = await ownerCtx.get(readUrl(owner.orgSlug, PRIVATE_PATH));
    expect(ownerRead.status()).toBe(200);
    expect(await ownerRead.text()).toBe(PRIVATE_BODY);

    // User B: own org, no membership in A, authenticated.
    const outsiderCtx = await newApiContext(playwright);
    await signUpViaApi(outsiderCtx);

    const streamed = await outsiderCtx.get(
      readUrl(owner.orgSlug, PRIVATE_PATH),
    );
    expect(streamed.status()).toBe(403);
    expect(await streamed.text()).not.toContain(PRIVATE_BODY);

    // A presigned URL would leak the bytes from the mount directly.
    const presigned = await outsiderCtx.get(
      readUrl(owner.orgSlug, PRIVATE_PATH, true),
    );
    expect(presigned.status()).toBe(403);
    expect(await presigned.text()).not.toContain("http");

    // Directory listing of the same volume stays gated by the middleware.
    const listed = await outsiderCtx.get(
      `/api/${owner.orgSlug}/fs/home/list?path=memory`,
    );
    expect(listed.status()).toBe(403);

    await outsiderCtx.dispose();
    await ownerCtx.dispose();
  });

  test("an anonymous caller cannot read another org's private home file", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);

    const put = await ownerCtx.put(
      `/api/${owner.orgSlug}/fs/home/file?path=${encodeURIComponent(PRIVATE_PATH)}`,
      { data: PRIVATE_BODY, headers: { "content-type": "text/markdown" } },
    );
    expect(put.status()).toBe(200);

    // Fresh context = no session cookie.
    const anonCtx = await newApiContext(playwright);
    const res = await anonCtx.get(readUrl(owner.orgSlug, PRIVATE_PATH));
    expect(res.status()).toBe(401);
    expect(await res.text()).not.toContain(PRIVATE_BODY);

    await anonCtx.dispose();
    await ownerCtx.dispose();
  });

  test("an explicitly shared file IS readable by a non-member (the intended carve-out)", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const sharedPath = "shared/public-note.md";
    const sharedBody = "org-a-published-note";

    const put = await ownerCtx.put(
      `/api/${owner.orgSlug}/fs/home/file?path=${encodeURIComponent(sharedPath)}`,
      { data: sharedBody, headers: { "content-type": "text/markdown" } },
    );
    expect(put.status()).toBe(200);

    const share = await ownerCtx.post(
      `/api/${owner.orgSlug}/fs/home/public?path=${encodeURIComponent(sharedPath)}`,
      { data: { mode: "public" } },
    );
    expect(share.status(), await share.text().catch(() => "")).toBe(200);

    const anonCtx = await newApiContext(playwright);
    const res = await anonCtx.get(readUrl(owner.orgSlug, sharedPath));
    expect(res.status()).toBe(200);
    expect(await res.text()).toBe(sharedBody);

    // Sharing one file must not publish its private sibling.
    const sibling = await anonCtx.get(readUrl(owner.orgSlug, PRIVATE_PATH));
    expect(sibling.status()).toBe(401);

    await anonCtx.dispose();
    await ownerCtx.dispose();
  });
});

test.describe("org-fs cross-org read boundary — bearer principals", () => {
  /**
   * The carve-out is reached by ANY principal, not just cookie sessions, so
   * every token type has to be denied on a private path too. Both of these
   * are minted inside the outsider's OWN org with full power there — the
   * question is whether that power leaks across the tenant boundary on the
   * one route the membership gate defers.
   */
  test("an MCP OAuth token and a wildcard API key from another org are both denied", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);

    const put = await ownerCtx.put(
      `/api/${owner.orgSlug}/fs/home/file?path=${encodeURIComponent(PRIVATE_PATH)}`,
      { data: PRIVATE_BODY, headers: { "content-type": "text/markdown" } },
    );
    expect(put.status()).toBe(200);

    // Outsider: owner of their own org, no membership in the target org.
    const outsiderCtx = await newApiContext(playwright);
    const outsider = await signUpViaApi(outsiderCtx);

    const { accessToken } = await mintMcpAccessToken(outsiderCtx);
    const wildcardKeyRes = await outsiderCtx.post(
      `/api/${outsider.orgSlug}/tools/API_KEY_CREATE`,
      {
        data: {
          name: `cross-org-${Date.now()}`,
          permissions: { "*": ["*"] },
        },
      },
    );
    expect(wildcardKeyRes.ok()).toBe(true);
    const wildcardKey = ((await wildcardKeyRes.json()) as { key?: string }).key;
    expect(wildcardKey).toBeTruthy();

    // The outsider's own private file — the positive control below reads it.
    const ownPath = "memory/outsider-note.md";
    const ownBody = "outsider-own-memory";
    const ownPut = await outsiderCtx.put(
      `/api/${outsider.orgSlug}/fs/home/file?path=${encodeURIComponent(ownPath)}`,
      { data: ownBody, headers: { "content-type": "text/markdown" } },
    );
    expect(ownPut.status()).toBe(200);

    // A cookie-free context: only the Authorization header authenticates.
    const bearerCtx = await newApiContext(playwright);

    for (const [label, token] of [
      ["mcp oauth token", accessToken],
      ["wildcard api key", wildcardKey!],
    ] as const) {
      // Positive control: the token is a recognized principal on this route.
      const own = await bearerCtx.get(readUrl(outsider.orgSlug, ownPath), {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(own.status(), `${label} own-org status`).toBe(200);
      expect(await own.text(), `${label} own-org body`).toBe(ownBody);

      const res = await bearerCtx.get(readUrl(owner.orgSlug, PRIVATE_PATH), {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect([401, 403], `${label} status`).toContain(res.status());
      expect(await res.text(), `${label} body`).not.toContain(PRIVATE_BODY);

      const presigned = await bearerCtx.get(
        readUrl(owner.orgSlug, PRIVATE_PATH, true),
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect([401, 403], `${label} presign status`).toContain(
        presigned.status(),
      );
    }

    await bearerCtx.dispose();
    await outsiderCtx.dispose();
    await ownerCtx.dispose();
  });
});

test.describe("org-fs cross-org read boundary — stale session role", () => {
  /**
   * `boundAuth.hasPermission` short-circuits on `hasAdminRole(role)`, where
   * `role` is captured at context construction from the SESSION's active org
   * (context-factory.ts). `resolveOrgFromPath` only calls
   * `ctx.access.setRole(pathRole)`, which updates AccessControl's copy — the
   * bound client keeps the stale one. On the share carve-out route (the only
   * org-scoped route a non-member reaches) that stale "owner" grants
   * ORG_FS_READ in a tenant the caller has no membership in.
   *
   * A signup-only session has `activeOrganizationId` NULL, so `role` is
   * undefined and the bypass never fires — which is why this needs an
   * explicit set-active to reproduce.
   */
  test("a non-member whose session has an active org is still denied", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);

    const put = await ownerCtx.put(
      `/api/${owner.orgSlug}/fs/home/file?path=${encodeURIComponent(PRIVATE_PATH)}`,
      { data: PRIVATE_BODY, headers: { "content-type": "text/markdown" } },
    );
    expect(put.status()).toBe(200);

    const outsiderCtx = await newApiContext(playwright);
    const outsider = await signUpViaApi(outsiderCtx);

    // What using the app does: session now has an active org, role owner.
    const setActive = await outsiderCtx.post(
      "/api/auth/organization/set-active",
      { data: { organizationSlug: outsider.orgSlug } },
    );
    expect(
      setActive.ok(),
      `set-active: ${setActive.status()} ${await setActive.text().catch(() => "")}`,
    ).toBe(true);

    // The two paths the report targets: org memory and per-user memory.
    const orgMemory = "MEMORY.md";
    const userMemory = `users/${owner.userId}/MEMORY.md`;
    for (const path of [orgMemory, userMemory]) {
      const seed = await ownerCtx.put(
        `/api/${owner.orgSlug}/fs/home/file?path=${encodeURIComponent(path)}`,
        { data: PRIVATE_BODY, headers: { "content-type": "text/markdown" } },
      );
      expect(seed.status()).toBe(200);
    }

    // The carve-out matches any volume, so the gate must hold outside `home`.
    const uploadPath = "thrd_e2e/upload.md";
    const uploadPut = await ownerCtx.put(
      `/api/${owner.orgSlug}/fs/uploads/file?path=${encodeURIComponent(uploadPath)}`,
      { data: PRIVATE_BODY, headers: { "content-type": "text/markdown" } },
    );
    expect(uploadPut.status()).toBe(200);
    const uploadRead = await outsiderCtx.get(
      `/api/${owner.orgSlug}/fs/uploads/read?path=${encodeURIComponent(uploadPath)}`,
    );
    expect(await uploadRead.text()).not.toContain(PRIVATE_BODY);
    expect(uploadRead.status()).toBe(403);

    for (const path of [PRIVATE_PATH, orgMemory, userMemory]) {
      const res = await outsiderCtx.get(readUrl(owner.orgSlug, path));
      expect(await res.text(), `${path} body`).not.toContain(PRIVATE_BODY);
      expect(res.status(), `${path} status`).toBe(403);

      const presigned = await outsiderCtx.get(
        readUrl(owner.orgSlug, path, true),
      );
      expect(presigned.status(), `${path} presign status`).toBe(403);
    }

    await outsiderCtx.dispose();
    await ownerCtx.dispose();
  });
});
