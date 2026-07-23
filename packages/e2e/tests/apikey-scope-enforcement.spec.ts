/**
 * E2E: an API key is authorized SOLELY by its own allowlist — never by the
 * owner's org role.
 *
 * Regression for the privilege-escalation bug where the admin/owner role bypass
 * fired before a key's stored `permissions` were checked — so a "read-only" key
 * minted by an admin acted with full org power (could call API_KEY_CREATE,
 * MONITORING_STATS, etc.). See apps/api/src/auth/api-key-permissions.ts.
 *
 * Contract proven over HTTP only:
 *   - a key scoped to one tool is denied an out-of-scope tool (403), including
 *     the exact escalation (API_KEY_CREATE), even though the owner is an admin;
 *   - a key is a capability, not a member: even a basic-usage tool outside the
 *     key's allowlist is denied (no membership floor for keys);
 *   - a key with an explicit wildcard still has full access (not denied);
 *   - there is no "key without a scope": API_KEY_CREATE requires `permissions`.
 */
import { signUpViaApi } from "../fixtures/auth-api";
import { expect, newApiContext, test } from "../fixtures/test";

test.describe("API key scope enforcement", () => {
  test("a key is capped at its allowlist regardless of the owner's role", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    // The owner is admin/owner of their auto-created org. Mint a key scoped to a
    // single tool. (Scoped keys are created server-side via the tool — Better
    // Auth blocks `permissions` on cookie/client requests — and the owner's
    // admin role authorizes the cookie-session call here.)
    const createScoped = await ownerCtx.post(
      `/api/${owner.orgSlug}/tools/API_KEY_CREATE`,
      {
        data: {
          name: `scoped-${stamp}`,
          permissions: { self: ["AUTOMATION_LIST"] },
        },
      },
    );
    expect(
      createScoped.ok(),
      `API_KEY_CREATE(scoped): HTTP ${createScoped.status()} — ${await createScoped.text().catch(() => "")}`,
    ).toBe(true);
    const scopedKey = ((await createScoped.json()) as { key?: string }).key;
    expect(scopedKey, "scoped key value returned").toBeTruthy();

    // A key with an explicit wildcard is a full key.
    const createFull = await ownerCtx.post(
      `/api/${owner.orgSlug}/tools/API_KEY_CREATE`,
      { data: { name: `full-${stamp}`, permissions: { "*": ["*"] } } },
    );
    expect(
      createFull.ok(),
      `API_KEY_CREATE(full): HTTP ${createFull.status()}`,
    ).toBe(true);
    const fullKey = ((await createFull.json()) as { key?: string }).key;
    expect(fullKey, "full key value returned").toBeTruthy();

    // There is no "key without a scope": permissions are required.
    const createNoScope = await ownerCtx.post(
      `/api/${owner.orgSlug}/tools/API_KEY_CREATE`,
      { data: { name: `noscope-${stamp}` } },
    );
    expect(
      createNoScope.status(),
      `API_KEY_CREATE without permissions should be 400, got ${createNoScope.status()}`,
    ).toBe(400);

    // Bearer-auth context with no session cookie → auth is purely the API key.
    const apiCtx = await newApiContext(playwright);
    const auth = (key: string) => ({ Authorization: `Bearer ${key}` });

    // In allowlist → allowed (the key authenticates and works).
    const inScope = await apiCtx.post(
      `/api/${owner.orgSlug}/tools/AUTOMATION_LIST`,
      { headers: auth(scopedKey!), data: {} },
    );
    expect(
      inScope.ok(),
      `scoped AUTOMATION_LIST: HTTP ${inScope.status()}`,
    ).toBe(true);

    // Out of allowlist AND not a basic-usage tool → DENIED, even though the
    // owner is an admin. This is the fix.
    const outOfScope = await apiCtx.post(
      `/api/${owner.orgSlug}/tools/MONITORING_STATS`,
      { headers: auth(scopedKey!), data: {} },
    );
    expect(
      outOfScope.status(),
      `scoped MONITORING_STATS should be 403, got ${outOfScope.status()}`,
    ).toBe(403);
    const deniedBody = (await outOfScope.json()) as { error?: string };
    expect(deniedBody.error ?? "").toMatch(
      /access denied|permission|forbidden/i,
    );

    // A key is a capability, not a member: a basic-usage tool (granted to every
    // member) that is NOT in the key's allowlist is still DENIED. The key takes
    // its own codepath and never gets the membership floor.
    const basicUsageOutOfScope = await apiCtx.post(
      `/api/${owner.orgSlug}/tools/COLLECTION_CONNECTIONS_LIST`,
      { headers: auth(scopedKey!), data: {} },
    );
    expect(
      basicUsageOutOfScope.status(),
      `scoped key COLLECTION_CONNECTIONS_LIST should be 403, got ${basicUsageOutOfScope.status()}`,
    ).toBe(403);

    // The exact escalation from the report: a scoped key must not mint keys.
    const escalate = await apiCtx.post(
      `/api/${owner.orgSlug}/tools/API_KEY_CREATE`,
      {
        headers: auth(scopedKey!),
        data: {
          name: `should-not-work-${stamp}`,
          permissions: { self: ["*"] },
        },
      },
    );
    expect(
      escalate.status(),
      `scoped API_KEY_CREATE should be 403, got ${escalate.status()}`,
    ).toBe(403);

    // A wildcard key keeps full access (not denied) → full keys aren't broken.
    const fullReach = await apiCtx.post(
      `/api/${owner.orgSlug}/tools/MONITORING_STATS`,
      { headers: auth(fullKey!), data: {} },
    );
    expect(
      fullReach.status(),
      `wildcard key MONITORING_STATS must not be 403, got ${fullReach.status()}`,
    ).not.toBe(403);

    await ownerCtx.dispose();
    await apiCtx.dispose();
  });
});
