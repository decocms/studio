/**
 * Unit tests for the API-key authorization wired into `createBoundAuthClient`.
 * These exercise only the in-memory decision branches (API-key allowlist / role
 * bypass), none of which call Better Auth — so a minimal stubbed `auth` is enough.
 */
import { describe, expect, it } from "bun:test";
import { createBoundAuthClient } from "./context-factory";
import type { BetterAuthInstance } from "./studio-context";

const stubAuth = { api: {} } as unknown as BetterAuthInstance;

describe("createBoundAuthClient — API-key authorization", () => {
  it("authorizes an API key SOLELY by its allowlist, ignoring the owner role", async () => {
    const client = createBoundAuthClient({
      auth: stubAuth,
      headers: new Headers(),
      role: "admin", // owner is an admin — must NOT widen the key
      permissions: { self: ["ORGANIZATION_GET"] },
      apiKeyId: "key_1",
    });

    expect(client.isApiKeyPrincipal).toBe(true);
    expect(await client.hasPermission({ self: ["ORGANIZATION_GET"] })).toBe(
      true,
    );
    // The exact escalation the report found — denied even for an admin owner.
    expect(await client.hasPermission({ self: ["API_KEY_CREATE"] })).toBe(
      false,
    );
  });

  it("treats a wildcard key as full access (explicit full key)", async () => {
    const client = createBoundAuthClient({
      auth: stubAuth,
      headers: new Headers(),
      role: "user",
      permissions: { "*": ["*"] },
      apiKeyId: "key_2",
    });

    expect(client.isApiKeyPrincipal).toBe(true);
    expect(await client.hasPermission({ self: ["API_KEY_CREATE"] })).toBe(true);
    expect(await client.hasPermission({ vir_x: ["SEND_MESSAGE"] })).toBe(true);
  });

  it("denies an API key with no allowlist (fail-closed)", async () => {
    const client = createBoundAuthClient({
      auth: stubAuth,
      headers: new Headers(),
      role: "owner",
      permissions: undefined,
      apiKeyId: "key_3",
    });

    expect(client.isApiKeyPrincipal).toBe(true);
    expect(await client.hasPermission({ self: ["ORGANIZATION_GET"] })).toBe(
      false,
    );
  });

  it("keeps the admin/owner role bypass for a non-API-key principal", async () => {
    const client = createBoundAuthClient({
      auth: stubAuth,
      headers: new Headers(),
      role: "admin",
      permissions: { self: ["ORGANIZATION_GET"] }, // e.g. a studio JWT payload
      // no apiKeyId — not an API key principal
    });

    expect(client.isApiKeyPrincipal).toBe(false);
    expect(await client.hasPermission({ self: ["API_KEY_CREATE"] })).toBe(true);
  });

  // Better Auth's `parseRoles` joins an assigned role array with "," before
  // storing `member.role`, so a multi-role owner/admin's role can arrive here
  // as e.g. "admin,billing-manager", not a lone "admin". An exact-match bypass
  // check would wrongly fall through to the narrower stored `permissions`
  // (e.g. a studio JWT payload) and deny an action the role actually grants.
  it("keeps the admin/owner bypass for a comma-joined multi-role principal", async () => {
    const client = createBoundAuthClient({
      auth: stubAuth,
      headers: new Headers(),
      role: "admin,billing-manager",
      permissions: { self: ["ORGANIZATION_GET"] },
    });

    expect(await client.hasPermission({ self: ["API_KEY_CREATE"] })).toBe(true);
  });

  // `role` here is resolved once, from the session's active org, at
  // context-creation time — and `boundAuth` is never rebuilt when
  // `resolveOrgFromPath` targets a different org. AccessControl.setRole
  // keeps its OWN `this.role` in sync with the path-resolved org and passes
  // it as `options.role` on every hasPermission() call; that must win over
  // the stale closure role, or an owner of the session's active org would
  // bypass every permission check on an unrelated org where they hold only
  // a lesser role.
  it("prefers options.role (path-resolved org) over the stale session-org role", async () => {
    const client = createBoundAuthClient({
      auth: stubAuth,
      headers: new Headers(),
      role: "owner", // session's active org — NOT the org being checked
      // no `permissions` — this is the browser-session flow (Flow 2)
    });

    expect(
      await client.hasPermission(
        { self: ["API_KEY_CREATE"] },
        { role: "user" }, // path-resolved org: caller is only a plain member
      ),
    ).toBe(false);
  });
});
